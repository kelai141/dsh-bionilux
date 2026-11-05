/**
 * Standalone local release server for installer acceptance runs.
 *
 * The production bootstrap only accepts official HTTPS GitHub release URLs.
 * That whitelist stays in production code. This harness serves the same
 * version-pinned URL shape over loopback and exposes a fetch adapter that
 * rewrites an official URL to the local origin only for the acceptance run.
 *
 * Fixture layout (BN_FIXTURE):
 *
 *   linux-release.json
 *   linux-bootstrap-plugin.tar.xz
 *   linux-runtime-plugin.tar.xz
 *   <runtime asset files referenced by linux-release.json>
 *
 * Every declared archive is hashed and sized before the server starts. A
 * deliberate tamper mode is applied while streaming a selected asset so the
 * caller can prove size and digest failures close the production install path.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const MANIFEST_NAME = 'linux-release.json';
export const OFFICIAL_GITHUB_HOSTS = Object.freeze(['github.com', 'www.github.com', 'api.github.com']);
export const TAMPER_MODES = Object.freeze(['digest', 'truncate', 'extend']);

function required(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(field + ' is required');
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function safeName(value) {
  if (typeof value !== 'string' || value.length === 0 || path.basename(value) !== value || value === '.' || value === '..') {
    throw new TypeError('unsafe release asset name: ' + String(value));
  }
  return value;
}

async function digestFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size };
}

function releaseIdentity(manifest) {
  const first = manifest?.plugins?.runtime?.url ?? manifest?.plugins?.bootstrap?.url;
  let parsed;
  try {
    parsed = new URL(first);
  } catch {
    throw new TypeError('manifest plugin URL is not absolute');
  }
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
  if (!match || parsed.protocol !== 'https:' || !OFFICIAL_GITHUB_HOSTS.includes(parsed.hostname)) {
    throw new TypeError('manifest must use an official versioned GitHub release URL');
  }
  const version = String(manifest.version ?? '').replace(/^v/, '');
  const tag = 'v' + version;
  if (decodeURIComponent(match[3]) !== tag) throw new TypeError('manifest asset tag does not match manifest version');
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    tag,
    version,
  };
}

function manifestAssets(manifest, identity) {
  const entries = [];
  const add = (asset, label, declaredName) => {
    if (!isObject(asset)) throw new TypeError(label + ' must be an object');
    let url;
    try {
      url = new URL(asset.url);
    } catch {
      throw new TypeError(label + '.url must be absolute');
    }
    const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match || url.protocol !== 'https:' || !OFFICIAL_GITHUB_HOSTS.includes(url.hostname)) {
      throw new TypeError(label + ' must use an official HTTPS GitHub release URL');
    }
    const name = decodeURIComponent(match[4]);
    safeName(name);
    if (declaredName && name !== declaredName) throw new TypeError(label + ' has an unexpected file name');
    if (decodeURIComponent(match[1]) !== identity.owner || decodeURIComponent(match[2]) !== identity.repo) {
      throw new TypeError(label + ' belongs to a different repository');
    }
    if (decodeURIComponent(match[3]) !== identity.tag) throw new TypeError(label + ' belongs to a different release tag');
    entries.push({
      name,
      label,
      url: 'https://github.com/' + identity.owner + '/' + identity.repo + '/releases/download/' + identity.tag + '/' + name,
      sha256: required(asset.sha256, label + '.sha256'),
      size: asset.size,
      unpackedSize: asset.unpackedSize,
    });
  };
  add(manifest.plugins.bootstrap, 'plugins.bootstrap', 'linux-bootstrap-plugin.tar.xz');
  add(manifest.plugins.runtime, 'plugins.runtime', 'linux-runtime-plugin.tar.xz');
  if (!Array.isArray(manifest.runtimes) || manifest.runtimes.length === 0) {
    throw new TypeError('manifest.runtimes must be a non-empty array');
  }
  for (const [index, runtime] of manifest.runtimes.entries()) {
    add(runtime.backendAsset, 'runtimes[' + index + '].backendAsset');
    add(runtime.rootfsAsset, 'runtimes[' + index + '].rootfsAsset');
    add(runtime.nodeAsset, 'runtimes[' + index + '].nodeAsset');
  }
  return entries;
}

/**
 * Read and verify one fixture directory.
 *
 * Verification here covers the server's own inputs. The bootstrap and runtime
 * manager still verify everything they receive; this early check only prevents
 * an acceptance run from starting with a malformed or incomplete fixture.
 */
