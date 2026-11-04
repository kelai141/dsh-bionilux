/**
 * @dsh-android/linux-runtime — the experimental DSH Mobile Linux capability plugin.
 *
 * This is our own internal plugin: it ships in the built-in (hard) plugin
 * directory, but it is **not enabled by default** — presence is not activation.
 * Only an explicit user action (enabling the system and confirming the install)
 * loads and activates it.
 *
 * It owns the runtime lifecycle (install, reinstall, uninstall, health) and the
 * Agent-facing `linux_bash` tool. Bionilux, the Debian minimal rootfs and the
 * shared glibc Node.js package are downloaded, checksum-verified release assets
 * managed by the bootstrap plugin, not code in this package.
 */
import { createManager, LinuxRuntimeManager, ExecutionGate } from '../modules/manager.js';
import { SessionRegistry } from '../modules/session.js';

export { createManager, LinuxRuntimeManager, ExecutionGate };
export { PersistentSession, SessionRegistry, SessionProtocolParser, assertSessionId } from '../modules/session.js';
export {
  selectRuntime,
  validateManifest,
  validateAsset,
  MANIFEST_SCHEMA_VERSION,
  PACKAGE_VERSION,
  DEFAULT_RUNTIME_IDS,
  defaultRuntimeIdForArch,
  resolveHostArchitecture,
} from '../modules/manifest.js';
export { installPluginAsset, assertOfficialAssetUrl, isAllowedAssetOrigin, verifyDownloadedAsset } from '../modules/asset-installer.js';

export const name = 'dsh-linux-runtime';

/** The only service this plugin needs: the host's explicit injection adapter. */
export const inject = ['tools'];

/**
 * Agent-facing description of the Linux environment.
 *
 * The distinction from the existing Termux shell is written for the Agent: the
 * two shells are different *execution environments*, not two names for one
 * thing, and the Linux one provides runtime support (Debian/glibc packages), not
 * a security boundary.
 */
export const LINUX_BASH_DESCRIPTION = [
  'Run a shell command inside the DSH Mobile Linux environment (Debian/glibc user space, own apt/dpkg).',
  'Use it when a task needs Debian packages, glibc, or Linux-only build tooling.',
  'The plain bash tool runs on the phone host (Android/Termux, Bionic libc, Termux packages): use that for phone-side work, Termux tooling and host paths.',
  'Inside Linux, npm/node resolve to the shared Linux glibc Node.js runtime, not the host Bionic Node.js.',
  'Paths follow guest semantics: /usr, /etc and /var are the Debian ones; the workspace and configured shared directories stay visible under their own absolute paths.',
  'This is a Debian environment, not a sandbox: guest root is a user-space identity and is not Android root.',
  'If the Linux runtime is not installed or unhealthy, the command fails with an explicit error. It never silently falls back to the Termux shell.',
].join(' ');

export const LINUX_SESSION_DESCRIPTION = [
  'Manage a persistent shell inside the DSH Mobile Linux environment. A session keeps exported variables and its working directory between tool calls.',
  'Use action=open to create it, action=run for a command that should finish, action=start for a long build, action=poll to read new job output by byte offset, and action=close to release it.',
  'Sessions are non-interactive: full-screen programs, job control and terminal resizing are unsupported. Use the background job output instead of a PTY.',
  'Sessions live in this plugin process only. A host or app restart ends them; open a new session after a restart.',
].join(' ');

const LINUX_BASH_OUTPUT_PROPERTIES = {
  stdout: { type: 'string', required: true },
  stderr: { type: 'string', required: true },
  exitCode: { type: 'number' },
  timedOut: { type: 'boolean' },
  cwd: { type: 'string' },
  runtimeId: { type: 'string' },
  session: { type: 'string' },
  sessionClosed: { type: 'boolean' },
  stdoutTruncated: { type: 'boolean' },
  stderrTruncated: { type: 'boolean' },
  running: { type: 'boolean' },
  pid: { type: 'number' },
};

const renderShellResult = (_args, value) =>
  [
    { type: 'text', text: String(value?.stdout ?? '') },
    value?.stderr ? { type: 'text', text: String(value.stderr) } : null,
  ].filter(Boolean);

