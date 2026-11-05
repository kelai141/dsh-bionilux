#!/usr/bin/env node
/**
 * Standalone device acceptance for the real installer and tool path.
 *
 * Run inside the Android app's host Node:
 *
 *   node standalone-device.mjs --install
 *   node standalone-device.mjs --serve [--install]
 *   node standalone-device.mjs --negative
 *   node standalone-device.mjs --negative-only
 *
 * The only acceptance-specific seams are the plugin host adapter and the
 * loopback fetch adapter. Everything after them is the production code:
 *
 *   local HTTP release server
 *     -> createMobileBootstrap
 *     -> linuxPluginHost.install -> real linux-runtime apply()
 *     -> real manager -> system tar -xJf for local archives
 *     -> real linux_bash registration and real SessionRegistry
 *
 * BN_FIXTURE is a private directory containing linux-release.json and every
 * archive it names. The local server reads that manifest, verifies each archive
 * against it, then serves the latest-release JSON and version-pinned download
 * paths. Downloads still pass through the production byte and SHA-256 checks.
 *
 * --serve binds 127.0.0.1:18790 (BN_SERVE_PORT overrides) and keeps the
 * installed runtime and persistent guest shell alive after the install report is
 * written. Its reports are separate files:
 *
 *   logs/standalone-device-install.json
 *   logs/standalone-device-service.json
 *
 * Negative cases are opt-in (--negative or --install). They corrupt only
 * linux-runtime-plugin.tar.xz by default, so the production digest check closes
 * the install before the large rootfs is fetched.
 *
 * This is not an Android UI integration: no settings slot, binder or Activity.
 * The HTTP adapter is this harness's own loopback server, with its own Bearer
 * token check. Android app-private TCP is visible across apps, so the token file
 * (mode 0600, BN_FIXTURE/service-token) is the access check. Reports describe the
 * adapter source explicitly.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// path.resolve() would interpret an Android guest absolute path as a host path
// when the harness itself runs in a different namespace.
const guestPaths = process.platform === 'android' || process.env.BN_GUEST_PATHS === '1';
const pathApi = guestPaths ? path.posix : path;
const fixtureRoot = pathApi.resolve(required(process.env.BN_FIXTURE, 'BN_FIXTURE'));
const dataDir = pathApi.join(fixtureRoot, 'data');
const logsRoot = pathApi.join(fixtureRoot, 'logs');
const installReportPath = pathApi.join(logsRoot, 'standalone-device-install.json');
const serviceReportPath = pathApi.join(logsRoot, 'standalone-device-service.json');
const tokenPath = pathApi.join(fixtureRoot, 'service-token');
const serveHost = process.env.BN_SERVE_HOST ?? '127.0.0.1';
const servePort = Number(process.env.BN_SERVE_PORT ?? 18790);
const expectedUid = Number(process.env.BN_EXPECT_UID ?? 10146);
const mobileVersion = process.env.BN_MOBILE_VERSION ?? '0.14.0';
const modes = new Set(process.argv.slice(2));
const shouldServe = modes.has('--serve');
const forceInstall = modes.has('--install');
const startedAt = new Date().toISOString();
const observations = [];
const httpLog = [];

const errorText = (error) => (error instanceof Error ? error.message : String(error));

function required(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(field + ' is required');
  return value;
}

function record(name, detail, extra = {}) {
  const entry = {
    name,
    actual: true,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    at: new Date().toISOString(),
    ...extra,
  };
  observations.push(entry);
  process.stderr.write('[acceptance] ' + name + ': ' + entry.detail + '\n');
  return entry;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}

async function findSourceRoot() {
  const candidates = [
    process.env.BN_SOURCE_ROOT,
    path.join(fixtureRoot, 'src'),
    path.resolve(here, '..', '..'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'packages', 'linux-bootstrap', 'src', 'index.js'))) {
      return path.resolve(candidate);
    }
  }
  throw new Error('cannot locate packages/linux-bootstrap; set BN_SOURCE_ROOT');
}

const sourceRoot = await findSourceRoot();
const resolveModule = (relative, override) => (override ? path.resolve(override) : path.join(sourceRoot, relative));
const bootstrapPath = resolveModule('packages/linux-bootstrap/src/index.js', process.env.BN_BOOTSTRAP_MODULE);
const routesPath = resolveModule('packages/linux-bootstrap/src/routes.js', process.env.BN_ROUTES_MODULE);
const sessionPath = resolveModule('packages/linux-runtime/modules/session.js', process.env.BN_SESSION_MODULE);
const serverPath = path.resolve(here, 'standalone-download-server.mjs');
const loadModule = (file) => import(pathToFileURL(file).href);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Make every acceptance-only difference visible in the reports.
 */
