import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const MARKER = '\u001eBIONILUX';
const FRAME_END = '\u001f';
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_JOB_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_JOBS = 16;
const DEFAULT_MAX_QUEUED_RUNS = 64;
const DEFAULT_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 600_000;
const CLOSE_SETTLE_MS = 2_000;
const SIGTERM_GRACE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 10_000;
const JOB_SCOPE_ENV = 'BIONILUX_SESSION_JOB';
const PROC_SCOPES = process.platform === 'linux' || process.platform === 'android';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const shellQuote = (value) => `'` + String(value).replaceAll("'", "'\\''") + `'`;

function statFields(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  return stat.slice(end + 1).trim().split(/\s+/);
}

function procStarttime(stat) {
  return statFields(stat)?.[19] ?? null;
}

function procGroupAlive(job) {
  if (!job.pid || !job.start) return false;
  try {
    const stat = readFileSync(`/proc/${job.pid}/stat`, 'utf8');
    const fields = statFields(stat);
    return Boolean(
      fields &&
        fields[19] === job.start &&
        Number(fields[2]) === job.pid &&
        !['Z', 'X', 'x'].includes(fields[0]),
    );
  } catch {
    return false;
  }
}

function killWindowsTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

/**
 * The shell reports an MSYS pid while taskkill needs the Windows pid. Git Bash
 * exposes that mapping as /proc/<msys-pid>/winpid; without it a PID from `$!`
 * must never be sent to taskkill, because it could name an unrelated process.
 */
