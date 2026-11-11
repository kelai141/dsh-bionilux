import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(message);
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

test('parser snapshots are non-destructive and hide only matching protocol tails', () => {
  const marker = String.fromCharCode(30) + 'BIONILUX';
  const end = String.fromCharCode(31);
  const parser = new SessionProtocolParser(1024, 'snap');
  parser.begin();
  parser.push(marker + 'snap:BEGIN' + end);
  const output = 'prefix' + marker + 'different:END:literal';
  parser.push(output);
  assert.equal(parser.snapshot().stdout, output);
  assert.equal(parser.snapshot().stdout, output, 'a second snapshot must not append the tail again');
  parser.push(marker + 'snap:EN');
  assert.equal(parser.snapshot().stdout, output, 'a split matching frame must not leak into output');
  parser.push('D:0' + end + marker + 'snap:CWD:/' + end);
  assert.equal(parser.take().stdout.value, output, 'snapshot must not change normal completion');
});

test('snapshot output bounds preserve UTF-8 and distinguish a full prefix from truncation', () => {
  const marker = String.fromCharCode(30) + 'BIONILUX';
  const end = String.fromCharCode(31);
  const parser = new SessionProtocolParser(5, 'utf8');
  parser.begin();
  parser.push(marker + 'utf8:BEGIN' + end);
  parser.push('a😀');
  assert.equal(parser.snapshot().stdout, 'a😀');
  assert.equal(parser.snapshot().stdoutTruncated, false);
  parser.push('z');
  assert.equal(parser.snapshot().stdout, 'a😀');
  assert.equal(parser.snapshot().stdoutTruncated, true);

  const cut = new SessionProtocolParser(4, 'cut');
  cut.begin();
  cut.push(marker + 'cut:BEGIN' + end);
  cut.push('a😀');
  assert.equal(cut.snapshot().stdout, 'a');
  assert.ok(Buffer.byteLength(cut.snapshot().stdout) <= 4);
  assert.equal(cut.snapshot().stdoutTruncated, true);
});