const adapter = Object.freeze({
  http: {
    source: 'tests/acceptance/standalone-download-server.mjs',
    productionWhitelistChanged: false,
    behavior: 'serves fixture archives and latest-release JSON over loopback',
  },
  fetch: {
    source: 'createLocalFetch in tests/acceptance/standalone-download-server.mjs',
    productionWhitelistChanged: false,
    behavior: 'rewrites official https://github.com URLs to local http only inside this harness; other URLs are rejected',
  },
  pluginHost: {
    source: 'tests/acceptance/standalone-device.mjs createPluginHost()',
    behavior: 'imports the verified runtime entry and supplies a Cordis-shaped ctx; plugin apply(), registration and manager are real',
  },
  archive: {
    source: 'Android system tar',
    behavior: 'tar -xJf extracts local xz archives and recreates native symbolic links',
  },
  tools: {
    source: 'packages/linux-runtime/lib/index.js apply()/ctx.tools.register',
    behavior: 'linux_bash is the real registered tool; session tools call the real SessionRegistry',
  },
  androidUi: 'not integrated; process/HTTP acceptance only',
  auth: {
    scheme: 'Authorization: Bearer <token>',
    tokenFile: tokenPath,
    tokenMode: '0600 (enforced on POSIX; Windows permissions not enforceable)',
    exempt: ['/health'],
    note: 'every route except /health requires Bearer; Android loopback is shared between apps, so the token is the access check',
  },
});

function environmentReport() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    uid: process.getuid?.() ?? null,
    expectedUid,
    app: process.env.BN_APP ?? null,
    packageName: process.env.BN_PACKAGE ?? null,
    prefix: process.env.PREFIX ?? null,
    ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null,
    home: process.env.HOME ?? null,
    tmpdir: process.env.TMPDIR ?? null,
    fixture: fixtureRoot,
    dataDir,
    sourceRoot,
    tokenFile: tokenPath,
  };
}

/**
 * Load the service token from its file, generating it only when absent.
 *
 * The token is only ever read from BN_FIXTURE/service-token after that file is
 * created. It is never accepted from the environment, printed or included in a
 * report: Android localhost ports are visible to other apps on the device, so an
 * unauthenticated route is not private.
 */
async function loadServiceToken() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  let generated = false;
  let existing;
  try {
    existing = readFileSync(tokenPath, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing == null) {
    await fs.writeFile(tokenPath, randomBytes(32).toString('base64url') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.chmod(tokenPath, 0o600).catch(() => undefined);
    generated = true;
  }
  // Always read back from the file. This is the only token source, so a caller
  // cannot inject one through the environment.
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new TypeError('service token file must contain 32-256 base64url characters');
  }
  const mode = (await fs.stat(tokenPath)).mode & 0o777;
  // Windows reports synthetic 0666 permissions even for mode 0600. Android
  // must enforce the real check; no report may claim 0600 on a filesystem that
  // cannot express it.
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new Error('service token file must be mode 0600, got ' + mode.toString(8));
  }
  return {
    token,
    path: tokenPath,
    mode,
    modeEnforced: process.platform !== 'win32',
    generated,
  };
}

function authorized(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(value);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function runProcess(file, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The close event reports the failure.
      }
    }, timeout);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, signal, timedOut });
    });
  });
}

async function tarVersion() {
  try {
    const value = await runProcess('tar', ['--version'], { timeout: 15_000 });
    return { ok: value.exitCode === 0, line: value.stdout.split('\n')[0].trim(), stderr: value.stderr.trim() };
  } catch (error) {
    return { ok: false, line: null, stderr: errorText(error) };
  }
}

/**
 * Extract with the device's system tar.
 *
 * xJf is deliberate: xz decoding and native symbolic links belong to the host,
 * and production extraction is host-owned. The manifest unpackedSize convention
 * counts regular files only, so links are never followed here.
 */
async function extractArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  const args = ['-xJf', archive, '-C', destination];
  // The device path always uses native links. On a Windows host tar cannot
  // create POSIX symlinks without elevation; that host-only fallback is opt-in
  // and recorded, so it is never mistaken for the device contract.
  if (process.platform === 'win32' && process.env.BN_WINDOWS_LINK_COPY === '1') args.push('--no-same-permissions');
  const result = await runProcess('tar', args, { timeout: 600_000 });
  if (result.exitCode !== 0) {
    throw new Error('tar -xJf failed for ' + path.basename(archive) + ': ' + (result.stderr.trim() || 'exit ' + result.exitCode));
  }
}

async function digestFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Count regular files without following symbolic links.
 *
 * This mirrors the manager's measureUnpackedBytes contract: symlinks contribute
 * zero bytes and are never traversed; hard-linked inodes count once. Do not
 * "improve" this by following links or summing tar's logical size.
 */
async function measureUnpackedBytes(directory) {
  let total = 0;
  const seen = new Set();
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!stat.isFile()) throw new Error('unsupported archive entry: ' + target);
      const identity = stat.dev + ':' + stat.ino;
      if (seen.has(identity)) continue;
      seen.add(identity);
      total += stat.size;
    }
  }
  await visit(directory);
  return total;
}

async function inspectTree(directory) {
  const symlinks = [];
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        symlinks.push({ path: path.relative(directory, target), target: await fs.readlink(target) });
        continue;
      }
      if (stat.isDirectory()) {
        await visit(target);
        continue;
      }
      if (stat.isFile()) files.push(path.relative(directory, target));
    }
  }
  await visit(directory);
  return { symlinks, files };
}

function packageRootOf(directory) {
  if (existsSync(path.join(directory, 'package.json'))) return directory;
  const nested = path.join(directory, 'package');
  if (existsSync(path.join(nested, 'package.json'))) return nested;
  throw new Error('runtime plugin bundle has no package.json');
}