export async function loadFixture(fixtureDirectory) {
  const directory = path.resolve(required(fixtureDirectory, 'fixture'));
  const info = await stat(directory);
  if (!info.isDirectory()) throw new TypeError('fixture must be a directory');
  const manifestPath = path.join(directory, MANIFEST_NAME);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const identity = releaseIdentity(manifest);
  const assets = manifestAssets(manifest, identity);
  const seen = new Set();
  const files = new Map();
  for (const asset of assets) {
    if (seen.has(asset.name)) throw new TypeError('manifest references duplicate asset ' + asset.name);
    seen.add(asset.name);
    const file = path.resolve(directory, asset.name);
    if (!isWithin(directory, file)) throw new TypeError('asset path escaped fixture: ' + asset.name);
    const fileInfo = await stat(file);
    if (!fileInfo.isFile()) throw new TypeError('asset is not a regular file: ' + asset.name);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new TypeError(asset.label + '.sha256 is invalid');
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new TypeError(asset.label + '.size is invalid');
    const digest = await digestFile(file);
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) {
      throw new Error('fixture asset does not match its manifest: ' + asset.name);
    }
    files.set(asset.name, {
      ...asset,
      path: file,
      actualSha256: digest.sha256,
      actualSize: digest.size,
    });
  }
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  return {
    directory,
    manifest,
    manifestBytes,
    manifestPath,
    manifestSha256: manifestDigest,
    manifestSize: manifestBytes.length,
    identity,
    files,
  };
}

function parseLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('BN_DOWNLOAD_ORIGIN must be an absolute http URL');
  }
  if (url.protocol !== 'http:') throw new TypeError('BN_DOWNLOAD_ORIGIN must use http');
  if (url.username || url.password || url.search || url.hash) throw new TypeError('BN_DOWNLOAD_ORIGIN must not contain credentials, query or fragment');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('BN_DOWNLOAD_ORIGIN must target loopback');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new TypeError('BN_DOWNLOAD_ORIGIN must not contain a path');
  const port = url.port === '' ? 0 : Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('BN_DOWNLOAD_ORIGIN has an invalid port');
  return {
    host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, ''),
    port,
  };
}

function normalizeTamper(tamper, tamperAsset, fixture) {
  if (tamper == null || tamper === '') return null;
  const mode = typeof tamper === 'string' ? tamper : tamper.mode;
  if (!TAMPER_MODES.includes(mode)) throw new TypeError('tamper mode must be one of ' + TAMPER_MODES.join(', '));
  let asset = typeof tamper === 'object' && tamper.asset ? tamper.asset : tamperAsset;
  if (!asset) {
    // Negative cases must stay cheap. The runtime plugin is the small archive
    // that is downloaded and hashed before the manager touches runtime assets,
    // so a digest failure there closes the install before any big rootfs fetch.
    asset = 'linux-runtime-plugin.tar.xz';
  }
  safeName(asset);
  if (!fixture.files.has(asset)) throw new TypeError('tamper target is not a manifest asset: ' + asset);
  return { mode, asset };
}

function sendJson(response, value, contentType = 'application/json; charset=utf-8') {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
  });
  response.end(bytes);
  return bytes.length;
}

function officialManifestUrl(fixture) {
  const { owner, repo, tag } = fixture.identity;
  return 'https://github.com/' + owner + '/' + repo + '/releases/download/' + tag + '/' + MANIFEST_NAME;
}