function windowsPid(shell, msysPid) {
  if (!shell || !Number.isInteger(msysPid)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const probe = spawn(shell, ['--noprofile', '--norc', '-c', `cat /proc/${msysPid}/winpid 2>/dev/null`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => probe.kill(), 1_000);
    timer.unref?.();
    probe.stdout?.setEncoding('utf8');
    probe.stdout?.on('data', (chunk) => { output += chunk; });
    probe.once('error', () => { clearTimeout(timer); resolve(null); });
    probe.once('close', () => {
      clearTimeout(timer);
      const pid = Number.parseInt(output.trim(), 10);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Every surviving process whose environment carries this job's exact tag. */
async function taggedProcesses(scope) {
  if (!PROC_SCOPES) return [];
  const expected = JOB_SCOPE_ENV + '=' + scope;
  const members = [];
  for (const name of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const pid = Number(name);
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = statFields(stat);
      if (!fields || fields.length < 20 || ['Z', 'X', 'x'].includes(fields[0])) continue;
      const environment = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
      if (!environment.split('\0').includes(expected)) continue;
      const confirm = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      if (procStarttime(confirm) !== fields[19]) continue;
      members.push({ pid, start: fields[19] });
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    }
  }
  return members;
}

/** Run one short shell command in the session's guest launcher. */
function shellCommand(file, command, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(file, ['--noprofile', '--norc', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.once('error', (error) => { clearTimeout(timer); resolve({ stdout, stderr, error }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

/** Session names are also used in diagnostics and tool arguments. */
export function assertSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new TypeError('session must be 1-64 characters: letters, digits, dot, underscore or dash');
  }
  return value;
}

function assertJobId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{16,64}$/.test(value)) {
    throw new TypeError('job must be a hexadecimal identifier returned by start');
  }
  return value;
}

/**
 * A queued command that never ran because the session closed must not look like
 * a command failure: the caller needs to know the install aborted its work.
 */
function sessionClosedError(id) {
  const error = new Error(
    'session ' + id + ' was closed; the queued command was aborted before it ran',
  );
  error.name = 'AbortError';
  error.code = 'ERR_SESSION_CLOSED';
  return error;
}

function appendBounded(buffer, text, limit) {
  if (buffer.truncated || text.length === 0) return;
  const remaining = limit - Buffer.byteLength(buffer.value);
  if (remaining <= 0) {
    buffer.truncated = true;
    return;
  }
  const bytes = Buffer.from(text);
  if (bytes.length <= remaining) {
    buffer.value += text;
    return;
  }
  // Do not turn a partial UTF-8 character into a replacement character whose
  // encoded size can exceed the byte budget.
  let end = remaining;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  buffer.value += bytes.subarray(0, end).toString('utf8');
  buffer.truncated = true;
}

/**
 * Raw marker parser.
 *
 * Markers are control-character-prefixed byte strings, not lines, so a command
 * that writes no trailing newline returns exactly what it wrote. Retained
 * output is bounded; only enough tail is kept to detect a marker split across
 * chunks.
 */
export class SessionProtocolParser {
  constructor(limit, nonce) {
    this.limit = limit;
    this.nonce = nonce;
    this.beginMarker = `${MARKER}${nonce}:BEGIN${FRAME_END}`;
    this.endPrefix = `${MARKER}${nonce}:END:`;
    this.cwdPrefix = `${MARKER}${nonce}:CWD:`;
    this.readyMarker = `${MARKER}${nonce}:READY${FRAME_END}`;
    this.phase = 'ready';
    this.buffer = '';
    this.current = null;
    this.tailReserve = Math.max(this.endPrefix.length, this.cwdPrefix.length, this.beginMarker.length) + 32;
  }

  get waitingForReady() {
    return this.phase === 'ready';
  }

  begin() {
    this.current = {
      stdout: { value: '', truncated: false },
      stderr: { value: '', truncated: false },
      exitCode: null,
      cwd: null,
    };
    this.phase = 'begin';
    this.buffer = '';
  }

  push(text) {
    this.buffer += text;
    for (;;) {
      if (this.phase === 'ready') {
        const index = this.buffer.indexOf(this.readyMarker);
        if (index < 0) {
          this._trim(this.readyMarker.length);
          return false;
        }
        this.buffer = this.buffer.slice(index + this.readyMarker.length);
        this.phase = 'idle';
        return false;
      }
      if (this.phase === 'idle' || this.phase === 'done') {
        this._trim(this.tailReserve);
        return false;
      }
      if (this.phase === 'begin') {
        const index = this.buffer.indexOf(this.beginMarker);
        if (index < 0) {
          this._trim(this.beginMarker.length);
          return false;
        }
        this.buffer = this.buffer.slice(index + this.beginMarker.length);
        this.phase = 'body';
        continue;
      }
      if (this.phase === 'body') {
        const index = this.buffer.indexOf(this.endPrefix);
        if (index < 0) {
          this._flushBody();
          return false;
        }
        appendBounded(this.current.stdout, this.buffer.slice(0, index), this.limit);
        const statusStart = index + this.endPrefix.length;
        const end = this.buffer.indexOf(FRAME_END, statusStart);
        if (end < 0) {
          // Keep the END prefix itself until its status and terminator arrive.
          // Consuming it early made a chunk split inside the status permanent.
          this.buffer = this.buffer.slice(index);
          if (this.buffer.length > this.tailReserve + 32) {
            throw new Error('invalid session frame: unterminated exit status');
          }
          return false;
        }
        const status = this.buffer.slice(statusStart, end);
        if (!/^-?\d+$/.test(status)) throw new Error('invalid session frame: bad exit status');
        this.buffer = this.buffer.slice(end + FRAME_END.length);
        this.current.exitCode = Number(status);
        this.phase = 'cwd';
        continue;
      }
      if (this.phase === 'cwd') {
        const index = this.buffer.indexOf(this.cwdPrefix);
        if (index < 0) {
          this._trim(this.tailReserve);
          return false;
        }
        const pathStart = index + this.cwdPrefix.length;
        const end = this.buffer.indexOf(FRAME_END, pathStart);
        if (end < 0) {
          // A long working directory may exceed the marker tail reserve. Keep
          // it intact up to the guest PATH_MAX instead of dropping its prefix.
          if (index > 0) this.buffer = this.buffer.slice(index);
          if (this.buffer.length > 4096 + this.cwdPrefix.length + 1) {
            throw new Error('invalid session frame: working directory is too long');
          }
          return false;
        }
        this.current.cwd = this.buffer.slice(pathStart, end);
        this.buffer = this.buffer.slice(end + FRAME_END.length);
        this.phase = 'done';
        return true;
      }
      return false;
    }
  }

  _trim(keep) {
    if (this.buffer.length <= keep) return;
    this.buffer = this.buffer.slice(-keep);
  }

  _flushBody() {
    if (!this.current) return;
    if (this.buffer.length <= this.tailReserve) return;
    const flush = this.buffer.slice(0, this.buffer.length - this.tailReserve);
    appendBounded(this.current.stdout, flush, this.limit);
    this.buffer = this.buffer.slice(-this.tailReserve);
  }

  pushStderr(text) {
    if (this.current) appendBounded(this.current.stderr, text, this.limit);
  }

  take() {
    const current = this.current;
    this.current = null;
    return current;
  }

  /**
   * Everything the parser has interpreted so far, without ending the command.
   * A timeout closes the session mid-body, and the already parsed prefix is the
   * only diagnostic the caller has left. The body tail still buffered for
   * marker detection is appended for the same reason.
   */
  snapshot() {
    const current = {
      stdout: { ...(this.current?.stdout ?? { value: '', truncated: false }) },
      stderr: { ...(this.current?.stderr ?? { value: '', truncated: false }) },
      exitCode: this.current?.exitCode ?? null,
      cwd: this.current?.cwd ?? null,
    };
    if (this.phase === 'body' && this.buffer.length > 0) {
      // Only this command's END frame is protocol data. Marker-like text from
      // the command is still output; a snapshot must not consume or duplicate it.
      let end = this.buffer.indexOf(this.endPrefix);
      if (end < 0) {
        end = this.buffer.length;
        for (let size = Math.min(this.buffer.length, this.endPrefix.length - 1); size > 0; size -= 1) {
          if (this.buffer.endsWith(this.endPrefix.slice(0, size))) {
            end -= size;
            break;
          }
        }
      }
      appendBounded(current.stdout, this.buffer.slice(0, end), this.limit);
    }
    return {
      stdout: current.stdout.value,
      stderr: current.stderr.value,
      exitCode: Number.isInteger(current.exitCode) ? current.exitCode : null,
      cwd: current.cwd ?? null,
      stdoutTruncated: current.stdout.truncated,
      stderrTruncated: current.stderr.truncated,
    };
  }
}

function readyFrame(nonce) {
  return "printf '%s' '" + MARKER + nonce + ':READY' + FRAME_END + "'\n";
}

function commandFrame(marker, command, cwd) {
  const heredoc = '__BIONILUX_CMD_' + marker + '__';
  const lines = ["printf '%s' '" + marker + ':BEGIN' + FRAME_END + "'", 'set +e'];
  if (cwd) lines.push('cd -- ' + shellQuote(cwd));
  lines.push(
    '__bionilux_cd_status=$?',
    'if [ "$__bionilux_cd_status" -eq 0 ]; then',
    "__bionilux_command=$(cat <<'" + heredoc + "'",
    command,
    heredoc,
    ')',
    'if [ -n "$__bionilux_command" ]; then',
    '  eval "$__bionilux_command" </dev/null',
    '  __bionilux_cd_status=$?',
    'fi',
    'fi',
    "printf '%s:%s" + FRAME_END + "' '" + marker + ":END' \"$__bionilux_cd_status\"",
    "printf '%s:%s" + FRAME_END + "' '" + marker + ":CWD' \"$PWD\"",
  );
  return lines.join('\n') + '\n';
}

function makeNonce(command) {
  for (;;) {
    const nonce = randomBytes(12).toString('hex');
    if (!command.includes(nonce)) return nonce;
  }
}

/**
 * One persistent guest shell.
 *
 * The shell is non-interactive bash reading framed commands from stdin. It
 * keeps exported variables and the working directory between calls. It is not
 * a PTY: full-screen programs, job control and terminal resizing remain
 * unsupported. The process is registered with the manager child set so install,
 * uninstall and dispose terminate it before replacing the rootfs.
 */
export class PersistentSession {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.id = assertSessionId(options.id);
    this.maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    this.maxJobBytes = options.maxJobBytes || DEFAULT_MAX_JOB_BYTES;
    this.maxJobs = options.maxJobs || DEFAULT_MAX_JOBS;
    this.maxQueuedRuns = options.maxQueuedRuns || DEFAULT_MAX_QUEUED_RUNS;
    this.jobRetentionMs = options.jobRetentionMs || DEFAULT_JOB_RETENTION_MS;
    this.onExit = options.onExit;
    this.closed = false;
    this._closeRequested = false;
    this.exit = undefined;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
    this._queue = Promise.resolve();
    // One abort hook per admitted but not yet started run, so close() can reject
    // the queue at once instead of letting each task discover the dead shell.
    this._queueAborts = new Set();
    this._queued = 0;
    this._pending = null;
    this._child = null;
    this._killTimer = undefined;
    this._parser = null;
    this._ready = false;
    this._register = null;
    this._readyTimer = undefined;
    this._readyResolve = undefined;
    this._readyReject = undefined;
    this._paths = undefined;
    this._cwd = null;
    this._sharedPaths = [];
    this._jobs = new Map();
    this._jobsInternal = new Set();
    this._jobStartQueue = Promise.resolve();
  }

  get running() {
    return !this.closed && !this._closeRequested && Number.isInteger(this._child?.pid);
  }

  get pid() {
    return this.running ? this._child.pid : null;
  }

  jobRoot() {
    if (!this._paths?.rootfs) return null;
    return path.join(this._paths.rootfs, 'tmp', '.bionilux-sessions', this.id);
  }

  _shellPath(hostPath) {
    if (typeof this.manager._sessionPathForShell === 'function') {
      return this.manager._sessionPathForShell(hostPath);
    }
    const relative = path.relative(this._paths.rootfs, hostPath).split(path.sep).join('/');
    return '/' + relative;
  }

  info() {
    return {
      session: this.id,
      running: this.running,
      pid: this.pid,
      cwd: this._cwd ?? null,
      exitCode: this.exit?.exitCode ?? null,
      jobs: [...this._jobs.keys()],
    };
  }

  _frameMarker(command) {
    for (;;) {
      const marker = MARKER + makeNonce(command);
      if (!command.includes(marker)) return marker;
    }
  }

  async open(paths, cwdInfo) {
    if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
    if (this.manager.disposed || this.manager.gate.exclusive || this.manager.gate.pendingExclusive > 0) {
      throw new Error('Linux runtime is busy with a management operation; session was not opened');
    }
    // Two open() calls for one name must share the same startup. Returning the
    // second caller early exposed a child that had not answered READY yet.
    if (this._opening) return this._opening;
    if (this._child) return this;
    const opening = this._open(paths, cwdInfo);
    this._opening = opening;
    try {
      return await opening;
    } finally {
      if (this._opening === opening) this._opening = undefined;
    }
  }

  async _open(paths, cwdInfo) {
    this._paths = paths;
    this._sharedPaths = [...(cwdInfo.sharedPaths ?? [])];
    if (typeof this.manager._prepareHostPaths === 'function') {
      await this.manager._prepareHostPaths(paths.rootfs, cwdInfo.hostPaths);
    }
    this._cwd = cwdInfo.guestCwd;
    // A session name is unique in the registry, so its job root can be reset
    // without touching another live session's outputs.
    const root = this.jobRoot();
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
    const nonce = randomBytes(12).toString('hex');
    this._parser = new SessionProtocolParser(this.maxOutputBytes, nonce);
    const environment = this.manager._executionEnvironment(paths, cwdInfo);
    const launch =
      typeof this.manager._sessionLaunch === 'function'
        ? this.manager._sessionLaunch(paths)
        : { file: paths.launcher, args: ['/bin/bash', '--noprofile', '--norc', '-s'] };
    this._shellExecutable = launch.file;
    let child;
    try {
      child = spawn(launch.file, launch.args, {
        cwd: this.manager.dataDir,
        env: this.manager.processScope.environment(environment),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this._finish({ exitCode: null, signal: null, error });
      throw error;
    }
    this._child = child;
    // spawn() reports some launch failures asynchronously. A missing executable
    // can still leave stdout/stderr null, so every stream is guarded.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('data', (chunk) => this._onStdout(chunk));
    child.stderr?.on('data', (chunk) => this._onStderr(chunk));
    const processPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        this._finish({ exitCode: null, signal: null, error });
        resolve({ exitCode: null, signal: null, error });
      });
      child.once('close', (code, signal) => {
        this._finish({ exitCode: Number.isInteger(code) ? code : null, signal: signal ?? null });
        resolve({ exitCode: code, signal });
      });
    });
    this._register = {
      abort: () => this.close(),
      cancel: () => this._terminate('SIGTERM'),
      forceKill: () => this._terminate('SIGKILL'),
      promise: processPromise,
    };
    // Register synchronously after spawn: an earlier management drain was
    // rejected above, and a later drain sees this child and aborts it.
    this.manager.children.add(this._register);
    try {
      // Write READY first, then wait for it. Waiting before writing deadlocks
      // until the startup timeout.
      if (!child.stdin) throw new Error(`session ${this.id} was started without a command channel`);
      child.stdin.write(readyFrame(nonce));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`session ${this.id} did not become ready`)),
          STARTUP_TIMEOUT_MS,
        );
        timer.unref?.();
        this._readyTimer = timer;
        this._readyResolve = resolve;
        this._readyReject = reject;
      });
      this._ready = true;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    return this;
  }

  _onStdout(chunk) {
    if (!this._parser) return;
    let complete;
    try {
      complete = this._parser.push(String(chunk));
    } catch (error) {
      // A malformed frame cannot be skipped without losing the stream framing.
      // Fail the one command and close the shell instead of hanging forever.
      this._completeRun({ protocolError: error });
      void this.close();
      return;
    }
    if (this._parser.phase !== 'ready' && !this._ready) {
      this._ready = true;
      if (this._readyTimer) clearTimeout(this._readyTimer);
      this._readyTimer = undefined;
      this._readyResolve?.();
      this._readyResolve = undefined;
      this._readyReject = undefined;
    }
    if (complete) this._completeRun();
  }

  _onStderr(chunk) {
    this._parser?.pushStderr(String(chunk));
  }

  _completeRun(extra = {}) {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    const parsed = this._parser.take() ?? {
      stdout: { value: '', truncated: false },
      stderr: { value: '', truncated: false },
      exitCode: null,
      cwd: null,
    };
    if (parsed.cwd) this._cwd = parsed.cwd;
    if (extra.protocolError) {
      pending.resolve({
        stdout: parsed.stdout.value,
        stderr: [parsed.stderr.value, extra.protocolError.message].filter(Boolean).join('\n'),
        exitCode: null,
        signal: null,
        timedOut: false,
        sessionClosed: true,
        stdoutTruncated: parsed.stdout.truncated,
        stderrTruncated: parsed.stderr.truncated,
        cwd: this._cwd,
        session: this.id,
        running: false,
      });
      return;
    }
    pending.resolve({
      stdout: parsed.stdout.value,
      stderr: parsed.stderr.value,
      exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : extra.exitCode ?? null,
      signal: extra.signal ?? null,
      timedOut: Boolean(extra.timedOut || pending.timedOut),
      sessionClosed: Boolean(extra.sessionClosed),
      stdoutTruncated: parsed.stdout.truncated,
      stderrTruncated: parsed.stderr.truncated,
      cwd: this._cwd,
      session: this.id,
      running: this.running,
    });
  }

  _finish(extra = {}) {
    if (this.closed) return;
    this.closed = true;
    // Every closure path (timeout, dispose drain, explicit close, shell death)
    // lands here, so queued commands are rejected once and immediately.
    this._abortQueuedRuns();
    this.exit = extra;
    if (this._killTimer) clearTimeout(this._killTimer);
    this._killTimer = undefined;
    if (this._register) this.manager.children.delete(this._register);
    this._register = null;
    if (this._readyTimer) clearTimeout(this._readyTimer);
    this._readyTimer = undefined;
    const readyError = new Error(`session ${this.id} exited before it was ready`);
    this._readyReject?.(readyError);
    this._readyReject = undefined;
    this._readyResolve = undefined;
    const pending = this._pending;
    this._pending = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      const partial = this._parser?.snapshot();
      this._parser = null;
      pending.resolve({
        stdout: partial?.stdout ?? '',
        stderr: [partial?.stderr, Number.isInteger(extra.exitCode) ? '' : 'session exited before the command completed']
          .filter(Boolean)
          .join('\n'),
        exitCode: Number.isInteger(extra.exitCode) ? extra.exitCode : null,
        signal: extra.signal ?? null,
        timedOut: Boolean(pending.timedOut),
        sessionClosed: true,
        stdoutTruncated: partial?.stdoutTruncated ?? false,
        stderrTruncated: partial?.stderrTruncated ?? false,
        cwd: this._cwd,
        session: this.id,
        running: false,
      });
    }
    const exit = { ...extra, session: this.id };
    this._resolveExit(exit);
    this._exitPromise = Promise.resolve(exit);
    try {
      this.onExit?.(this);
    } catch {
      // Registry bookkeeping must not keep a dead process in the child set.
    }
  }

  _terminate(signal) {
    const child = this._child;
    if (!child || this.closed) return;
    try {
      if (!Number.isInteger(child.pid)) return;
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    if (signal !== 'SIGKILL' && !this._killTimer) {
      this._killTimer = setTimeout(() => this._terminate('SIGKILL'), SIGTERM_GRACE_MS);
      this._killTimer.unref?.();
    }
  }

  run({ command, cwd, timeoutMs } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    if (this.closed || this._closeRequested) return Promise.reject(sessionClosedError(this.id));
    const maxQueued = Number.isInteger(this.maxQueuedRuns) && this.maxQueuedRuns > 0
      ? this.maxQueuedRuns
      : DEFAULT_MAX_QUEUED_RUNS;
    if (this._queued >= maxQueued) {
      return Promise.reject(
        new Error(
          'session ' + this.id + ' already has ' + this._queued + ' queued commands; wait for the running one before queueing more',
        ),
      );
    }
    this._queued += 1;
    let aborted = false;
    let abort;
    const rejection = new Promise((_resolve, reject) => {
      abort = reject;
    });
    // The queued run must not become an unhandled rejection before it is awaited.
    rejection.catch(() => undefined);
    const admit = () => {
      // An aborted run must never reach the shell afterwards: the session is
      // gone, and its rejection would be unobserved.
      if (aborted) return undefined;
      this._queueAborts.delete(hook);
      this._queued -= 1;
      return this._run(command, cwd, timeoutMs);
    };
    const hook = (error) => {
      aborted = true;
      abort(error);
    };
    this._queueAborts.add(hook);
    const task = Promise.race([this._queue.then(admit), rejection]);
    this._queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Reject every run that was queued but had not started. Their replies are
   * AbortError/ERR_SESSION_CLOSED, not "session is not running": a management
   * operation closed the session, and the caller must see that abort instead of
   * a shell symptom that looks like a command failure.
   */
  _abortQueuedRuns() {
    if (this._queueAborts.size === 0) return;
    const aborts = [...this._queueAborts];
    this._queueAborts.clear();
    this._queued = Math.max(0, this._queued - aborts.length);
    for (const abort of aborts) abort(sessionClosedError(this.id));
    this._queue = Promise.resolve();
  }

  async _run(command, cwd, timeoutMs) {
    if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
    if (!this._child) throw new Error(`session ${this.id} is not running`);
    if (this._pending) throw new Error(`session ${this.id} is busy`);
    const marker = this._frameMarker(command);
    const nonce = marker.slice(MARKER.length);
    this._parser = new SessionProtocolParser(this.maxOutputBytes, nonce);
    this._parser.phase = 'idle';
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const pending = { nonce, resolve: finish, reject, timedOut: false };
      this._pending = pending;
      this._parser.begin();
      const timer = setTimeout(() => {
        // A command that outlives its timeout cannot be interrupted without
        // losing the framing (the shell may be inside the guest process), so
        // terminate the whole session and report that it is gone.
        const timedOut = this._pending;
        this._pending = null;
        if (timedOut?.timer) clearTimeout(timedOut.timer);
        // Capture what the command already produced before close() tears the
        // shell down. A stuck long build's partial log is the only diagnostic
        // the caller gets, so an empty stdout here was a real data loss.
        const partial = this._parser?.snapshot() ?? {
          stdout: '',
          stderr: '',
          exitCode: null,
          cwd: null,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
        const note = `command timed out after ${timeout} ms; the session was closed`;
        void this.close({ timedOut: true }).then(() => {
          finish({
            stdout: partial.stdout,
            stderr: [partial.stderr, note].filter(Boolean).join('\n'),
            exitCode: null,
            signal: null,
            timedOut: true,
            sessionClosed: true,
            stdoutTruncated: partial.stdoutTruncated,
            stderrTruncated: partial.stderrTruncated,
            cwd: this._cwd,
            session: this.id,
            running: false,
          });
        });
      }, timeout);
      timer.unref?.();
      pending.timer = timer;
      try {
        this._child.stdin.write(commandFrame(marker, command, cwd));
      } catch (error) {
        clearTimeout(timer);
        this._pending = null;
        reject(error);
      }
    });
  }

  /**
   * Start a command in the background without changing the session's own cwd
   * or environment. Output is kept in a bounded log so poll() can return new
   * bytes without replaying the whole build.
   */
  startJob(options = {}) {
    // Serialize admission, not execution: concurrent callers must not all see
    // the same free slot before their asynchronous launch frames complete.
    const task = this._jobStartQueue.then(() => this._startJob(options));
    this._jobStartQueue = task.catch(() => undefined);
    return task;
  }

  async _startJob({ command, cwd } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
    const root = this.jobRoot();
    if (!root) throw new Error('session has no guest rootfs to store job output');
    await this._pruneJobs({ reserve: 1 });
    if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
    const job = randomBytes(12).toString('hex');
    const directory = path.join(root, job);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, 'command.sh'), command + '\n', { mode: 0o700 });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const guestDir = this._shellPath(directory);
    const logLimit = Number.isFinite(this.maxJobBytes) && this.maxJobBytes > 0 ? this.maxJobBytes : DEFAULT_MAX_JOB_BYTES;
    const scope = 'session-' + this.id + ':' + job;
    const status = shellQuote(guestDir + '/status');
    const statusTmp = shellQuote(guestDir + '/status.tmp');
    const output = shellQuote(guestDir + '/output.log');
    const script = shellQuote(guestDir + '/command.sh');
    // The producer is line buffered, and head is unbuffered because its stdout
    // is the job log file. The trailing cat drains the rest so reaching the log
    // cap does not SIGPIPE the build. pipefail keeps the producer's failure as
    // the pipeline status even though the drain succeeds.
    const drain = 'stdbuf -o0 head -c ' + logLimit + '; cat > /dev/null; ';
    const inner =
      'set -o pipefail; ' +
      'if command -v stdbuf >/dev/null 2>&1; then stdbuf -oL -eL bash ' + script + ' 2>&1' +
      ' | { ' + drain + '}; else bash ' + script + ' 2>&1 | { head -c ' + logLimit + '; cat > /dev/null; }; fi' +
      '; __bionilux_status=$?; printf "%s\\n" "$__bionilux_status" > ' + statusTmp + ' && mv ' + statusTmp + ' ' + status;
    // Run the job supervisor in its own session and process group. The guest
    // launcher may otherwise leave descendants in the parent shell's group,
    // where closing the shell would signal them before they can be verified.
    const supervisor =
      'if command -v setsid >/dev/null 2>&1; then exec env ' + JOB_SCOPE_ENV + '=' + shellQuote(scope) +
      ' setsid bash -c ' + shellQuote(inner) + '; else exec env ' + JOB_SCOPE_ENV + '=' + shellQuote(scope) +
      ' bash -c ' + shellQuote(inner) + '; fi';
    const launch = [
      // Isolate launch-only cd/exit from the persistent session shell.
      process.platform === 'win32' ? '( set -m;' : '( set +m;',
      cwd ? 'cd -- ' + shellQuote(cwd) + ' || exit 125' : '',
      'mkdir -p ' + shellQuote(guestDir) + ' || exit 125',
      // Job control gives the job its own process group, including descendants
      // that clear their environment (for example `env -i`). Without it a
      // non-interactive shell leaves the job in the session shell's group.
      '  ( ' + supervisor + ' ) > ' + output + ' 2>&1 </dev/null &',
      '  __bionilux_job_pid=$!',
      '  printf "%s\\n" "$__bionilux_job_pid" > ' + shellQuote(guestDir + '/pid'),
      // Git Bash exposes the Windows pid before the supervisor can exit. This
      // is the only safe handle for taskkill /T; a bare `$!` is an MSYS pid.
      '  cat /proc/$__bionilux_job_pid/winpid > ' + shellQuote(guestDir + '/winpid') + ' 2>/dev/null || :',
      ')',
    ]
      .filter(Boolean)
      .join('\n');
    const jobInfo = {
      job,
      pid: null,
      start: null,
      winpid: null,
      scope,
      offset: 0,
      size: 0,
      directory,
      logLimit,
      exitCode: null,
      finishedAt: null,
    };
    // Track before the launch frame: shutdown must also see in-flight starts.
    this._jobsInternal.add(jobInfo);
    const readIdentity = async () => {
      const pid = await fs.readFile(path.join(directory, 'pid'), 'utf8').then(
        (value) => Number.parseInt(value.trim(), 10), () => null,
      );
      jobInfo.pid = Number.isInteger(pid) && pid > 0 ? pid : null;
      jobInfo.start = PROC_SCOPES && jobInfo.pid
        ? await fs.readFile(`/proc/${jobInfo.pid}/stat`, 'utf8').then(procStarttime, () => null)
        : null;
      const winpid = await fs.readFile(path.join(directory, 'winpid'), 'utf8').then(
        (value) => Number.parseInt(value.trim(), 10), () => null,
      );
      jobInfo.winpid = Number.isInteger(winpid) && winpid > 0 ? winpid : null;
    };
    try {
      const result = await this.run({ command: launch });
      await readIdentity();
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `session ${this.id} could not start the job (exit ${result.exitCode})`);
      }
      if (this.closed || this._closeRequested) throw sessionClosedError(this.id);
      this._jobs.set(job, jobInfo);
      return {
        session: this.id,
        job,
        pid: jobInfo.pid,
        running: true,
        launchExitCode: result.exitCode,
        launchStderr: result.stderr,
      };
    } catch (error) {
      // run() can reject before a frame is admitted too. Never leak its files or
      // bookkeeping; stop any producer that did start before discarding identity.
      await readIdentity();
      await this._stopJobs([jobInfo]);
      this._jobs.delete(job);
      this._jobsInternal.delete(jobInfo);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async _pruneJobs({ reserve = 0 } = {}) {
    const maxJobs = Number.isInteger(this.maxJobs) && this.maxJobs > 0 ? this.maxJobs : DEFAULT_MAX_JOBS;
    const retention = Number.isFinite(this.jobRetentionMs) && this.jobRetentionMs > 0
      ? this.jobRetentionMs
      : DEFAULT_JOB_RETENTION_MS;
    const finished = [...this._jobs.values()]
      .filter((job) => job.finishedAt != null)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    const now = Date.now();
    const remove = [];
    for (const job of finished) {
      if (now - job.finishedAt >= retention) remove.push(job);
    }
    const keep = this._jobs.size - remove.length;
    const target = Math.max(0, maxJobs - reserve);
    if (keep > target) {
      // Polling retains up to the limit; only a start reserves one new slot.
      const excess = keep - target;
      const candidates = finished.filter((job) => !remove.includes(job));
      // Oldest observed completions go first; do not discard an extra log
      // merely because the caller is polling at the capacity limit.
      remove.push(...candidates.slice(0, excess));
    }
    for (const job of remove) {
      // Keep the internal set in step with the public map on every removal
      // branch: _stopJobs() iterates the set with the same objects.
      this._jobs.delete(job.job);
      this._jobsInternal.delete(job);
      await fs.rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (reserve > 0 && this._jobs.size + reserve > maxJobs) {
      throw new Error(`session ${this.id} has ${this._jobs.size} unfinished jobs; poll or close them before starting another`);
    }
  }

  async pollJob({ job, offset = 0, limitBytes = 64 * 1024 } = {}) {
    assertJobId(job);
    const jobInfo = this._jobs.get(job);
    if (!jobInfo) throw new Error(`unknown job ${job} in session ${this.id}`);
    const start = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
    const max = Math.max(1, Math.min(Number.isFinite(limitBytes) ? Math.floor(limitBytes) : 64 * 1024, this.maxOutputBytes));
    let bytes = Buffer.alloc(0);
    try {
      const handle = await fs.open(path.join(jobInfo.directory, 'output.log'), 'r');
      try {
        const stat = await handle.stat();
        const size = stat.size;
        const from = Math.min(start, size);
        const length = Math.min(max, size - from);
        if (length > 0) {
          bytes = Buffer.alloc(length);
          const { bytesRead } = await handle.read(bytes, 0, length, from);
          bytes = bytes.subarray(0, bytesRead);
        }
        jobInfo.size = size;
        jobInfo.offset = from + bytes.length;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      jobInfo.offset = start;
    }
    const statusText = await fs.readFile(path.join(jobInfo.directory, 'status'), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    const finished = statusText != null;
    if (finished) {
      jobInfo.exitCode = Number.parseInt(statusText.trim(), 10);
      jobInfo.finishedAt ??= Date.now();
    }
    // A zombie leader answers signal 0. The frame status is the supervisor's
    // own exit status, so a live producer or drain is never reported as done.
    const running = !finished;
    await this._pruneJobs();
    return {
      session: this.id,
      job,
      stdout: bytes.toString('utf8'),
      nextOffset: jobInfo.offset,
      eof: jobInfo.offset >= jobInfo.size,
      running,
      finished,
      exitCode: finished ? jobInfo.exitCode : null,
      logLimit: jobInfo.logLimit,
    };
  }

  async close(options = {}) {
    if (this._closing) return this._closing;
    if (this.closed) return this._exitPromise;
    // Closing is idempotent and must settle once even when dispose, timeout and
    // the manager drain race each other. A bare `exit 0` would kill the job
    // supervisor before its producer, leaving reparented descendants behind.
    // Set this before the first await in shutdown: even a slow job drain must
    // not admit new commands or launches into the closing shell.
    this._closeRequested = true;
    this._closing = this._close(options);
    return this._closing;
  }

  async _jobMembers(job) {
    if (!PROC_SCOPES || !job.scope) return [];
    return taggedProcesses(job.scope);
  }

  async _signalJobs(job, signal, members) {
    // Signal a verified group before reaping its leader; environment-cleared
    // descendants would otherwise lose the group identity used for cleanup.
    if (job.pid && job.start) {
      try {
        const stat = await fs.readFile(`/proc/${job.pid}/stat`, 'utf8');
        const fields = statFields(stat);
        if (fields && fields[19] === job.start && Number(fields[2]) === job.pid) {
          process.kill(-job.pid, signal);
        }
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
      }
    }
    for (const member of members) {
      try {
        const stat = await fs.readFile(`/proc/${member.pid}/stat`, 'utf8');
        const fields = statFields(stat);
        if (!fields || fields[19] !== member.start) continue;
        const state = fields[0];
        if (['Z', 'X', 'x'].includes(state)) continue;
        process.kill(member.pid, signal);
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
      }
    }
    // Signal the verified process group too: it catches descendants that
    // cleared or replaced the scope tag after fork. The identity above still
    // gates this so a reused PID is never signalled.
    if (!job.pid) return;
    try {
      const stat = await fs.readFile(`/proc/${job.pid}/stat`, 'utf8');
      const fields = statFields(stat);
      if (!fields || job.start && fields[19] !== job.start) return;
      if (Number(fields[2]) !== job.pid) return;
      process.kill(-job.pid, signal);
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error?.code)) throw error;
    }
  }

  async _stopJobs(jobs = [...this._jobsInternal]) {
    if (!jobs.length) return;
    if (process.platform === 'win32') {
      for (const job of jobs) {
        // MSYS pipeline members and env-scrubbed descendants are not always in
        // the Windows parent tree, and `$!` names an MSYS pid. Signal the job's
        // own process group in its own shell, then verify it is gone.
        if (!Number.isInteger(job.pid)) continue;
        // A job that wrote its status has already reaped its pipeline. There is
        // no group left to signal; probing it would start a fresh shell.
        const status = await fs.readFile(path.join(job.directory, 'status'), 'utf8').catch(() => null);
        if (status != null) continue;
        const signal = 'kill -TERM -- -' + job.pid + ' 2>/dev/null || kill -TERM ' + job.pid + ' 2>/dev/null';
        await shellCommand(this._shellExecutable, signal, 2_000);
        let gone = false;
        for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
          const probe = await shellCommand(
            this._shellExecutable,
            'kill -0 -- -' + job.pid + ' 2>/dev/null',
            2_000,
          );
          gone = probe.code !== 0;
          if (!gone) await sleep(100);
        }
        if (!gone) {
          await shellCommand(this._shellExecutable, 'kill -KILL -- -' + job.pid + ' 2>/dev/null', 2_000);
        }
        // taskkill is a last resort for a detached leader, and only with its
        // verified Windows pid, never with the MSYS pid from `$!`.
        if (!gone && Number.isInteger(job.winpid)) await killWindowsTree(job.winpid);
        // A signal may leave an orphan that taskkill did not own while the
        // leader already changed state. Only surviving executables are
        // signalled again; a zombie group leader is not a running job.
        await shellCommand(
          this._shellExecutable,
          'kill -KILL -- -' + job.pid + ' 2>/dev/null',
          2_000,
        );
      }
      return;
    }
    const scopes = new Map();
    for (const job of jobs) scopes.set(job, await this._jobMembers(job));
    for (const job of jobs) {
      if (job.pid) {
        const member = job.start ? { pid: job.pid, start: job.start } : null;
        if (member) scopes.get(job).push(member);
      }
    }
    for (const job of jobs) await this._signalJobs(job, 'SIGTERM', scopes.get(job));
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (Date.now() < deadline) {
      let alive = false;
      for (const job of jobs) {
        const members = await this._jobMembers(job);
        if (members.length) alive = true;
      }
      if (!alive && !jobs.some((job) => procGroupAlive(job))) return;
      await sleep(50);
    }
    for (const job of jobs) {
      const members = await this._jobMembers(job);
      await this._signalJobs(job, 'SIGKILL', members);
    }
    const killEnd = Date.now() + 1_000;
    while (Date.now() < killEnd) {
      let alive = false;
      for (const job of jobs) {
        if (await this._jobMembers(job).then((members) => members.length)) alive = true;
      }
      if (!alive && !jobs.some((job) => procGroupAlive(job))) return;
      await sleep(50);
    }
  }

  async _close(options) {
    // Abort queued commands before the slow job/child shutdown, so callers stop
    // waiting on work that can no longer run.
    this._abortQueuedRuns();
    await this._stopJobs();
    const child = this._child;
    if (!child) {
      this._finish({ exitCode: null, signal: null, timedOut: Boolean(options.timedOut) });
      return this._exitPromise;
    }
    try {
      child.stdin.write('exit 0\n');
      child.stdin.end();
    } catch {
      // The shell may already be gone; the wait below observes that.
    }
    const exited = await Promise.race([this._exitPromise, sleep(CLOSE_SETTLE_MS).then(() => null)]);
    if (!exited) {
      this._terminate('SIGTERM');
      const afterTerm = await Promise.race([this._exitPromise, sleep(SIGTERM_GRACE_MS).then(() => null)]);
      if (!afterTerm) {
        this._terminate('SIGKILL');
        await Promise.race([this._exitPromise, sleep(1_000).then(() => null)]);
      }
    }
    if (!this.closed) {
      // The process-scope scan in manager dispose is the final backstop.
      this._finish({ exitCode: null, signal: 'SIGKILL', timedOut: Boolean(options.timedOut) });
    }
    // Kill anything a job respawned after the first stop, then remove its logs.
    await this._stopJobs();
    const root = this.jobRoot();
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    return this._exitPromise;
  }
}

