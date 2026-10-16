import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGithubUrl } from './manifest.js'

const bytesValue = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array

async function digestFile(filePath) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), size }
}

async function unpackedBytes(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    const info = await lstat(child)
    if (info.isSymbolicLink()) throw new Error('Extracted plugin bundles may not contain symlinks')
    if (info.isDirectory()) total += await unpackedBytes(child)
    else if (info.isFile()) total += info.size
    else throw new Error('Unsupported filesystem entry in extracted plugin bundle')
  }
  return total
}

function assertAsset(asset) {
  if (!asset || typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size < 0 || !Number.isSafeInteger(asset.unpackedSize) || asset.unpackedSize < 0) {
    throw new TypeError('Asset requires url, SHA-256, size, and unpackedSize')
  }
  const url = parseGithubUrl(asset.url)
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match || url.search || url.hash) throw new TypeError('Asset must use a versioned HTTPS GitHub release URL')
  return url.href
}

export async function installVerifiedPluginBundle({
  asset,
  destinationRoot,
  downloadAsset,
  extractArchive,
  fetchImpl = globalThis.fetch,
  kind = 'plugin',
  packageName,
  entry = 'lib/index.js',
}) {
  const url = assertAsset(asset)
  if (typeof destinationRoot !== 'string' || !destinationRoot) throw new TypeError('destinationRoot is required')
  if (typeof downloadAsset !== 'function' || typeof extractArchive !== 'function') throw new TypeError('downloadAsset and safe extractArchive adapters are required')
  const root = path.resolve(destinationRoot)
  await mkdir(root, { recursive: true })
  const finalDirectory = path.join(root, asset.sha256)
  const markerPath = path.join(finalDirectory, '.dsh-asset-integrity.json')
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    const rootInfo = await lstat(finalDirectory)
    if (rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && marker.sha256 === asset.sha256 && marker.size === asset.size && marker.unpackedSize === asset.unpackedSize) {
      if (packageName) await validatePackage(finalDirectory, packageName, entry)
      return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize: asset.unpackedSize, reused: true }
    }
  } catch { /* Rebuild missing or untrusted cached staging content. */ }

  const token = randomUUID()
  const archivePath = path.join(root, `.asset-${token}`)
  const staging = path.join(root, `.stage-${token}`)
  const resultDirectory = path.join(staging, 'package')
  await mkdir(staging, { recursive: true })
  try {
    const downloaded = await downloadAsset({ ...asset, url }, { destination: archivePath, fetchImpl })
    if (bytesValue(downloaded)) await writeFile(archivePath, downloaded)
    else if (typeof downloaded === 'string' && path.resolve(downloaded) !== archivePath) await copyFile(downloaded, archivePath)
    else if (bytesValue(downloaded?.data)) await writeFile(archivePath, downloaded.data)
    else if (downloaded?.path && path.resolve(downloaded.path) !== archivePath) await copyFile(downloaded.path, archivePath)
    const archiveInfo = await lstat(archivePath)
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('Asset downloader must produce a regular file')
    const digest = await digestFile(archivePath)
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) throw new Error('Plugin asset SHA-256 or size verification failed')
    await mkdir(resultDirectory, { recursive: true })
    await extractArchive(archivePath, resultDirectory, { kind, safe: true, stripComponents: 0 })
    const nestedPackage = path.join(resultDirectory, 'package')
    let packageDirectory = resultDirectory
    try {
      if ((await stat(path.join(nestedPackage, 'package.json'))).isFile()) packageDirectory = nestedPackage
    } catch { /* Archive is already rooted at the package directory. */ }
    const unpackedSize = await unpackedBytes(packageDirectory)
    if (unpackedSize !== asset.unpackedSize) throw new Error(`Unpacked size mismatch: expected ${asset.unpackedSize}, got ${unpackedSize}`)
    if (packageName) await validatePackage(packageDirectory, packageName, entry)
    await writeFile(path.join(packageDirectory, '.dsh-asset-integrity.json'), `${JSON.stringify({ sha256: asset.sha256, size: asset.size, unpackedSize })}\n`)
    const backupDirectory = path.join(root, `.backup-${token}`)
    let hadPrevious = false
    try {
      await rename(finalDirectory, backupDirectory)
      hadPrevious = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await rename(packageDirectory, finalDirectory)
      if (hadPrevious) await rm(backupDirectory, { recursive: true, force: true })
    } catch (error) {
      if (hadPrevious) await rename(backupDirectory, finalDirectory).catch(() => {})
      throw error
    }
    return { path: finalDirectory, sha256: asset.sha256, size: asset.size, unpackedSize, reused: false }
  } catch (error) {
    throw error
  } finally {
    await rm(archivePath, { force: true }).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function validatePackage(directory, packageName, entry) {
  const metadataPath = path.join(directory, 'package.json')
  const metadataStat = await lstat(metadataPath)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('Verified plugin archive is missing a regular package.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (metadata.name !== packageName) throw new Error(`Expected plugin package ${packageName}`)
  const entryPath = path.resolve(directory, entry)
  const relative = path.relative(directory, entryPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin entry escapes package directory')
  const entryStat = await lstat(entryPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Plugin entry ${entry} is missing or unsafe`)
}
