/**
 * A cached plugin slot must never be activated on the strength of its own
 * marker file alone.
 *
 * The host reports (and this file reproduces) that reuse only re-validated the
 * package name and entry, so a slot whose contents had been altered still
 * activated. `reused: true` has to be a verification outcome: the published tree
 * is re-measured and re-validated, and a slot that no longer matches the
 * manifest is rebuilt from a verified source instead of being activated.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMobileBootstrap } from '../src/index.js'

const root = path.join(os.tmpdir(), `bionilux-bundle-reuse-tests-${process.pid}`)
after(async () => { await rm(root, { recursive: true, force: true }) })

const archive = Buffer.from('reuse path runtime archive')
const sha256 = createHash('sha256').update(archive).digest('hex')
const version = '3.0.0'
const tag = `v${version}`
const releaseUrl = `https://github.com/acme/dsh-bionilux/releases/download/${tag}`
const packageName = '@dsh-android/linux-runtime'
const entrySource = 'export function apply() {}'
const packageJson = JSON.stringify({ name: packageName, version: '3.0.0' })
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

function harness({ dataDir = path.join(root, `state-${Math.random().toString(16).slice(2)}`) } = {}) {
  const calls = { downloads: 0 }
  const service = createMobileBootstrap({
    dataDir,
    arch: 'arm64',
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => '0.14.0',
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

const install = (service) => service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })
const reinstall = (service) => service.reinstall({ confirmed: true, activate: true })

test('an intact published slot is reused without re-downloading', async () => {
  const value = harness()
  await value.service.ready
  await install(value.service)
  assert.equal(value.calls.downloads, 1)
  await reinstall(value.service)
  assert.equal(value.calls.downloads, 1, 'an intact slot must be reused rather than re-fetched')
})

test('a slot whose contents were altered is rebuilt, not activated', async () => {
  const value = harness()
  await value.service.ready
  const first = await install(value.service)
  const publishedRoot = first.plugins.runtime.directory

  // The marker still describes the manifest (it is not rewritten by an
  // attacker), the package name and entry are untouched - only the payload
  // differs. Reuse must notice, because nothing here proves the tree is intact.
  await writeFile(path.join(publishedRoot, 'lib', 'index.js'), `${entrySource}\n// tampered payload`)

  await reinstall(value.service)

  assert.equal(value.calls.downloads, 2, 'an altered slot must be rebuilt from a verified source')
  assert.equal(
    await readFile(path.join(publishedRoot, 'lib', 'index.js'), 'utf8'),
    entrySource,
    'the tampered payload must not survive as the activated runtime',
  )
})

test('a slot containing a symbolic link is rebuilt, not activated', { skip: process.platform === 'win32' ? 'creating symlinks needs privilege on Windows' : false }, async () => {
  const value = harness()
  await value.service.ready
  const first = await install(value.service)
  const publishedRoot = first.plugins.runtime.directory

  const { symlink } = await import('node:fs/promises')
  await symlink('/etc/passwd', path.join(publishedRoot, 'lib', 'link.js'))

  await reinstall(value.service)
  assert.equal(value.calls.downloads, 2, 'a slot with a symbolic link must not be reused')
})