async function streamModified(response, file, plan, declaredSize) {
  const length = plan?.mode === 'truncate' ? Math.max(0, declaredSize - 1) : plan?.mode === 'extend' ? declaredSize + 4 : declaredSize;
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(length),
    'Cache-Control': 'no-store',
  });
  let sent = 0;
  async function* body() {
    let first = true;
    for await (const chunk of createReadStream(file)) {
      let output = chunk;
      if (plan?.mode === 'digest' && first && output.length > 0) {
        output = Buffer.from(output);
        output[0] ^= 0x01;
      }
      first = false;
      if (plan?.mode === 'truncate' && sent + output.length > length) {
        output = output.subarray(0, Math.max(0, length - sent));
      }
      if (output.length > 0) {
        sent += output.length;
        yield output;
      }
      if (plan?.mode === 'truncate' && sent >= length) break;
    }
    if (plan?.mode === 'extend') {
      const extra = Buffer.from('TAMP');
      sent += extra.length;
      yield extra;
    }
  }
  await pipeline(Readable.from(body()), response);
  return sent;
}

/**
 * Start the local release service.
 *
 * @param {object} [options]
 * @param {string} [options.fixture] Fixture directory. Defaults to BN_FIXTURE.
 * @param {string} [options.origin] Loopback origin. Defaults to BN_DOWNLOAD_ORIGIN or port 0.
 * @param {'digest'|'truncate'|'extend'|null} [options.tamper] Deliberate stream corruption.
 * @param {string} [options.tamperAsset] Asset file name to corrupt. Defaults to
 *   the runtime plugin: it is small and is verified before any large runtime
 *   asset, so the negative case never downloads the rootfs.
 * @returns {Promise<object>} Server handle.
 */
