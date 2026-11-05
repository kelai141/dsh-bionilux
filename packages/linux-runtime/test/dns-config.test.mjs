import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertResolvConfWritable,
  filterUsableDnsServers,
  inspectResolvConf,
  isUsableNameserver,
  normaliseDnsServers,
  parseNameservers,
  resolveDnsServers,
} from '../modules/dns-config.js';
import { createManager } from '../modules/manager.js';

const temporaryRoot = path.join(os.tmpdir(), `bionilux-dns-tests-${process.pid}`);
let counter = 0;

function tempDir() {
  counter += 1;
  return path.join(temporaryRoot, `case-${counter}`);
}

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('only addresses a guest resolver can reach are accepted', () => {
  for (const value of ['1.1.1.1', '8.8.8.8', '10.0.2.3', '2001:4860:4860::8888', '[2001:4860:4860::8888]']) {
    assert.equal(isUsableNameserver(value), true, value);
  }
  for (const value of ['127.0.0.1', '127.10.0.1', '::1', '0.0.0.0', '224.0.0.1', 'fe80::1', 'not-an-ip', '']) {
    assert.equal(isUsableNameserver(value), false, value);
  }
  assert.deepEqual(filterUsableDnsServers(['127.0.0.1', '1.1.1.1', '1.1.1.1']), ['1.1.1.1']);
});

test('explicit dnsServers are validated instead of silently dropped', () => {
  assert.deepEqual(normaliseDnsServers([' 1.1.1.1 ', '1.1.1.1', '2001:4860:4860::8888']), [
    '1.1.1.1',
    '2001:4860:4860::8888',
  ]);
  assert.throws(() => normaliseDnsServers(['127.0.0.1']), /unusable DNS address/);
  assert.throws(() => normaliseDnsServers('1.1.1.1'), /must be an array/);
  assert.throws(() => normaliseDnsServers([42]), /only strings/);
});

test('resolv.conf parsing ignores comments and unusable entries', () => {
  const text = [
    '# nameserver 9.9.9.9',
    'nameserver 1.1.1.1',
    'nameserver 127.0.0.1',
    '  nameserver   8.8.8.8 # trailing',
    'search example.test',
    'nameserver ::1',
  ].join('\n');
  assert.deepEqual(parseNameservers(text), ['1.1.1.1', '8.8.8.8']);
  assert.deepEqual(parseNameservers(''), []);
});

test('inspectResolvConf distinguishes missing, usable and symlinked files', async (t) => {
  const root = tempDir();
  await mkdir(root, { recursive: true });
  assert.deepEqual(inspectResolvConf(path.join(root, 'etc', 'resolv.conf')), {
    exists: false,
    symlink: false,
    usable: false,
    servers: [],
  });

  await mkdir(path.join(root, 'etc'), { recursive: true });
  await writeFile(path.join(root, 'etc', 'resolv.conf'), '# written by the host\nnameserver 9.9.9.9\n');
  assert.deepEqual(inspectResolvConf(path.join(root, 'etc', 'resolv.conf')), {
    exists: true,
    symlink: false,
    usable: true,
    servers: ['9.9.9.9'],
  });

  const link = path.join(root, 'etc', 'linked.conf');
  try {
    await symlink(path.join(root, 'etc', 'resolv.conf'), link);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.diagnostic('file symlinks are unavailable; skipping the symlink case');
      return;
    }
    throw error;
  }
  assert.equal(inspectResolvConf(link).symlink, true);
  assert.equal(inspectResolvConf(link).usable, false);
});

test('explicit servers win; provider runs only when the option is empty', async () => {
  const calls = [];
  const explicit = await resolveDnsServers({
    dnsServers: ['10.0.2.3'],
    dnsServersProvider: async () => {
      calls.push('provider');
      return ['8.8.8.8'];
    },
  });
  assert.deepEqual(explicit, { servers: ['10.0.2.3'], source: 'explicit' });
  assert.deepEqual(calls, []);

  const provided = await resolveDnsServers({
    dnsServers: [],
    dnsServersProvider: async (context) => {
      calls.push(context.rootfs);
      return ['8.8.4.4'];
    },
    rootfs: '/tmp/guest',
  });
  assert.deepEqual(provided, { servers: ['8.8.4.4'], source: 'provider' });
  assert.deepEqual(calls, ['/tmp/guest']);
});

test('the host resolver is used when it reports a routable address', async () => {
  const result = await resolveDnsServers({
    dnsGetServers: () => ['127.0.0.1', '192.168.1.1'],
    allowPublicDnsFallback: true,
    dnsProbe: async () => {
      throw new Error('public DNS must not be probed');
    },
  });
  assert.deepEqual(result, { servers: ['192.168.1.1'], source: 'host' });
});

test('the loopback stub never becomes the guest resolver; the first reachable fallback wins', async () => {
  const probed = [];
  const result = await resolveDnsServers({
    dnsGetServers: () => ['127.0.0.1'],
    allowPublicDnsFallback: true,
    dnsFallback: ['1.1.1.1', '8.8.8.8'],
    dnsProbe: async (server) => {
      probed.push(server);
      return server === '8.8.8.8';
    },
  });
  assert.deepEqual(result, { servers: ['8.8.8.8'], source: 'fallback', attempts: ['1.1.1.1', '8.8.8.8'] });
  assert.deepEqual(probed, ['1.1.1.1', '8.8.8.8']);
});