/**
 * Owns the named sessions of one plugin registration.
 *
 * Sessions are process-local: they survive tool calls and can run long builds,
 * but a host restart cannot preserve a live shell. After a restart the Agent
 * opens a new session and the manager's process-scope cleanup covers the old
 * processes.
 */
export class SessionRegistry {
  constructor(manager, { maxSessions = DEFAULT_MAX_SESSIONS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, maxJobBytes = DEFAULT_MAX_JOB_BYTES } = {}) {
    this.manager = manager;
    this.maxSessions = maxSessions;
    this.maxOutputBytes = maxOutputBytes;
    this.maxJobBytes = maxJobBytes;
    this.sessions = new Map();
    this.disposed = false;
  }

  async _assertAvailable() {
    if (this.disposed || this.manager.disposed) throw new Error('Linux runtime sessions are disposed');
    const status = typeof this.manager.verify === 'function'
      ? await this.manager.verify()
      : this.manager.status();
    if (this.disposed || this.manager.disposed) throw new Error('Linux runtime sessions are disposed');
    if (!status.healthy) throw new Error(`Linux runtime is unavailable: ${status.reason ?? 'unhealthy'}`);
    if (this.manager.gate.exclusive || this.manager.gate.pendingExclusive > 0) {
      throw new Error('Linux runtime is busy with a management operation');
    }
    return status;
  }

