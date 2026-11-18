import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateAsset } from './manifest.js';

const ALLOWED_REDIRECT_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

const GITHUB_RELEASE_HOSTS = new Set(['github.com', 'www.github.com']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 hex digest`);
  }
  return value;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isAllowedAssetOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(parsed.hostname.toLowerCase());
}

export function assertOfficialAssetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('asset.url must be an absolute URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !GITHUB_RELEASE_HOSTS.has(hostname) ||
    !parsed.pathname.includes('/releases/download/')
  ) {
    throw new TypeError('asset.url must be an official GitHub HTTPS release URL');
  }
  return url;
}

function id() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

async function verifyFile(asset, file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error('downloaded asset is not a regular file');
  if (stat.size !== asset.size) {
    throw new Error(`asset size mismatch: expected ${asset.size}, got ${stat.size}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) {
    throw new Error('asset SHA-256 mismatch');
  }
  return stat.size;
}

class InterruptedDownload extends Error {}

async function* responseChunks(response) {
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      yield* response.body;
    } else {
      yield await response.arrayBuffer();
    }
  } catch (cause) {
    throw new InterruptedDownload('asset response was interrupted', { cause });
  }
}

async function fetchAsset(fetchImpl, asset, destination) {
  const file = await fs.open(destination, 'wx');
  const attempts = 3;
  let size = 0;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const request = { redirect: 'follow' };
        if (size > 0) request.headers = { Range: `bytes=${size}-`, 'Accept-Encoding': 'identity' };
        let response;
        try {
          response = await fetchImpl(asset.url, request);
        } catch (cause) {
          throw new InterruptedDownload('asset request was interrupted', { cause });
        }
        const status = response?.status;
        if (!response?.ok) {
          await response?.body?.cancel?.();
          const message = `asset download failed: HTTP ${status ?? 'unknown'}`;
          if (status === 408 || status === 429 || status >= 500) throw new InterruptedDownload(message);
          throw new Error(message);
        }
        if (response.url && !isAllowedAssetOrigin(response.url)) {
          await response.body?.cancel?.();
          throw new Error('asset download redirected away from the official GitHub release origin');
        }
        if (status === 206) {
          const range = response.headers?.get('content-range');
          if (size === 0 || range !== `bytes ${size}-${asset.size - 1}/${asset.size}`) {
            await response.body?.cancel?.();
            throw new Error('asset download returned an unexpected Content-Range');
          }
        } else if (size > 0) {
          await file.truncate(0);
          size = 0;
        }
        for await (const chunk of responseChunks(response)) {
          const buffer = Buffer.from(chunk);
          if (size + buffer.length > asset.size) {
            throw new Error(`asset exceeded declared size: expected ${asset.size}`);
          }
          for (let offset = 0; offset < buffer.length;) {
            const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, size);
            if (bytesWritten === 0) throw new Error('asset file stopped accepting writes');
            offset += bytesWritten;
            size += bytesWritten;
          }
        }
        if (size !== asset.size) {
          throw new InterruptedDownload(`asset size mismatch: expected ${asset.size}, got ${size}`);
        }
        return;
      } catch (error) {
        if (!(error instanceof InterruptedDownload) || attempt === attempts || size === asset.size) throw error;
        await delay(250 * attempt);
      }
    }
  } finally {
    await file.close();
  }
}

async function unpackedSize(directory) {
  let total = 0;
  const seenFiles = new Set();
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) {
        await visit(target);
      } else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (!seenFiles.has(identity)) {
          seenFiles.add(identity);
          total += stat.size;
        }
      }
    }
  }
  await visit(directory);
  return total;
}

async function writeMarker(directory, asset) {
  await fs.writeFile(
    path.join(directory, '.asset.json'),
    `${JSON.stringify({ sha256: asset.sha256, size: asset.size, unpackedSize: asset.unpackedSize }, null, 2)}\n`,
    { flag: 'wx' },
  );
}

function entries(directory) {
  return readdirSync(directory, { withFileTypes: true });
}

