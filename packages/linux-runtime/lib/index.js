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
  'For JDK, Android SDK, Gradle and APK compilation, run installation and every build step here or in linux_session, even when the output targets Android.',
  'The plain bash tool runs on the phone host (Android/Termux, Bionic libc, Termux packages): use that for phone-side work, Termux tooling and host paths.',
  'Inside Linux, npm/node resolve to the shared Linux glibc Node.js runtime, not the host Bionic Node.js.',
  'Paths follow guest semantics: /usr, /etc and /var are the Debian ones; the workspace and configured shared directories stay visible under their own absolute paths.',
  'The current conversation workspace is shared automatically with file editing tools and is the default working directory. Use those same absolute workspace paths for builds; /root belongs to the private Debian filesystem.',
  'This is a Debian environment, not a sandbox: guest root is a user-space identity and is not Android root.',
  'The Android kernel and /proc are shared. Android entries in /proc/1/root or lack of mount namespaces do not mean this command ran in Termux. Do not nest proot/chroot to enter Debian again.',
  'Without session this is a fresh shell on every call: cd and export do not persist. Pass the same session name or use linux_session to retain build environment state.',
  'If the Linux runtime is not installed or unhealthy, the command fails with an explicit error. It never silently falls back to the Termux shell.',
].join(' ');

export const LINUX_SESSION_DESCRIPTION = [
  'Manage a persistent shell inside the DSH Mobile Linux environment. A session keeps exported variables and its working directory between tool calls.',
  'Use this Debian/glibc shell for package installation, JDK/Android SDK/Gradle and APK builds. The plain bash tool is the separate Android/Termux host.',
  'Use action=open to create it, action=run for a command that should finish, action=start for a long build, action=poll to read new job output by byte offset, and action=close to release it.',
  'Sessions are non-interactive: full-screen programs, job control and terminal resizing are unsupported. Use the background job output instead of a PTY.',
  'Sessions live in this plugin process only. A host or app restart ends them; open a new session after a restart.',
].join(' ');

const LINUX_BASH_OUTPUT_PROPERTIES = {
  stdout: { type: 'string' },
  stderr: { type: 'string' },
  exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
  signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  timedOut: { type: 'boolean' },
  cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  runtimeId: { type: 'string' },
  session: { type: 'string' },
  sessionClosed: { type: 'boolean' },
  stdoutTruncated: { type: 'boolean' },
  stderrTruncated: { type: 'boolean' },
  running: { type: 'boolean' },
  pid: { oneOf: [{ type: 'number' }, { type: 'null' }] },
};

const renderShellResult = (_args, value) => {
  // The model receives rendered text. Job identifiers and byte offsets must be
  // present there so it can poll a long build without guessing internal state.
  const { stdout, stderr, ...metadata } = value ?? {};
  return [
    { type: 'text', text: 'Execution environment: Debian/glibc Linux (linux_bash/linux_session); Android kernel and /proc are shared.' },
    { type: 'text', text: String(stdout ?? '') },
    stderr ? { type: 'text', text: String(stderr) } : null,
    Object.keys(metadata).length ? { type: 'text', text: JSON.stringify(metadata) } : null,
  ].filter(Boolean);
};

/** Read the same per-conversation workspace service used by the file tools. */
async function executionDirectories(ctx, args, exec) {
  if (!exec?.agent || typeof ctx.get !== 'function') return { cwd: args.cwd };
  const directories = ctx.get('workingDirectory');
  if (typeof directories?.ensure !== 'function') throw new Error('Linux tools require the conversation working-directory service');
  const workspace = await directories.ensure(exec.agent, exec.signal);
  return { cwd: args.cwd, sharedPaths: [workspace] };
}

/**
 * Register the persistent-session tool next to linux_bash.
 *
 * The registry is created here when the caller does not supply one, so a host
 * adapter that mounts this plugin gets persistent shells without extra
 * configuration.
 */
