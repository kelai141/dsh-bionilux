/**
 * The host may fetch and unpack the bundle itself (docs/DECISIONS.md D-015).
 * These tests pin the contract that makes that safe:
 *
 *   - staged content is re-verified against the manifest before it is used
 *   - content that is present but wrong fails closed, instead of silently
 *     re-downloading (a mismatch is corruption or tampering, not a cache miss)
 *   - a required bundle that is missing is an error, not a fallback
 *   - the host's own staging area is left intact and re-verifiable
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMobileBootstrap } from '../src/index.js'

// A pid-unique temporary root, matching manager.test.mjs. Sharing the package's
// `.test-data` directory would race: bootstrap.test.mjs removes that whole root
// on teardown, including whatever a parallel test file is still using.
const root = path.join(os.tmpdir(), `bionilux-host-staged-tests-${process.pid}`)
after(async () => { await rm(root, { recursive: true, force: true }) })

const archive = Buffer.from('host staged runtime archive')
const sha256 = createHash('sha256').update(archive).digest('hex')
const version = '2.0.0'
const tag = `v${version}`
const releaseUrl = `https://github.com/acme/dsh-bionilux/releases/download/${tag}`
const packageName = '@dsh-android/linux-runtime'
const entrySource = 'export function apply() {}'
const packageJson = JSON.stringify({ name: packageName, version })
const unpackedSize = Buffer.byteLength(packageJson) + Buffer.byteLength(entrySource)

function manifest() {
  const asset = (name) => ({
    url: `${releaseUrl}/${name}`,
    sha256,
    size: archive.length,
    unpackedSize,
    pluginReleaseUrl: `https://github.com/acme/dsh-bionilux/releases/tag/${tag}`,
  })
  return {
    schemaVersion: 1,
    version,
    minMobileVersion: '0.14.0',
    plugins: { bootstrap: asset('linux-bootstrap-plugin.tar.xz'), runtime: asset('linux-runtime-plugin.tar.xz') },
    runtimes: [{
      id: 'debian-minimal', label: 'Debian minimal', architecture: 'arm64', backend: 'bionilux',
      backendAsset: asset('bionilux.tar.xz'), rootfsAsset: asset('rootfs.tar.xz'), nodeAsset: asset('node.tar.xz'),
    }],
  }
}

function response(value, url = '') {
  const bytes = Buffer.from(JSON.stringify(value))
  return {
    ok: true, status: 200, url,
    json: async () => value,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

const runtimeManager = {
  install: async () => {},
  reinstall: async () => {},
  uninstall: async () => {},
  status: async () => ({ running: false }),
}

function harness({ dataDir = path.join(root, `staged-${Math.random().toString(16).slice(2)}`), requireStagedBundle = false } = {}) {
  const calls = { downloads: 0 }
  const service = createMobileBootstrap({
    dataDir,
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => '0.14.0',
    requireStagedBundle,
    pluginHost: {
      install: async () => ({ manager: runtimeManager, rollback: async () => {} }),
      uninstall: async () => {},
      isInjected: async () => ({ injected: true, active: true }),
    },
    downloadAsset: async () => { calls.downloads += 1; return archive },
    extractArchive: async (_asset, destination) => {
      await writeFile(path.join(destination, 'package.json'), packageJson)
      await mkdir(path.join(destination, 'lib'), { recursive: true })
      await writeFile(path.join(destination, 'lib', 'index.js'), entrySource)
    },
    fetchImpl: async (url) => (url.includes('api.github.com')
      ? response({
        tag_name: tag,
        assets: [{ name: 'linux-release.json', size: Buffer.byteLength(JSON.stringify(manifest())), digest: null, browser_download_url: `${releaseUrl}/linux-release.json` }],
      }, url)
      : response(manifest(), url)),
  })
  return { service, calls, dataDir }
}

/** Write the layout the host publishes: `<dataDir>/staging/<sha256>/{asset.tar.xz,unpacked/}`. */
async function stageBundle(dataDir, { body = archive, extraFile = null } = {}) {
  const stagedRoot = path.join(dataDir, 'staging', sha256)
  await mkdir(path.join(stagedRoot, 'unpacked', 'lib'), { recursive: true })
  await writeFile(path.join(stagedRoot, 'asset.tar.xz'), body)
  await writeFile(path.join(stagedRoot, 'unpacked', 'package.json'), packageJson)
  await writeFile(path.join(stagedRoot, 'unpacked', 'lib', 'index.js'), entrySource)
  if (extraFile) await writeFile(path.join(stagedRoot, 'unpacked', extraFile), 'extra')
  return stagedRoot
}

const install = (service) => service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })

test('a host-staged bundle is re-verified and published without a download', async () => {
  const value = harness()
  const stagedRoot = await stageBundle(value.dataDir)
  await value.service.ready
  const result = await install(value.service)

  assert.equal(value.calls.downloads, 0, 'a verified staged bundle must not trigger a download')
  const publishedRoot = path.join(value.dataDir, 'staging', 'runtime-plugin', sha256)
  assert.equal(result.plugins.runtime.directory, publishedRoot)

  // Published under our own root, with our own integrity marker...
  const marker = JSON.parse(await readFile(path.join(publishedRoot, '.dsh-asset-integrity.json'), 'utf8'))
  assert.deepEqual(marker, { sha256, size: archive.length, unpackedSize })
  // ...and the host's staging area is left intact so it stays re-verifiable.
  assert.equal((await stat(path.join(stagedRoot, 'asset.tar.xz'))).isFile(), true)
  assert.equal((await stat(path.join(stagedRoot, 'unpacked', 'package.json'))).isFile(), true)
})

test('a staged archive that does not match the manifest fails closed and is not re-downloaded', async () => {
  const value = harness()
  await stageBundle(value.dataDir, { body: Buffer.from('tampered bytes of a different length') })
  await value.service.ready
  await assert.rejects(install(value.service), /Host-staged archive does not match the release manifest/)
  assert.equal(value.calls.downloads, 0, 'tampering must not be papered over by a silent re-download')
})

test('a staged unpacked tree of the wrong size fails closed', async () => {
  const value = harness()
  await stageBundle(value.dataDir, { extraFile: 'extra.txt' })
  await value.service.ready
  await assert.rejects(install(value.service), /Host-staged bundle unpacked size mismatch/)
  assert.equal(value.calls.downloads, 0)
})

test('a required staged bundle that is missing fails closed instead of downloading', async () => {
  const value = harness({ requireStagedBundle: true })
  await value.service.ready
  await assert.rejects(install(value.service), /No host-staged bundle is available/)
  assert.equal(value.calls.downloads, 0, 'the engine must not fetch bytes when the host owns fetching')
})

test('an optional staged bundle that is missing falls back to the download path', async () => {
  const value = harness()
  await value.service.ready
  const result = await install(value.service)
  assert.equal(value.calls.downloads, 1, 'the documented download contract must keep working')
  assert.equal(result.plugins.runtime.directory, path.join(value.dataDir, 'staging', 'runtime-plugin', sha256))
})