async function verifyExtractedTree(directory, asset, label) {
  const measured = await measureUnpackedBytes(directory);
  const tree = await inspectTree(directory);
  assert.equal(measured, asset.unpackedSize, label + ' unpacked regular-file bytes differ from the manifest');
  record(label + '-tree', {
    measured,
    declaredUnpackedSize: asset.unpackedSize,
    files: tree.files.length,
    symlinks: tree.symlinks.length,
    symlinkSamples: tree.symlinks.slice(0, 5),
  });
  return { measured, ...tree };
}

/**
 * Host adapter for the runtime plugin.
 *
 * The host's real job is to import a verified directory and turn the plugin's
 * registration context into host services. That is all this adapter does; it
 * does not implement manifest validation, activation or lifecycle semantics.
 */
function createPluginHost({ runtimeDir, arch, fetchImpl, assetsBySha }) {
  const loaded = [];
  const downloadLog = [];
  const extractLog = [];
  // One host adapter may apply the same runtime twice (restore, then bootstrap
  // activation). The plugin directory is content addressed but each import is a
  // fresh module instance, so keep the live owner by data directory here.
  const managedByDirectory = new Map();

  async function downloadAsset(asset, options = {}) {
    // Two production adapters disagree on the second argument: the runtime
    // manager passes a destination string, while the bootstrap passes
    // { destination, fetchImpl }. Support both without guessing from asset.url.
    const destination = typeof options === 'string'
      ? options
      : typeof options?.destination === 'string'
        ? options.destination
        : asset.path;
    assert.ok(typeof destination === 'string' && destination.length > 0, 'download destination is required');
    const fetchForDownload = (typeof options === 'object' ? options?.fetchImpl : undefined) ?? fetchImpl;
    const response = await fetchForDownload(asset.url);
    if (!response.ok) {
      record('download-http-failure', {
        url: asset.url,
        status: response.status,
        declaredBytes: asset.size,
      });
      throw new Error('asset download failed: HTTP ' + response.status + ' for ' + asset.url);
    }
    if (!response.body) throw new Error('asset download response has no body stream');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Stream to disk. The rootfs is hundreds of MB and must never be buffered
    // in the host Node heap. Runtime and bootstrap callers pass the same
    // archive path, so open must tolerate truncating a prior partial attempt.
    const handle = await fs.open(destination, 'w');
    const hash = createHash('sha256');
    let receivedBytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        receivedBytes += chunk.length;
        if (receivedBytes > asset.size) {
          throw new Error('asset exceeded declared bytes: ' + asset.size + ' for ' + asset.url);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    const receivedSha256 = hash.digest('hex');
    const entry = {
      name: path.basename(new URL(asset.url).pathname),
      declaredBytes: asset.size,
      receivedBytes,
      declaredSha256: asset.sha256,
      receivedSha256,
      httpStatus: response.status,
    };
    downloadLog.push(entry);
  }

  async function extractForAsset(archive, destination, options = {}) {
    const kind = options.kind ?? 'asset';
    const archivePath = String(archive);
    const digest = await digestFile(archivePath);
    await extractArchive(archivePath, destination);
    const asset = assetsBySha.get(digest.sha256) ?? null;
    const entry = {
      kind,
      archive: path.basename(archivePath),
      archiveSha256: digest.sha256,
      archiveBytes: digest.size,
      assetName: asset?.name ?? null,
      destination,
    };
    extractLog.push(entry);
    if (asset) {
      const target = kind === 'plugin' ? packageRootOf(destination) : destination;
      await verifyExtractedTree(target, asset, kind + '-' + asset.name);
    } else {
      record(kind + '-archive-unknown', 'extracted archive is not in the manifest: ' + entry.archive, {
        archiveSha256: digest.sha256,
      });
    }
  }

  async function install({ directory, entry, config, enable }) {
    if (enable !== true) throw new Error('runtime activation requires explicit enable');
    const entryPath = path.resolve(directory, entry ?? 'lib/index.js');
    const relative = path.relative(directory, entryPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
      throw new Error('verified plugin entry escaped its directory');
    }
    if (!existsSync(entryPath)) throw new Error('verified plugin entry is missing: ' + entryPath);
    const module = await loadModule(entryPath);
    const tools = new Map();
    const disposers = [];
    const ctx = {
      tools: {
        register(tool) {
          if (!tool || typeof tool.name !== 'string') throw new TypeError('tool registration requires a name');
          tools.set(tool.name, tool);
          const dispose = () => {
            if (tools.get(tool.name) === tool) tools.delete(tool.name);
          };
          disposers.push(dispose);
          return dispose;
        },
      },
      effect(dispose) {
        if (typeof dispose === 'function') disposers.push(dispose);
        return () => {};
      },
      provide(name, service) {
        this.services ??= {};
        this.services[name] = service;
      },
    };
    const runtimeConfig = {
      ...config,
      dataDir: runtimeDir,
      arch,
      downloadAsset,
      extractArchive: extractForAsset,
      fetchImpl,
    };
    // A restored plugin already has its manager-installed tree. Passing the
    // manager through avoids re-running manager.install(), which would replace
    // the active instance and its work directory.
    const persistedActive = path.join(runtimeConfig.dataDir, 'active.json');
    if (existsSync(persistedActive)) {
      const owner = managedByDirectory.get(runtimeConfig.dataDir);
      if (owner && !owner.disposed) {
        runtimeConfig.manager = owner;
      } else {
        const { createManager } = await loadModule(resolveModule('packages/linux-runtime/modules/manager.js'));
        runtimeConfig.manager = createManager({
          dataDir: runtimeConfig.dataDir,
          arch,
          downloadAsset,
          extractArchive: extractForAsset,
          fetchImpl,
        });
        managedByDirectory.set(runtimeConfig.dataDir, runtimeConfig.manager);
      }
    }
    let manager;
    try {
      manager = module.apply(ctx, runtimeConfig);
    } catch (error) {
      // A module copy loaded from a content-addressed directory has its own
      // manager registry. If another copy already claimed this data directory,
      // reuse that live owner instead of duplicating it.
      const owner = managedByDirectory.get(runtimeConfig.dataDir);
      if (error?.code !== 'ERR_RUNTIME_MANAGER_IN_USE' || !owner) throw error;
      runtimeConfig.manager = owner;
      manager = module.apply(ctx, runtimeConfig);
    }
    managedByDirectory.set(runtimeConfig.dataDir, manager);
    if (!manager || typeof manager.install !== 'function') {
      throw new Error('runtime plugin did not return a manager');
    }
    const loadedPlugin = { directory, entry, module, manager, tools, ctx };
    loaded.push(loadedPlugin);
    return {
      manager,
      tools,
      service: manager,
      plugin: loadedPlugin,
      rollback: async () => {
        for (const dispose of [...disposers].reverse()) {
          try {
            await dispose();
          } catch {
            // Manager disposal below is the final cleanup.
          }
        }
        await manager.dispose?.();
        const index = loaded.indexOf(loadedPlugin);
        if (index >= 0) loaded.splice(index, 1);
      },
    };
  }

  /**
   * Restore a plugin that bootstrap already persisted.
   *
   * The host owns plugin injection, so a new process must re-import the verified
   * directory before bootstrap.load() asks isInjected(). This is a restore, not
   * an install: no archive is fetched and the active runtime instance is kept.
   */
  async function restorePersisted(statePath) {
    if (loaded.length > 0) return false;
    if (process.env.BN_FORCE_PLUGIN_LOAD === '1') {
      const forced = process.env.BN_PLUGIN_DIRECTORY;
      if (!forced) throw new Error('BN_PLUGIN_DIRECTORY is required with BN_FORCE_PLUGIN_LOAD=1');
      await install({
        directory: path.resolve(forced),
        entry: 'lib/index.js',
        config: {},
        enable: true,
      });
      return true;
    }
    let state;
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch {
      return false;
    }
    if (!state?.installedLinuxVersion || typeof state.pluginDirectory !== 'string') return false;
    if (!existsSync(state.pluginDirectory)) {
      throw new Error('persisted runtime plugin directory is missing: ' + state.pluginDirectory);
    }
    await install({
      directory: state.pluginDirectory,
      entry: 'lib/index.js',
      config: {
        runtimeId: state.runtimeId ?? null,
        manifest: state.pinnedManifest ?? state.availableManifest ?? null,
      },
      enable: true,
    });
    return true;
  }

  async function uninstall({ rollback } = {}) {
    const value = loaded.pop();
    if (!value) return;
    if (rollback !== true) return;
    try {
      for (const name of [...value.tools.keys()]) value.tools.delete(name);
      await value.manager.dispose?.();
    } finally {
      value.tools.clear();
    }
  }

  return {
    loaded,
    downloadLog,
    extractLog,
    downloadAsset,
    extractArchive: extractForAsset,
    install,
    restorePersisted,
    uninstall,
    async isInjected() {
      return { injected: loaded.length > 0, active: loaded.length > 0 };
    },
  };
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        fail(Object.assign(new Error('request body exceeds ' + limit + ' bytes'), {
          statusCode: 413,
          code: 'ERR_REQUEST_BODY_TOO_LARGE',
        }));
        // Keep consuming the stream so the client receives the JSON 413
        // instead of a reset connection mid-upload.
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.once('error', fail);
    request.once('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('request body must be JSON'), { statusCode: 400 }));
      }
    });
  });
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
  });
  response.end(bytes);
}

