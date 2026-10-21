import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const PROCESS_SCOPE_ENV = 'BIONILUX_PROCESS_SCOPE';

const gone = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function identity(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('invalid /proc process identity');
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error('invalid /proc process start time');
  }
  return { state: fields[0], start: fields[19] };
}

function realUid(status) {
  const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
  if (!match) throw new Error('missing real process UID');
  return { real: Number(match[1]), effective: Number(match[2]) };
}

// A data directory has the same scope after a host restart. This is an
// ownership label, not a secret or an authentication boundary. Resolve the
// nearest existing parent too, so a newly created directory keeps its label.
function canonicalDirectory(directory) {
  let probe = path.resolve(directory);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(probe), ...tail.reverse());
    } catch (error) {
      if (!gone(error)) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Find cooperative runtime descendants even after setsid or a host crash.
 * A matching tag and real UID identify membership; starttime prevents a PID
 * found by a previous scan from being signalled after PID reuse. Unknown,
 * unreadable environments are never treated as proof of membership.
 */
export class ProcessScope {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.directory = canonicalDirectory(dataDir);
    this.enabled = process.platform === 'linux' || process.platform === 'android';
    this._tag = this.enabled
      ? createHash('sha256').update('bionilux-process-scope-v1\0').update(this.directory).digest('hex')
      : null;
    this._known = new Map();
    this._termination = null;
  }

  tag() {
    return this._tag;
  }

  environment(environment) {
    if (!this.enabled) return environment;
    return { ...environment, [PROCESS_SCOPE_ENV]: this._tag };
  }

  async members() {
    if (!this.enabled) return [];
    const expected = `${PROCESS_SCOPE_ENV}=${this._tag}`;
    const self = realUid(await fs.readFile('/proc/self/status', 'utf8'));
    const result = [];
    const names = await fs.readdir('/proc');
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const pid = Number(name);
      try {
        const before = identity(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
        if (before.state === 'Z' || before.state === 'X' || before.state === 'x') continue;
        const uid = realUid(await fs.readFile(`/proc/${pid}/status`, 'utf8'));
        if (uid.real !== self.real || uid.effective !== self.effective) continue;
        const known = this._known.get(pid);
        if (known !== before.start) {
          const environment = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
          if (!environment.split('\0').includes(expected)) continue;
        }
        const after = identity(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
        if (after.start !== before.start || ['Z', 'X', 'x'].includes(after.state)) continue;
        this._known.set(pid, after.start);
        result.push({ pid, start: after.start });
      } catch (error) {
        if (gone(error)) continue;
        // Android may hide unrelated same-UID processes (for example its Java
        // host). Once a process was positively identified, loss of access is
        // not permission to forget it and mutate its rootfs.
        if (this._known.has(pid)) throw error;
        if (error?.code === 'EACCES' || error?.code === 'EPERM') continue;
        throw error;
      }
    }
    const live = new Set(result.map(({ pid }) => pid));
    for (const pid of this._known.keys()) if (!live.has(pid)) this._known.delete(pid);
    return result;
  }

  async _signal(member, signal) {
    try {
      // Recheck immediately before signalling. A cached PID by itself is not
      // identity, including when the caller has permission to signal all UIDs.
      const current = identity(await fs.readFile(`/proc/${member.pid}/stat`, 'utf8'));
      if (current.start !== member.start || ['Z', 'X', 'x'].includes(current.state)) return;
      process.kill(member.pid, signal);
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }

  terminate(options) {
    this._termination ??= this._terminate(options).finally(() => { this._termination = null; });
    return this._termination;
  }

  async _terminate({ graceMs = 2_000, killMs = 1_000, intervalMs = 50 } = {}) {
    if (!this.enabled) return;
    try {
      const sent = new Set();
      const graceEnd = performance.now() + graceMs;
      let empty = 0;
      for (;;) {
        const members = await this.members();
        if (!members.length) {
          if (++empty >= 2) return;
          await pause(intervalMs);
          continue;
        }
        empty = 0;
        for (const member of members) {
          const key = `${member.pid}:${member.start}`;
          if (sent.has(key)) continue;
          await this._signal(member, 'SIGTERM');
          sent.add(key);
        }
        if (performance.now() >= graceEnd) break;
        await pause(intervalMs);
      }
      const killEnd = performance.now() + killMs;
      empty = 0;
      for (;;) {
        const members = await this.members();
        if (!members.length) {
          if (++empty >= 2) return;
          await pause(intervalMs);
          continue;
        }
        empty = 0;
        for (const member of members) await this._signal(member, 'SIGKILL');
        if (performance.now() >= killEnd) {
          let remaining = await this.members();
          if (!remaining.length) {
            await pause(intervalMs);
            remaining = await this.members();
            if (!remaining.length) return;
          }
          const error = new Error(`runtime processes remain after SIGKILL: ${remaining.map(({ pid }) => pid).join(', ')}`);
          error.code = 'ERR_RUNTIME_CHILDREN_STILL_RUNNING';
          error.remaining = remaining.length;
          throw error;
        }
        await pause(intervalMs);
      }
    } catch (error) {
      if (error.code === 'ERR_RUNTIME_CHILDREN_STILL_RUNNING') throw error;
      const failure = new Error('cannot verify runtime process scope; refusing to change the runtime', { cause: error });
      failure.code = 'ERR_RUNTIME_PROCESS_SCOPE_UNAVAILABLE';
      throw failure;
    }
  }
}
