/**
 * Process-scope acceptance on a real Linux host.
 *
 * These tests deliberately use the public manager lifecycle and the real
 * spawnCommand implementation. A launcher fixture based on /usr/bin/env turns
 * each manager command into a normal host shell command, so a manager-owned
 * setsid daemon can be observed through /proc after the command promise has
 * already settled.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createManager, spawnCommand } from '../modules/manager.js';
import { PROCESS_SCOPE_ENV, ProcessScope } from '../modules/process-scope.js';

const linuxHost = process.platform === 'linux' && process.arch === 'x64';
const testRoot = path.join(os.tmpdir(), 'bionilux-process-scope-' + process.pid);
const fixture = path.join(testRoot, 'fixture');
const daemons = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

async function copyElf(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

async function prepareFixture() {
  await rm(testRoot, { recursive: true, force: true });
  const backend = path.join(fixture, 'backend');
  const rootfs = path.join(fixture, 'rootfs');
  const node = path.join(fixture, 'node');
  await mkdir(path.join(backend, 'bin'), { recursive: true });
  await mkdir(path.join(backend, 'lib'), { recursive: true });
  await mkdir(path.join(backend, 'scripts'), { recursive: true });
  await mkdir(path.join(rootfs, 'bin'), { recursive: true });
  await mkdir(path.join(rootfs, 'usr', 'bin'), { recursive: true });
  await mkdir(path.join(rootfs, 'etc'), { recursive: true });
  await mkdir(path.join(rootfs, 'lib'), { recursive: true });
  await mkdir(path.join(node, 'bin'), { recursive: true });
  await mkdir(path.join(node, 'lib', 'node_modules', 'npm'), { recursive: true });

  // /usr/bin/env treats its first argument as the program: the manager's
  // ["/bin/bash", "-lc", command] becomes a real host shell command.
  await copyElf('/usr/bin/env', path.join(backend, 'bin', 'bionilux'));
  await copyElf('/bin/true', path.join(backend, 'lib', 'libbionilux_preload.so'));
  await writeFile(
    path.join(backend, 'scripts', 'prepare-rootfs.sh'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 },
  );

  for (const relative of ['bin/sh', 'bin/bash', 'usr/bin/apt-get', 'usr/bin/dpkg']) {
    await writeFile(path.join(rootfs, relative), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await writeFile(path.join(rootfs, 'etc', 'os-release'), 'ID=fixture\n');
  await copyElf('/bin/true', path.join(rootfs, 'lib', 'ld-linux-x86-64.so.2'));
  await copyElf('/bin/true', path.join(node, 'bin', 'node'));
  await writeFile(path.join(node, 'lib', 'node_modules', 'npm', 'index.js'), '// fixture\n');
}

function asset(kind, version) {
  const bytes = Buffer.from(kind + ':' + version);
  return {
    bytes,
    value: {
      url: 'https://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/' + kind + '.tar.xz',
      sha256: sha256(bytes),
      size: bytes.length,
      unpackedSize: 1024,
    },
  };
}

function makeManifest(version = '1.0.0') {
  const backend = asset('bionilux-backend-x64', version);
  const rootfs = asset('debian-minimal-x64', version);
  const node = asset('node-glibc-x64', 'stable');
  return {
    bytes: { backend: backend.bytes, rootfs: rootfs.bytes, node: node.bytes },
    manifest: {
      schemaVersion: 1,
      version,
      minMobileVersion: '0.14.0',
      plugins: {
        bootstrap: asset('linux-bootstrap-plugin', version).value,
        runtime: asset('linux-runtime-plugin', version).value,
      },
      runtimes: [
        {
          id: 'debian-minimal-x64',
          label: 'process-scope fixture',
          architecture: 'x64',
          backend: 'bionilux',
          backendAsset: backend.value,
          rootfsAsset: rootfs.value,
          nodeAsset: node.value,
        },
      ],
    },
  };
}

function makeIo(fixtureManifest) {
  return {
    downloadAsset: async (value, destination) => {
      const name = path.basename(new URL(value.url).pathname);
      const bytes = name.includes('backend')
        ? fixtureManifest.bytes.backend
        : name.includes('debian-minimal')
          ? fixtureManifest.bytes.rootfs
          : fixtureManifest.bytes.node;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    },
    extractArchive: async (_archive, destination, { kind } = {}) => {
      await rm(destination, { recursive: true, force: true });
      await cp(path.join(fixture, kind), destination, { recursive: true });
    },
  };
}

async function installedManager(name, version = '1.0.0') {
  const dataDir = path.join(testRoot, name);
  const fixtureManifest = makeManifest(version);
  const io = makeIo(fixtureManifest);
  const manager = createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: spawnCommand,
  });
  const status = await manager.install(fixtureManifest.manifest);
  assert.equal(status.healthy, true, status.reason);
  return { manager, dataDir, fixtureManifest, io };
}

function daemonCommand(pidFile) {
  const quoted = shellQuote(pidFile);
  return (
    "setsid /bin/sh -c 'echo $$ > " + quoted + "; exec /bin/sleep 300' " +
    '>/dev/null 2>&1 </dev/null &'
  );
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text;
    }
    await sleep(20);
  }
  throw new Error('timed out waiting for ' + file);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitGone(pid, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

function procEnv(pid) {
  const entries = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
  const values = new Map();
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index > 0) values.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return values;
}

function procSession(pid) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[3]);
}

function procStart(pid) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return fields[19];
}

async function startManagerDaemon(manager) {
  const pidFile = path.join(testRoot, 'daemon-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const result = await manager.execute({ command: daemonCommand(pidFile), timeout: 20_000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const pid = Number(await waitForFile(pidFile));
  daemons.add(pid);
  // Cleanup is management-only: there is no passive timer reaping the daemon
  // once the command handle has settled.
  await sleep(300);
  assert.equal(alive(pid), true, 'setsid daemon must be alive after the command settles');
  return pid;
}

async function killTracked(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  await waitGone(pid, 2_000);
  daemons.delete(pid);
}

async function startUnrelated(extraEnv, label) {
  const child = spawn('/bin/sleep', ['300'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  daemons.add(child.pid);
  await sleep(50);
  assert.equal(alive(child.pid), true, label + ' must start');
  return child.pid;
}

before(async () => {
  if (linuxHost) await prepareFixture();
});

after(async () => {
  for (const pid of [...daemons]) await killTracked(pid);
  await rm(testRoot, { recursive: true, force: true });
});

test('uninstall kills a settled setsid daemon carrying the manager tag', { skip: !linuxHost }, async () => {
  const { manager } = await installedManager('uninstall');
  const pid = await startManagerDaemon(manager);
  const tag = procEnv(pid).get('BIONILUX_PROCESS_SCOPE');
  assert.match(tag, /^[a-f0-9]{64}$/, 'manager must inject a deterministic 64-hex process tag');
  assert.equal(procSession(pid), pid, 'the daemon must be in its own session');

  await manager.uninstall();
  assert.equal(await waitGone(pid), true, 'uninstall must terminate the tagged setsid daemon');
  daemons.delete(pid);
  await manager.dispose();
});

test('the public scope API reports a stable tag and PID start time', { skip: !linuxHost }, async () => {
  const dataDir = path.join(testRoot, 'scope-api');
  await mkdir(dataDir, { recursive: true });
  const scope = new ProcessScope(dataDir);
  assert.match(scope.tag(), /^[a-f0-9]{64}$/);
  assert.equal(scope.tag(), new ProcessScope(dataDir).tag());
  const scoped = scope.environment({ PATH: process.env.PATH });
  assert.equal(scoped[PROCESS_SCOPE_ENV], scope.tag());

  const child = spawn('/bin/sleep', ['300'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...scoped },
  });
  child.unref();
  daemons.add(child.pid);
  await sleep(50);
  const members = await scope.members();
  const member = members.find(({ pid }) => pid === child.pid);
  assert.ok(member, 'the tagged process must be listed');
  assert.equal(member.start, procStart(child.pid), 'members must expose the /proc start time');
  await scope.terminate();
  assert.equal(await waitGone(child.pid), true);
  daemons.delete(child.pid);
});

test('dispose kills a settled setsid daemon carrying the manager tag', { skip: !linuxHost }, async () => {
  const { manager } = await installedManager('dispose');
  const pid = await startManagerDaemon(manager);
  assert.match(procEnv(pid).get('BIONILUX_PROCESS_SCOPE'), /^[a-f0-9]{64}$/);

  await manager.dispose();
  assert.equal(await waitGone(pid), true, 'dispose must terminate the tagged setsid daemon');
  daemons.delete(pid);
});

test('the tag is stable for a canonical dataDir and distinct for another', { skip: !linuxHost }, async () => {
  const first = await installedManager('stable-a');
  const command = "/bin/sh -c 'printf %s \"$BIONILUX_PROCESS_SCOPE\"'";
  const tagA = (await first.manager.execute({ command })).stdout.trim();
  assert.match(tagA, /^[a-f0-9]{64}$/);
  await first.manager.dispose();

  const restarted = createManager({
    dataDir: first.dataDir,
    arch: 'x64',
    downloadAsset: first.io.downloadAsset,
    extractArchive: first.io.extractArchive,
    runCommand: spawnCommand,
  });
  const tagRestarted = (await restarted.execute({ command })).stdout.trim();
  assert.equal(tagRestarted, tagA, 'a restarted owner must compute the same dataDir tag');
  await restarted.dispose();

  const other = await installedManager('stable-b');
  const tagB = (await other.manager.execute({ command })).stdout.trim();
  assert.match(tagB, /^[a-f0-9]{64}$/);
  assert.notEqual(tagB, tagA, 'different data directories need different tags');
  await other.manager.uninstall();
  await other.manager.dispose();
});

test('unrelated same-UID processes with another tag or no tag survive', { skip: !linuxHost }, async () => {
  const { manager } = await installedManager('unrelated');
  const otherTag = 'b'.repeat(64);
  const other = await startUnrelated({ BIONILUX_PROCESS_SCOPE: otherTag }, 'different-tag process');
  const untagged = await startUnrelated({ BIONILUX_PROCESS_SCOPE: '' }, 'untagged process');
  assert.equal(procEnv(other).get('BIONILUX_PROCESS_SCOPE'), otherTag);

  await manager.uninstall();
  assert.equal(alive(other), true, 'a different tag must not be treated as owned');
  assert.equal(alive(untagged), true, 'an untagged process must not be treated as owned');
  await killTracked(other);
  await killTracked(untagged);
  await manager.dispose();
});

async function spawnEscapedOwner(dataDir) {
  const pidFile = path.join(testRoot, 'restart-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const helper = path.join(testRoot, 'owner-' + Date.now() + '.mjs');
  const managerUrl = new URL('../modules/manager.js', import.meta.url).href;
  const source = [
    "import { createManager, spawnCommand } from " + JSON.stringify(managerUrl) + ';',
    "const manager = createManager({ dataDir: process.env.BN_OWNER_DATA, arch: 'x64', runCommand: spawnCommand });",
    'const status = manager.status();',
    "if (!status.healthy) throw new Error('owner fixture is unhealthy: ' + status.reason);",
    'const result = await manager.execute({ command: ' + JSON.stringify(daemonCommand(pidFile)) + ' });',
    "if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);",
    "process.stdout.write('ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  await writeFile(helper, source);
  const child = spawn(process.execPath, [helper], {
    env: { ...process.env, BN_OWNER_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 15_000;
  while (!stdout.includes('ready') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('owner exited early: ' + stderr);
    await sleep(25);
  }
  if (!stdout.includes('ready')) throw new Error('owner did not become ready: ' + stderr);
  const pid = Number(await waitForFile(pidFile));
  daemons.add(pid);
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(alive(pid), true, 'the daemon must outlive the SIGKILLed owner');
  return pid;
}

test('a restarted owner cleans the previous escaped daemon on dispose', { skip: !linuxHost }, async () => {
  const { manager, dataDir, fixtureManifest, io } = await installedManager('restart-dispose');
  await manager.dispose();
  const pid = await spawnEscapedOwner(dataDir);

  const restarted = createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: spawnCommand,
  });
  assert.equal(restarted.status().healthy, true);
  await restarted.dispose();
  assert.equal(await waitGone(pid), true, 'a new owner must clean the deterministic tag on dispose');
  daemons.delete(pid);
});

test('a restarted owner cleans the previous escaped daemon on install', { skip: !linuxHost }, async () => {
  const { manager, dataDir, fixtureManifest, io } = await installedManager('restart-install');
  await manager.dispose();
  const pid = await spawnEscapedOwner(dataDir);

  const restarted = createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: spawnCommand,
  });
  const status = await restarted.install(fixtureManifest.manifest, 'debian-minimal-x64');
  assert.equal(status.healthy, true, status.reason);
  assert.equal(await waitGone(pid), true, 'a new owner must clean the deterministic tag on install');
  daemons.delete(pid);
  await restarted.dispose();
});

test('a disposed old owner cannot kill the replacement owner daemon', { skip: !linuxHost }, async () => {
  const first = await installedManager('disposed-owner');
  const dataDir = first.dataDir;
  const fixtureManifest = first.fixtureManifest;
  await first.manager.dispose();

  const replacement = createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: first.io.downloadAsset,
    extractArchive: first.io.extractArchive,
    runCommand: spawnCommand,
  });
  assert.equal(replacement.status().healthy, true);
  const pid = await startManagerDaemon(replacement);

  // Repeated calls on the retired object must be inert: it no longer owns the
  // dataDir, even though its deterministic scope tag matches the replacement.
  await first.manager.dispose();
  assert.equal(alive(pid), true, 'old dispose must not kill the new owner daemon');
  const uninstalled = await first.manager.uninstall();
  assert.equal(uninstalled.state, 'disposed');
  assert.equal(alive(pid), true, 'old uninstall must not kill the new owner daemon');
  await assert.rejects(
    () => first.manager.install(fixtureManifest.manifest, 'debian-minimal-x64'),
    /manager is disposed/,
  );
  assert.equal(alive(pid), true, 'old install must not kill the new owner daemon');
  assert.equal(replacement.status().healthy, true, 'old calls must not remove the active record');

  await replacement.dispose();
  assert.equal(await waitGone(pid), true, 'the replacement owner must still kill its own daemon');
  daemons.delete(pid);
});