/**
 * Install once through the real bootstrap path, then optionally keep it alive.
 */
async function createRuntime({ fixture, server, arch, withSessions }) {
  const { createMobileBootstrap } = await loadModule(bootstrapPath);
  const { LINUX_ENVIRONMENT_ROUTES, createRouteHandlers } = await loadModule(routesPath);
  const { createLocalFetch } = await loadModule(serverPath);
  const { SessionRegistry } = withSessions ? await loadModule(sessionPath) : {};
  const assetsBySha = new Map([...server.fixture.files.values()].map((asset) => [asset.sha256, asset]));
  const rewrites = [];
  const localFetch = createLocalFetch({
    origin: server.origin,
    onRewrite: (entry) => rewrites.push(entry),
  });
  const pluginHost = createPluginHost({
    runtimeDir: path.join(dataDir, 'runtime'),
    arch,
    fetchImpl: localFetch,
    assetsBySha,
  });
  const statePath = path.join(dataDir, 'linux-bootstrap-state.json');
  const restored = await pluginHost.restorePersisted(statePath);
  if (restored) {
    record('runtime-plugin-restored', statePath, {
      behavior: 're-imported persisted verified plugin; no download, no reinstall',
    });
  }
  const bootstrap = createMobileBootstrap({
    dataDir,
    arch,
    releaseUrl: 'https://github.com/' + fixture.identity.owner + '/' + fixture.identity.repo + '/releases/latest',
    appVersionProvider: () => mobileVersion,
    pluginHost,
    fetchImpl: localFetch,
    downloadAsset: pluginHost.downloadAsset,
    extractArchive: pluginHost.extractArchive,
    autoUpdateEnabled: false,
  });
  const handlers = createRouteHandlers(bootstrap);
  await bootstrap.ready;
  const before = await handlers.status();
  let installed = before;
  // A persisted install is resumed, never reinstalled: reinstall() would
  // replace the active instance and destroy the work directory under test.
  if (forceInstall || !before.installed || !before.enabled) {
    installed = await handlers.install({ body: { confirmed: true } });
  }
  const plugin = pluginHost.loaded.at(-1);
  if (!plugin) {
    throw new Error(
      'bootstrap reports installed=' + before.installed +
      ' enabled=' + before.enabled +
      ' but did not restore the runtime plugin through linuxPluginHost; ' +
      'delete BN_FIXTURE/data to install fresh',
    );
  }
  const managerStatus = plugin.manager.status();
  assert.equal(managerStatus.healthy, true, managerStatus.reason);
  const registry = withSessions ? new SessionRegistry(plugin.manager) : null;
  if (registry) {
    await registry.open({ id: 'default' });
    const first = await registry.run('default', {
      command: 'export BN_ACCEPTANCE_VALUE=persisted; printf "opened:%s\\n" "$PWD"',
      timeoutMs: 60_000,
    });
    assert.equal(first.exitCode, 0, first.stderr);
    const second = await registry.run('default', {
      command: 'printf "reused:%s\\n" "$BN_ACCEPTANCE_VALUE"',
      timeoutMs: 60_000,
    });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stdout, /reused:persisted/);
    record('persistent-session-reuse', second.stdout.trim(), {
      source: 'real packages/linux-runtime/modules/session.js SessionRegistry',
      session: 'default',
    });
  }
  return {
    bootstrap,
    handlers,
    pluginHost,
    plugin,
    manager: plugin.manager,
    tools: plugin.tools,
    registry,
    rewrites,
    routes: LINUX_ENVIRONMENT_ROUTES,
  };
}

