import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertSessionId,
  PersistentSession,
  SessionProtocolParser,
  SessionRegistry,
  shellQuote,
} from '../modules/session.js';
import { registerLinuxBash } from '../lib/index.js';

const windows = process.platform === 'win32';
const bashCandidates = windows
  ? [process.env.BIONILUX_TEST_BASH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
  : ['/bin/bash'];
const bash = bashCandidates.find((candidate) => candidate && existsSync(candidate));
const skip = bash ? false : 'a real bash is required for session integration tests';

const roots = [];

async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bionilux-session-'));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * A manager double that keeps the production fields sessions depend on: the
 * child set, process scope, disposal flag, execution environment and gate. The
 * shell itself is a real bash process.
 */
async function makeManager() {
  const dataDir = await tempDir();
  const rootfs = path.join(dataDir, 'rootfs');
  await mkdir(path.join(rootfs, 'bin'), { recursive: true });
  await mkdir(path.join(rootfs, 'tmp'), { recursive: true });
  const manager = {
    dataDir,
    disposed: false,
    children: new Set(),
    gate: { exclusive: false, pendingExclusive: 0 },
    processScope: { environment: (environment) => environment },
    _executionEnvironment(_paths, cwdInfo) {
      return {
        ...process.env,
        BIONILUX_GUEST_CWD: cwdInfo.guestCwd,
        PATH: process.env.PATH,
      };
    },
    _resolveCwd(cwd) {
      if (cwd == null || cwd === '') return { guestCwd: '/', hostPaths: [] };
      if (!path.isAbsolute(cwd)) throw new TypeError('cwd must be an absolute path');
      return { guestCwd: cwd, hostPaths: [] };
    },
    _sessionLaunch(paths) {
      return { file: bash, args: ['--noprofile', '--norc', '-s'] };
    },
    _sessionPathForShell(hostPath) {
      if (!windows) return hostPath;
      return hostPath.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replaceAll('\\', '/');
    },
    status() {
      return {
        healthy: !this.disposed,
        reason: 'test manager',
        runtimeId: 'debian-minimal-test',
        paths: {
          rootfs,
          launcher: bash,
          node: path.join(dataDir, 'node'),
        },
      };
    },
    async dispose() {
      this.disposed = true;
      await Promise.allSettled([...this.children].map((child) => child.abort?.()));
      this.children.clear();
    },
  };
  return { manager, rootfs };
}

function realSession(manager) {
  return new PersistentSession(manager, { id: 'real', maxOutputBytes: 64 * 1024 });
}

function runBash(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, ['--noprofile', '--norc', '-c', command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', () => resolve(output));
  });
}

test('the parser returns stdout without a trailing newline and ignores framing', () => {
  const nonce = 'abc123';
  const parser = new SessionProtocolParser(1024, nonce);
  assert.equal(parser.push('noise'), false);
  parser.push('\u001eBIONILUXabc123:READY\u001f');
  assert.equal(parser.phase, 'idle');
  parser.begin();
  parser.push('\u001eBIONILUXabc123:BEGIN\u001f');
  parser.push('exact bytes');
  parser.push('\u001eBIONILUXabc123:END:7\u001f\u001eBIONILUXabc123:CWD:/work\u001f');
  assert.equal(parser.phase, 'done');
  const result = parser.take();
  assert.equal(result.stdout.value, 'exact bytes');
  assert.equal(result.exitCode, 7);
  assert.equal(result.cwd, '/work');
});

test('the parser keeps a bounded buffer when a command never emits a marker', () => {
  const parser = new SessionProtocolParser(8, 'n');
  parser.phase = 'body';
  parser.current = { stdout: { value: '', truncated: false }, stderr: { value: '', truncated: false } };
  parser.push('x'.repeat(100_000));
  assert.ok(parser.buffer.length < 4096, 'unflushed tail must stay bounded');
  assert.equal(parser.current.stdout.truncated, true);
  assert.equal(Buffer.byteLength(parser.current.stdout.value), 8);
});

test('an invalid exit-status frame is rejected', () => {
  const parser = new SessionProtocolParser(1024, 'bad');
  parser.push('\u001eBIONILUXbad:READY\u001f');
  parser.begin();
  parser.push('\u001eBIONILUXbad:BEGIN\u001f');
  assert.throws(() => parser.push('\u001eBIONILUXbad:END:oops\u001f'), /bad exit status/);
});