test('session startup rechecks management after deferred host-path preparation', async (t) => {
  for (const state of ['pending', 'exclusive', 'disposed']) {
    await t.test(state, async () => {
      const { manager } = await makeManager();
      const session = new PersistentSession(manager, { id: 'admission-' + state });
      let prepared;
      let release;
      const entered = new Promise((resolve) => { prepared = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      manager._prepareHostPaths = async () => { prepared(); await wait; };
      // The launch must never reach spawn, even on a host without Bash.
      manager._sessionLaunch = () => ({ file: path.join(manager.dataDir, 'must-not-spawn'), args: [] });
      const opening = session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
      const rejected = assert.rejects(opening, /busy with a management operation/);
      await entered;
      assert.equal(session._child, null);
      assert.equal(manager.children.size, 0, 'management drains before the preparation completes');
      if (state === 'pending') manager.gate.pendingExclusive = 1;
      if (state === 'exclusive') manager.gate.exclusive = true;
      if (state === 'disposed') manager.disposed = true;
      release();
      await rejected;
      assert.equal(session._child, null, 'a late open must not spawn after the management drain');
      assert.equal(manager.children.size, 0);
      await session.close();
      await manager.dispose();
    });
  }
});

test('same-named sessions in separate registries never share or remove job files', { skip, timeout: 60_000 }, async (t) => {
  const { manager } = await makeManager();
  const first = new SessionRegistry(manager);
  const second = new SessionRegistry(manager);
  t.after(async () => { await first.dispose(); await second.dispose(); await manager.dispose(); });
  const started = await first.start('build', { command: 'printf owned-by-first' });
  const firstSession = first.sessions.get('build');
  const firstRoot = firstSession.jobRoot();
  const firstDirectory = firstSession._jobs.get(started.job).directory;
  const commandFile = path.join(firstDirectory, 'command.sh');
  const original = await readFile(commandFile, 'utf8');
  await second.open({ id: 'build' });
  const secondRoot = second.sessions.get('build').jobRoot();
  assert.notEqual(secondRoot, firstRoot, 'registry-local names must not define shared disk ownership');
  assert.equal(await readFile(commandFile, 'utf8'), original, 'opening the second shell must preserve the first job');
  const secondDirectory = path.join(secondRoot, 'owned-by-second');
  await mkdir(secondDirectory, { recursive: true });
  await writeFile(path.join(secondDirectory, 'output.log'), 'second');
  await second.close('build');
  assert.equal(existsSync(secondRoot), false, 'close removes only the second shell namespace');
  assert.equal(await readFile(commandFile, 'utf8'), original, 'closing the second shell must preserve the first job');
  let result;
  await waitFor(async () => { result = await first.poll('build', { job: started.job }); return result.finished; },
    'the first job must remain pollable after the second shell closes', 30_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'owned-by-first');
});

test('a background job that exits immediately is not reported as running', { skip, timeout: 60_000 }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const registry = new SessionRegistry(manager);
  const started = await registry.start('early', { command: 'printf early' });
  // Cold emulator launches under a concurrent analyzer took over five seconds.
  // Keep a bounded completion budget without weakening the finished/exit checks.
  const deadline = Date.now() + 30_000;
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

test('closing a session kills the job supervisor and its untagged descendants', { skip }, async (t) => {
  const { manager, rootfs } = await makeManager();
  const registry = new SessionRegistry(manager);
  t.after(async () => { await registry.dispose(); await manager.dispose(); });
  const pidFile = path.join(rootfs, 'tmp', 'orphan-check.pid');
  const shellPidFile = manager._sessionPathForShell(pidFile);
  const started = await registry.start('orphans', {
    // The producer starts a background child and then waits. That child is not
    // the job leader, so it must be found by the job's own process group.
    command: 'bash -c \'env -i /bin/bash -c "sleep 120" & echo $! > "$0"; wait\' ' + shellQuote(shellPidFile),
  });
  assert.notEqual(started.pid, null, 'the job supervisor pid is recorded');
  const descendant = await waitFor(async () => {
    const pid = Number.parseInt(await readFile(pidFile, 'utf8').catch(() => ''), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }, 'the descendant pid must be observable');
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

test('session ids are restricted and the real shell is used', { skip }, async (t) => {
  assert.throws(() => assertSessionId('../escape'), /session must be/);
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const registry = new SessionRegistry(manager);
  const opened = await registry.open({ id: 'build' });
  assert.equal(opened.session, 'build');
  assert.equal(opened.running, true);
  const result = await registry.run('build', { command: 'printf "%s" "$BASH_VERSION"' });
  assert.match(result.stdout, /^\d+\.\d+\.\d+/, 'the real shell must report its bash version');
  await registry.dispose();
  await manager.dispose();
});

test('a real bash session keeps cwd and exported variables and preserves streams', { skip }, async (t) => {
  const { manager, rootfs } = await makeManager();
  t.after(() => manager.dispose());
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

test('a background job can be polled by byte offset without replaying output', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
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

test('explicit shell exit returns the final output and actual status', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const registry = new SessionRegistry(manager);
  const result = await registry.run('exit', { command: 'printf final-tail; exit 7' });
  assert.equal(result.stdout, 'final-tail');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 7);
  assert.equal(result.sessionClosed, true);
  await registry.dispose();
  await manager.dispose();
});

test('timeout closes the session and leaves no tracked child', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
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

test('a timed out command returns the output it already produced', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const registry = new SessionRegistry(manager);
  const result = await registry.run('partial', {
    command: 'printf "half-built"; printf "compiler-stalled" >&2; sleep 30',
    timeoutMs: 1_500,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.sessionClosed, true);
  // The partial log is the only diagnostic a stuck command leaves behind; an
  // empty stdout here discarded the entire prefix the parser had retained.
  assert.equal(result.stdout, 'half-built');
  assert.equal(result.stdoutTruncated, false);
  assert.match(result.stderr, /compiler-stalled/);
  assert.match(result.stderr, /timed out after 1500 ms/);
  assert.equal(result.stderrTruncated, false);
  await registry.dispose();
  await manager.dispose();
});

test('a timeout keeps a truncated prefix and reports the truncation flag', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const session = new PersistentSession(manager, { id: 'trunc', maxOutputBytes: 16 });
  await session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
  const result = await session.run({
    command: 'printf "%s" "' + 'x'.repeat(4096) + '"; sleep 30',
    timeoutMs: 1_500,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout.length, 16);
  assert.equal(result.stdoutTruncated, true, 'the cut prefix must be flagged as truncated');
  await session.close();
  await manager.dispose();
});

test('closing a session rejects every queued run with an AbortError', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const session = new PersistentSession(manager, { id: 'abort' });
  await session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
  const running = session.run({ command: 'sleep 30' });
  const firstQueued = session.run({ command: 'printf queued-one' });
  const secondQueued = session.run({ command: 'printf queued-two' });
  // Observe every rejection before close so no rejection is ever unhandled.
  const outcome = (promise) => promise.then((value) => value, (error) => error);
  const runningOutcome = outcome(running);
  const firstOutcome = outcome(firstQueued);
  const secondOutcome = outcome(secondQueued);
  await waitFor(() => session._pending, 'the first command must be running before close');
  await session.close();

  const first = await firstOutcome;
  const second = await secondOutcome;
  for (const error of [first, second]) {
    assert.ok(error instanceof Error, 'a queued run must reject, not resolve');
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ERR_SESSION_CLOSED');
    assert.match(error.message, /closed/);
    assert.doesNotMatch(error.message, /is not running/, 'the abort must not look like a shell symptom');
  }
  // The command that was already running still reports the closed session.
  const settled = await runningOutcome;
  assert.equal(settled.sessionClosed, true);
  assert.equal(session._queueAborts.size, 0, 'aborting must clear the queue hooks');
  assert.equal(session._queued, 0, 'aborting must not leak queue accounting');
  await manager.dispose();
});

test('the run queue is bounded and rejects the overflow', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const session = new PersistentSession(manager, { id: 'cap', maxQueuedRuns: 2 });
  await session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
  const outcome = (promise) => promise.then((value) => value, (error) => error);
  const running = outcome(session.run({ command: 'sleep 30' }));
  await waitFor(() => session._pending, 'the first run must leave the queue');
  const first = outcome(session.run({ command: 'printf one' }));
  const second = outcome(session.run({ command: 'printf two' }));
  const rejected = await outcome(session.run({ command: 'printf overflow' }));
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /already has 2 queued commands/);
  assert.notEqual(rejected.name, 'AbortError', 'a queue overflow is not a session close');
  assert.equal(session._queued, 2, 'the limit counts waiting commands, not the active one');
  await session.close();
  assert.equal((await running).sessionClosed, true);
  for (const queued of [await first, await second]) assert.equal(queued.code, 'ERR_SESSION_CLOSED');
  assert.equal(session._queued, 0);
  assert.equal(session._queueAborts.size, 0);
});

test('a run on an already closed session is rejected as an abort', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const session = new PersistentSession(manager, { id: 'gone' });
  await session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
  await session.close();
  await assert.rejects(
    session.run({ command: 'printf late' }),
    (error) => error.name === 'AbortError' && error.code === 'ERR_SESSION_CLOSED',
  );
  await manager.dispose();
});

test('a failed job launch removes its internal tracking entry', { skip }, async (t) => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  t.after(async () => { await registry.dispose(); await manager.dispose(); });
  await registry.open({ id: 'leak' });
  const session = registry.sessions.get('leak');
  const initialCwd = (await session.run({ command: 'printf "%s" "$PWD"' })).stdout;
  await assert.rejects(
    // A missing directory makes the launch frame exit 125 before the job starts.
    registry.start('leak', { command: 'printf never', cwd: '/nonexistent-bionilux-launch' }),
  );
  assert.equal(session._jobsInternal.size, 0, 'a failed launch must not leak a tracked job');
  assert.equal(session._jobs.size, 0);
  assert.deepEqual(await readdir(session.jobRoot()), [], 'failed launch files must be removed');
  assert.equal(session.running, true, 'a bad launch cwd must not close the session shell');
  assert.equal((await session.run({ command: 'printf "%s" "$PWD"' })).stdout, initialCwd);
  const started = await registry.start('leak', { command: 'printf ok' });
  assert.equal(session._jobsInternal.size, 1);
  assert.ok(session._jobs.has(started.job));
  await registry.dispose();
  await manager.dispose();
});

test('concurrent job starts cannot overbook the limit and a completed slot is reusable', { skip, timeout: 60_000 }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
  const session = new PersistentSession(manager, { id: 'capacity', maxJobs: 1 });
  await session.open(manager.status().paths, { guestCwd: '/', hostPaths: [] });
  const starts = await Promise.allSettled([
    session.startJob({ command: 'sleep 1; printf first' }),
    session.startJob({ command: 'printf overbooked' }),
  ]);
  assert.equal(starts[0].status, 'fulfilled');
  assert.equal(starts[1].status, 'rejected');
  assert.match(starts[1].reason.message, /unfinished jobs/);
  assert.equal(session._jobs.size, 1);
  const firstJob = starts[0].value.job;
  await waitFor(async () => (await session.pollJob({ job: firstJob })).finished,
    'the first job must complete while its log remains pollable at the limit', 30_000);
  const second = await session.startJob({ command: 'printf second' });
  assert.equal(session._jobs.size, 1);
  assert.equal(session._jobsInternal.size, 1);
  assert.equal(session._jobs.has(firstJob), false);
  assert.equal(session._jobs.has(second.job), true);
  await session.close();
});

test('pruning completed jobs trims to the limit without deleting an extra one', async () => {
  const { manager } = await makeManager();
  const session = new PersistentSession(manager, { id: 'prune', maxJobs: 2 });
  const directories = [];
  for (let index = 0; index < 3; index += 1) {
    const directory = await tempDir();
    directories.push(directory);
    const job = {
      job: 'job' + index,
      pid: null,
      start: null,
      winpid: null,
      scope: null,
      offset: 0,
      size: 0,
      directory,
      logLimit: 1024,
      exitCode: 0,
      // The oldest job is pruned first; the newest is the one a client polls.
      finishedAt: Date.now() - (10 - index) * 1_000,
    };
    session._jobs.set(job.job, job);
    session._jobsInternal.add(job);
  }
  await session._pruneJobs();
  assert.equal(session._jobs.size, 2, 'trimming must stop exactly at maxJobs');
  assert.deepEqual([...session._jobs.keys()], ['job1', 'job2'], 'the oldest finished job goes first');
  assert.equal(session._jobsInternal.size, 2, 'the internal set must not keep pruned jobs');
  assert.deepEqual(
    [...session._jobsInternal].map((job) => job.job).sort(),
    ['job1', 'job2'],
    'the internal set must hold the same jobs as the public map',
  );
  assert.equal(existsSync(directories[0]), false, 'the pruned job directory must be removed');
  assert.equal(existsSync(directories[2]), true, 'a job inside the limit must be kept');
  await manager.dispose();
});

test('queue admission is bounded and closure never executes rejected waiters', async () => {
  const { manager } = await makeManager();
  const session = new PersistentSession(manager, { id: 'queue-unit', maxQueuedRuns: 2 });
  const executed = [];
  let release;
  session._run = (command) => {
    executed.push(command);
    return new Promise((resolve) => { release = resolve; });
  };
  const outcome = (promise) => promise.then((value) => value, (error) => error);
  const active = outcome(session.run({ command: 'active' }));
  await Promise.resolve();
  assert.deepEqual(executed, ['active']);
  const first = outcome(session.run({ command: 'queued-one' }));
  const second = outcome(session.run({ command: 'queued-two' }));
  await assert.rejects(session.run({ command: 'overflow' }), /already has 2 queued commands/);
  await session.close();
  for (const waiting of [await first, await second]) {
    assert.equal(waiting.name, 'AbortError');
    assert.equal(waiting.code, 'ERR_SESSION_CLOSED');
  }
  release({ sessionClosed: true });
  await active;
  await session._queue;
  assert.deepEqual(executed, ['active'], 'aborted frames must never reach the shell later');
  assert.equal(session._queued, 0);
  assert.equal(session._queueAborts.size, 0);
  await manager.dispose();
});

test('a slow close rejects late work before its job drain completes', async () => {
  const { manager } = await makeManager();
  const session = new PersistentSession(manager, { id: 'draining' });
  let release;
  const drain = new Promise((resolve) => { release = resolve; });
  session._stopJobs = () => drain;
  const closing = session.close();
  assert.equal(session.running, false);
  for (const request of [session.run({ command: 'printf late' }), session.startJob({ command: 'printf late' })]) {
    await assert.rejects(request, (error) => error.name === 'AbortError' && error.code === 'ERR_SESSION_CLOSED');
  }
  assert.equal(session._queued, 0);
  assert.equal(session._queueAborts.size, 0);
  release();
  await closing;
  await manager.dispose();
});

test('a rejected job launch removes its reserved bookkeeping and files', async () => {
  const { manager } = await makeManager();
  const session = new PersistentSession(manager, { id: 'rejected' });
  session._paths = manager.status().paths;
  const failure = new Error('injected launch rejection');
  session.run = async () => { throw failure; };
  await assert.rejects(session.startJob({ command: 'printf never' }), (error) => error === failure);
  assert.equal(session._jobsInternal.size, 0);
  assert.equal(session._jobs.size, 0);
  assert.deepEqual(await readdir(session.jobRoot()), []);
  await session.close();
  await manager.dispose();
});

test('polling at the job limit succeeds and only admission reserves a slot', async () => {
  const { manager } = await makeManager();
  const session = new PersistentSession(manager, { id: 'limit', maxJobs: 2 });
  const now = Date.now();
  const jobs = [];
  for (let index = 0; index < 2; index += 1) {
    const directory = await tempDir();
    await writeFile(path.join(directory, 'output.log'), 'done' + index);
    await writeFile(path.join(directory, 'status'), '0');
    const info = { job: String(index + 1).repeat(24), directory, logLimit: 1024, offset: 0, size: 0,
      finishedAt: now - (2 - index) * 100, exitCode: 0 };
    session._jobs.set(info.job, info);
    session._jobsInternal.add(info);
    jobs.push(info);
  }
  const poll = await session.pollJob({ job: jobs[1].job });
  assert.equal(poll.stdout, 'done1');
  assert.equal(poll.finished, true);
  assert.equal(session._jobs.size, 2, 'a poll must not reserve a new launch slot');
  await session._pruneJobs({ reserve: 1 });
  assert.deepEqual([...session._jobs.keys()], [jobs[1].job]);
  assert.equal(session._jobsInternal.size, 1);
  assert.equal(existsSync(jobs[0].directory), false);
  jobs[1].finishedAt = null;
  const unfinished = { job: '3'.repeat(24), directory: await tempDir(), finishedAt: null };
  session._jobs.set(unfinished.job, unfinished);
  session._jobsInternal.add(unfinished);
  await assert.rejects(session._pruneJobs({ reserve: 1 }), /unfinished jobs/);
  await session._pruneJobs();
  assert.equal(session._jobs.size, 2, 'poll pruning must not reject a full live-job map');
  await manager.dispose();
});

test('registry availability awaits real runtime verification and fails closed', async () => {
  const { manager } = await makeManager();
  const registry = new SessionRegistry(manager);
  let release;
  manager.verify = () => new Promise((resolve) => { release = resolve; });
  let settled = false;
  const pending = registry._assertAvailable().finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'cached structural status must not bypass verification');
  release({ ...manager.status(), healthy: false, reason: 'external commands failed' });
  await assert.rejects(pending, /external commands failed/);
  await registry.dispose();
  await manager.dispose();
});

test('dispose closes every live session, and tool registration owns its registry', { skip }, async (t) => {
  const { manager } = await makeManager();
  t.after(() => manager.dispose());
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