/**
 * Prove a tampered HTTP response is rejected by production code.
 *
 * Each case uses fresh state and a fresh plugin host, so a failure cannot be
 * confused with the successful install or with another case.
 */
async function verifyFailureClosed({ fixture, arch, mode }) {
  const { startDownloadServer } = await loadModule(serverPath);
  const { createMobileBootstrap } = await loadModule(bootstrapPath);
  const { createLocalFetch } = await loadModule(serverPath);
  const tampered = await startDownloadServer({
    fixture: fixture.directory,
    origin: 'http://127.0.0.1:0',
    tamper: mode,
  });
  const caseRoot = path.join(fixtureRoot, 'negative-' + mode);
  const caseData = path.join(caseRoot, 'data');
  await fs.rm(caseRoot, { recursive: true, force: true });
  await fs.mkdir(caseData, { recursive: true });
  const assetsBySha = new Map([...tampered.fixture.files.values()].map((asset) => [asset.sha256, asset]));
  const rewrites = [];
  const localFetch = createLocalFetch({ origin: tampered.origin, onRewrite: (entry) => rewrites.push(entry) });
  const pluginHost = createPluginHost({
    runtimeDir: path.join(caseData, 'runtime'),
    arch,
    fetchImpl: localFetch,
    assetsBySha,
  });
  try {
    const bootstrap = createMobileBootstrap({
      dataDir: caseData,
      arch,
      releaseUrl: 'https://github.com/' + fixture.identity.owner + '/' + fixture.identity.repo + '/releases/latest',
      appVersionProvider: () => mobileVersion,
      pluginHost,
      fetchImpl: localFetch,
      downloadAsset: pluginHost.downloadAsset,
      extractArchive: pluginHost.extractArchive,
      autoUpdateEnabled: false,
    });
    await bootstrap.ready;
    let rejection = null;
    await assert.rejects(
      () => bootstrap.install({ confirmed: true, activate: true }),
      (error) => {
        rejection = error;
        return true;
      },
    );
    const status = await bootstrap.status();
    assert.equal(status.installed, false, mode + ' tamper must not activate a runtime');
    assert.equal(status.enabled, false, mode + ' tamper must not enable a runtime');
    assert.equal(pluginHost.loaded.length, 0, mode + ' tamper must not leave the runtime plugin loaded');
    const assetHits = tampered.requests.filter((request) => request.kind === 'asset');
    assert.ok(assetHits.length >= 1, mode + ' case must observe a real HTTP asset request');
    assert.ok(assetHits.some((request) => request.tampered === mode), mode + ' case did not tamper the asset stream');
    if (mode === 'digest') {
      assert.match(errorText(rejection), /SHA-256|checksum|digest/i);
    }
    record(mode + '-tamper-fails-closed', {
      message: errorText(rejection),
      statusError: status.error ?? null,
      httpAssetRequests: assetHits.length,
      pluginLoaded: pluginHost.loaded.length,
    }, { expected: 'rejected' });
    return { rejection, status, assetHits };
  } finally {
    await pluginHost.uninstall?.({ rollback: true }).catch(() => undefined);
    await tampered.close();
  }
}