  _name(id) {
    if (id == null || id === '') {
      for (let index = 1; ; index += 1) {
        const candidate = `session-${index}`;
        if (!this.sessions.has(candidate)) return candidate;
      }
    }
    return assertSessionId(id);
  }

  /**
   * A live session fixes its host pass-throughs for its whole lifetime. The
   * sibling tool calls run in one conversation workspace, so a different set
   * here would silently expose a second workspace to the same shell. Reject it
   * instead, and let the caller open a new session after closing this one.
   */
  _assertSameSharedPaths(session, cwdInfo) {
    if (!cwdInfo) return;
    const opened = [...(session._sharedPaths ?? [])].sort();
    const requested = [...(cwdInfo.sharedPaths ?? [])].sort();
    if (opened.length === requested.length && opened.every((value, index) => value === requested[index])) return;
    throw new Error(
      'session ' + session.id + ' was opened with different sharedPaths; close it before changing the shared directories',
    );
  }

  async open({ id, cwd, sharedPaths = [] } = {}) {
    const status = await this._assertAvailable();
    const name = this._name(id);
    const existing = this.sessions.get(name);
    if (existing && existing.running) {
      if (sharedPaths != null && sharedPaths.length > 0) {
        this._assertSameSharedPaths(existing, this.manager._resolveCwd(cwd, status.paths.rootfs, sharedPaths));
      }
      return existing.info();
    }
    if (this.sessions.size >= this.maxSessions && !existing) {
      throw new Error(`session limit reached (${this.maxSessions}); close a session before opening another`);
    }
    if (existing) {
      this.sessions.delete(name);
      await existing.close().catch(() => undefined);
    }
    const cwdInfo = this.manager._resolveCwd(cwd, status.paths.rootfs, sharedPaths ?? []);
    const session = new PersistentSession(this.manager, {
      id: name,
      maxOutputBytes: this.maxOutputBytes,
      maxJobBytes: this.maxJobBytes,
      onExit: () => {
        if (this.sessions.get(name) === session) this.sessions.delete(name);
      },
    });
    this.sessions.set(name, session);
    try {
      await session.open(status.paths, cwdInfo);
    } catch (error) {
      if (this.sessions.get(name) === session) this.sessions.delete(name);
      throw error;
    }
    return session.info();
  }

