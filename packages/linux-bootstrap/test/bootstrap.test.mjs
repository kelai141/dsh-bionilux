import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMobileBootstrap } from '../src/index.js'
import { createRouteHandlers } from '../src/routes.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const archive = Buffer.from('verified runtime archive')
const sha256 = createHash('sha256').update(archive).digest('hex')
const tag = 'v1.1.0'
const releaseUrl = `https://github.com/acme/dsh-bionilux/releases/download/${tag}`
const entrySource = 'export function apply() {}'

function runtimePackage(version) {
  return JSON.stringify({ name: '@dsh-android/linux-runtime', version })
}

function expandedSize(version) {
  return Buffer.byteLength(runtimePackage(version)) + Buffer.byteLength(entrySource)
}

function manifest(version = '1.1.0') {
  const versionTag = `v${version}`
  const base = `https://github.com/acme/dsh-bionilux/releases/download/${versionTag}`
  const asset = (name) => ({ url: `${base}/${name}`, sha256, size: archive.length, unpackedSize: expandedSize(version), pluginReleaseUrl: `https://github.com/acme/dsh-bionilux/releases/tag/${versionTag}` })
  return {
    schemaVersion: 1,
    version,
    minMobileVersion: '0.14.0',
    plugins: { bootstrap: asset('linux-bootstrap-plugin.tar.xz'), runtime: asset('linux-runtime-plugin.tar.xz') },
    runtimes: [{ id: 'debian-minimal', label: 'Debian minimal', architecture: 'arm64', backend: 'bionilux', backendAsset: asset('bionilux.tar.xz'), rootfsAsset: asset('rootfs.tar.xz'), nodeAsset: asset('node.tar.xz') }],
  }
}

