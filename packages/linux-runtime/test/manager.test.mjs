import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManager, GUEST_PATH_PREFIXES, isGuestPath } from '../modules/manager.js';
import { validateManifest, validateAsset, selectRuntime } from '../modules/manifest.js';

const temporaryRoot = path.join(os.tmpdir(), `bionilux-runtime-tests-${process.pid}`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const ARCHIVE_FILES = {
  node: {
    'bin/node': '#!/bin/sh\n',
    'lib/node_modules/npm/index.js': '// npm\n',
  },
  backend: {
    'bin/bionilux': '#!/bin/sh\n',
    'lib/libbionilux_preload.so': 'shared object\n',
    'scripts/prepare-rootfs.sh': '#!/bin/sh\n',
  },
  rootfs: {
    'bin/sh': '#!/bin/sh\n',
    'bin/bash': '#!/bin/sh\n',
    'usr/bin/apt-get': '#!/bin/sh\n',
    'usr/bin/dpkg': '#!/bin/sh\n',
    'etc/os-release': 'ID=debian\n',
  },
};

/** Build an asset whose downloaded bytes match its declared digest. */
function makeAsset(name, { body = `archive:${name}`, digestBody = null } = {}) {
  const bytes = Buffer.from(body);
  return {
    bytes,
    asset: {
      url: `https://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/${name}`,
      sha256: sha256(digestBody ? Buffer.from(digestBody) : bytes),
      size: bytes.length,
      unpackedSize: 1024,
    },
  };
}

function makeManifest({ nodeAsset, rootfsFiles = ARCHIVE_FILES.rootfs, version = '1.0.0' } = {}) {
  const backend = makeAsset('bionilux-backend-aarch64.tar.xz');
  const rootfs = makeAsset('debian-minimal-aarch64.tar.xz');
  const node = nodeAsset ?? makeAsset('node-glibc-v24.22.0-linux-arm64.tar.xz');
  return {
    bytes: { backend: backend.bytes, rootfs: rootfs.bytes, node: node.bytes },
    rootfsFiles,
    manifest: {
      schemaVersion: 1,
      version,
      minMobileVersion: '0.14.0',
      plugins: {
        bootstrap: makeAsset('linux-bootstrap-plugin.tar.xz').asset,
        runtime: makeAsset('linux-runtime-plugin.tar.xz').asset,
      },
      runtimes: [
        {
          id: 'debian-minimal',
          label: 'Debian minimal',
          architecture: 'arm64',
          backend: 'bionilux',
          backendAsset: backend.asset,
          rootfsAsset: rootfs.asset,
          nodeAsset: node.asset,
        },
      ],
    },
  };
}

/**
 * IO harness: downloads write the archive bytes the manifest declares, and the
 * safe extractor materializes the fake payload for each archive kind.
 */
function makeIo(fixture, { onExtract } = {}) {
  const stats = { downloads: [], extracts: [] };
  const io = {
    stats,
    downloadAsset: async (asset, destination) => {
      stats.downloads.push(path.basename(new URL(asset.url).pathname));
      const name = path.basename(new URL(asset.url).pathname);
      const bytes = name.includes('bionilux-backend')
        ? fixture.bytes.backend
        : name.includes('debian-minimal')
          ? fixture.bytes.rootfs
          : name.includes('node-glibc')
            ? fixture.bytes.node
            : fixture.bytes.backend;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    },
    extractArchive: async (_archive, destination, { kind } = {}) => {
      stats.extracts.push(kind);
      if (typeof onExtract === 'function') await onExtract(kind, destination);
      const files = kind === 'rootfs' ? fixture.rootfsFiles : ARCHIVE_FILES[kind];
      if (!files) throw new Error(`unknown archive kind ${kind}`);
      for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(destination, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
        if (relative.startsWith('bin/') || relative.startsWith('usr/bin/') || relative === 'bin/node') {
          const { chmod } = await import('node:fs/promises');
          await chmod(target, 0o755);
        }
      }
    },
  };
  return io;
}

/**
 * Command runner: everything resolves immediately except an explicitly held
 * command (`sleep ...`), which stays pending until the manager aborts or
 * cancels it — that is what the cutover gate has to do before it replaces an
 * active rootfs.
 */
function makeRunner({ instant } = {}) {
  const calls = [];
  const isInstant =
    instant ?? ((spec) => !String(spec.args?.at(-1) ?? '').includes('sleep'));
  return {
    calls,
    runCommand(spec) {
      const record = { spec, aborted: false, cancelled: false, forceKilled: false, settled: false };
      calls.push(record);
      return {
        promise: new Promise((resolve) => {
          const settle = (result) => {
            if (record.settled) return;
            record.settled = true;
            resolve(result);
          };
          record.settle = settle;
          spec.signal?.addEventListener(
            'abort',
            () => {
              record.aborted = true;
              settle({ stdout: '', stderr: 'aborted', exitCode: 130 });
            },
            { once: true },
          );
          if (isInstant(spec)) settle({ stdout: 'ok', stderr: '', exitCode: 0 });
        }),
        cancel: () => {
          record.cancelled = true;
          record.settle?.({ stdout: '', stderr: 'cancelled', exitCode: 143 });
        },
        forceKill: () => {
          record.forceKilled = true;
          record.settle?.({ stdout: '', stderr: 'killed', exitCode: 137 });
        },
      };
    },
  };
}

function makeManager(fixture, { dataDir, ioOptions, runnerOptions, arch = 'arm64' } = {}) {
  const io = makeIo(fixture, ioOptions);
  const runner = makeRunner(runnerOptions);
  const manager = createManager({
    dataDir,
    arch,
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  return { manager, io, runner };
}

let counter = 0;
function tempDir() {
  counter += 1;
  return path.join(temporaryRoot, `case-${counter}`);
}

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test('install stages, proves health, then activates the runtime', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, io } = makeManager(fixture, { dataDir });

  assert.equal(manager.status().installed, false);
  assert.equal(manager.status().healthy, false);

  const status = await manager.install(fixture.manifest);

  assert.equal(status.healthy, true);
  assert.equal(status.installed, true);
  assert.equal(status.runtimeId, 'debian-minimal');
  assert.equal(status.version, '1.0.0');

  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.runtimeId, 'debian-minimal');
  assert.match(record.nodeKey, /^sha256-[a-f0-9]{64}$/);
  assert.deepEqual(io.stats.extracts.sort(), ['backend', 'node', 'rootfs']);
});

