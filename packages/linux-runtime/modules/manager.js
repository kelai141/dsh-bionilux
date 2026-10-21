import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  promises as fs,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { defaultRuntimeIdForArch, resolveHostArchitecture, selectRuntime } from './manifest.js';
import { assertOfficialAssetUrl, isAllowedAssetOrigin } from './asset-installer.js';
import { ProcessScope } from './process-scope.js';

const ACTIVE_SCHEMA_VERSION = 1;
const METADATA_SCHEMA_VERSION = 1;
const DEFAULT_GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SIGTERM_GRACE_MS = 2_000;
const STOP_SETTLE_MS = 2_000;
const FORCE_KILL_SETTLE_MS = 1_000;
const ROOTFS_REQUIRED_FILES = [
  'bin/sh',
  'bin/bash',
  'usr/bin/apt-get',
  'usr/bin/dpkg',
  'etc/os-release',
];
const ELF_MACHINE_BY_ARCH = Object.freeze({ arm64: 0xb7, x64: 0x3e });
const ELF_ARCH_BY_MACHINE = new Map([
  [0xb7, 'arm64'],
  [0x3e, 'x64'],
]);
const ROOTFS_LOADER_CANDIDATES = {
  arm64: [
    'lib/ld-linux-aarch64.so.1',
    'lib64/ld-linux-aarch64.so.1',
    'lib/aarch64-linux-gnu/ld-linux-aarch64.so.1',
    'usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1',
  ],
  x64: [
    'lib64/ld-linux-x86-64.so.2',
    'lib/ld-linux-x86-64.so.2',
    'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  ],
};
/**
 * One live manager per data directory in this shared Node realm.
 *
 * The execution gate and the child set are instance-local. Two managers that
 * both believe they own the same tree would each drain only their own
 * children, so one could replace the rootfs while the other's guest process
 * was still running. Rejecting the second owner is explicit and keeps dispose
 * scoped to the manager that actually owns the directory.
 *
 * The registry lives on globalThis under a Symbol.for key, so a plugin reload
 * that evaluates a fresh copy of this module cannot bypass ownership. Entries
 * are strong references on purpose: an owner must stay reachable until it is
 * disposed, because dropping it would release the directory while its child
 * set and gate were still live. A manager therefore owns its dataDir for its
 * whole lifetime and must be disposed; a failed dispose keeps ownership.
 * Worker threads and isolated VM contexts have their own globalThis, so they
 * are not covered by this registry. Source aliases, separate Node processes
 * and cross-process writers are outside it too.
 */
const MANAGER_OWNERS = Symbol.for('dsh-bionilux.runtime.managerOwners');

function liveManagers() {
  let owners = globalThis[MANAGER_OWNERS];
  if (!owners) {
    owners = new Map();
    Object.defineProperty(globalThis, MANAGER_OWNERS, {
      value: owners,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return owners;
}

function dataDirOwnerError(dataDir) {
  const error = new Error(
    `a live Linux runtime manager already owns ${dataDir}; dispose it before creating another manager for this dataDir`,
  );
  error.code = 'ERR_RUNTIME_MANAGER_IN_USE';
  return error;
}

const HOST_ENV_ALLOWLIST = new Set([
  'PATH',
  'ANDROID_ROOT',
  'ANDROID_DATA',
  'ANDROID_TZDATA_ROOT',
  'ANDROID_I18N_ROOT',
  'ANDROID_ART_ROOT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);
const GUEST_PATH_PREFIXES_LIST = [
  '/bin',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
  '/work',
];

/**
 * The guest namespace, deliberately exported.
 *
 * A working directory under one of these prefixes is *never* promoted to a host
 * pass-through: the launcher resolves a configured host directory by its own
 * name before consulting the rootfs, so promoting e.g. `/tmp` or `/etc` would
 * shadow the whole guest subtree of that name. Promoting a directory outside
 * the guest namespace is what makes a real host workspace visible instead.
 */
export const GUEST_PATH_PREFIXES = Object.freeze(GUEST_PATH_PREFIXES_LIST);

/** `true` when `value` names a path inside the guest's own namespace. */
export function isGuestPath(value) {
  return GUEST_PATH_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read/write gate between command execution and installation.
 *
 * Commands run concurrently (shared). Install, reinstall, uninstall and dispose
 * hold the gate exclusively, so a cutover can never race a guest process that is
 * still reading the rootfs being replaced. Management never waits forever on a
 * long-running command: it registers its intent first, then aborts in-flight
 * children, so a command admitted during the drain cannot spawn into the
 * cutover.
 */
export class ExecutionGate {
  constructor() {
    this.active = 0;
    this.exclusive = false;
    this.pendingExclusive = 0;
    this.waiters = [];
  }

  get busy() {
    return this.exclusive || this.active > 0;
  }

  get managementPending() {
    return this.pendingExclusive > 0;
  }

  _wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Acquire management access, cancellable while the drain is in progress.
   *
   * A caller that cannot prove its children exited must be able to withdraw the
   * intent instead of waiting for a promise that may never settle.
   */
  async acquireExclusive({ signal } = {}) {
    const abortError = () => {
      const reason = signal?.reason;
      return reason instanceof Error ? reason : new Error('management was cancelled');
    };
    if (signal?.aborted) throw abortError();
    this.pendingExclusive += 1;
    try {
      while (this.exclusive || this.active > 0) {
        if (signal?.aborted) throw abortError();
        await new Promise((resolve) => {
          const onAbort = () => this._wake();
          const waiter = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          this.waiters.push(waiter);
          signal?.addEventListener('abort', onAbort, { once: true });
          // The signal may have fired between the loop check and this listener.
          if (signal?.aborted) onAbort();
        });
      }
      if (signal?.aborted) throw abortError();
      this.exclusive = true;
    } finally {
      this.pendingExclusive -= 1;
      this._wake();
    }
  }

  releaseExclusive() {
    this.exclusive = false;
    this._wake();
  }

  async acquireShared() {
    while (this.exclusive || this.pendingExclusive > 0) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }

  releaseShared() {
    this.active -= 1;
    if (this.active === 0 && (this.exclusive || this.pendingExclusive > 0)) this._wake();
  }
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeDataDir(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || resolved.length < 4) {
    throw new TypeError('dataDir must be a non-root private directory');
  }
  return resolved;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new TypeError(`${field} contains unsafe path characters`);
  }
  return value;
}

function makeId(prefix) {
  try {
    return `${prefix}-${Date.now().toString(36)}-${randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function fileExists(file) {
  try {
    return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function directoryExists(directory) {
  try {
    return lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a rootfs-internal path without following a guest absolute symlink on
 * the host.
 *
 * A Debian rootfs uses links such as /lib/ld-linux-aarch64.so.1 ->
 * /lib/aarch64-linux-gnu/ld-linux-aarch64.so.1. On Android that target is a
 * guest path, so reading the host path would either fail or inspect an unrelated
 * host library. Resolve it inside the rootfs instead, and fail closed on a link
 * that escapes.
 */
function resolveRootfsTarget(rootfs, candidate) {
  const relative = path.relative(rootfs, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path escapes the runtime rootfs');
  }
  let current = rootfs;
  let pending = relative.split(path.sep).filter(Boolean);
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === '.') continue;
    if (part === '..') {
      if (current === rootfs) throw new Error('rootfs symlink escapes the runtime rootfs');
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    if (!pathIsWithin(rootfs, next)) {
      throw new Error('rootfs symlink escapes the runtime rootfs');
    }
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      // The remaining path cannot resolve. Return it so the caller reports a
      // missing or unreadable object instead of guessing.
      const unresolved = pending.length > 0 ? path.join(next, ...pending) : next;
      if (!pathIsWithin(rootfs, unresolved)) {
        throw new Error('rootfs symlink escapes the runtime rootfs');
      }
      return unresolved;
    }
    if (stat.isSymbolicLink()) {
      links += 1;
      if (links > 40) throw new Error('rootfs symlink chain is too deep');
      const link = readlinkSync(next);
      if (path.isAbsolute(link)) {
        current = rootfs;
        // Legacy prepare-rootfs used physical absolute targets; newer bundles
        // use guest absolute or relative targets. Do not prefix legacy links
        // with rootfs a second time.
        const target = pathIsWithin(rootfs, link) ? path.relative(rootfs, link) : link;
        pending = target.replace(/^[/\\]+/, '').split(/[/\\]+/).filter(Boolean).concat(pending);
      } else {
        pending = link.split(/[/\\]+/).filter(Boolean).concat(pending);
      }
      continue;
    }
    if (pending.length > 0) {
      if (!stat.isDirectory()) {
        const unresolved = path.join(next, ...pending);
        if (!pathIsWithin(rootfs, unresolved)) {
          throw new Error('rootfs symlink escapes the runtime rootfs');
        }
        return unresolved;
      }
      current = next;
      continue;
    }
    return next;
  }
  return current;
}

/**
 * Read the 20-byte ELF identity: 16-byte e_ident plus e_type and e_machine.
 *
 * The executable bit and a matching file name say nothing about the target
 * architecture; the machine field is the only local evidence that a launcher,
 * preload, shared Node or rootfs loader can run on this device.
 */
function readElfIdentity(file, { rootfs } = {}) {
  const target = rootfs ? resolveRootfsTarget(rootfs, file) : file;
  let stat;
  try {
    stat = statSync(target);
  } catch (error) {
    throw new Error(`cannot be read (${error.code ?? error.message})`);
  }
  if (!stat.isFile()) {
    throw new Error('is not a regular file');
  }
  let fd;
  try {
    fd = openSync(target, 'r');
  } catch (error) {
    throw new Error(`cannot be read (${error.code ?? error.message})`);
  }
  try {
    const header = Buffer.alloc(20);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead < header.length) {
      throw new Error('is shorter than the 20-byte ELF header');
    }
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      throw new Error('is not an ELF object');
    }
    const elfClass = header[4];
    if (elfClass !== 1 && elfClass !== 2) {
      throw new Error('has an unknown ELF class');
    }
    const endian = header[5];
    if (endian !== 1 && endian !== 2) {
      throw new Error('has an unknown ELF endianness');
    }
    const machine = endian === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return { elfClass, endian, machine };
  } finally {
    closeSync(fd);
  }
}

function assertElfArchitecture(file, arch, { rootfs } = {}) {
  const identity = readElfIdentity(file, { rootfs });
  if (identity.elfClass !== 2) {
    throw new Error('is not a 64-bit ELF object');
  }
  if (identity.endian !== 1) {
    throw new Error('is not a little-endian ELF object');
  }
  const expected = ELF_MACHINE_BY_ARCH[arch];
  if (identity.machine !== expected) {
    const found = ELF_ARCH_BY_MACHINE.get(identity.machine) ?? `e_machine ${identity.machine}`;
    throw new Error(`is a ${found} ELF object; expected ${arch}`);
  }
}

/** Resolve one rootfs-relative object and report whether it exists at all. */
function inspectRootfsObject(rootfs, relative) {
  const candidate = path.join(rootfs, relative);
  const target = resolveRootfsTarget(rootfs, candidate);
  try {
    const stat = statSync(target);
    return { candidate, target, exists: true, regular: stat.isFile() };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { candidate, target, exists: false, regular: false };
    }
    throw new Error(`cannot be read (${error.code ?? error.message})`);
  }
}

function normaliseCommandResult(result) {
  const value = isObject(result) ? result : {};
  const exitCode = Number.isInteger(value.exitCode)
    ? value.exitCode
    : Number.isInteger(value.code)
      ? value.code
      : null;
  return {
    stdout: value.stdout == null ? '' : String(value.stdout),
    stderr: value.stderr == null ? '' : String(value.stderr),
    exitCode,
    signal: value.signal == null ? null : String(value.signal),
    timedOut: Boolean(value.timedOut),
  };
}

function normaliseRunnerResult(raw) {
  if (raw && typeof raw.then === 'function') {
    return { promise: Promise.resolve(raw), cancel: undefined, forceKill: undefined };
  }
  if (isObject(raw) && raw.promise && typeof raw.promise.then === 'function') {
    return {
      promise: Promise.resolve(raw.promise),
      cancel: typeof raw.cancel === 'function' ? raw.cancel : undefined,
      forceKill: typeof raw.forceKill === 'function' ? raw.forceKill : undefined,
    };
  }
  return { promise: Promise.resolve(raw), cancel: undefined, forceKill: undefined };
}

/**
 * Spawn one guest command in its own process group on POSIX.
 *
 * Abort and timeout send SIGTERM, then escalate to SIGKILL after a grace
 * period. Without the escalation a guest command that traps SIGTERM would keep
 * its whole session alive and pin the execution gate forever. Exported so host
 * adapters and tests can use the same termination contract as the manager.
 */
export function spawnCommand(spec) {
  const detached = process.platform !== 'win32';
  const child = spawn(spec.file, spec.args ?? [], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  let timer;
  let killTimer;
  let settled = false;
  let timedOut = false;
  const sendSignal = (signal) => {
    if (settled) return;
    try {
      // The pid stays undefined when spawn itself failed; there is no process
      // to signal in that case.
      if (!Number.isInteger(child.pid)) return;
      if (detached) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const terminate = (signal = 'SIGTERM') => {
    if (settled) return;
    sendSignal(signal);
    if (signal !== 'SIGKILL' && !killTimer) {
      killTimer = setTimeout(() => terminate('SIGKILL'), SIGTERM_GRACE_MS);
      killTimer.unref?.();
    }
  };
  const forceKill = () => terminate('SIGKILL');
  const promise = new Promise((resolve, reject) => {
    const onAbort = () => terminate('SIGTERM');
    const cleanup = () => {
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      spec.signal?.removeEventListener('abort', onAbort);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(spec.timeout) && spec.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
      }, spec.timeout);
      timer.unref?.();
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      cleanup();
      resolve({ stdout, stderr, exitCode: code, signal, timedOut });
    });
  });
  return { promise, cancel: terminate, forceKill, child };
}

/** Resolve once every child promise settles, or after a bounded grace period. */
function waitForSettlement(children, timeoutMs) {
  if (children.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    Promise.allSettled(children.map((child) => child.promise)).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function writeFileAtomic(target, contents) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${makeId('tmp')}`);
  await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    // Android/Linux rename replaces atomically. Windows does not replace an
    // existing file, so use the narrow fallback needed by host-side tests.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') {
      throw error;
    }
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function verifyFile(asset, file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`download is not a regular file: ${asset.url}`);
  if (stat.size !== asset.size) {
    throw new Error(`download size mismatch for ${asset.url}: expected ${asset.size}, got ${stat.size}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error(`download checksum mismatch for ${asset.url}`);
  }
  return stat.size;
}

async function downloadWithFetch(fetchImpl, asset, destination) {
  const response = await fetchImpl(asset.url, { redirect: 'follow' });
  if (!response?.ok) {
    throw new Error(`download failed for ${asset.url}: HTTP ${response?.status ?? 'unknown'}`);
  }
  if (response.url && !isAllowedAssetOrigin(response.url)) {
    throw new Error('download redirected away from the official GitHub release origin');
  }
  const hash = createHash('sha256');
  let size = 0;
  const handle = await fs.open(destination, 'wx');
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > asset.size) throw new Error(`download exceeded declared size for ${asset.url}`);
        hash.update(buffer);
        await handle.write(buffer);
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      size = buffer.length;
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  if (size !== asset.size) {
    throw new Error(`download size mismatch for ${asset.url}: expected ${asset.size}, got ${size}`);
  }
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error(`download checksum mismatch for ${asset.url}`);
  }
}

function cleanHostEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (HOST_ENV_ALLOWLIST.has(key)) environment[key] = value;
  }
  return environment;
}

function executableFileExists(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function measureUnpackedBytes(directory) {
  let total = 0;
  const seen = new Set();
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          total += stat.size;
        }
      }
    }
  }
  await visit(directory);
  return total;
}

export class LinuxRuntimeManager {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dataDir = assertSafeDataDir(options.dataDir);
    this.processScope = new ProcessScope(this.dataDir);
    this._ownerKey = this.processScope.directory;
    const owners = liveManagers();
    const owner = owners.get(this._ownerKey);
    if (owner && !owner.disposed) throw dataDirOwnerError(this.dataDir);
    this.arch = resolveHostArchitecture(options.arch);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.downloadAsset = options.downloadAsset;
    this.extractArchive = options.extractArchive;
    this.runCommand = options.runCommand ?? spawnCommand;
    if (typeof this.runCommand !== 'function') throw new TypeError('runCommand must be a function');
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : undefined;
    this.events = new EventEmitter();
    this.children = new Set();
    this.gate = new ExecutionGate();
    this.disposed = false;
    owners.set(this._ownerKey, this);
  }

  on(event, listener) {
    this.events.on(event, listener);
    return this;
  }

  off(event, listener) {
    this.events.off(event, listener);
    return this;
  }

  _paths() {
    return {
      active: path.join(this.dataDir, 'active.json'),
      instances: path.join(this.dataDir, 'instances'),
      sharedNode: path.join(this.dataDir, 'shared', 'node'),
      staging: path.join(this.dataDir, '.staging'),
      deleting: path.join(this.dataDir, '.deleting'),
    };
  }

  _instancePaths(instanceId) {
    assertSafeId(instanceId, 'instanceId');
    const root = path.join(this._paths().instances, instanceId);
    if (!pathIsWithin(this.dataDir, root)) throw new Error('instance path escaped dataDir');
    return {
      root,
      backend: path.join(root, 'backend'),
      rootfs: path.join(root, 'rootfs'),
      metadata: path.join(root, 'metadata.json'),
    };
  }

  _nodePath(nodeKey) {
    assertSafeId(nodeKey, 'nodeKey');
    return path.join(this._paths().sharedNode, nodeKey, this.arch);
  }

  /**
   * Content-addressed root of a shared Node installation.
   *
   * Cleanup removes this directory, not just the architecture leaf, so an
   * uninstall does not leave an empty `<nodeKey>/` husk behind.
   */
  _nodeRoot(nodeKey) {
    assertSafeId(nodeKey, 'nodeKey');
    return path.join(this._paths().sharedNode, nodeKey);
  }

  _readActive() {
    const file = this._paths().active;
    if (!fileExists(file)) return undefined;
    try {
      return this._validateActiveRecord(JSON.parse(readFileSync(file, 'utf8'))).record;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate an active record against this manager before trusting it.
   *
   * status() used to read active.json directly, so it ignored the architecture
   * check that _readActive performs and could report an arm64 runtime healthy
   * while the record named an x64 one. Health is always evaluated for the
   * architecture this manager actually owns.
   */
  _validateActiveRecord(raw) {
    if (!isObject(raw)) return { reason: 'active.json must contain an object' };
    if (raw.schemaVersion !== ACTIVE_SCHEMA_VERSION) {
      return { reason: 'active.json has an unsupported schema' };
    }
    try {
      assertSafeId(raw.instanceId, 'active.instanceId');
      assertSafeId(raw.runtimeId, 'active.runtimeId');
    } catch (error) {
      return { reason: error.message };
    }
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      return { reason: 'active.json has no runtime version' };
    }
    if (raw.architecture !== this.arch) {
      return {
        reason: `active.json targets architecture ${String(raw.architecture)} but this manager manages ${this.arch}`,
      };
    }
    return { record: raw };
  }

  _healthForRecord(record) {
    if (!record) return { healthy: false, reason: 'runtime is not installed' };
    if (record.architecture !== this.arch) {
      return {
        healthy: false,
        reason: `active record targets architecture ${String(record.architecture)} but this manager manages ${this.arch}`,
      };
    }
    let instance;
    try {
      instance = this._instancePaths(record.instanceId);
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
    const nodeKey = record.nodeKey ?? record.nodeVersion;
    if (typeof nodeKey !== 'string') return { healthy: false, reason: 'active record has no shared Node identity' };
    let node;
    try {
      node = this._nodePath(nodeKey);
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
    const required = [
      ['backend executable', path.join(instance.backend, 'bin', 'bionilux'), 'executable'],
      ['backend preload', path.join(instance.backend, 'lib', 'libbionilux_preload.so'), 'file'],
      ['rootfs preparation script', path.join(instance.backend, 'scripts', 'prepare-rootfs.sh'), 'file'],
      ['shared Linux Node', path.join(node, 'bin', 'node'), 'executable'],
      ['shared npm directory', path.join(node, 'lib', 'node_modules', 'npm'), 'directory'],
    ];
    for (const [label, file, kind] of required) {
      const present =
        kind === 'executable' ? executableFileExists(file) : kind === 'directory' ? directoryExists(file) : fileExists(file);
      if (!present) {
        return { healthy: false, reason: `${label} is missing${kind === 'executable' ? ' or not executable' : ''}` };
      }
    }
    for (const relative of ROOTFS_REQUIRED_FILES) {
      const target = path.join(instance.rootfs, relative);
      if (!fileExists(target)) {
        return { healthy: false, reason: `rootfs file is missing: /${relative}` };
      }
    }
    const nativeObjects = [
      ['backend launcher', path.join(instance.backend, 'bin', 'bionilux')],
      ['backend preload', path.join(instance.backend, 'lib', 'libbionilux_preload.so')],
      ['shared Linux Node', path.join(node, 'bin', 'node')],
    ];
    for (const [label, file] of nativeObjects) {
      try {
        assertElfArchitecture(file, this.arch);
      } catch (error) {
        return { healthy: false, reason: `${label} at ${file} ${error.message}` };
      }
    }
    let nativeLoaders = 0;
    // Cross-development rootfs may also contain another architecture's
    // loader. Verify the selected native ABI and require it to exist.
    for (const relative of ROOTFS_LOADER_CANDIDATES[this.arch]) {
      let inspected;
      try {
        inspected = inspectRootfsObject(instance.rootfs, relative);
      } catch (error) {
        return { healthy: false, reason: `rootfs dynamic loader /${relative} ${error.message}` };
      }
      if (!inspected.exists) continue;
      if (!inspected.regular) {
        return { healthy: false, reason: `rootfs dynamic loader at ${inspected.candidate} is not a regular file` };
      }
      try {
        assertElfArchitecture(inspected.target, this.arch);
      } catch (error) {
        return { healthy: false, reason: `rootfs dynamic loader at ${inspected.candidate} ${error.message}` };
      }
      nativeLoaders += 1;
    }
    if (nativeLoaders === 0) {
      return { healthy: false, reason: `rootfs dynamic loader for ${this.arch} is missing` };
    }
    if (!directoryExists(instance.root) || !directoryExists(instance.backend) || !directoryExists(instance.rootfs)) {
      return { healthy: false, reason: 'runtime instance is incomplete' };
    }
    return {
      healthy: true,
      paths: {
        instance: instance.root,
        backend: instance.backend,
        rootfs: instance.rootfs,
        node,
        launcher: path.join(instance.backend, 'bin', 'bionilux'),
        preload: path.join(instance.backend, 'lib', 'libbionilux_preload.so'),
      },
    };
  }

  status() {
    if (this.disposed) {
      return Object.freeze({ healthy: false, installed: false, state: 'disposed', reason: 'manager is disposed' });
    }
    const activeFile = this._paths().active;
    if (!fileExists(activeFile)) {
      return Object.freeze({ healthy: false, installed: false, state: 'absent', reason: 'runtime is not installed' });
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(activeFile, 'utf8'));
    } catch (error) {
      return Object.freeze({ healthy: false, installed: false, state: 'unhealthy', reason: `active.json is unreadable: ${error.message}` });
    }
    const validation = this._validateActiveRecord(raw);
    if (!validation.record) {
      return Object.freeze({
        healthy: false,
        installed: isObject(raw),
        state: 'unhealthy',
        reason: validation.reason,
      });
    }
    const record = validation.record;
    const health = this._healthForRecord(record);
    return Object.freeze({
      healthy: health.healthy,
      installed: true,
      state: health.healthy ? 'healthy' : 'unhealthy',
      reason: health.reason,
      runtimeId: record.runtimeId,
      version: record.version,
      architecture: record.architecture,
      instanceId: record.instanceId,
      paths: health.paths,
    });
  }

  _emitState() {
    const state = this.status();
    this.events.emit('change', state);
    try {
      this.onStateChange?.(state);
    } catch {
      // State observers cannot break installation or execution.
    }
    return state;
  }

  /**
   * Management critical section: install, reinstall, uninstall and dispose.
   *
   * Management intent is registered before children are stopped. A command
   * that would otherwise be admitted during the drain window therefore waits
   * instead of spawning a process into the cutover. If a child cannot be
   * confirmed dead, the intent is withdrawn and the operation fails without
   * touching active.json or the instance tree.
   */
  async _exclusive(operation) {
    const controller = new AbortController();
    const acquisition = this.gate.acquireExclusive({ signal: controller.signal });
    let acquired = false;
    try {
      try {
        await this._stopChildren();
      } catch (error) {
        controller.abort(error);
        try {
          await acquisition;
          acquired = true;
        } catch {
          acquired = false;
        }
        throw error;
      }
      await acquisition;
      acquired = true;
      return await operation();
    } finally {
      if (acquired) this.gate.releaseExclusive();
    }
  }

  async _ensureDirectories() {
    const paths = this._paths();
    await fs.mkdir(paths.instances, { recursive: true });
    await fs.mkdir(paths.sharedNode, { recursive: true });
    await fs.mkdir(paths.staging, { recursive: true });
    await fs.mkdir(paths.deleting, { recursive: true });
  }

  async _download(asset, destination) {
    assertOfficialAssetUrl(asset.url);
    if (typeof this.downloadAsset === 'function') {
      await this.downloadAsset(asset, destination);
      await verifyFile(asset, destination);
      return;
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('downloadAsset IO is required; no fetchImpl is available');
    }
    await downloadWithFetch(this.fetchImpl, asset, destination);
  }

  async _extract(archive, destination, kind) {
    if (typeof this.extractArchive !== 'function') {
      throw new Error('extractArchive IO is required; refusing unsafe shell extraction');
    }
    await fs.mkdir(destination, { recursive: true });
    await this.extractArchive(archive, destination, { kind });
  }

  async _materialize(asset, archive, destination, kind) {
    await this._download(asset, archive);
    await this._extract(archive, destination, kind);
  }

  async _runManaged(spec) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(spec.signal?.reason);
    if (spec.signal?.aborted) relayAbort();
    else spec.signal?.addEventListener('abort', relayAbort, { once: true });
    // Synchronous: introducing an await here would reopen the admission race
    // between acquiring the shared gate and registering the spawned child.
    const effectiveSpec = {
      ...spec,
      env: this.processScope.environment(spec.env),
      signal: controller.signal,
    };
    let raw;
    try {
      raw = this.runCommand(effectiveSpec);
    } catch (error) {
      spec.signal?.removeEventListener('abort', relayAbort);
      throw error;
    }
    const handle = normaliseRunnerResult(raw);
    const child = {
      abort: () => controller.abort(new Error('Linux runtime operation stopped')),
      cancel: handle.cancel,
      forceKill: handle.forceKill,
      promise: handle.promise,
    };
    this.children.add(child);
    try {
      return await handle.promise;
    } finally {
      this.children.delete(child);
      spec.signal?.removeEventListener('abort', relayAbort);
    }
  }

  async _stopChildren() {
    // A disposed object may be called again after a replacement has claimed
    // this directory. Its scope label is stable, so it must not drain the new
    // owner's processes.
    if (this.disposed) return;
    const children = [...this.children];
    if (!children.length && !this.processScope.enabled) return;
    // Reparented/setsid children can outlive a completed command handle. Drain
    // the scope alongside tracked process groups, including after host restart.
    // Wait for both cleanups even if one fails before releasing the gate.
    const results = await Promise.allSettled([
      this._stopTrackedChildren(children),
      this.processScope.terminate(),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  async _stopTrackedChildren(children) {
    if (children.length === 0) return;
    for (const child of children) {
      try {
        child.abort();
      } catch {
        // Continue terminating all children.
      }
      try {
        child.cancel?.('SIGTERM');
      } catch {
        // Continue terminating all children.
      }
    }
    await waitForSettlement(children, STOP_SETTLE_MS);
    let remaining = children.filter((child) => this.children.has(child));
    for (const child of remaining) {
      try {
        child.forceKill?.();
      } catch {
        // Best effort after the grace period.
      }
    }
    if (remaining.length > 0) await waitForSettlement(remaining, FORCE_KILL_SETTLE_MS);
    remaining = children.filter((child) => this.children.has(child));
    if (remaining.length > 0) {
      // The process was signalled but never confirmed dead. Dropping the
      // handle or releasing the cutover here would let an update delete a
      // rootfs that is still in use. Keep tracking it and fail management.
      const error = new Error(
        `Linux runtime command did not exit after SIGKILL (${remaining.length} still running); refusing to change the runtime`,
      );
      error.code = 'ERR_RUNTIME_CHILDREN_STILL_RUNNING';
      error.remaining = remaining.length;
      throw error;
    }
  }

  async _prepareRootfs(instance, signal) {
    const script = path.join(instance.backend, 'scripts', 'prepare-rootfs.sh');
    const result = normaliseCommandResult(
      await this._runManaged({
        file: 'sh',
        args: [script, '--rootfs', instance.rootfs, '--relative-links'],
        cwd: instance.root,
        env: cleanHostEnvironment(),
        timeout: 120_000,
        signal,
      }),
    );
    if (result.exitCode !== 0) {
      throw new Error(`prepare-rootfs.sh failed with exit code ${result.exitCode}: ${result.stderr}`.trim());
    }
  }

  async _ensureSharedNode(runtime, staging, activeRecord) {
    const node = this._nodePath(nodeKeyFor(runtime));
    if (this._nodeIsHealthy(node)) return { node, created: false };
    const hadBrokenNode = existsSync(node);
    if (hadBrokenNode && activeRecord) await this._stopChildren();
    if (hadBrokenNode) await removeTree(node);
    const nodeStage = path.join(staging, 'node');
    const archive = path.join(staging, 'node.archive');
    await this._materialize(runtime.nodeAsset, archive, nodeStage, 'node');
    if (!this._nodeIsHealthy(nodeStage)) {
      throw new Error('shared Linux Node archive is incomplete');
    }
    await fs.mkdir(path.dirname(node), { recursive: true });
    await fs.rename(nodeStage, node);
    return { node, created: true };
  }

  _nodeIsHealthy(node) {
    return fileExists(path.join(node, 'bin', 'node')) && directoryExists(path.join(node, 'lib', 'node_modules', 'npm'));
  }

  async _writeActive(record) {
    await writeFileAtomic(this._paths().active, `${JSON.stringify(record, null, 2)}\n`);
  }

  async _removeActive() {
    const active = this._paths().active;
    if (!fileExists(active)) return;
    const tombstone = path.join(this._paths().deleting, `${makeId('active')}.json`);
    await fs.rename(active, tombstone);
    await fs.rm(tombstone, { force: true });
  }

  async _removePreviousInstance(record, keepNodeKey) {
    if (!record?.instanceId) return;
    const instance = this._instancePaths(record.instanceId).root;
    if (!pathIsWithin(this.dataDir, instance)) return;
    await removeTree(instance);
    const previousNodeKey = record.nodeKey ?? record.nodeVersion;
    if (previousNodeKey && previousNodeKey !== keepNodeKey) {
      const node = this._nodePath(previousNodeKey);
      if (!this._nodeReferencedByAnyInstance(node)) await removeTree(this._nodeRoot(previousNodeKey));
    }
  }

  _nodeReferencedByAnyInstance(node) {
    const instances = this._paths().instances;
    if (!directoryExists(instances)) return false;
    let entries;
    try {
      entries = requireDirectoryEntries(instances);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = path.join(instances, entry.name, 'metadata.json');
      try {
        const value = JSON.parse(readFileSync(metadata, 'utf8'));
        const key = value.nodeKey ?? value.nodeVersion;
        if (key && path.resolve(this._nodePath(key)) === path.resolve(node)) return true;
      } catch {
        // An unknown instance is preserved conservatively.
        return true;
      }
    }
    return false;
  }

  /**
   * Install (or replace) the active runtime instance.
   *
   * The whole swap runs under the management gate: the rootfs, backend and
   * shared Node are staged first, health is proven on the staged tree, and only
   * then is the active record atomically replaced. A failure leaves the
   * previously active instance untouched.
   */
  async install(manifest, runtimeId = defaultRuntimeIdForArch(this.arch)) {
    return this._exclusive(() => this._installLocked(manifest, runtimeId));
  }

  async _installLocked(manifest, runtimeId) {
    if (this.disposed) throw new Error('manager is disposed');
    const selection = selectRuntime(manifest, runtimeId, this.arch);
    await this._ensureDirectories();
    const previous = this._readActive();
    const instanceId = makeId(runtimeId);
    const staging = path.join(this._paths().staging, instanceId);
    const stagedInstance = path.join(staging, 'instance');
    const finalInstance = this._instancePaths(instanceId).root;
    let nodeCreated = false;
    let promoted = false;
    const nodeKey = nodeKeyFor(selection.runtime);
    try {
      await fs.mkdir(stagedInstance, { recursive: true });
      const instance = {
        root: stagedInstance,
        backend: path.join(stagedInstance, 'backend'),
        rootfs: path.join(stagedInstance, 'rootfs'),
      };
      const nodeResult = await this._ensureSharedNode(selection.runtime, staging, previous);
      nodeCreated = nodeResult.created;
      await this._materialize(
        selection.runtime.backendAsset,
        path.join(staging, 'backend.archive'),
        instance.backend,
        'backend',
      );
      await this._materialize(
        selection.runtime.rootfsAsset,
        path.join(staging, 'rootfs.archive'),
        instance.rootfs,
        'rootfs',
      );
      await this._prepareRootfs(instance);
      const record = {
        schemaVersion: ACTIVE_SCHEMA_VERSION,
        instanceId,
        runtimeId: selection.runtime.id,
        version: selection.manifest.version,
        architecture: selection.runtime.architecture,
        nodeKey,
        activatedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(stagedInstance, 'metadata.json'),
        `${JSON.stringify({ ...record, schemaVersion: METADATA_SCHEMA_VERSION }, null, 2)}\n`,
        { flag: 'wx' },
      );
      await fs.rename(stagedInstance, finalInstance);
      promoted = true;
      const health = this._healthForRecord(record);
      if (!health.healthy) throw new Error(`staged runtime is unhealthy: ${health.reason}`);
      await this._stopChildren();
      await this._writeActive(record);
      if (previous && previous.instanceId !== record.instanceId) {
        // Cleanup of the retired instance is best effort: the new runtime is
        // already active, so a stale directory must not turn a successful
        // install into a reported failure.
        await this._removePreviousInstance(previous, nodeKey).catch(() => undefined);
      }
      return this._emitState();
    } catch (error) {
      // A failure after promotion (for example an unhealthy staged tree) must
      // not leave an instance directory behind: its metadata would also pin the
      // shared Node as referenced forever.
      if (promoted && this._readActive()?.instanceId !== instanceId) {
        await removeTree(finalInstance).catch(() => undefined);
      }
      if (nodeCreated && !this._nodeReferencedByAnyInstance(this._nodePath(nodeKey))) {
        await removeTree(this._nodeRoot(nodeKey)).catch(() => undefined);
      }
      throw error;
    } finally {
      await removeTree(staging).catch(() => undefined);
    }
  }

  async reinstall(manifest, runtimeId = defaultRuntimeIdForArch(this.arch)) {
    return this.install(manifest, runtimeId);
  }

  async uninstall() {
    return this._exclusive(async () => {
      if (this.disposed) return this.status();
      const previous = this._readActive();
      if (!previous) {
        await this._removeActive().catch(() => undefined);
        return this._emitState();
      }
      await this._stopChildren();
      const instance = this._instancePaths(previous.instanceId).root;
      const tombstone = path.join(this._paths().deleting, `${previous.instanceId}-${makeId('delete')}`);
      if (directoryExists(instance)) await fs.rename(instance, tombstone);
      await this._removeActive();
      await removeTree(tombstone);
      const previousNodeKey = previous.nodeKey ?? previous.nodeVersion;
      if (previousNodeKey && !this._nodeReferencedByAnyInstance(this._nodePath(previousNodeKey))) {
        await removeTree(this._nodeRoot(previousNodeKey));
      }
      return this._emitState();
    });
  }

  _resolveCwd(cwd, rootfs) {
    if (cwd == null || cwd === '') return { guestCwd: '/', hostPaths: [] };
    // "Absolute" is platform-aware on purpose: on Android this is the POSIX
    // check, while host-side tests can pass a real Windows temp directory.
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new TypeError('cwd must be an absolute path');
    }
    const resolved = path.resolve(cwd);
    if (pathIsWithin(rootfs, resolved)) {
      const relative = path.relative(rootfs, resolved).split(path.sep).filter(Boolean).join('/');
      return { guestCwd: relative ? `/${relative}` : '/', hostPaths: [] };
    }
    if (isGuestPath(cwd) || !existsSync(cwd)) {
      // A guest-namespace directory is never promoted to a host pass-through:
      // the launcher resolves a configured host directory before the rootfs, so
      // promoting /tmp or /etc would shadow the guest's own subtree. A path that
      // does not exist on the host is likewise only meaningful inside the guest.
      return { guestCwd: cwd, hostPaths: [] };
    }
    return { guestCwd: cwd, hostPaths: [cwd] };
  }

  _executionEnvironment(paths, cwdInfo) {
    const environment = cleanHostEnvironment();
    const nodeBin = path.join(paths.node, 'bin');
    const hostPaths = [nodeBin, ...cwdInfo.hostPaths];
    environment.BIONILUX_ROOTFS = paths.rootfs;
    environment.BIONILUX_PRELOAD = paths.preload;
    environment.BIONILUX_GUEST_CWD = cwdInfo.guestCwd;
    environment.BIONILUX_GUEST_PATH = `${nodeBin}:${DEFAULT_GUEST_PATH}`;
    environment.BIONILUX_HOST_PATHS = [...new Set(hostPaths)].join(':');
    environment.BIONILUX_FAKE_ROOT = '1';
    environment.BIONILUX_LENIENT = '0';
    environment.BIONILUX_ANDROID_PATHS = '1';
    environment.PATH = `${nodeBin}${path.delimiter}${environment.PATH ?? ''}`;
    return environment;
  }

  async execute({ command, cwd, timeout, signal } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError('command must be a non-empty string');
    }
    // Close the microtask window where a command was admitted just before
    // management announced a cutover: release the permit and wait instead of
    // spawning a guest process that the drain would not see.
    for (;;) {
      await this.gate.acquireShared();
      if (!this.gate.managementPending) break;
      this.gate.releaseShared();
    }
    try {
      if (this.disposed) throw new Error('manager is disposed');
      const current = this.status();
      if (!current.healthy) {
        throw new Error(`Linux runtime is unavailable: ${current.reason ?? 'unhealthy'}`);
      }
      const cwdInfo = this._resolveCwd(cwd, current.paths.rootfs);
      const environment = this._executionEnvironment(current.paths, cwdInfo);
      const result = normaliseCommandResult(
        await this._runManaged({
          file: current.paths.launcher,
          args: ['/bin/bash', '-lc', command],
          cwd: this.dataDir,
          env: environment,
          timeout,
          signal,
        }),
      );
      return {
        ...result,
        cwd: cwdInfo.guestCwd,
        runtimeId: current.runtimeId,
        architecture: current.architecture,
      };
    } finally {
      this.gate.releaseShared();
    }
  }

  async dispose() {
    const result = await this._exclusive(async () => {
      if (this.disposed) return;
      await this._stopChildren();
      this.disposed = true;
      this.children.clear();
      this._emitState();
      this.events.removeAllListeners();
    });
    const owners = liveManagers();
    if (owners.get(this._ownerKey) === this) owners.delete(this._ownerKey);
    return result;
  }
}

/**
 * Content-addressed identity of the shared Linux Node package.
 *
 * Keying by the archive digest means an unrelated Linux system release that
 * ships the same Node archive reuses the existing installation instead of
 * downloading and installing Node again.
 */
function nodeKeyFor(runtime) {
  const sha256 = runtime?.nodeAsset?.sha256;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError('runtime.nodeAsset.sha256 is required for the shared Linux Node');
  }
  return `sha256-${sha256}`;
}

function requireDirectoryEntries(directory) {
  // The synchronous form keeps status/uninstall fail-closed without making
  // status() unexpectedly asynchronous.
  return readdirSync(directory, { withFileTypes: true });
}

export function createManager(options) {
  return new LinuxRuntimeManager(options);
}
