/**
 * Device acceptance for the Linux runtime manager.
 *
 * This file is copied into a private Android fixture and run by the guest Node
 * behind the patched Bionilux launcher. It deliberately uses the real
 * spawnCommand implementation, so every "process exited" assertion is backed by
 * a PID and a /proc observation rather than by a mock runner.
 *
 * Layout expected by the harness (BN_MANAGER_FIXTURE, or three levels above
 * this file):
 *
 *   fixture/backend/bin/bionilux
 *   fixture/backend/lib/libbionilux_preload.so
 *   fixture/backend/scripts/prepare-rootfs.sh
 *   fixture/rootfs/...
 *   fixture/node/bin/node
 *   fixture/node/lib/node_modules/npm/
 *
 * Results are written to logs/manager-device-result.json. A failing assertion
 * still writes the observations collected before the failure.
 *
 * The manager module is imported from the repository path by default. Set
 * BN_MANAGER_MODULE when this file is copied into a private device fixture with
 * a different module layout.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const managerOverride = process.env.BN_MANAGER_MODULE;
const managerUrl = managerOverride
  ? managerOverride.startsWith('.')
    ? new URL(managerOverride, import.meta.url).href
    : pathToFileURL(path.resolve(managerOverride)).href
  : new URL('../../packages/linux-runtime/modules/manager.js', import.meta.url).href;
const { createManager, spawnCommand } = await import(managerUrl);
const fixtureRoot = process.env.BN_MANAGER_FIXTURE ?? path.resolve(here, '../../..');
const fixture = path.join(fixtureRoot, 'fixture');
const logs = path.join(fixtureRoot, 'logs');
const expectedUid = Number(process.env.BN_EXPECT_UID ?? process.getuid?.() ?? -1);
const stage = process.argv[2] ?? '--all';
const observations = [];
const startedAt = new Date().toISOString();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

function escapedChildSource() {
  return [
    "const {spawn}=require('child_process');",
    "const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    'c.unref();',
    'console.log(c.pid);',
  ].join('');
}

function nodeEvalCommand(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return "/usr/bin/node -e 'eval(Buffer.from(\"" + encoded + "\",\"base64\").toString())'";
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(name, detail, extra = {}) {
  observations.push({
    name,
    actual: true,
    procUid: extra.procUid ?? expectedUid,
    detail,
    ...extra,
  });
}

function asset(kind, body = 'archive:' + kind) {
  const bytes = Buffer.from(body);
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

function manifest(version) {
  const backend = asset('bionilux-backend-x64', 'backend:' + version);
  const rootfs = asset('debian-minimal-x64', 'rootfs:' + version);
  const node = asset('node-glibc-x64', 'node:stable');
  return {
    bytes: { backend: backend.bytes, rootfs: rootfs.bytes, node: node.bytes },
    value: {
      schemaVersion: 1,
      version,
      minMobileVersion: '0.14.0',
      plugins: {
        bootstrap: asset('linux-bootstrap-plugin').value,
        runtime: asset('linux-runtime-plugin').value,
      },
      runtimes: [
        {
          id: 'debian-minimal-x64',
          label: 'Debian minimal x64 fixture',
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

function makeIo({ slowExtract = false } = {}) {
  const extractionStarted = [];
  let extractSlowly = slowExtract;
  const bytesBySha = new Map();
  for (const version of ['1.0.0', '1.1.0', '2.0.0', '3.0.0']) {
    for (const kind of ['bionilux-backend-x64', 'debian-minimal-x64', 'node-glibc-x64']) {
      const value = asset(kind, kind === 'bionilux-backend-x64'
        ? 'backend:' + version
        : kind === 'debian-minimal-x64'
          ? 'rootfs:' + version
          : 'node:stable');
      bytesBySha.set(value.value.sha256, value.bytes);
    }
  }
  return {
    extractionStarted,
    setSlowExtract(value) {
      extractSlowly = Boolean(value);
    },
    downloadAsset: async (value, destination) => {
      const bytes = bytesBySha.get(value.sha256);
      if (!bytes) throw new Error('fixture has no bytes for ' + value.url);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    },
    extractArchive: async (_archive, destination, { kind } = {}) => {
      extractionStarted.push({ kind, at: now() });
      if (extractSlowly) {
        await fs.writeFile(path.join(logs, 'slow-install-marker.json'), JSON.stringify({
          pid: process.pid,
          kind,
          at: new Date().toISOString(),
        }));
        await sleep(120_000);
      }
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(path.join(fixture, kind), destination, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    },
  };
}

function makeManager(dataDir, options = {}) {
  const io = makeIo(options);
  const manager = createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: spawnCommand,
  });
  return { manager, io };
}

async function waitForFile(file, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + file);
}

function procState(pid) {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    const state = /^State:\s+(\w)/m.exec(status)?.[1];
    return { alive: true, uid: uid == null ? undefined : Number(uid), state };
  } catch (error) {
    if (error?.code === 'ENOENT') return { alive: false };
    throw error;
  }
}

function procEnvironment(pid) {
  const values = new Map();
  for (const entry of readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0')) {
    const index = entry.indexOf('=');
    if (index > 0) values.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return values;
}

async function waitForEnvironment(pid, name, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = procEnvironment(pid).get(name);
      if (value !== undefined) return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
    await sleep(25);
  }
  return undefined;
}

async function waitGone(pid, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  let last = procState(pid);
  while (Date.now() < deadline) {
    last = procState(pid);
    if (!last.alive) return last;
    await sleep(25);
  }
  return last;
}

async function guestNode(manager, source) {
  const result = await manager.execute({
    command: nodeEvalCommand(source),
    timeout: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

async function checkGuestIdentity(manager, status) {
  const procUidFile = path.join(status.paths.rootfs, 'tmp', 'proc-uid.txt');
  const result = await guestNode(
    manager,
    "const fs=require('fs');fs.writeFileSync('/tmp/proc-uid.txt',fs.readFileSync('/proc/self/status','utf8'));console.log(JSON.stringify({pid:process.pid,uid:process.getuid(),node:process.version}))",
  );
  const info = JSON.parse(result.stdout.trim());
  const procUid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(procUidFile, 'utf8'))?.[1]);
  assert.equal(info.uid, 0, 'the guest identity is virtual root by design');
  assert.equal(procUid, expectedUid, '/proc must report the app UID');
  record('guest-node-identity', info, {
    procUid,
    pid: info.pid,
    fakeRootUid: info.uid,
  });
}

async function foregroundCutover() {
  const dataDir = path.join(fixtureRoot, 'data-main');
  await fs.rm(dataDir, { recursive: true, force: true });
  const { manager, io } = makeManager(dataDir);
  const installed = await manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);
  await checkGuestIdentity(manager, installed);

  const pidFile = path.join(installed.paths.rootfs, 'tmp', 'foreground.pid');
  const running = manager.execute({
    command: nodeEvalCommand('require("fs").writeFileSync("/tmp/foreground.pid",String(process.pid));setInterval(()=>{},1000)'),
    timeout: 60_000,
  });
  const pid = Number((await waitForFile(pidFile)).trim());
  const before = procState(pid);
  assert.equal(before.alive, true, 'the foreground guest process must be running');
  assert.equal(before.uid, expectedUid);
  record('foreground-process-running', 'pid ' + pid + ' is ' + before.state, { procUid: before.uid, pid });

  const oldRootfs = installed.paths.rootfs;
  io.extractionStarted.length = 0;
  const installing = manager.install(manifest('1.1.0').value);
  const executeResult = await running;
  const executeSettledAt = now();
  const installedNext = await installing;
  const firstExtractAt = io.extractionStarted[0]?.at;
  assert.ok(
    executeResult.signal || executeResult.exitCode !== 0,
    'management aborts the in-flight command',
  );
  assert.ok(firstExtractAt != null, 'the replacement was staged');
  assert.ok(
    executeSettledAt <= firstExtractAt,
    'the child exited at ' + executeSettledAt + ' but extraction began at ' + firstExtractAt,
  );
  assert.equal(installedNext.healthy, true, installedNext.reason);
  assert.equal(existsSync(oldRootfs), false, 'the retired rootfs must be gone');
  const gone = await waitGone(pid);
  assert.equal(gone.alive, false, 'the foreground process must be reaped before the cutover');
  record(
    'foreground-killed-before-rootfs-mutation',
    'pid ' + pid + ' exited before first extraction; old rootfs removed',
    { procUid: before.uid, pid, executeSettledAt, firstExtractAt },
  );

  await manager.dispose();
  return { dataDir };
}

async function backgroundResidual() {
  const dataDir = path.join(fixtureRoot, 'data-background');
  await fs.rm(dataDir, { recursive: true, force: true });
  const { manager } = makeManager(dataDir);
  const installed = await manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);

  const result = await manager.execute({
    command:
      '/bin/sh -c \'/usr/bin/node -e "process.on(\"SIGHUP\",()=>{});setInterval(()=>{},1000)" >/dev/null 2>&1 & echo $!\'',
    timeout: 30_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, 'unexpected background pid: ' + result.stdout);
  const alive = procState(pid);
  assert.equal(alive.alive, true, 'the shell leaves its background child running');
  record('background-child-running', 'pid ' + pid + ' is ' + alive.state, { procUid: alive.uid, pid });

  const uninstalled = await manager.uninstall();
  assert.equal(uninstalled.installed, false);
  const after = await waitGone(pid);
  const survived = after.alive;
  if (survived) {
    // Do not leave the fixture behind while the assertion is being reported.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  assert.equal(
    survived,
    false,
    'background pid ' + pid + ' survived uninstall (state ' + (after.state ?? 'unknown') + ')',
  );
  record('background-child-killed-before-uninstall', 'pid ' + pid + ' exited', {
    procUid: alive.uid,
    pid,
  });
  await manager.dispose();
}

async function overlappingManager() {
  const dataDir = path.join(fixtureRoot, 'data-overlap');
  await fs.rm(dataDir, { recursive: true, force: true });
  const { manager, io } = makeManager(dataDir);
  const installed = await manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);

  const pidFile = path.join(installed.paths.rootfs, 'tmp', 'overlap.pid');
  const running = manager.execute({
    command: nodeEvalCommand('require("fs").writeFileSync("/tmp/overlap.pid",String(process.pid));setInterval(()=>{},1000)'),
    timeout: 60_000,
  });
  const pid = Number((await waitForFile(pidFile)).trim());
  const before = procState(pid);
  assert.equal(before.alive, true);

  const reloadedUrl = managerUrl + (managerUrl.includes('?') ? '&' : '?') + 'reload=' + Date.now();
  const reloaded = await import(reloadedUrl);
  let rejected;
  assert.throws(
    () =>
      reloaded.createManager({
        dataDir,
        arch: 'x64',
        downloadAsset: io.downloadAsset,
        extractArchive: io.extractArchive,
        runCommand: spawnCommand,
      }),
    (error) => {
      rejected = error;
      return error.code === 'ERR_RUNTIME_MANAGER_IN_USE' && /dispose it before/.test(error.message);
    },
  );
  assert.equal(procState(pid).alive, true, 'the rejected owner must not stop the existing session');

  await manager.dispose();
  const result = await running;
  assert.ok(result.signal || result.exitCode !== 0);
  const gone = await waitGone(pid);
  assert.equal(gone.alive, false);

  const replacement = reloaded.createManager({
    dataDir,
    arch: 'x64',
    downloadAsset: io.downloadAsset,
    extractArchive: io.extractArchive,
    runCommand: spawnCommand,
  });
  const status = replacement.status();
  assert.equal(status.healthy, true, status.reason);
  const echo = await replacement.execute({ command: 'echo owner-released' });
  assert.equal(echo.exitCode, 0);
  assert.match(echo.stdout, /owner-released/);
  await replacement.dispose();
  record('overlapping-manager-rejected', rejected.message, {
    procUid: before.uid,
    pid,
    errorCode: rejected.code,
    freshModule: true,
    ownerReleasedAfterDispose: true,
  });
}

async function dispose() {
  const dataDir = path.join(fixtureRoot, 'data-dispose');
  await fs.rm(dataDir, { recursive: true, force: true });
  const { manager } = makeManager(dataDir);
  const installed = await manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);
  const pidFile = path.join(installed.paths.rootfs, 'tmp', 'dispose.pid');
  const running = manager.execute({
    command: nodeEvalCommand('require("fs").writeFileSync("/tmp/dispose.pid",String(process.pid));setInterval(()=>{},1000)'),
    timeout: 60_000,
  });
  const pid = Number((await waitForFile(pidFile)).trim());
  const before = procState(pid);
  assert.equal(before.alive, true);
  await manager.dispose();
  const result = await running;
  const after = await waitGone(pid);
  assert.ok(result.signal || result.exitCode !== 0, 'dispose aborts the command');
  assert.equal(after.alive, false, 'dispose left pid ' + pid + ' running');
  record('dispose-kills-guest-session', 'pid ' + pid + ' exited on dispose', {
    procUid: before.uid,
    pid,
  });
}

async function escapedSession() {
  const dataDir = path.join(fixtureRoot, 'data-escaped');
  await fs.rm(dataDir, { recursive: true, force: true });
  const { manager } = makeManager(dataDir);
  const installed = await manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);

  // A child that creates its own session leaves the launcher's process group.
  // The process-scope scan must still find it by the deterministic env tag.
  const detachedSource = [
    "const {spawn}=require('child_process');",
    "const c=spawn('/usr/bin/node',['-e','process.on(\"SIGHUP\",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    'c.unref();',
    'console.log(c.pid);',
  ].join('');
  const result = await guestNode(manager, detachedSource);
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, 'escaped pid: ' + result.stdout);
  const alive = procState(pid);
  assert.equal(alive.alive, true);
  const tag = await waitForEnvironment(pid, 'BIONILUX_PROCESS_SCOPE');
  assert.match(tag, /^[a-f0-9]{64}$/, 'the daemon must carry the manager tag');

  // env -i removes the logical environment. The final2 preload caches the
  // scope tag privately and re-establishes it for the exec, so the raw /proc
  // environment still exposes the tag to process scope.
  const clearedSource = [
    "const {spawn}=require('child_process');",
    "const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});",
    'c.unref();',
    'console.log(c.pid);',
  ].join('');
  const cleared = await manager.execute({
    command: 'env -i ' + nodeEvalCommand(clearedSource),
    timeout: 30_000,
  });
  assert.equal(cleared.exitCode, 0, cleared.stderr || cleared.stdout);
  const clearedPid = Number(cleared.stdout.trim());
  assert.ok(Number.isInteger(clearedPid) && clearedPid > 1, 'env -i escaped pid: ' + cleared.stdout);
  const clearedAlive = procState(clearedPid);
  assert.equal(clearedAlive.alive, true);
  assert.equal(
    await waitForEnvironment(clearedPid, 'BIONILUX_PROCESS_SCOPE'),
    tag,
    'the cached tag must remain visible in /proc after env -i',
  );

  const sleepBinary = existsSync('/system/bin/sleep') ? '/system/bin/sleep' : '/bin/sleep';
  const guardian = spawn(sleepBinary, ['300'], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH },
  });
  guardian.unref();
  await sleep(100);
  assert.equal(procState(guardian.pid).alive, true);
  assert.equal(procEnvironment(guardian.pid).get('BIONILUX_PROCESS_SCOPE'), undefined);

  await manager.uninstall();
  const gone = await waitGone(pid, 6_000);
  const clearedGone = await waitGone(clearedPid, 6_000);
  if (gone.alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  if (clearedGone.alive) {
    try {
      process.kill(clearedPid, 'SIGKILL');
    } catch {}
  }
  assert.equal(gone.alive, false, 'escaped session pid ' + pid + ' survived uninstall');
  assert.equal(clearedGone.alive, false, 'env -i escaped session pid ' + clearedPid + ' survived uninstall');
  assert.equal(procState(guardian.pid).alive, true, 'untagged same-UID guardian must survive');
  record('escaped-session-killed-before-uninstall', 'pid ' + pid + ' was terminated', {
    procUid: alive.uid,
    pid,
    expected: 'dead',
  });
  record('escaped-env-i-session-killed-before-uninstall', 'pid ' + clearedPid + ' was terminated', {
    procUid: clearedAlive.uid,
    pid: clearedPid,
    expected: 'dead',
    envCleared: true,
  });
  record('untagged-guardian-survives-uninstall', 'pid ' + guardian.pid + ' survived', {
    pid: guardian.pid,
    expected: 'alive',
  });
  try {
    process.kill(guardian.pid, 'SIGKILL');
  } catch {}
  await manager.dispose();
}

async function restartOwnerCleanup() {
  const dataDir = path.join(fixtureRoot, 'data-restart');
  await fs.rm(dataDir, { recursive: true, force: true });
  const first = makeManager(dataDir);
  const installed = await first.manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);
  await first.manager.dispose();

  const pidFile = path.join(logs, 'restart-daemon.pid');
  await fs.rm(pidFile, { force: true });
  const helper = path.join(logs, 'restart-owner.mjs');
  const helperSource = [
    "import { promises as fs } from 'node:fs';",
    'import { createManager, spawnCommand } from ' + JSON.stringify(managerUrl) + ';',
    "const manager = createManager({ dataDir: process.env.BN_OWNER_DATA, arch: 'x64', runCommand: spawnCommand });",
    'const status = manager.status();',
    "if (!status.healthy) throw new Error('owner fixture is unhealthy: ' + status.reason);",
    'const result = await manager.execute({ command: ' +
      JSON.stringify(nodeEvalCommand(escapedChildSource())) + ' });',
    "if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);",
    'const pid = Number(result.stdout.trim());',
    'await fs.writeFile(process.env.BN_OWNER_PIDFILE, String(pid));',
    "process.stdout.write('ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  await fs.writeFile(helper, helperSource);

  const owner = spawn(process.execPath, [helper], {
    env: { ...process.env, BN_OWNER_DATA: dataDir, BN_OWNER_PIDFILE: pidFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  owner.stdout.setEncoding('utf8');
  owner.stderr.setEncoding('utf8');
  owner.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  owner.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  while (!stdout.includes('ready') && Date.now() < deadline) {
    if (owner.exitCode != null) throw new Error('owner exited early: ' + stderr);
    await sleep(25);
  }
  if (!stdout.includes('ready')) throw new Error('owner did not become ready: ' + stderr);
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  const before = procState(pid);
  assert.equal(before.alive, true);

  owner.kill('SIGKILL');
  await once(owner, 'exit');
  assert.equal(procState(pid).alive, true, 'the escaped daemon must outlive the killed owner');

  const restarted = makeManager(dataDir);
  const status = restarted.manager.status();
  assert.equal(status.healthy, true, status.reason);
  await restarted.manager.dispose();
  const gone = await waitGone(pid, 6_000);
  const survived = gone.alive;
  if (survived) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    await waitGone(pid);
  }
  assert.equal(survived, false, 'a restarted owner left escaped pid ' + pid + ' running');
  record('restarted-owner-cleans-escaped-daemon', 'pid ' + pid + ' was terminated by the next owner', {
    procUid: before.uid,
    pid,
    ownerKilled: true,
  });
}

async function interruptedSlowInstall() {
  const dataDir = path.join(fixtureRoot, 'data-interrupted');
  await fs.rm(dataDir, { recursive: true, force: true });
  const first = makeManager(dataDir);
  const installed = await first.manager.install(manifest('1.0.0').value);
  assert.equal(installed.healthy, true, installed.reason);
  const before = readFileSync(path.join(dataDir, 'active.json'), 'utf8');
  await fs.writeFile(path.join(logs, 'interrupted-before.json'), before);

  // This manager is killed by the host orchestrator once slow-install-marker.json
  // appears. Everything before that point is a real install.
  first.io.setSlowExtract(true);
  await first.manager.install(manifest('2.0.0').value);
  throw new Error('slow install was expected to be killed before activation');
}

async function verifyInterrupted() {
  const dataDir = path.join(fixtureRoot, 'data-interrupted');
  const manager = makeManager(dataDir, { version: '3.0.0' });
  const status = manager.manager.status();
  assert.equal(status.healthy, true, status.reason);
  assert.equal(status.version, '1.0.0', 'the interrupted install must not activate');
  const active = readFileSync(path.join(dataDir, 'active.json'), 'utf8');
  assert.equal(active, readFileSync(path.join(logs, 'interrupted-before.json'), 'utf8'));
  const echo = await manager.manager.execute({ command: 'echo interrupted-recovered' });
  assert.equal(echo.exitCode, 0);
  assert.match(echo.stdout, /interrupted-recovered/);
  const recovered = await manager.manager.install(manifest('3.0.0').value);
  assert.equal(recovered.healthy, true, recovered.reason);
  assert.equal(recovered.version, '3.0.0');
  record('interrupted-install-restored', 'previous ' + status.version + ' stayed active; retry reached ' + recovered.version, {
    activeUnchanged: true,
  });
  await manager.manager.dispose();
}

async function run() {
  await fs.mkdir(logs, { recursive: true });
  let failure;
  try {
    if (stage === '--slow-install') {
      await interruptedSlowInstall();
    } else if (stage === '--verify-interrupted') {
      await verifyInterrupted();
    } else if (stage === '--background') {
      await backgroundResidual();
    } else if (stage === '--escaped') {
      await escapedSession();
    } else if (stage === '--overlap') {
      await overlappingManager();
    } else if (stage === '--restart') {
      await restartOwnerCleanup();
    } else {
      await foregroundCutover();
      await overlappingManager();
      await backgroundResidual();
      await dispose();
      await escapedSession();
      await restartOwnerCleanup();
    }
  } catch (error) {
    failure = { name: error?.name, message: error?.message, stack: error?.stack };
  }
  const report = {
    stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    transport: 'actual-patched-launcher',
    syntheticDownload: true,
    productionAssetOrInstallValidation: false,
    knownLimitations: [
      'process-scope matches only readable exact env tags for the same real UID; unreadable or missing tags are not treated as owned',
      'worker threads or isolated VM contexts do not share the manager owner registry',
      'this is lifecycle cleanup, not a security containment boundary',
    ],
    expectedUid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    observations,
    failure,
    passed: failure == null,
  };
  const suffix = stage === '--all' ? '' : stage;
  await fs.writeFile(
    path.join(logs, 'manager-device-result' + suffix + '.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}

await run();