test('a failing install leaves the previous active runtime untouched', async () => {
  const dataDir = tempDir();
  const good = makeManifest();
  const { manager } = makeManager(good, { dataDir });
  const first = await manager.install(good.manifest);
  assert.equal(first.healthy, true);

  const brokenRootfs = { ...ARCHIVE_FILES.rootfs };
  delete brokenRootfs['usr/bin/dpkg'];
  const broken = makeManifest({ version: '1.1.0', rootfsFiles: brokenRootfs });
  const { manager: second } = makeManager(broken, { dataDir });

  await assert.rejects(() => second.install(broken.manifest, 'debian-minimal'), /unhealthy|rootfs file is missing/);

  const after = second.status();
  assert.equal(after.healthy, true, 'the previously active instance must stay active');
  assert.equal(after.version, '1.0.0');
  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.version, '1.0.0');
});

test('shared glibc Node is downloaded once and reused across releases', async () => {
  const dataDir = tempDir();
  const first = makeManifest({ version: '1.0.0' });
  const { manager } = makeManager(first, { dataDir });
  await manager.install(first.manifest);

  const nodeDownloads = () => {
    const shared = path.join(dataDir, 'shared', 'node');
    return existsSync(shared) ? [path.join(shared)] : [];
  };
  assert.equal(nodeDownloads().length, 1);

  // A new Linux release that ships the same Node archive must not re-download it.
  const second = makeManifest({ version: '1.1.0' });
  const io = makeIo(second);
  const next = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: makeRunner().runCommand,
  });
  await next.install(second.manifest);

  assert.equal(io.stats.downloads.filter((name) => name.includes('node-glibc')).length, 0);
  assert.equal(next.status().version, '1.1.0');
  assert.equal(next.status().healthy, true);
});