function routeDefinitions(routes) {
  return Object.values(routes).map((route) => route.method + ' ' + route.path);
}

function sessionTools() {
  return [
    {
      name: 'session_open',
      description: 'Open or reuse a named persistent bash session in the installed Linux runtime.',
      parameters: { id: { type: 'string' }, cwd: { type: 'string' } },
    },
    {
      name: 'session_run',
      description: 'Run a command in a named persistent bash session, reusing exported state and cwd.',
      parameters: {
        session: { type: 'string', required: true },
        command: { type: 'string', required: true },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
    },
    {
      name: 'session_close',
      description: 'Close a named persistent bash session.',
      parameters: { session: { type: 'string', required: true } },
    },
    {
      name: 'session_list',
      description: 'List named persistent bash sessions owned by this service.',
      parameters: {},
    },
  ].map((tool) => ({ ...tool, source: 'acceptance adapter over real SessionRegistry' }));
}

async function serve(runtime, auth) {
  if (!runtime.registry) throw new Error('serve mode requires the real SessionRegistry');
  if (!auth || typeof auth.token !== 'string') throw new Error('serve mode requires the service token');
  const routes = runtime.routes;
  const handlers = runtime.handlers;
  const manager = runtime.manager;
  const tools = runtime.tools;
  const extraTools = sessionTools();
  let closing = false;

  async function snapshot(extra = {}) {
    const bootstrapStatus = await runtime.bootstrap.status();
    const managerStatus = manager.status();
    return {
      kind: 'standalone-device-service',
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      adapter,
      bind: { host: serveHost, port: servePort },
      environment: environmentReport(),
      installed: bootstrapStatus.installed,
      enabled: bootstrapStatus.enabled,
      version: bootstrapStatus.version,
      runtimeId: bootstrapStatus.runtimeId,
      manager: {
        healthy: managerStatus.healthy,
        state: managerStatus.state,
        reason: managerStatus.reason ?? null,
      },
      routes: routeDefinitions(routes),
      tools: [...tools.keys()],
      sessionTools: extraTools.map((tool) => tool.name),
      sessions: runtime.registry.list(),
      auth: {
        enabled: true,
        tokenFile: auth.path,
        tokenMode: auth.modeEnforced ? auth.mode.toString(8) : 'not enforceable on ' + process.platform,
        exempt: ['/health'],
      },
      requests: httpLog.slice(-200),
      ...extra,
    };
  }

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const entry = { at: new Date().toISOString(), method: request.method, path: request.url, status: 0, durationMs: 0, authenticated: false };
    httpLog.push(entry);
    if (httpLog.length > 500) httpLog.splice(0, httpLog.length - 500);
    try {
      const url = new URL(request.url, 'http://' + serveHost);
      const pathname = url.pathname;
      if (pathname === '/health') {
        const value = await snapshot();
        const ready = value.installed && value.manager.healthy;
        sendJson(response, ready ? 200 : 503, {
          ok: ready,
          ready,
          version: value.version,
          runtimeId: value.runtimeId,
          manager: value.manager,
          tools: value.tools,
          sessions: value.sessions,
          uid: value.environment.uid,
          adapter: 'loopback-http-acceptance',
        });
        entry.status = ready ? 200 : 503;
        return;
      }
      if (!authorized(request, auth.token)) {
        sendJson(response, 401, {
          ok: false,
          error: 'Authorization: Bearer <token> is required',
          tokenFile: auth.path,
        });
        entry.status = 401;
        return;
      }
      entry.authenticated = true;
      if (pathname === '/tools' && request.method === 'GET') {
        sendJson(response, 200, {
          tools: [
            ...[...tools.entries()].map(([name, tool]) => ({
              name,
              description: tool.description ?? null,
              parameters: tool.parameters ?? null,
              source: 'packages/linux-runtime/lib/index.js apply()/ctx.tools.register',
            })),
            ...extraTools,
          ],
          sessions: runtime.registry.list(),
        });
        entry.status = 200;
        return;
      }
      if (pathname.startsWith('/tools/') && request.method === 'POST') {
        const name = decodeURIComponent(pathname.slice('/tools/'.length));
        const body = await readBody(request);
        // Dispatch through the actual registration. Do not forward only a
        // hand-picked argument subset: additional registered tools (including
        // linux_session) must receive their own body unchanged.
        if (tools.has(name)) {
          const tool = tools.get(name);
          if (!tool || typeof tool.execute !== 'function') {
            throw new Error('registered tool has no execute(): ' + name);
          }
          const value = await tool.execute(body);
          sendJson(response, 200, { ok: true, tool: name, ...value });
          entry.status = 200;
          return;
        }
        if (name === 'session_open') {
          sendJson(response, 200, {
            ok: true,
            tool: name,
            ...(await runtime.registry.open({ id: body.id, cwd: body.cwd })),
          });
          entry.status = 200;
          return;
        }
        if (name === 'session_run') {
          if (typeof body.session !== 'string') throw new TypeError('session is required');
          const value = await runtime.registry.run(body.session, {
            command: body.command,
            cwd: body.cwd,
            timeoutMs: body.timeoutMs,
          });
          sendJson(response, 200, { ok: true, tool: name, ...value });
          entry.status = 200;
          return;
        }
        if (name === 'session_close') {
          if (typeof body.session !== 'string') throw new TypeError('session is required');
          sendJson(response, 200, { ok: true, tool: name, ...(await runtime.registry.close(body.session)) });
          entry.status = 200;
          return;
        }
        if (name === 'session_list') {
          sendJson(response, 200, { ok: true, tool: name, sessions: runtime.registry.list() });
          entry.status = 200;
          return;
        }
        throw Object.assign(new Error('unknown tool: ' + name), { statusCode: 404 });
      }
      const routeName = Object.keys(routes).find((key) => routes[key].path === pathname);
      if (routeName) {
        const definition = routes[routeName];
        if (definition.method !== request.method) {
          sendJson(response, 405, { ok: false, error: 'method must be ' + definition.method });
          entry.status = 405;
          return;
        }
        const body = definition.method === 'GET' ? {} : await readBody(request);
        const result = await handlers[routeName]({ body, request });
        sendJson(response, 200, result);
        entry.status = 200;
        return;
      }
      if (pathname === '/sessions' && request.method === 'GET') {
        sendJson(response, 200, { sessions: runtime.registry.list() });
        entry.status = 200;
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not found', path: pathname });
      entry.status = 404;
    } catch (error) {
      entry.status = error?.statusCode ?? 500;
      // A rejected oversized upload may still be streaming. Stop the response
      // cleanly after its JSON error, rather than reusing a half-read request.
      if (error?.code === 'ERR_REQUEST_BODY_TOO_LARGE') entry.bodyRejected = true;
      sendJson(response, entry.status, {
        ok: false,
        error: errorText(error),
        code: error?.code ?? null,
      });
    } finally {
      entry.durationMs = Date.now() - started;
      await writeJson(serviceReportPath, await snapshot({ lastRequest: entry })).catch(() => undefined);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(servePort, serveHost, resolve);
  });
  record('serve-listening', serveHost + ':' + servePort, {
    routes: routeDefinitions(routes),
    tools: [...tools.keys()],
    sessions: runtime.registry.list(),
    adapter: 'loopback-http-acceptance',
  });
  await writeJson(serviceReportPath, await snapshot());

  let shutdownPromise;
  const shutdown = (reason) => {
    shutdownPromise ??= (async () => {
      if (closing) return;
      closing = true;
      record('serve-shutdown', reason);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await runtime.registry.dispose().catch(() => undefined);
      await manager.dispose().catch(() => undefined);
      await writeJson(serviceReportPath, await snapshot({
        stoppedAt: new Date().toISOString(),
        reason,
      })).catch(() => undefined);
    })();
    return shutdownPromise;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      shutdown(signal).finally(() => process.exit(0));
    });
  }
  return { server, shutdown, snapshot };
}

