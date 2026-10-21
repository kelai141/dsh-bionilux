import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManager, GUEST_PATH_PREFIXES, isGuestPath, spawnCommand } from '../modules/manager.js';
import {
  DEFAULT_RUNTIME_IDS,
  defaultRuntimeIdForArch,
  resolveHostArchitecture,
  validateManifest,
  validateAsset,
  selectRuntime,
} from '../modules/manifest.js';
import { apply } from '../lib/index.js';

const temporaryRoot = path.join(os.tmpdir(), `bionilux-runtime-tests-${process.pid}`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const ELF_MACHINE = { arm64: 0xb7, x64: 0x3e };

/**
 * Minimal real ELF64 header (64 bytes). The health check reads the first 20
 * bytes, so this fixture exercises the production parser instead of a script
 * that would have to bypass it.
 */
function makeElf(architecture = 'arm64', { type = 2 } = {}) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = 2; // ELFCLASS64
  bytes[5] = 1; // little endian
  bytes[6] = 1; // EV_CURRENT
  bytes.writeUInt16LE(type, 16); // ET_EXEC (2) or ET_DYN (3)
  bytes.writeUInt16LE(ELF_MACHINE[architecture], 18);
  return bytes;
}

const ARCHIVE_FILES = {
  node: {
    'bin/node': makeElf('arm64'),
    'lib/node_modules/npm/index.js': '// npm\n',
  },
  backend: {
    'bin/bionilux': makeElf('arm64'),
    'lib/libbionilux_preload.so': makeElf('arm64', { type: 3 }),
    'scripts/prepare-rootfs.sh': '#!/bin/sh\n',
  },
  rootfs: {
    'bin/sh': '#!/bin/sh\n',
    'bin/bash': '#!/bin/sh\n',
    'usr/bin/apt-get': '#!/bin/sh\n',
    'usr/bin/dpkg': '#!/bin/sh\n',
    'etc/os-release': 'ID=debian\n',
    'lib/ld-linux-aarch64.so.1': makeElf('arm64', { type: 3 }),
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

function makeDualManifest() {
  const fixture = makeManifest();
  const x64 = structuredClone(fixture.manifest.runtimes[0]);
  x64.id = 'debian-minimal-x64';
  x64.label = 'Debian minimal x64';
  x64.architecture = 'x64';
  return { ...fixture.manifest, runtimes: [fixture.manifest.runtimes[0], x64] };
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

/**
 * A runner that acknowledges an abort only after a short delay. That delay is
 * the window in which a command used to be admitted while a cutover was still
 * draining the previous one.
 */
function makeDeferredAbortRunner({ abortDelayMs = 75 } = {}) {
  const calls = [];
  return {
    calls,
    runCommand(spec) {
      const record = {
        spec,
        startedAt: process.hrtime.bigint(),
        aborted: false,
        cancelled: false,
        forceKilled: false,
        settled: false,
      };
      calls.push(record);
      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      record.settle = (result) => {
        if (record.settled) return;
        record.settled = true;
        resolvePromise(result);
      };
      spec.signal?.addEventListener(
        'abort',
        () => {
          record.aborted = true;
          setTimeout(() => record.settle({ stdout: '', stderr: 'aborted', exitCode: 130 }), abortDelayMs);
        },
        { once: true },
      );
      if (!String(spec.args?.at(-1) ?? '').includes('sleep')) {
        record.settle({ stdout: 'ok', stderr: '', exitCode: 0 });
      }
      return {
        promise,
        cancel: () => {
          record.cancelled = true;
        },
        forceKill: () => {
          record.forceKilled = true;
          record.settle({ stdout: '', stderr: 'killed', exitCode: 137 });
        },
      };
    },
  };
}

/** A runner that ignores polite termination until forceKill, then exits late. */
function makeStubbornRunner({ forceKillDelayMs = 100 } = {}) {
  const calls = [];
  return {
    calls,
    runCommand(spec) {
      const record = { spec, aborted: false, cancelled: false, forceKilled: false, settled: false };
      calls.push(record);
      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      record.settle = (result) => {
        if (record.settled) return;
        record.settled = true;
        resolvePromise(result);
      };
      spec.signal?.addEventListener('abort', () => {
        record.aborted = true;
      }, { once: true });
      if (!String(spec.args?.at(-1) ?? '').includes('sleep')) {
        record.settle({ stdout: 'ok', stderr: '', exitCode: 0 });
      }
      return {
        promise,
        cancel: () => {
          record.cancelled = true;
        },
        forceKill: () => {
          record.forceKilled = true;
          setTimeout(() => record.settle({ stdout: '', stderr: 'killed', exitCode: 137 }), forceKillDelayMs);
        },
      };
    },
  };
}

/** A runner that never settles and ignores every termination request. */
function makeUnkillableRunner() {
  const calls = [];
  return {
    calls,
    runCommand(spec) {
      const record = { spec, aborted: false, cancelled: false, forceKilled: false };
      calls.push(record);
      if (!String(spec.args?.at(-1) ?? '').includes('sleep')) {
        return { promise: Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 }) };
      }
      return {
        promise: new Promise(() => {}),
        cancel: () => {
          record.cancelled = true;
        },
        forceKill: () => {
          record.forceKilled = true;
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
  await manager.dispose();

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
  assert.deepEqual(
    (await readdir(path.join(dataDir, 'instances'))).sort(),
    [first.instanceId],
    'the failed staged instance must not be left behind as an orphan',
  );
});

test('shared glibc Node is downloaded once and reused across releases', async () => {
  const dataDir = tempDir();
  const first = makeManifest({ version: '1.0.0' });
  const { manager } = makeManager(first, { dataDir });
  await manager.install(first.manifest);
  await manager.dispose();

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
  await manager.dispose();

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

test('management refuses a command admitted while it drains in-flight children', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const runner = makeDeferredAbortRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  await manager.install(fixture.manifest);
  let cutoverCompletedAt;
  manager.on('change', (state) => {
    if (state.version === '1.1.0') cutoverCompletedAt = process.hrtime.bigint();
  });

  const running = manager.execute({ command: 'sleep 100', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const installing = manager.install(makeManifest({ version: '1.1.0' }).manifest);
  for (let attempt = 0; attempt < 100 && !runner.calls.some((call) => call.aborted); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(runner.calls.some((call) => call.aborted), true, 'the running command must be aborted');

  // Issued while the manager is still waiting for the aborted child to settle.
  const queuedController = new AbortController();
  const queued = manager.execute({ command: 'sleep 500', signal: queuedController.signal });
  const outcome = await Promise.race([
    installing.then(() => 'installed'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
  ]);

  assert.equal(outcome, 'installed', 'a command admitted during the drain must not hold up management');
  for (const call of runner.calls.filter((candidate) => String(candidate.spec.args?.at(-1) ?? '') === 'sleep 500')) {
    assert.equal(cutoverCompletedAt !== undefined, true);
    assert.ok(
      call.startedAt >= cutoverCompletedAt,
      'a command admitted during the drain must not spawn before the cutover completes',
    );
  }

  // Deferred, not dropped: the command runs once the cutover releases the gate.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    runner.calls.filter((call) => String(call.spec.args?.at(-1) ?? '') === 'sleep 500').length,
    1,
  );
  queuedController.abort();
  assert.equal((await queued).exitCode, 130);
  assert.equal((await running).exitCode, 130);
});

test('a cutover waits for a force-killed child to exit before activating the new tree', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const runner = makeStubbornRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  await manager.install(fixture.manifest);

  const running = manager.execute({ command: 'sleep 100', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const status = await manager.install(makeManifest({ version: '1.1.0' }).manifest);
  const stubborn = runner.calls.find((call) => String(call.spec.args?.at(-1) ?? '') === 'sleep 100');

  assert.equal(stubborn.forceKilled, true);
  assert.equal(stubborn.settled, true, 'management must wait for the child to exit, not only send SIGKILL');
  assert.equal(status.healthy, true);
  assert.equal((await running).exitCode, 137);
});

test('management rejects and preserves the active tree when a child never exits', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const runner = makeUnkillableRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  const installed = await manager.install(fixture.manifest);
  assert.equal(installed.healthy, true);
  const activeBefore = await readFile(path.join(dataDir, 'active.json'), 'utf8');
  const rootfsFile = path.join(installed.paths.rootfs, 'etc', 'os-release');

  const running = manager.execute({ command: 'sleep 100' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await assert.rejects(
    () => manager.install(makeManifest({ version: '1.1.0' }).manifest),
    (error) =>
      error.code === 'ERR_RUNTIME_CHILDREN_STILL_RUNNING' &&
      /did not exit after SIGKILL/.test(error.message),
  );

  const status = manager.status();
  assert.equal(status.healthy, true);
  assert.equal(status.version, '1.0.0');
  assert.equal(await readFile(path.join(dataDir, 'active.json'), 'utf8'), activeBefore);
  assert.equal(existsSync(rootfsFile), true, 'the active rootfs must stay in place');
  assert.deepEqual((await readdir(path.join(dataDir, 'instances'))).sort(), [installed.instanceId]);
  assert.deepEqual(await readdir(path.join(dataDir, '.staging')), []);
  assert.equal(manager.children.size, 1, 'an unconfirmed child must stay tracked');
  const afterFailure = await manager.execute({ command: 'echo after' });
  assert.equal(afterFailure.exitCode, 0, 'a failed drain must not leave the gate permanently held');
  assert.equal(manager.children.size, 1, 'the unconfirmed child is still tracked after later commands');
  assert.equal(
    runner.calls.find((call) => String(call.spec.args?.at(-1) ?? '') === 'sleep 100').forceKilled,
    true,
  );
  void running;
});

test('a second live manager for the same dataDir is rejected without touching the first', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager, runner, io } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const controller = new AbortController();
  const running = manager.execute({ command: 'sleep 100', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const activeCall = runner.calls.find((call) => String(call.spec.args?.at(-1) ?? '') === 'sleep 100');

  assert.throws(
    () => makeManager(fixture, { dataDir }),
    (error) =>
      error.code === 'ERR_RUNTIME_MANAGER_IN_USE' &&
      /dispose it before creating another manager/.test(error.message),
  );
  assert.equal(activeCall.settled, false, 'rejection must not stop the existing manager child');

  // A hot reload evaluates a fresh module URL. Its module-local state is new,
  // but the process-wide owner registry must still see the live first manager.
  const reloaded = await import(`../modules/manager.js?reload=${Date.now()}`);
  assert.throws(
    () =>
      reloaded.createManager({
        dataDir,
        arch: 'arm64',
        downloadAsset: io.downloadAsset,
        extractArchive: io.extractArchive,
        runCommand: runner.runCommand,
      }),
    (error) => error.code === 'ERR_RUNTIME_MANAGER_IN_USE',
  );

  controller.abort();
  assert.equal((await running).exitCode, 130);
  await manager.dispose();

  const replacement = {
    manager: reloaded.createManager({
      dataDir,
      arch: 'arm64',
      downloadAsset: io.downloadAsset,
      extractArchive: io.extractArchive,
      runCommand: runner.runCommand,
    }),
  };
  assert.equal(replacement.manager.status().healthy, true);
  assert.equal((await replacement.manager.execute({ command: 'echo released' })).exitCode, 0);
  await replacement.manager.dispose();
});

test('a manager whose dispose failed keeps ownership of its dataDir', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const runner = makeUnkillableRunner();
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  await manager.install(fixture.manifest);
  const running = manager.execute({ command: 'sleep 100' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await assert.rejects(
    () => manager.dispose(),
    (error) => error.code === 'ERR_RUNTIME_CHILDREN_STILL_RUNNING',
  );
  assert.throws(
    () => makeManager(fixture, { dataDir }),
    (error) => error.code === 'ERR_RUNTIME_MANAGER_IN_USE',
  );
  void running;
});

test('a dataDir symlink alias cannot bypass manager ownership', { skip: process.platform === 'win32' }, async () => {
  const base = tempDir();
  const dataDir = path.join(base, 'real');
  const alias = path.join(base, 'alias');
  await mkdir(dataDir, { recursive: true });
  await symlink(dataDir, alias, 'dir');
  const first = createManager({ dataDir, arch: 'arm64' });
  try {
    assert.throws(() => createManager({ dataDir: alias, arch: 'arm64' }),
      (error) => error.code === 'ERR_RUNTIME_MANAGER_IN_USE');
  } finally {
    await first.dispose();
  }
  const replacement = createManager({ dataDir: alias, arch: 'arm64' });
  await replacement.dispose();
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

test('health rejects an active record that targets another architecture', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const activeFile = path.join(dataDir, 'active.json');
  const record = JSON.parse(await readFile(activeFile, 'utf8'));
  record.architecture = 'x64';
  await writeFile(activeFile, JSON.stringify(record, null, 2));

  const status = manager.status();
  assert.equal(status.installed, true);
  assert.equal(status.healthy, false);
  assert.equal(status.state, 'unhealthy');
  assert.match(status.reason, /architecture/);
  await assert.rejects(() => manager.execute({ command: 'echo hi' }), /architecture/);
});

test('plugin teardown disposes the manager it created and stops guest sessions', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const runner = makeDeferredAbortRunner({ abortDelayMs: 25 });
  let teardown;
  const ctx = {
    tools: { register: () => () => {} },
    effect: (setup) => {
      teardown = setup();
    },
  };
  const manager = apply(ctx, {
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: runner.runCommand,
  });
  await manager.install(fixture.manifest);

  const running = manager.execute({ command: 'sleep 100' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await teardown();

  assert.equal(manager.status().state, 'disposed');
  assert.equal((await running).exitCode, 130);
});

test('plugin teardown leaves a host-owned manager running', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const io = makeIo(fixture);
  const manager = createManager({
    dataDir,
    arch: 'arm64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: makeRunner().runCommand,
  });
  let teardown;
  const ctx = {
    tools: { register: () => () => {} },
    effect: (setup) => {
      teardown = setup();
    },
  };
  apply(ctx, { manager });

  await teardown();
  assert.equal(manager.status().state, 'absent', 'the host owns its manager lifecycle');
  await manager.dispose();
});

test('failed plugin service registration releases its newly owned manager', async () => {
  const dataDir = tempDir();
  let failedManager;
  assert.throws(() => apply({
    provide(_name, manager) {
      failedManager = manager;
      throw new Error('service registration rejected');
    },
  }, { dataDir, arch: 'arm64' }), /service registration rejected/);
  try {
    const deadline = Date.now() + 3_000;
    while (!failedManager.disposed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(failedManager.disposed, true, 'failed apply must roll back its owned resources');
    const replacement = createManager({ dataDir, arch: 'arm64' });
    await replacement.dispose();
  } finally {
    await failedManager.dispose();
  }
});

test('failed plugin service registration detaches without disposing a host manager', async () => {
  const { manager } = makeManager(makeManifest(), { dataDir: tempDir() });
  try {
    assert.throws(() => apply({
      provide() { throw new Error('service registration rejected'); },
    }, { manager }), /service registration rejected/);
    assert.equal(manager.disposed, false);
    assert.equal(manager.events.listenerCount('change'), 0);
  } finally {
    await manager.dispose();
  }
});

test('health requires a rootfs entry point to be a file, not a directory', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const bash = path.join(manager.status().paths.rootfs, 'bin', 'bash');
  await rm(bash, { force: true });
  await mkdir(bash);

  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.match(status.reason, /rootfs file is missing: \/bin\/bash/);
});

test('health rejects a non-ELF launcher instead of trusting its file name', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  await writeFile(path.join(manager.status().paths.backend, 'bin', 'bionilux'), Buffer.alloc(64, 0x41));

  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.match(status.reason, /backend launcher.*is not an ELF object/);
});

test('health rejects a wrong-architecture backend ELF object', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  await writeFile(
    path.join(manager.status().paths.backend, 'lib', 'libbionilux_preload.so'),
    makeElf('x64', { type: 3 }),
  );

  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.match(status.reason, /backend preload.*x64 ELF object; expected arm64/);
});

test('health rejects a wrong-architecture rootfs dynamic loader', async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  await writeFile(
    path.join(manager.status().paths.rootfs, 'lib', 'ld-linux-aarch64.so.1'),
    makeElf('x64', { type: 3 }),
  );

  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.match(status.reason, /rootfs dynamic loader.*x64 ELF object; expected arm64/);
});

test('health requires a native loader but allows a cross-development loader', async () => {
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir: tempDir() });
  await manager.install(fixture.manifest);
  const rootfs = manager.status().paths.rootfs;
  await mkdir(path.join(rootfs, 'lib64'), { recursive: true });
  await writeFile(path.join(rootfs, 'lib64', 'ld-linux-x86-64.so.2'), makeElf('x64', { type: 3 }));
  assert.equal(manager.status().healthy, true);
  await rm(path.join(rootfs, 'lib', 'ld-linux-aarch64.so.1'));
  const missing = manager.status();
  assert.equal(missing.healthy, false);
  assert.match(missing.reason, /rootfs dynamic loader for arm64 is missing/);
});

test('a rootfs loader symlink is resolved inside the rootfs and cannot escape', { skip: process.platform === 'win32' }, async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const loader = path.join(manager.status().paths.rootfs, 'lib', 'ld-linux-aarch64.so.1');
  const real = path.join(manager.status().paths.rootfs, 'lib', 'aarch64-linux-gnu', 'ld-linux-aarch64.so.1');
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, makeElf('arm64', { type: 3 }));
  await rm(loader, { force: true });
  await symlink('/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1', loader);

  const resolved = manager.status();
  assert.equal(resolved.healthy, true, resolved.reason);

  await rm(loader, { force: true });
  await symlink(real, loader);
  const legacy = manager.status();
  assert.equal(legacy.healthy, true, legacy.reason);

  await rm(loader, { force: true });
  await symlink('../../outside-loader', loader);
  const escaped = manager.status();
  assert.equal(escaped.healthy, false);
  assert.match(escaped.reason, /escapes the runtime rootfs/);
});

test('a rootfs directory symlink is resolved inside the rootfs', { skip: process.platform === 'win32' }, async () => {
  const dataDir = tempDir();
  const fixture = makeManifest();
  const { manager } = makeManager(fixture, { dataDir });
  await manager.install(fixture.manifest);

  const rootfs = manager.status().paths.rootfs;
  await rm(path.join(rootfs, 'lib'), { recursive: true, force: true });
  const loaderDirectory = path.join(rootfs, 'usr', 'lib', 'other');
  await mkdir(loaderDirectory, { recursive: true });
  await writeFile(path.join(loaderDirectory, 'ld-linux-aarch64.so.1'), makeElf('x64', { type: 3 }));
  await symlink('/usr/lib/other', path.join(rootfs, 'lib'));

  const status = manager.status();
  assert.equal(status.healthy, false);
  assert.match(
    status.reason,
    /rootfs dynamic loader.*x64 ELF object; expected arm64/,
    'the absolute directory link must be resolved inside the rootfs, not on the host',
  );
});

test('spawnCommand escalates a guest session that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const handle = spawnCommand({
    file: process.execPath,
    args: [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ],
    cwd: os.tmpdir(),
    env: process.env,
  });
  // Do not start the termination clock until the child has installed its
  // handler. A fixed sleep shorter than process startup is flaky under load.
  await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('child did not report readiness')), 10_000);
    handle.child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stdout.includes('ready')) return;
      clearTimeout(timer);
      resolve();
    });
    handle.child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const signalledAt = Date.now();
  handle.cancel('SIGTERM');
  const result = await handle.promise;

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - signalledAt < 10_000, 'termination must stay bounded');
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

  assert.throws(() => selectRuntime(fixture.manifest, 'debian-minimal', 'x64'), /targets arm64, but this host is x64/);
  assert.throws(() => validateAsset({ url: fixture.manifest.runtimes[0].rootfsAsset.url, sha256: 'a'.repeat(64), size: 0, unpackedSize: 1 }), /size/);
});