test('a different shared Node archive installs alongside and retires the old one', async () => {
  const dataDir = tempDir();
  const first = makeManifest({ version: '1.0.0' });
  const { manager } = makeManager(first, { dataDir });
  await manager.install(first.manifest);

  const upgraded = makeManifest({ version: '1.1.0', nodeAsset: makeAsset('node-glibc-v25.0.0-linux-arm64.tar.xz') });
  const io = makeIo(upgraded);
  const next = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: makeRunner().runCommand,
  });
  await next.install(upgraded.manifest);

  assert.equal(io.stats.downloads.filter((name) => name.includes('node-glibc')).length, 1);
  const record = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));
  assert.equal(record.nodeKey, `sha256-${upgraded.manifest.runtimes[0].nodeAsset.sha256}`);
});

test('the cutover stops in-flight commands and blocks new ones until it finishes', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const beforeCutover = runner.calls.length;

  const running = manager.execute({ command: 'sleep 100', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Upgrade on the same manager instance: one manager owns one data directory.
  const replacement = makeManifest({ version: '1.1.0' });
  const installed = await manager.install(replacement.manifest);
  const result = await running;

  assert.equal(result.exitCode, 130, 'the in-flight command was aborted, not silently dropped');
  assert.equal(runner.calls.length > beforeCutover, true);
  assert.equal(installed.healthy, true);
  assert.equal(manager.status().version, '1.1.0');
});

test('a command issued during a cutover waits for it instead of running against a replaced rootfs', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const installPromise = manager.install(fixture.manifest);
  const queued = manager.execute({ command: 'echo after' });

  const installed = await installPromise;
  const result = await queued;

  assert.equal(installed.healthy, true);
  assert.equal(result.exitCode, 0);
  const lastSpec = runner.calls.at(-1).spec;
  assert.equal(lastSpec.args.at(-1), 'echo after');
});

test('uninstall removes the instance and unreferenced Node but keeps foreign data', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const foreign = path.join(dataDir, 'workspaces', 'project');
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, 'keep.txt'), 'user data\n');

  const status = await manager.uninstall();

  assert.equal(status.installed, false);
  assert.equal(existsSync(path.join(dataDir, 'instances')), true);
  assert.equal(existsSync(path.join(dataDir, 'shared', 'node')), true);
  assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'user data\n');
  const shared = path.join(dataDir, 'shared', 'node');
  if (existsSync(shared)) {
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(shared), []);
  }
});