export async function startDownloadServer(options = {}) {
  const fixtureDirectory = options.fixture ?? process.env.BN_FIXTURE;
  if (!fixtureDirectory) throw new TypeError('BN_FIXTURE is required');
  const fixture = await loadFixture(fixtureDirectory);
  const requested = options.origin ?? process.env.BN_DOWNLOAD_ORIGIN ?? 'http://127.0.0.1:0';
  const binding = parseLoopbackOrigin(requested);
  const tamper = normalizeTamper(
    options.tamper ?? process.env.BN_TAMPER,
    options.tamperAsset ?? process.env.BN_TAMPER_ASSET,
    fixture,
  );
  const requests = [];
  const latestPath = '/repos/' + fixture.identity.owner + '/' + fixture.identity.repo + '/releases/latest';
  const downloadPrefix = '/' + fixture.identity.owner + '/' + fixture.identity.repo + '/releases/download/' + fixture.identity.tag + '/';

  const server = http.createServer(async (request, response) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let pathname;
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const record = { at: startedAt, method: request.method, path: pathname, status: 0, bytes: 0, kind: 'other' };
    requests.push(record);
    try {
      if (request.method !== 'GET') {
        record.status = 405;
        response.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      if (pathname === latestPath) {
        record.kind = 'release-api';
        const metadata = {
          name: MANIFEST_NAME,
          size: fixture.manifestSize,
          digest: 'sha256:' + fixture.manifestSha256,
          browser_download_url: officialManifestUrl(fixture),
        };
        record.bytes = sendJson(response, {
          tag_name: fixture.identity.tag,
          name: fixture.identity.tag,
          draft: false,
          prerelease: false,
          assets: [metadata],
        });
        return;
      }
      if (pathname.startsWith(downloadPrefix)) {
        const encodedName = pathname.slice(downloadPrefix.length);
        let name;
        try {
          name = decodeURIComponent(encodedName);
        } catch {
          record.status = 400;
          response.writeHead(400).end();
          return;
        }
        if (name === MANIFEST_NAME) {
          record.kind = 'manifest';
          record.name = name;
          record.declaredBytes = fixture.manifestSize;
          const bytes = fixture.manifestBytes;
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store',
          });
          response.end(bytes);
          record.bytes = bytes.length;
          return;
        }
        safeName(name);
        const asset = fixture.files.get(name);
        if (!asset) {
          record.status = 404;
          response.writeHead(404).end();
          return;
        }
        record.kind = 'asset';
        record.name = name;
        record.declaredBytes = asset.size;
        const plan = tamper && tamper.asset === name ? tamper : null;
        record.tampered = plan ? plan.mode : null;
        record.bytes = await streamModified(response, asset.path, plan, asset.size);
        return;
      }
      if (pathname === '/__acceptance__/health') {
        record.kind = 'health';
        record.bytes = sendJson(response, {
          ok: true,
          manifestVersion: fixture.manifest.version,
          owner: fixture.identity.owner,
          repo: fixture.identity.repo,
          tag: fixture.identity.tag,
          tamper,
        });
        return;
      }
      record.status = 404;
      response.writeHead(404).end();
    } catch (error) {
      record.status = 500;
      record.error = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy(error);
    } finally {
      if (!record.status) record.status = response.statusCode || 200;
      record.durationMs = Date.now() - started;
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(binding.port, binding.host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local release server did not expose a TCP address');
  const origin = 'http://127.0.0.1:' + address.port;
  let closed = false;
  return {
    origin,
    port: address.port,
    fixture,
    tamper,
    requests,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Rewrite official GitHub HTTPS URLs to the loopback server.
 *
 * This adapter belongs to acceptance only. It rejects every other URL instead
 * of forwarding it, so an acceptance run cannot accidentally reach production
 * while appearing to test the local fixture.
 */
export function createLocalFetch(options = {}) {
  const origin = options.origin ?? process.env.BN_DOWNLOAD_ORIGIN;
  const originUrl = new URL(required(origin, 'origin'));
  if (originUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(originUrl.hostname)) {
    throw new TypeError('local fetch origin must be loopback http');
  }
  if (originUrl.username || originUrl.password || originUrl.search || originUrl.hash || (originUrl.pathname !== '/' && originUrl.pathname !== '')) {
    throw new TypeError('local fetch origin must not contain credentials, path, query or fragment');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const onRewrite = typeof options.onRewrite === 'function' ? options.onRewrite : undefined;
  const targetBase = 'http://127.0.0.1:' + (originUrl.port || '80');

  return async function localFetch(input, init = {}) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let official;
    try {
      official = new URL(raw);
    } catch {
      throw new TypeError('local fetch accepts only absolute official GitHub URLs');
    }
    if (official.protocol !== 'https:' || !OFFICIAL_GITHUB_HOSTS.includes(official.hostname)) {
      throw new TypeError('local fetch adapter only rewrites official HTTPS GitHub URLs: ' + official.href);
    }
    if (official.search || official.hash) throw new TypeError('official release URLs must not contain query or fragment');
    const target = targetBase + official.pathname;
    const response = await fetchImpl(target, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('local release server must not redirect: HTTP ' + response.status);
    }
    const wrapped = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Production validators inspect response.url expecting the official origin.
    // The actual socket still goes to loopback; no production check is relaxed.
    Object.defineProperty(wrapped, 'url', { value: official.href, enumerable: true, configurable: false });
    if (onRewrite) onRewrite({ url: official.href, target, status: response.status });
    return wrapped;
  };
}

/**
 * CLI: run the fixture service on its own.
 *
 *   BN_FIXTURE=<dir> node standalone-download-server.mjs [--origin http://127.0.0.1:18790]
 *
 * It prints one JSON line with the bound origin, then stays alive until SIGINT
 * or SIGTERM. The device harness imports the factory instead of spawning this.
 */
async function main() {
  const args = process.argv.slice(2);
  let origin = process.env.BN_DOWNLOAD_ORIGIN;
  let fixture = process.env.BN_FIXTURE;
  let tamper = process.env.BN_TAMPER;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--origin') origin = args[++index];
    else if (value === '--fixture') fixture = args[++index];
    else if (value === '--tamper') tamper = args[++index];
    else throw new TypeError('unknown argument: ' + value);
  }
  const server = await startDownloadServer({ fixture, origin, tamper });
  process.stdout.write(JSON.stringify({
    origin: server.origin,
    fixture: server.fixture.directory,
    version: server.fixture.manifest.version,
    tag: server.fixture.identity.tag,
    assets: [...server.fixture.files.keys()],
    tamper: server.tamper,
  }) + '\n');
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();

export default { startDownloadServer, createLocalFetch, loadFixture };