test('the parser accepts an exit status and cwd split across chunks', () => {
  const parser = new SessionProtocolParser(1024, 'split');
  parser.push('\u001eBIONILUXsplit:READY\u001f');
  parser.begin();
  parser.push('\u001eBIONILUXsplit:BEGIN\u001f');
  parser.push('payload\u001eBIONILUXsplit:END:');
  assert.equal(parser.phase, 'body');
  parser.push('42\u001f\u001eBIONILUXsplit:CWD:');
  assert.equal(parser.phase, 'cwd');
  assert.equal(parser.push('/' + 'x'.repeat(3000)), false, 'a long cwd must be kept, not trimmed');
  assert.equal(parser.push('\u001f'), true);
  const result = parser.take();
  assert.equal(result.exitCode, 42);
  assert.equal(result.cwd, '/' + 'x'.repeat(3000));
  assert.equal(result.stdout.value, 'payload');
});

test('a background job that exits immediately is not reported as running', { skip }, async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  const started = await registry.start('early', { command: 'printf early' });
  const deadline = Date.now() + 5_000;
  let poll = await registry.poll('early', { job: started.job });
  while (!poll.finished && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    poll = await registry.poll('early', { job: started.job, offset: poll.nextOffset });
  }
  assert.equal(poll.finished, true);
  assert.equal(poll.running, false, 'a reaped supervisor must not answer signal 0 as running');
  assert.equal(poll.exitCode, 0);
  await registry.dispose();
  await manager.dispose();
});

