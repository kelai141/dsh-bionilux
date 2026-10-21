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

export { createManager, LinuxRuntimeManager, ExecutionGate };
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

  const parameterSchema = {
    command: { type: 'string', required: true, description: 'Shell command to run as /bin/bash -lc inside the Linux environment.' },
    cwd: { type: 'string', description: 'Absolute working directory. A guest path such as /root or a shared host directory.' },
    timeoutMs: { type: 'number', description: 'Command timeout in milliseconds.' },
  };

  const tool = {
    name: 'linux_bash',
    description: LINUX_BASH_DESCRIPTION,
    parameters: parameterSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          exitCode: { type: 'number' },
          timedOut: { type: 'boolean' },
          cwd: { type: 'string' },
          runtimeId: { type: 'string' },
        },
      },
      render: (_args, value) =>
        [
          { type: 'text', text: String(value?.stdout ?? '') },
          value?.stderr ? { type: 'text', text: String(value.stderr) } : null,
        ].filter(Boolean),
    },
    execute: async (args = {}) => {
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
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

  return tools.register(tool);
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