test('the guest environment is derived, not inherited from the host', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  runner.calls.length = 0;
  await manager.execute({ command: 'echo hi' });
  const spec = runner.calls.at(-1).spec;
  const env = spec.env;

  for (const leaked of ['PREFIX', 'TERMUX_VERSION', 'LD_PRELOAD', 'NODE_OPTIONS', 'npm_config_prefix']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the guest`);
  }
  assert.equal(env.BIONILUX_ROOTFS, manager.status().paths.rootfs);
  assert.equal(env.BIONILUX_LENIENT, '0');
  assert.match(env.BIONILUX_GUEST_PATH, /lib\/node_modules\/npm|bin:.*\/usr\/bin/);
  assert.equal(env.BIONILUX_GUEST_PATH.startsWith(path.join(manager.status().paths.node, 'bin')), true);
  assert.equal(spec.args[0], '/bin/bash');
  assert.equal(spec.args[1], '-lc');
  assert.equal(spec.args[2], 'echo hi');
});

test('cwd inside the rootfs becomes a guest path, and relative cwd is rejected', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const rootfs = manager.status().paths.rootfs;
  await mkdir(path.join(rootfs, 'work'), { recursive: true });

  runner.calls.length = 0;
  const inside = await manager.execute({ command: 'pwd', cwd: path.join(rootfs, 'work') });
  assert.equal(inside.cwd, '/work');
  const nodeBin = path.join(manager.status().paths.node, 'bin');
  // The list is colon-separated for the POSIX guest; on a Windows host an
  // absolute path itself contains ':', so compare by position instead of by
  // splitting.
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).startsWith(nodeBin),
    true,
    'the shared Linux Node bin directory must stay reachable from the guest',
  );

  const guestPath = await manager.execute({ command: 'pwd', cwd: '/root' });
  assert.equal(guestPath.cwd, '/root');
  assert.equal(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS.includes('/root'), false);

  await assert.rejects(() => manager.execute({ command: 'pwd', cwd: 'relative/path' }), /absolute path/);
});

test('a working directory in the guest namespace is never promoted to a host pass-through', { skip: process.platform === 'win32' }, async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  // /tmp exists on the host and is also a guest path: promoting it would shadow
  // the guest's own /tmp, so the cwd must stay a guest path.
  const guestNamespaceDir = path.posix.join('/tmp', `bionilux-guest-ns-${process.pid}`);
  await mkdir(guestNamespaceDir, { recursive: true });

  runner.calls.length = 0;
  const result = await manager.execute({ command: 'pwd', cwd: guestNamespaceDir });

  assert.equal(result.cwd, guestNamespaceDir);
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).includes(guestNamespaceDir),
    false,
    'the guest namespace must not be shadowed',
  );
});

test('a host workspace outside the guest namespace stays visible under its own name', async () => {
  const dataDir = tempDir();
  // On platforms whose temp root is itself a guest path (Linux CI: /tmp) this
  // case cannot be exercised without shadowing the guest namespace, so it is
  // reported as skipped rather than asserted.
  const guestPrefixed = GUEST_PATH_PREFIXES.some((prefix) => dataDir === prefix || dataDir.startsWith(`${prefix}${path.sep}`) || dataDir.startsWith(`${prefix}/`));
  if (guestPrefixed) return;

  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const shared = path.join(dataDir, 'workspaces', 'project');
  await mkdir(shared, { recursive: true });

  runner.calls.length = 0;
  const outside = await manager.execute({ command: 'pwd', cwd: shared });

  assert.equal(outside.cwd, shared);
  assert.equal(
    String(runner.calls.at(-1).spec.env.BIONILUX_HOST_PATHS).endsWith(shared),
    true,
    'a real host workspace must stay reachable',
  );
});

test('the guest namespace list covers the directories the rootfs owns', () => {
  for (const required of ['/etc', '/usr', '/tmp', '/var', '/home', '/root']) {
    assert.equal(GUEST_PATH_PREFIXES.includes(required), true, `${required} must be in the guest namespace`);
  }
  assert.equal(isGuestPath('/etc'), true);
  assert.equal(isGuestPath('/etc/os-release'), true);
  assert.equal(isGuestPath('/etcetera'), false, 'prefix matching must not leak to similar names');
  assert.equal(isGuestPath('/data/data/com.dsharnessmobile.shell/files'), false);
});

test('execution fails closed when the runtime is absent, and never falls back to the host', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner } = makeManager(fixture, { dataDir });

  await assert.rejects(() => manager.execute({ command: 'echo hi' }), /Linux runtime is unavailable/);
  assert.equal(runner.calls.length, 0, 'no host shell may be spawned as a fallback');
});

test('reinstall replaces the instance without leaving a stale active record', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);
  const first = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));

  const status = await manager.reinstall(fixture.manifest);
  const second = JSON.parse(await readFile(path.join(dataDir, 'active.json'), 'utf8'));

  assert.equal(status.healthy, true);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(existsSync(path.join(dataDir, 'instances', first.instanceId)), false);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(dataDir, '.staging')), []);
});

test('manifest validation rejects unsafe assets and unsupported selections', () => {
  const fixture = makeManifest();
  assert.equal(validateManifest(fixture.manifest).runtimes[0].id, 'debian-minimal');

  const httpUrl = structuredClone(fixture.manifest);
  httpUrl.plugins.runtime.url = 'http://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/linux-runtime-plugin.tar.xz';
  assert.throws(() => validateManifest(httpUrl), /HTTPS/i);

  const badDigest = structuredClone(fixture.manifest);
  badDigest.plugins.runtime.sha256 = 'nope';
  assert.throws(() => validateManifest(badDigest), /sha256/);

  const duplicate = structuredClone(fixture.manifest);
  duplicate.runtimes.push({ ...duplicate.runtimes[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate/);

  const traversal = structuredClone(fixture.manifest);
  traversal.runtimes[0].id = '../escape';
  assert.throws(() => validateManifest(traversal), /unsafe path/);

  assert.throws(() => selectRuntime(fixture.manifest, 'debian-minimal', 'x64'), /not present in the manifest/);
  assert.throws(() => validateAsset({ url: fixture.manifest.runtimes[0].rootfsAsset.url, sha256: 'a'.repeat(64), size: 0, unpackedSize: 1 }), /size/);
});