async function normalizeNpmPackRoot(directory) {
  const top = entries(directory);
  const packageEntry = top.find((entry) => entry.name === 'package');
  if (!packageEntry || !packageEntry.isDirectory() || top.length !== 1) return;
  const packageRoot = path.join(directory, 'package');
  const children = entries(packageRoot);
  for (const child of children) {
    const source = path.join(packageRoot, child.name);
    const target = path.join(directory, child.name);
    if (!within(directory, target) || existsSync(target)) {
      throw new Error('npm pack archive normalization would overwrite or escape the staging directory');
    }
    await fs.rename(source, target);
  }
  await fs.rmdir(packageRoot);
}

function markerMatches(directory, asset) {
  try {
    const marker = JSON.parse(readFileSync(path.join(directory, '.asset.json'), 'utf8'));
    return isObject(marker) && marker.sha256 === asset.sha256 && marker.size === asset.size && marker.unpackedSize === asset.unpackedSize;
  } catch {
    return false;
  }
}

/**
 * Install a release asset into a content-addressed directory.
 *
 * The final directory is `${destinationRoot}/${asset.sha256}`. The helper is
 * idempotent, verifies the exact compressed byte count and SHA-256 after both
 * injected and fallback downloads, accepts either npm's `package/` archive
 * prefix or a direct package root, and calls only the injected safe extractor.
 * It never invokes tar, a shell, or an archive command.
 *
 * @param {object} options
 * @param {object} options.asset Exact manifest Asset object.
 * @param {string} options.destinationRoot Bootstrap-owned plugin store.
 * @param {Function} [options.downloadAsset] (asset, archivePath) => Promise<void>.
 * @param {Function} [options.extractArchive] (archivePath, stagePath, {kind}) => Promise<void>.
 * @param {Function} [options.fetchImpl=fetch] Fetch fallback used only when downloadAsset is omitted.
 * @param {string} [options.kind='plugin'] Safe extractor kind.
 * @returns {Promise<{path:string,sha256:string,size:number,unpackedSize:number,reused:boolean}>}
 */
export async function installPluginAsset({
  asset,
  destinationRoot,
  downloadAsset,
  extractArchive,
  fetchImpl = globalThis.fetch,
  kind = 'plugin',
} = {}) {
  const validated = validateAsset(asset);
  assertOfficialAssetUrl(validated.url);
  if (typeof destinationRoot !== 'string' || destinationRoot.length === 0) {
    throw new TypeError('destinationRoot is required');
  }
  if (typeof extractArchive !== 'function') {
    throw new Error('extractArchive IO is required; refusing unsafe shell extraction');
  }
  const root = path.resolve(destinationRoot);
  const finalPath = path.join(root, safeId(validated.sha256, 'asset.sha256'));
  if (!within(root, finalPath)) throw new Error('content-addressed asset path escaped destinationRoot');
  await fs.mkdir(root, { recursive: true });
  if (existsSync(finalPath)) {
    if (markerMatches(finalPath, validated)) {
      return { path: finalPath, ...validated, reused: true };
    }
    throw new Error('content-addressed plugin path exists but does not match its asset marker');
  }

  const stage = path.join(root, `.staging-${id()}`);
  const archive = path.join(stage, 'asset.archive');
  const extracted = path.join(stage, 'package');
  try {
    await fs.mkdir(extracted, { recursive: true });
    if (typeof downloadAsset === 'function') await downloadAsset(validated, archive);
    else if (typeof fetchImpl === 'function') await fetchAsset(fetchImpl, validated, archive);
    else throw new Error('downloadAsset IO is required; no fetchImpl is available');
    await verifyFile(validated, archive);
    await extractArchive(archive, extracted, { kind });
    await normalizeNpmPackRoot(extracted);
    const actualUnpackedSize = await unpackedSize(extracted);
    if (actualUnpackedSize !== validated.unpackedSize) {
      throw new Error(`asset unpacked size mismatch: expected ${validated.unpackedSize}, got ${actualUnpackedSize}`);
    }
    await writeMarker(extracted, validated);
    try {
      await fs.rename(extracted, finalPath);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
        if (markerMatches(finalPath, validated)) {
          return { path: finalPath, ...validated, reused: true };
        }
      }
      throw error;
    }
    return { path: finalPath, ...validated, reused: false };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { verifyFile as verifyDownloadedAsset };