test('no reachable resolver is an explicit failure when requireDns is set', async () => {
  await assert.rejects(
    () =>
      resolveDnsServers({
        dnsGetServers: () => ['127.0.0.1'],
        allowPublicDnsFallback: true,
        dnsFallback: ['1.1.1.1'],
        dnsProbe: async () => false,
        requireDns: true,
      }),
    (error) => error.code === 'ERR_RUNTIME_DNS_UNAVAILABLE' && /after probing 1\.1\.1\.1/.test(error.message),
  );

  const optional = await resolveDnsServers({
    dnsGetServers: () => ['127.0.0.1'],
    requireDns: false,
  });
  assert.deepEqual(optional, { servers: [], source: 'none', attempts: [] });
});

test('a public probe stops when the operation is aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('install cancelled'));
  await assert.rejects(
    () =>
      resolveDnsServers({
        dnsGetServers: () => [],
        allowPublicDnsFallback: true,
        dnsFallback: ['1.1.1.1'],
        dnsProbe: async () => true,
        signal: controller.signal,
      }),
    /install cancelled/,
  );
});

function makeRunner() {
  const calls = [];
  return {
    calls,
    runCommand(spec) {
      calls.push(spec);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
}

async function makeInstance({ resolv = null } = {}) {
  const root = tempDir();
  const instance = {
    root,
    backend: path.join(root, 'backend'),
    rootfs: path.join(root, 'rootfs'),
  };
  await mkdir(path.join(instance.backend, 'scripts'), { recursive: true });
  await mkdir(path.join(instance.rootfs, 'etc'), { recursive: true });
  await writeFile(path.join(instance.backend, 'scripts', 'prepare-rootfs.sh'), '#!/bin/sh\nexit 0\n');
  if (resolv !== null) await writeFile(path.join(instance.rootfs, 'etc', 'resolv.conf'), resolv);
  return instance;
}

test('host preparation receives --dns and the Termux loader path', async () => {
  const dataDir = tempDir();
  const runner = makeRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    dnsServers: ['10.0.2.3'],
    runCommand: runner.runCommand,
  });
  const previousLoaderPath = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = '/data/data/com.termux/files/usr/lib';
  try {
    const instance = await makeInstance();
    await manager._prepareRootfs(instance);
    assert.equal(runner.calls.length, 1);
    const [spec] = runner.calls;
    assert.equal(spec.file, 'sh');
    assert.deepEqual(spec.args.slice(-2), ['--dns', '10.0.2.3']);
    assert.equal(spec.env.LD_LIBRARY_PATH, '/data/data/com.termux/files/usr/lib');

    const guest = manager._executionEnvironment(
      {
        rootfs: instance.rootfs,
        preload: path.join(instance.backend, 'lib', 'libbionilux_preload.so'),
        launcher: path.join(instance.backend, 'bin', 'bionilux'),
        node: path.join(dataDir, 'shared', 'node', 'x', 'arm64'),
      },
      { guestCwd: '/', hostPaths: [] },
    );
    assert.equal(guest.LD_LIBRARY_PATH, undefined, 'guest execute must stay clean');
  } finally {
    if (previousLoaderPath === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previousLoaderPath;
    await manager.dispose();
  }
});

test('an existing usable resolv.conf is preserved', async () => {
  const dataDir = tempDir();
  const runner = makeRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    dnsServers: ['10.0.2.3'],
    runCommand: runner.runCommand,
  });
  try {
    const instance = await makeInstance({ resolv: '# operator supplied\nnameserver 9.9.9.9\n' });
    await manager._prepareRootfs(instance);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].args.includes('--dns'), false);
  } finally {
    await manager.dispose();
  }
});

test('a symlinked resolv.conf blocks the install instead of writing to the host', async () => {
  assert.throws(
    () => assertResolvConfWritable({ exists: true, symlink: true, usable: false }),
    (error) => error.code === 'ERR_RUNTIME_DNS_RESOLV_SYMLINK',
  );
  assert.doesNotThrow(() => assertResolvConfWritable({ exists: false, symlink: false, usable: false }));
  assert.doesNotThrow(() => assertResolvConfWritable({ exists: true, symlink: false, usable: true }));
});

test('invalid DNS options are rejected when the manager is constructed', () => {
  const base = {
    dataDir: tempDir(),
    arch: 'arm64',
    runCommand: () => {
      throw new Error('not used');
    },
  };
  assert.throws(() => createManager({ ...base, dnsServers: '1.1.1.1' }), /dnsServers must be an array/);
  assert.throws(() => createManager({ ...base, dnsServersProvider: 'nope' }), /dnsServersProvider must be a function/);
  assert.throws(() => createManager({ ...base, dnsProbe: 'nope' }), /dnsProbe must be a function/);
  assert.throws(() => createManager({ ...base, dnsProbeTimeoutMs: 0 }), /positive number/);
});