  async _session(id, { cwd, sharedPaths = [] } = {}) {
    const status = await this._assertAvailable();
    const name = assertSessionId(id);
    let session = this.sessions.get(name);
    if (!session || !session.running) {
      await this.open({ id: name, cwd, sharedPaths });
      session = this.sessions.get(name);
    }
    const cwdInfo = cwd == null && (sharedPaths == null || sharedPaths.length === 0)
      ? undefined
      : this.manager._resolveCwd(cwd, status.paths.rootfs, sharedPaths ?? []);
    if (cwdInfo && sharedPaths?.length) this._assertSameSharedPaths(session, cwdInfo);
    // Mapping validation must not become a cd on every call. Only an explicit
    // cwd changes an existing persistent shell's working directory.
    return { session, cwdInfo: cwd == null ? undefined : cwdInfo };
  }

  async run(id, { command, cwd, timeoutMs, sharedPaths = [] } = {}) {
    const { session, cwdInfo } = await this._session(id, { cwd, sharedPaths });
    return session.run({ command, cwd: cwdInfo?.guestCwd, timeoutMs });
  }

  async start(id, { command, cwd, sharedPaths = [] } = {}) {
    const { session, cwdInfo } = await this._session(id, { cwd, sharedPaths });
    return session.startJob({ command, cwd: cwdInfo?.guestCwd });
  }

  async poll(id, options = {}) {
    const name = assertSessionId(id);
    const session = this.sessions.get(name);
    if (!session) throw new Error(`unknown session ${name}`);
    return session.pollJob(options);
  }

  async close(id) {
    const name = assertSessionId(id);
    const session = this.sessions.get(name);
    if (!session) return { session: name, running: false, closed: true };
    await session.close();
    this.sessions.delete(name);
    return { session: name, running: false, closed: true };
  }

  list() {
    return [...this.sessions.values()].map((session) => session.info());
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}