async function main() {
  await fs.mkdir(logsRoot, { recursive: true });
  const auth = await loadServiceToken();
  const arch = process.arch;
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('unsupported device architecture: ' + arch);
  if (typeof process.getuid === 'function' && process.env.BN_ALLOW_UID_MISMATCH !== '1') {
    assert.equal(process.getuid(), expectedUid, 'harness must run as the expected app UID');
  }
  if (process.env.BN_APP && process.env.BN_REQUIRE_HOST_ENV !== '0') {
    assert.ok(process.env.PREFIX, 'PREFIX is required when running through the app host Node wrapper');
    assert.ok(process.env.LD_LIBRARY_PATH, 'LD_LIBRARY_PATH is required when running through the app host Node wrapper');
  }
  const manifestPath = path.join(fixtureRoot, 'linux-release.json');
  assert.equal(existsSync(manifestPath), true, 'linux-release.json is missing from BN_FIXTURE');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const tar = await tarVersion();
  assert.equal(tar.ok, true, 'Android system tar is required: ' + tar.stderr);
  record('environment', environmentReport());
  record('system-tar', tar.line, {
    source: 'Android system tar',
    command: 'tar -xJf <archive> -C <destination>',
  });

  const { startDownloadServer } = await loadModule(serverPath);
  const server = await startDownloadServer({
    fixture: fixtureRoot,
    origin: shouldServe ? 'http://127.0.0.1:0' : (process.env.BN_DOWNLOAD_ORIGIN ?? 'http://127.0.0.1:0'),
  });
  let runtime = null;
  let serveHandle = null;
  try {
    record('fixture', {
      directory: server.fixture.directory,
      version: server.fixture.manifest.version,
      tag: server.fixture.identity.tag,
      manifestBytes: server.fixture.manifestSize,
      manifestSha256: server.fixture.manifestSha256,
      assets: [...server.fixture.files.values()].map((asset) => ({
        name: asset.name,
        bytes: asset.size,
        unpackedSize: asset.unpackedSize,
      })),
    });
    assert.equal(server.fixture.manifest.version, manifest.version, 'server read a different manifest');
    assert.ok(
      server.fixture.manifest.runtimes.some((value) => value.architecture === arch),
      'fixture has no runtime for ' + arch,
    );

    if (forceInstall || modes.has('--negative') || modes.has('--negative-only')) {
      await verifyFailureClosed({ fixture: server.fixture, arch, mode: 'digest' });
      await verifyFailureClosed({ fixture: server.fixture, arch, mode: 'truncate' });
    }
    if (modes.has('--negative-only')) {
      const report = {
        kind: 'standalone-device-negative',
        startedAt,
        finishedAt: new Date().toISOString(),
        passed: true,
        adapter,
        environment: environmentReport(),
        observations,
        service: {
          tokenFile: auth.path,
          tokenMode: auth.modeEnforced ? auth.mode.toString(8) : 'not enforceable on ' + process.platform,
          authentication: 'Bearer required on every route except /health',
        },
        failure: null,
      };
      await writeJson(path.join(logsRoot, 'standalone-device-negative.json'), report);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    runtime = await createRuntime({
      fixture: server.fixture,
      server,
      arch,
      withSessions: shouldServe,
    });
    const plugin = runtime.plugin;
    const bash = runtime.tools.get('linux_bash');
    assert.ok(bash, 'linux_bash was not registered by the real runtime plugin');

    const pluginPackage = JSON.parse(await fs.readFile(path.join(plugin.directory, 'package.json'), 'utf8'));
    assert.equal(pluginPackage.name, '@dsh-android/linux-runtime');
    record('installed-plugin-package', pluginPackage.name + '@' + pluginPackage.version, {
      directory: plugin.directory,
    });

    for (const download of runtime.pluginHost.downloadLog) {
      assert.equal(download.receivedBytes, download.declaredBytes, 'HTTP bytes differ from manifest for ' + download.name);
      assert.equal(download.receivedSha256, download.declaredSha256, 'HTTP digest differs from manifest for ' + download.name);
      const request = server.requests.find((value) => value.kind === 'asset' && value.name === download.name);
      assert.ok(request, 'no local HTTP request observed for ' + download.name);
      assert.equal(request.bytes, download.declaredBytes);
      record('download-real-http-bytes', download.name, {
        httpBytes: request.bytes,
        receivedBytes: download.receivedBytes,
        declaredBytes: download.declaredBytes,
        declaredSha256: download.declaredSha256,
        receivedSha256: download.receivedSha256,
      });
    }

    const execute = await bash.execute({
      command: 'printf "standalone-%s\\n" "$(uname -m)"; printf "guest-uid=%s\\n" "$(id -u)"',
      timeoutMs: 60_000,
    });
    assert.equal(execute.exitCode, 0, execute.stderr);
    assert.match(execute.stdout, /standalone-/);
    record('linux_bash-execute', execute.stdout.trim(), {
      source: 'real runtime plugin registration',
      runtimeId: execute.runtimeId,
    });

    if (shouldServe) serveHandle = await serve(runtime, auth);

    const report = {
      kind: 'standalone-device-install',
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: shouldServe ? 'serve' : 'install',
      passed: true,
      adapter,
      environment: environmentReport(),
      fixture: {
        directory: server.fixture.directory,
        version: server.fixture.manifest.version,
        tag: server.fixture.identity.tag,
        manifestBytes: server.fixture.manifestSize,
        manifestSha256: server.fixture.manifestSha256,
      },
      bootstrap: await runtime.bootstrap.status(),
      manager: runtime.manager.status(),
      plugin: {
        directory: plugin.directory,
        package: pluginPackage,
        tools: [...runtime.tools.keys()],
      },
      observations,
      service: {
        tokenFile: auth.path,
        tokenMode: auth.modeEnforced ? auth.mode.toString(8) : 'not enforceable on ' + process.platform,
        tokenGenerated: auth.generated,
        authentication: 'Bearer required on every route except /health',
      },
      failure: null,
    };
    await writeJson(installReportPath, report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    if (serveHandle) await new Promise(() => {});
  } catch (error) {
    const report = {
      kind: 'standalone-device-install',
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: shouldServe ? 'serve' : 'install',
      passed: false,
      adapter,
      environment: environmentReport(),
      observations,
      service: {
        tokenFile: auth.path,
        tokenMode: auth.modeEnforced ? auth.mode.toString(8) : 'not enforceable on ' + process.platform,
        authentication: 'Bearer required on every route except /health',
      },
      failure: {
        name: error?.name ?? 'Error',
        message: errorText(error),
        stack: error?.stack ?? null,
      },
    };
    await writeJson(installReportPath, report).catch(() => undefined);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 1;
    if (serveHandle) await serveHandle.shutdown('startup failure').catch(() => undefined);
    if (runtime) await runtime.manager.dispose().catch(() => undefined);
  } finally {
    // Always release the fixture listener. A failed --serve start must not
    // leave a Node process holding the port (and the token file) forever.
    if (runtime) await runtime.manager.dispose().catch(() => undefined);
    await server.close();
  }
}

await main();