test('closing a session kills the job supervisor and its untagged descendants', { skip }, async () => {
  const { manager, rootfs } = await makeManager();
  const registry = new SessionRegistry(manager);
  const pidFile = path.join(rootfs, 'tmp', 'orphan-check.pid');
  const started = await registry.start('orphans', {
    // The producer starts a background child and then waits. That child is not
    // the job leader, so it must be found by the job's own process group.
    command: 'bash -c \'env -i /bin/bash -c "sleep 120" & echo $! > "$0"; wait\' ' + shellQuote(pidFile),
    // A small Windows shutdown window makes the cleanup path deterministic.
    ...(windows ? { timeoutMs: 20_000 } : {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.notEqual(started.pid, null, 'the job supervisor pid is recorded');
  const descendant = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => ''), 10);
  assert.ok(Number.isInteger(descendant), 'the descendant pid must be observable');
  // `kill(pid, 0)` succeeds for a zombie. On Linux, read the state field so a
  // reaped-but-not-yet-collected process counts as stopped; a live process with
  // its original PID still counts as a failure.
  const alive = async () => {
    const probe = await runBash(
      '[ -r /proc/' + descendant + '/stat ] || { printf gone; exit; }; ' +
      'stat=$(cat /proc/' + descendant + '/stat 2>/dev/null) || { printf gone; exit; }; ' +
      'state=${stat##*) }; case "$state" in Z*|X*) printf gone ;; *) printf alive ;; esac',
    );
    return /alive/.test(probe);
  };
  assert.equal(await alive(), true, 'the descendant must still be running before close');
  await registry.close('orphans');
  // A killed process can stay visible as a zombie until its new parent reaps
  // it. Wait for that state transition; a live process keeps failing the check.
  for (let attempt = 0; attempt < 20 && await alive(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await registry.dispose();
  await manager.dispose();
  assert.equal(await alive(), false, 'closing the session must kill every job descendant');
});

test('session ids are restricted and the real shell is used', { skip }, async () => {
  assert.throws(() => assertSessionId('../escape'), /session must be/);
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  const opened = await registry.open({ id: 'build' });
  assert.equal(opened.session, 'build');
  assert.equal(opened.running, true);
  const result = await registry.run('build', { command: 'printf "%s" "$BASH_VERSION"' });
  assert.match(result.stdout, /^\d+\.\d+\.\d+/, 'the real shell must report its bash version');
  await registry.dispose();
  await manager.dispose();
});

test('a real bash session keeps cwd and exported variables and preserves streams', { skip }, async () => {
  const { manager, rootfs } = await makeManager();
  const registry = new SessionRegistry(manager);
  const work = path.join(rootfs, 'tmp', 'work');
  await mkdir(work, { recursive: true });

  const first = await registry.run('build', { command: 'export BUILT=yes; cd ' + JSON.stringify(work) + '; printf "no newline"' });
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout, 'no newline', 'stdout must be returned exactly');
  assert.equal(first.cwd.endsWith('/tmp/work') || first.cwd.endsWith('\\tmp\\work'), true);

  const second = await registry.run('build', { command: 'printf "%s|%s" "$BUILT" "$PWD"' });
  assert.equal(second.stdout, 'yes|' + first.cwd, 'state must survive the previous call');

  const ordered = await registry.run('build', { command: 'printf out1; printf err1 >&2; printf out2; (exit 9)' });
  assert.equal(ordered.stdout, 'out1out2');
  assert.equal(ordered.stderr, 'err1');
  assert.equal(ordered.exitCode, 9);
  assert.equal(ordered.timedOut, false);
  assert.equal(ordered.sessionClosed, false);
  assert.equal(ordered.running, true);

  await registry.dispose();
  await manager.dispose();
});

test('a background job can be polled by byte offset without replaying output', { skip }, async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  const started = await registry.start('jobs', {
    // Each write is followed by a stop so the poll below can prove incremental
    // reads without depending on stdbuf availability on the host.
    command: 'sleep 0.4; printf first; sleep 1.2; printf second; sleep 1.2; exit 3',
  });
  assert.match(started.job, /^[a-f0-9]{24}$/);
  // The job's own exit status must be the build status, not the status of a
  // successful tail of the log.
  let early = await registry.poll('jobs', { job: started.job, offset: 0, limitBytes: 5 });
  const firstOutputDeadline = Date.now() + 5_000;
  while (early.stdout === '' && Date.now() < firstOutputDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    early = await registry.poll('jobs', { job: started.job, offset: 0, limitBytes: 5 });
  }
  assert.equal(early.stdout, 'first');
  assert.equal(early.nextOffset, 5);

  let poll = early;
  let collected = early.stdout;
  const deadline = Date.now() + 8_000;
  while (!poll.finished && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    poll = await registry.poll('jobs', { job: started.job, offset: poll.nextOffset });
    collected += poll.stdout;
  }
  assert.equal(poll.finished, true);
  assert.equal(poll.exitCode, 3);
  assert.equal(collected, 'firstsecond', 'offsets must not duplicate bytes');

  const empty = await registry.poll('jobs', { job: started.job, offset: poll.nextOffset });
  assert.equal(empty.stdout, '');
  assert.equal(empty.nextOffset, poll.nextOffset);
  await registry.dispose();
  await manager.dispose();
});

test('explicit shell exit returns the final output and actual status', { skip }, async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  const result = await registry.run('exit', { command: 'printf final-tail; exit 7' });
  assert.equal(result.stdout, 'final-tail');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 7);
  assert.equal(result.sessionClosed, true);
  await registry.dispose();
  await manager.dispose();
});

test('timeout closes the session and leaves no tracked child', { skip }, async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  await registry.open({ id: 'slow' });
  const started = Date.now();
  const result = await registry.run('slow', { command: 'sleep 30', timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.sessionClosed, true);
  assert.ok(Date.now() - started < 8_000, 'timeout must be bounded');
  assert.equal(manager.children.size, 0, 'the dead session must leave the child set');
  assert.deepEqual(registry.list(), []);
  await registry.dispose();
  await manager.dispose();
});

test('dispose closes every live session, and tool registration owns its registry', { skip }, async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  await registry.open({ id: 'a' });
  await registry.open({ id: 'b' });
  assert.equal(manager.children.size, 2);
  await registry.dispose();
  assert.equal(manager.children.size, 0);
  assert.deepEqual(registry.list(), []);

  const tools = [];
  const ctx = { tools: { register: (tool) => { tools.push(tool); return () => {}; } } };
  const dispose = registerLinuxBash(ctx, manager);
  assert.deepEqual(tools.map((tool) => tool.name), ['linux_bash', 'linux_session']);
  const open = await tools[1].execute({ action: 'open', session: 'tool' });
  assert.equal(open.running, true);
  const run = await tools[0].execute({ session: 'tool', command: 'printf "via tool"' });
  assert.equal(run.stdout, 'via tool');
  const listed = await tools[1].execute({ action: 'list' });
  assert.equal(listed.sessions.length, 1);
  dispose();
  await manager.dispose();
});