function response(value, url = '') {
  const bytes = Buffer.from(JSON.stringify(value))
  return { ok: true, status: 200, url, json: async () => value, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

function harness({ dataDir = path.join(root, `state-${Math.random().toString(16).slice(2)}`), currentVersion = { value: '0.14.0' }, latestVersion = '1.1.0', managerProvider, hostReturnsManager = true, isInjected } = {}) {
  const calls = { manifestFetches: 0, downloads: 0, managerInstalls: [], managerUninstalls: 0, hostInstalls: [], hostUninstalls: 0, injectionQueries: 0 }
  const runtimeManager = {
    install: async (...args) => calls.managerInstalls.push(args),
    reinstall: async (...args) => calls.managerInstalls.push(args),
    uninstall: async () => { calls.managerUninstalls += 1 },
    status: async () => ({ running: false }),
  }
  const service = createMobileBootstrap({
    dataDir,
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => currentVersion.value,
    managerProvider,
    pluginHost: {
      install: async (input) => { calls.hostInstalls.push(input); return { ...(hostReturnsManager ? { manager: runtimeManager } : {}), rollback: async () => { calls.hostUninstalls += 1 } } },
      uninstall: async () => { calls.hostUninstalls += 1 },
      isInjected: async () => {
        calls.injectionQueries += 1
        return isInjected ?? { injected: true, active: true }
      },
      service: runtimeManager,
    },
    downloadAsset: async () => { calls.downloads += 1; return archive },
    extractArchive: async (_asset, destination) => {
      await writeFile(path.join(destination, 'package.json'), runtimePackage(latestVersion))
      await mkdir(path.join(destination, 'lib'), { recursive: true })
      await writeFile(path.join(destination, 'lib', 'index.js'), entrySource)
    },
    fetchImpl: async (url) => {
      calls.manifestFetches += 1
      if (url.includes('api.github.com')) return response({
        tag_name: `v${latestVersion}`,
        assets: [{ name: 'linux-release.json', size: Buffer.byteLength(JSON.stringify(manifest(latestVersion))), digest: null, browser_download_url: `https://github.com/acme/dsh-bionilux/releases/download/v${latestVersion}/linux-release.json` }],
      }, url)
      return response(manifest(latestVersion), url)
    },
  })
  return { service, calls, dataDir, currentVersion }
}

test('manual check always fetches, startup on unchanged mobile version is network silent', async () => {
  const value = harness()
  await value.service.ready
  assert.equal(value.calls.manifestFetches, 0)
  await value.service.checkForUpdates({ source: 'manual' })
  assert.equal(value.calls.manifestFetches, 2)
  const status = await value.service.status()
  assert.equal(status.availableVersion, '1.1.0')
  assert.equal(status.updateAvailable, true)
})

test('install uses plugin-first lazy manager provisioning and persists app version baseline', async () => {
  let providerCalls = 0
  const value = harness({ hostReturnsManager: false, managerProvider: async ({ pluginHost, directory, entry, config }) => {
    providerCalls += 1
    assert.ok(pluginHost)
    assert.ok(directory)
    assert.equal(entry, 'lib/index.js')
    assert.equal(config.runtimeId, 'debian-minimal')
    return pluginHost.service
  } })
  await value.service.ready
  assert.equal(providerCalls, 0)
  await value.service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true })
  assert.equal(providerCalls, 1)
  assert.equal(value.calls.hostInstalls.length, 1)
  assert.equal(value.calls.hostInstalls[0].enable, true)
  assert.equal(value.calls.managerInstalls.length, 1)
  assert.equal(value.calls.managerInstalls[0][1], 'debian-minimal')
  const state = JSON.parse(await readFile(path.join(value.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.installedSystemMobileVersion, '0.14.0')
  assert.equal(state.installedLinuxVersion, '1.1.0')
})

test('mobile-version delta triggers automatic check/install once; enabling toggle does not check', async () => {
  const value = harness()
  await value.service.ready
  await value.service.install({ confirmed: true, activate: true })
  await value.service.setAutoUpdateEnabled(false)
  value.currentVersion.value = '0.14.1'
  const fresh = harness({ dataDir: value.dataDir, currentVersion: value.currentVersion, latestVersion: '1.2.0' })
  await fresh.service.ready
  assert.equal(fresh.calls.manifestFetches, 0)
  await fresh.service.setAutoUpdateEnabled(true)
  assert.equal(fresh.calls.manifestFetches, 0)
  const resumed = harness({ dataDir: value.dataDir, currentVersion: value.currentVersion, latestVersion: '1.2.0' })
  const stored = JSON.parse(await readFile(path.join(value.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  stored.autoUpdateEnabled = true
  await writeFile(path.join(value.dataDir, 'linux-bootstrap-state.json'), JSON.stringify(stored))
  await resumed.service.ready
  assert.equal(resumed.calls.manifestFetches, 2)
  assert.equal(resumed.calls.managerInstalls.length, 1)
})

test('a plugin the user removed from the injection directory is never resurrected', async () => {
  // 1. Explicit install works and persists the activation state.
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })
  let state = JSON.parse(await readFile(path.join(installed.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.injectionActivated, true)

  // 2. The user deletes the runtime plugin by hand, then the app updates.
  const removed = harness({
    dataDir: installed.dataDir,
    currentVersion: { value: '0.15.0' },
    latestVersion: '1.2.0',
    isInjected: { injected: false, active: false },
  })
  await removed.service.ready

  state = JSON.parse(await readFile(path.join(installed.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.injectionActivated, false, 'a removed plugin must be recorded as inactive')
  assert.equal(state.enabled, false)
  assert.equal(removed.calls.manifestFetches, 0, 'no update may be fetched for a removed plugin')
  assert.equal(removed.calls.hostInstalls.length, 0, 'nothing may be re-added to the injection directory')
})

test('an automatic update fails closed when the injected plugin disappears mid-flight', async () => {
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })

  const gone = harness({
    dataDir: installed.dataDir,
    currentVersion: { value: '0.15.0' },
    latestVersion: '1.2.0',
    isInjected: { injected: true, active: true },
  })
  await gone.service.ready

  // Simulate the user removing the directory between the check and the install.
  gone.service.setAutoUpdateEnabled(false)
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  stored.injectionActivated = true
  stored.enabled = true
  await writeFile(statePath, JSON.stringify(stored))

  const hostile = harness({
    dataDir: installed.dataDir,
    currentVersion: { value: '0.15.0' },
    latestVersion: '1.2.0',
    isInjected: { injected: false, active: false },
  })
  await hostile.service.ready
  await hostile.service.checkForUpdates({ source: 'mobile-version-change' })

  const after = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(after.injectionActivated, false, 'the removal must be persisted')
  assert.equal(hostile.calls.hostInstalls.length, 0, 'an automatic update must never re-add the plugin')
})

test('manual check never installs an available update on its own', async () => {
  const value = harness()
  await value.service.ready
  await value.service.install({ confirmed: true, activate: true })

  const newer = harness({
    dataDir: value.dataDir,
    currentVersion: value.currentVersion,
    latestVersion: '1.3.0',
  })
  await newer.service.ready
  const status = await newer.service.checkForUpdates({ source: 'manual' })

  assert.equal(status.updateAvailable, true)
  assert.equal(newer.calls.managerInstalls.length, 0, 'a manual check only reports, it does not install')
  assert.equal(newer.calls.hostInstalls.length, 0)
})

test('install and reinstall require an explicit confirmed activation', async () => {
  const value = harness()
  await value.service.ready
  await assert.rejects(() => value.service.install({}), /confirmed:true and activate:true/)
  await assert.rejects(() => value.service.install({ confirmed: true }), /confirmed:true and activate:true/)
  await assert.rejects(() => value.service.reinstall({ confirmed: true }), /confirmed:true and activate:true/)
  assert.equal(value.calls.hostInstalls.length, 0)
  assert.equal(value.calls.managerInstalls.length, 0)

  const status = await value.service.status()
  assert.equal(status.installed, false)
  assert.equal(status.autoUpdate, false, 'auto-update is off until the user opts in')
})

test('the service offers the manifest runtimes and defaults to Debian minimal', async () => {
  const value = harness()
  await value.service.ready
  await value.service.checkForUpdates({ source: 'manual' })
  const status = await value.service.status()

  assert.equal(status.defaultRuntimeId, 'debian-minimal')
  assert.equal(Array.isArray(status.runtimes), true)
  assert.equal(status.runtimes.length, 1)
  assert.deepEqual(
    { id: status.runtimes[0].id, architecture: status.runtimes[0].architecture, installed: status.runtimes[0].installed },
    { id: 'debian-minimal', architecture: 'arm64', installed: false },
  )

  await assert.rejects(
    () => value.service.install({ runtimeId: 'not-a-runtime', confirmed: true, activate: true }),
    /Unknown runtime id/,
  )
  assert.equal(value.calls.hostInstalls.length, 0, 'an unknown runtime must not reach the host adapter')
});

test('rejects bad package asset digest before host activation', async () => {
  const value = harness()
  const originalFetch = value.service
  await originalFetch.ready
  const badArchive = Buffer.from('wrong')
  const badService = createMobileBootstrap({
    dataDir: path.join(root, 'bad-hash'),
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => '0.14.0',
    pluginHost: { install: async () => assert.fail('must not activate'), uninstall: async () => {} },
    downloadAsset: async () => badArchive,
    extractArchive: async () => assert.fail('must not extract'),
    manager: { install: async () => {}, uninstall: async () => {} },
    fetchImpl: async (url) => response(url.includes('api.github.com') ? { tag_name: tag, assets: [{ name: 'linux-release.json', browser_download_url: `${releaseUrl}/linux-release.json` }] } : manifest(), url),
  })
  await badService.ready
  await badService.checkForUpdates({ source: 'manual' })
  await assert.rejects(badService.install({ confirmed: true, activate: true }), /SHA-256 or size verification failed/)
})

test('writes require confirmed true on route handler adapter', async () => {
  const value = harness()
  await value.service.ready
  const handlers = createRouteHandlers(value.service)
  await assert.rejects(handlers.check({ body: {} }), /confirmed:true is required/)
  const checked = await handlers.check({ body: { confirmed: true } })
  assert.equal(checked.availableVersion, '1.1.0')
})

after(async () => rm(root, { recursive: true, force: true }))