/**
 * Register the persistent-session tool next to linux_bash.
 *
 * The registry is created here when the caller does not supply one, so a host
 * adapter that mounts this plugin gets persistent shells without extra
 * configuration.
 */
export function registerLinuxSession(ctx, manager, { registry = new SessionRegistry(manager), ownsRegistry = false } = {}) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== 'function') {
    if (ownsRegistry) void registry.dispose();
    return () => {};
  }
  const tool = {
    name: 'linux_session',
    description: LINUX_SESSION_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'open, run, start, poll, close or list.',
        enum: ['open', 'run', 'start', 'poll', 'close', 'list'],
      },
      session: {
        type: 'string',
        description: 'Session name. Defaults to session-1 for run/start/poll; open without a name allocates one.',
      },
      command: { type: 'string', description: 'Command for run or start. A run keeps the session shell state; start only launches a background job.' },
      cwd: { type: 'string', description: 'Absolute guest working directory for open or the next run/start.' },
      timeoutMs: { type: 'number', description: 'Timeout for run. A timed-out command closes its session.' },
      job: { type: 'string', description: 'Job identifier returned by start, required by poll.' },
      offset: { type: 'number', description: 'Byte offset returned by the previous poll.' },
      limitBytes: { type: 'number', description: 'Maximum job output bytes to return in this poll.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...LINUX_BASH_OUTPUT_PROPERTIES,
          action: { type: 'string' },
          job: { type: 'string' },
          nextOffset: { type: 'number' },
          eof: { type: 'boolean' },
          finished: { type: 'boolean' },
          sessions: { type: 'array' },
        },
      },
      render: renderShellResult,
    },
    execute: async (args = {}) => {
      const action = String(args.action ?? '').trim();
      const session = args.session == null || args.session === '' ? 'session-1' : String(args.session);
      if (action === 'open') {
        return { ...(await registry.open({ id: args.session, cwd: args.cwd })), action };
      }
      if (action === 'list') {
        return { action, sessions: registry.list(), stdout: '', stderr: '' };
      }
      if (action === 'close') {
        return { action, ...(await registry.close(session)), stdout: '', stderr: '' };
      }
      if (action === 'start') {
        const result = await registry.start(session, { command: String(args.command ?? ''), cwd: args.cwd });
        return { ...result, action, stdout: '', stderr: result.launchStderr ?? '' };
      }
      if (action === 'poll') {
        return { ...(await registry.poll(session, { job: args.job, offset: args.offset, limitBytes: args.limitBytes })), action };
      }
      if (action === 'run') {
        const result = await registry.run(session, {
          command: String(args.command ?? ''),
          cwd: args.cwd,
          timeoutMs: Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : undefined,
        });
        return { ...result, action, runtimeId: manager.status().runtimeId };
      }
      throw new Error('action must be one of open, run, start, poll, close or list');
    },
  };
  const disposeTool = tools.register(tool);
  return () => {
    try {
      disposeTool?.();
    } finally {
      if (ownsRegistry) void registry.dispose();
    }
  };
}

/**
 * Build the Agent tool face for a manager.
 *
 * Registration is dynamic: the tool exists only while the runtime is healthy, so
 * the Agent never sees a Linux tool that cannot run. Each execution re-reads
 * health and normalizes the result through the manager.
 *
 * @param {object} ctx - Cordis context (uses `ctx.tools.register` when present).
 * @param {import('../modules/manager.js').LinuxRuntimeManager} manager - Runtime manager.
 * @param {object} [options] - Extra tool metadata.
 * @returns {() => void} Disposer for the current registration.
 */