export function registerLinuxSession(ctx, manager, { registry = new SessionRegistry(manager), registryFor, ownsRegistry = false } = {}) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== 'function') {
    if (ownsRegistry) void registry.dispose();
    return () => {};
  }
  const tool = {
    name: 'linux_session',
    description: LINUX_SESSION_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
      action: {
        type: 'string',
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
    execute: async (args = {}, exec) => {
      const sessions = registryFor?.(exec) ?? registry;
      const action = String(args.action ?? '').trim();
      const session = args.session == null || args.session === '' ? 'session-1' : String(args.session);
      const directories = ['open', 'run', 'start'].includes(action) ? await executionDirectories(ctx, args, exec) : {};
      if (action === 'open') {
        return { ...(await sessions.open({ id: args.session, ...directories })), action };
      }
      if (action === 'list') {
        return { action, sessions: sessions.list(), stdout: '', stderr: '' };
      }
      if (action === 'close') {
        return { action, ...(await sessions.close(session)), stdout: '', stderr: '' };
      }
      if (action === 'start') {
        const result = await sessions.start(session, { command: String(args.command ?? ''), ...directories });
        return { ...result, action, stdout: '', stderr: result.launchStderr ?? '' };
      }
      if (action === 'poll') {
        return { ...(await sessions.poll(session, { job: args.job, offset: args.offset, limitBytes: args.limitBytes })), action };
      }
      if (action === 'run') {
        const result = await sessions.run(session, {
          command: String(args.command ?? ''),
          ...directories,
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
  const scoped = new WeakMap();
  const ownedRegistries = new Set(ownsRegistry ? [registry] : []);
  const registryFor = exec => {
    if (!ownsRegistry || !exec?.agent) return registry;
    let sessions = scoped.get(exec.agent);
    if (!sessions) {
      sessions = new SessionRegistry(manager);
      scoped.set(exec.agent, sessions);
      ownedRegistries.add(sessions);
    }
    return sessions;
  };
  const releaseRegistries = () => {
    for (const sessions of ownedRegistries) void sessions.dispose();
    ownedRegistries.clear();
  };

  const parameterSchema = {
    command: { type: 'string', description: 'Shell command. Runs as /bin/bash -c unless session is set; the configured guest PATH is preserved.' },
    cwd: { type: 'string', description: 'Absolute working directory. A guest path such as /root or a shared host directory.' },
    timeoutMs: { type: 'number', description: 'Command timeout in milliseconds.' },
    session: { type: 'string', description: 'Persistent session name. When set, the command runs in that shell and keeps its cwd and exported variables.' },
  };

  const tool = {
    name: 'linux_bash',
    description: LINUX_BASH_DESCRIPTION,
    parameters: { type: 'object', properties: parameterSchema, required: ['command'], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stdout', 'stderr'],
        properties: LINUX_BASH_OUTPUT_PROPERTIES,
      },
      render: renderShellResult,
    },
    execute: async (args = {}, exec) => {
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
      const directories = await executionDirectories(ctx, args, exec);
      if (args.session != null && args.session !== '') {
        const result = await registryFor(exec).run(String(args.session), {
          command: String(args.command ?? ''),
          ...directories,
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
        ...directories,
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
  let disposeSession;
  try {
    disposeSession = registerLinuxSession(ctx, manager, { registry, registryFor });
  } catch (error) {
    disposeBash?.();
    releaseRegistries();
    throw error;
  }
  return () => {
    try {
      disposeBash?.();
    } finally {
      try {
        disposeSession?.();
      } finally {
        releaseRegistries();
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
 * @param {string} [config.nativeLibDir] - APK native library directory, the only place an app process may execute an ELF.
 * @returns {import('../modules/manager.js').LinuxRuntimeManager} the manager.
 */
export async function apply(ctx, config = {}) {
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
      nativeLibDir: config.nativeLibDir,
      probeTimeoutMs: config.probeTimeoutMs,
    });

  let disposeTool = () => {};
  let registered = false;
  let cleaned = false;
  const syncTool = () => {
    if (cleaned) return;
    const healthy = manager.status().healthy === true;
    // Verification refreshes also emit change. Do not dispose live persistent
    // registries on healthy -> healthy, including the session doing the probe.
    if (healthy && registered) return;
    if (!healthy && !registered) return;
    try {
      disposeTool();
    } catch {
      // A broken host tool disposer must not break a runtime state change.
    }
    registered = false;
    disposeTool = () => {};
    if (healthy) {
      // Activation must fail if the real registry rejects a tool. Reporting a
      // healthy environment while silently hiding its tools strands the agent.
      disposeTool = registerLinuxBash(ctx, manager) ?? (() => {});
      registered = true;
    }
  };
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
    // A restored active.json is not evidence that Android can execute this
    // backend. Prove Bash, external commands and shared Node before publishing
    // the service or tools; a failed proof remains visible but unregistered.
    if (typeof manager.verify === 'function') await manager.verify();
    if (!cleaned) {
      syncTool();
      if (typeof ctx.provide === 'function') ctx.provide('linuxRuntimeManager', manager);
    }
  } catch (error) {
    Promise.resolve(cleanup()).catch(() => undefined);
    throw error;
  }
  return manager;
}

export default { name, inject, apply, registerLinuxBash, LINUX_BASH_DESCRIPTION };