test('runtime defaults derive from the host architecture and never retarget an explicit id', () => {
  assert.deepEqual(DEFAULT_RUNTIME_IDS, { arm64: 'debian-minimal', x64: 'debian-minimal-x64' });
  assert.equal(defaultRuntimeIdForArch('arm64'), 'debian-minimal');
  assert.equal(defaultRuntimeIdForArch('x64'), 'debian-minimal-x64');
  assert.throws(() => defaultRuntimeIdForArch('riscv64'), /arm64 or x64/);
  assert.equal(resolveHostArchitecture('arm64'), 'arm64');
  assert.equal(resolveHostArchitecture('x64'), 'x64');
  assert.throws(() => resolveHostArchitecture('riscv64'), /arm64 or x64/);
  if (process.arch === 'arm64' || process.arch === 'x64') {
    assert.equal(resolveHostArchitecture(), process.arch);
  }

  const dual = makeDualManifest();
  assert.equal(selectRuntime(dual, 'debian-minimal-x64', 'x64').runtime.architecture, 'x64');
  assert.throws(() => selectRuntime(dual, 'debian-minimal', 'x64'), /targets arm64, but this host is x64/);
  assert.throws(() => selectRuntime(dual, 'debian-minimal-x64', 'arm64'), /targets x64, but this host is arm64/);
});

test('the manager derives arch from the host when it is not supplied', () => {
  if (process.arch !== 'arm64' && process.arch !== 'x64') return;
  const manager = createManager({
    dataDir: tempDir(),
    runCommand: () => {
      throw new Error('not used');
    },
  });
  assert.equal(manager.arch, process.arch);
});

test('manager install defaults to the runtime id for its own architecture', async () => {
  for (const [arch, expected] of [['arm64', 'debian-minimal'], ['x64', 'debian-minimal-x64']]) {
    const manager = createManager({
      dataDir: tempDir(),
      arch,
      runCommand: () => {
        throw new Error('not used');
      },
    });
    let selected;
    manager._installLocked = async (_manifest, runtimeId) => {
      selected = runtimeId;
      return { healthy: true };
    };
    await manager.install(makeDualManifest());
    assert.equal(selected, expected);
  }
});