export function registerLinuxBash(ctx, manager, options = {}) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== 'function') return () => {};

  const registry = options.registry ?? new SessionRegistry(manager);
  const ownsRegistry = options.registry == null;

  const parameterSchema = {
    command: { type: 'string', required: true, description: 'Shell command. Runs as /bin/bash -c unless session is set; the configured guest PATH is preserved.' },
    cwd: { type: 'string', description: 'Absolute working directory. A guest path such as /root or a shared host directory.' },
    timeoutMs: { type: 'number', description: 'Command timeout in milliseconds.' },
    session: { type: 'string', description: 'Persistent session name. When set, the command runs in that shell and keeps its cwd and exported variables.' },
  };

  const tool = {
    name: 'linux_bash',
    description: LINUX_BASH_DESCRIPTION,
    parameters: parameterSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: LINUX_BASH_OUTPUT_PROPERTIES,
      },
      render: renderShellResult,
    },
    execute: async (args = {}) => {
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
      if (args.session != null && args.session !== '') {
        const result = await registry.run(String(args.session), {
          command: String(args.command ?? ''),
          cwd: args.cwd,
          timeoutMs,
        });
        if (result.timedOut) {
          throw new Error(`Command timed out after ${timeoutMs} ms; session ${String(args.session)} was closed.`);
        }
        return {
          ...result,
          runtimeId: manager.status().runtimeId,
          ...(options.metadata ?? {}),
        };
      }
      const result = await manager.execute({
        command: String(args.command ?? ''),
        cwd: args.cwd,
        timeout: timeoutMs,
      });
      if (result.timedOut) {
        throw new Error(`Command timed out after ${timeoutMs} ms inside the Linux environment.`);
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut,
        cwd: result.cwd,
        runtimeId: result.runtimeId,
        ...(options.metadata ?? {}),
      };
    },
  };

  const disposeBash = tools.register(tool);
  const disposeSession = registerLinuxSession(ctx, manager, { registry });
  return () => {
    try {
      disposeBash?.();
    } finally {
      try {
        disposeSession?.();
      } finally {
        if (ownsRegistry) void registry.dispose();
      }
    }
  };
}

/**
 * Cordis plugin body.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - Host-supplied configuration.
 * @param {object} [config.manager] - Prebuilt manager (host-owned instance).
 * @param {string} [config.dataDir] - Private app directory for rootfs, backend and shared Node.
 * @param {'arm64'|'x64'} [config.arch] - Target architecture.
 * @param {Function} [config.downloadAsset] - Checksum-verifying downloader.
 * @param {Function} [config.extractArchive] - Safe archive extractor.
 * @returns {import('../modules/manager.js').LinuxRuntimeManager} the manager.
 */
export function apply(ctx, config = {}) {
  // A manager supplied by the host belongs to the host. One created here must
  // stop its guest sessions when the plugin is unloaded.
  const ownsManager = config.manager == null;
  const manager =
    config.manager ??
    createManager({
      dataDir: config.dataDir,
      arch: config.arch,
      downloadAsset: config.downloadAsset ?? config.linuxAssetIO?.downloadAsset,
      extractArchive: config.extractArchive ?? config.linuxAssetIO?.extractArchive,
      fetchImpl: config.fetchImpl,
      runCommand: config.runCommand,
      onStateChange: config.onStateChange,
      dnsServers: config.dnsServers,
      dnsServersProvider: config.dnsServersProvider,
      dnsProbe: config.dnsProbe,
      dnsProbeTimeoutMs: config.dnsProbeTimeoutMs,
    });

  let disposeTool = () => {};
  const syncTool = () => {
    try {
      disposeTool();
    } catch {
      // A broken host tool disposer must not break a runtime state change.
    }
    disposeTool = () => {};
    if (manager.status().healthy) {
      try {
        disposeTool = registerLinuxBash(ctx, manager) ?? (() => {});
      } catch {
        disposeTool = () => {};
      }
    }
  };

  let cleaned = false;
  let cleanupResult;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      try { disposeTool(); } catch { /* Still release owned runtime resources. */ }
      disposeTool = () => {};
      manager.off('change', syncTool);
      cleanupResult = ownsManager ? manager.dispose() : undefined;
    }
    return cleanupResult;
  };

  try {
    // Register teardown before providing services: a failed plugin apply must
    // not retain the directory's manager lease indefinitely.
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
    manager.on('change', syncTool);
    syncTool();
    if (typeof ctx.provide === 'function') ctx.provide('linuxRuntimeManager', manager);
  } catch (error) {
    Promise.resolve(cleanup()).catch(() => undefined);
    throw error;
  }
  return manager;
}

export default { name, inject, apply, registerLinuxBash, LINUX_BASH_DESCRIPTION };
