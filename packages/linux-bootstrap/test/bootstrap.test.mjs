import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMobileBootstrap } from '../src/index.js'
import { createRouteHandlers } from '../src/routes.js'

// A fresh root per test process. A package-relative root made concurrent
// Windows and WSL runs delete each other's state during teardown.
const root = await mkdtemp(path.join(os.tmpdir(), 'bionilux-bootstrap-tests-'))
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

function harness({ dataDir = path.join(root, `state-${Math.random().toString(16).slice(2)}`), currentVersion = { value: '0.14.0' }, latestVersion = '1.1.0', managerProvider, hostReturnsManager = true, isInjected, hostInstallError, managerVerify = async () => ({ healthy: true }) } = {}) {
  const calls = { manifestFetches: 0, downloads: 0, managerInstalls: [], managerUninstalls: 0, hostInstalls: [], hostUninstalls: 0, injectionQueries: 0 }
  const runtimeManager = {
    install: async (...args) => calls.managerInstalls.push(args),
    reinstall: async (...args) => calls.managerInstalls.push(args),
    uninstall: async () => { calls.managerUninstalls += 1 },
    status: async () => ({ healthy: true }),
    verify: managerVerify,
  }
  const service = createMobileBootstrap({
    dataDir,
    stagingDirectory: path.join(dataDir, 'plugins', 'runtime'),
    arch: 'arm64',
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => currentVersion.value,
    managerProvider,
    pluginHost: {
      install: async (input) => { calls.hostInstalls.push(input); if (hostInstallError) throw hostInstallError; return { ...(hostReturnsManager ? { manager: runtimeManager } : {}), rollback: async () => { calls.hostUninstalls += 1 } } },
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

test('a failed activation is rolled back without leaving the service reporting an install', async () => {
  const value = harness({
    hostReturnsManager: false,
    managerProvider: async () => ({
      install: async () => {},
      uninstall: async () => {},
      verify: async () => { throw new Error('runtime status is unavailable') },
    }),
  })
  await value.service.ready

  await assert.rejects(
    () => value.service.install({ confirmed: true, activate: true }),
    /runtime status is unavailable/,
  )
  assert.equal(value.calls.hostUninstalls, 1, 'the activated plugin must be rolled back')

  const status = await value.service.status()
  assert.equal(status.installed, false, 'a rolled-back install must not be reported as installed')
  assert.equal(status.version, null)
  assert.equal(status.runtimeId, null)
  assert.match(status.error, /runtime status is unavailable/)
})

test('mobile-version delta triggers automatic check/install once; enabling toggle does not check', async () => {
  const value = harness()
  await value.service.ready
  await value.service.install({ confirmed: true, activate: true })
  await value.service.setAutoUpdateEnabled(false)
  value.currentVersion.value = '0.14.1'

  // Reopen the same store with the new app version: the preference is off, so
  // nothing is fetched and enabling the toggle must not check either.
  const reopened = harness({ dataDir: value.dataDir, currentVersion: value.currentVersion, latestVersion: '1.2.0' })
  await reopened.service.ready
  assert.equal(reopened.calls.manifestFetches, 0, 'auto-update off must stay network silent')
  await reopened.service.setAutoUpdateEnabled(true)
  assert.equal(reopened.calls.manifestFetches, 0, 'the toggle itself must not trigger a check')

  // Persist the preference, then reopen: the recorded app version differs from
  // the current one, so exactly one automatic check (and install) happens.
  const statePath = path.join(value.dataDir, 'linux-bootstrap-state.json')
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  stored.autoUpdateEnabled = true
  await writeFile(statePath, JSON.stringify(stored))

  const afterVersionChange = harness({ dataDir: value.dataDir, currentVersion: value.currentVersion, latestVersion: '1.2.0' })
  await afterVersionChange.service.ready
  assert.equal(afterVersionChange.calls.manifestFetches, 2)
  assert.equal(afterVersionChange.calls.managerInstalls.length, 1)
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

  // Record the pre-removal state deterministically: settle every write before
  // reopening the store, so the reopened service cannot race a stale write.
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const active = JSON.parse(await readFile(statePath, 'utf8'))
  active.enabled = true
  active.injectionActivated = true
  active.autoUpdateEnabled = true
  await writeFile(statePath, JSON.stringify(active))

  // The user removes the runtime plugin: the host reports it as not injected.
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
  assert.equal(after.enabled, false)
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
  // Reopening restores the persisted installation (that is not an install); the
  // check itself must still not stage or download anything.
  assert.equal(newer.calls.hostInstalls.length, 1, 'only the cold-start restore may touch the host')
  assert.equal(newer.calls.downloads, 0, 'a manual check must not download')
})

test('cold start re-activates a persisted opt-in before the host view can clear it', async () => {
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(stored.enabled, true)

  // A fresh process has not loaded the runtime plugin yet: the host reports
  // injected-but-inactive. Restoring must happen before that view is reconciled,
  // otherwise the persisted opt-in is cleared and the tools never come back.
  const cold = harness({ dataDir: installed.dataDir, isInjected: { injected: true, active: false } })
  await cold.service.ready
  assert.equal(cold.calls.hostInstalls.length, 1, 'the persisted installation must be re-activated')
  assert.equal(cold.calls.hostInstalls[0].directory, stored.pluginDirectory)
  assert.equal(cold.calls.hostInstalls[0].entry, 'lib/index.js')
  assert.equal(cold.calls.hostInstalls[0].enable, true)
  assert.equal(cold.calls.hostInstalls[0].config.runtimeId, 'debian-minimal')
  assert.equal(cold.calls.hostInstalls[0].config.arch, 'arm64')
  assert.ok(cold.calls.hostInstalls[0].config.dataDir.endsWith('runtime'))
  assert.deepEqual(cold.calls.hostInstalls[0].config.manifest.version, '1.1.0')
  assert.equal(cold.calls.downloads, 0, 'a restore must never download')
  assert.equal(cold.calls.manifestFetches, 0, 'a restore must never hit the network')

  const after = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(after.enabled, true, 'the cold-start restore must not clear the opt-in')
  assert.equal(after.injectionActivated, true)
  const status = await cold.service.status()
  assert.equal(status.installed, true)
  assert.equal(status.injectionActivated, true)
})

test('cold start never resurrects a removed or incomplete installation', async () => {
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const stored = JSON.parse(await readFile(statePath, 'utf8'))

  // 1. The host says the plugin is no longer injected (the user removed it).
  const removed = harness({ dataDir: installed.dataDir, isInjected: { injected: false, active: false } })
  await removed.service.ready
  assert.equal(removed.calls.hostInstalls.length, 0, 'nothing may be re-added')
  assert.equal(removed.calls.downloads, 0)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).enabled, false)

  // 2. The persisted directory is still reported as injected, but its entry is gone.
  await writeFile(statePath, JSON.stringify(stored))
  await rm(path.join(stored.pluginDirectory, 'lib', 'index.js'), { force: true })
  const incomplete = harness({ dataDir: installed.dataDir, isInjected: { injected: true, active: false } })
  await incomplete.service.ready
  assert.equal(incomplete.calls.hostInstalls.length, 0, 'a missing entry must not be re-fetched')
  assert.equal(incomplete.calls.downloads, 0)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.enabled, false)
  assert.equal(state.injectionActivated, false)
  assert.match(state.lastError, /files are missing/)
})

test('a persisted directory outside the plugin root is never activated', async () => {
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  // A tampered record pointing at a real entry outside our staging root.
  const outside = path.join(root, `outside-${Math.random().toString(16).slice(2)}`)
  await mkdir(path.join(outside, 'lib'), { recursive: true })
  await writeFile(path.join(outside, 'lib', 'index.js'), entrySource)
  await writeFile(statePath, JSON.stringify({ ...stored, pluginDirectory: outside }))

  const tampered = harness({ dataDir: installed.dataDir, isInjected: { injected: true, active: false } })
  await tampered.service.ready
  assert.equal(tampered.calls.hostInstalls.length, 0)
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).enabled, false)
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

test('the arm64 service offers the arm64 runtime and defaults to Debian minimal', async () => {
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
    /not present in the release manifest/,
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
    arch: 'arm64',
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

test('install rejects unavailable or failed executable verification before persisting activation', async () => {
  for (const managerVerify of [undefined, async () => ({ healthy: false, reason: 'bash cannot load libtinfo' }), async () => ({})]) {
    const value = harness({ managerVerify: managerVerify ?? null })
    await value.service.ready
    await assert.rejects(value.service.install({ confirmed: true, activate: true }), /cannot prove usability|not usable/)
    assert.equal(value.calls.hostUninstalls, 1)
    const status = await value.service.status()
    assert.equal(status.installed, false)
    assert.equal(status.enabled, false)
    const stored = JSON.parse(await readFile(path.join(value.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
    assert.equal(stored.installedLinuxVersion, null)
  }
})

test('cold restore awaits verification and keeps failed health inactive despite host membership', async () => {
  const installed = harness()
  await installed.service.install({ confirmed: true, activate: true })
  let release
  const proof = new Promise(resolve => { release = resolve })
  let verifying
  const started = new Promise(resolve => { verifying = resolve })
  const cold = harness({ dataDir: installed.dataDir, managerVerify: async () => { verifying(); return proof } })
  await started
  let settled = false
  cold.service.ready.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'startup must wait for the executable probe')
  release({ healthy: false, reason: 'external id cannot execute' })
  await cold.service.ready
  assert.equal(cold.calls.hostUninstalls, 1, 'failed restore releases the activated host scope')
  await cold.service.syncInjectionState()
  const status = await cold.service.status()
  assert.equal(status.installed, true, 'failed restore retains installed data')
  assert.equal(status.enabled, false)
  assert.equal(status.injectionActivated, false)
  assert.equal(status.runtime.healthy, false)
  assert.match(status.error, /external id cannot execute/)
})

test('cold restore rechecks minimum app version and architecture before loading a plugin', async () => {
  for (const mismatch of ['version', 'architecture']) {
    const installed = harness()
    await installed.service.install({ confirmed: true, activate: true })
    const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
    const stored = JSON.parse(await readFile(statePath, 'utf8'))
    if (mismatch === 'architecture') stored.pinnedManifest.runtimes[0].architecture = 'x64'
    await writeFile(statePath, JSON.stringify(stored))
    const cold = harness({ dataDir: installed.dataDir, currentVersion: { value: mismatch === 'version' ? '0.13.0' : '0.14.0' } })
    await cold.service.ready
    assert.equal(cold.calls.hostInstalls.length, 0)
    assert.equal(cold.calls.downloads, 0)
    const status = await cold.service.status()
    assert.equal(status.enabled, false)
    assert.match(status.error, /requires DSH Mobile|architecture|arm64/)
  }
})

after(async () => rm(root, { recursive: true, force: true }))

test('shutdown during cold restore preserves persisted opt-in for the next engine', async () => {
  const installed = harness()
  await installed.service.ready
  await installed.service.install({ confirmed: true, activate: true })
  const statePath = path.join(installed.dataDir, 'linux-bootstrap-state.json')
  const before = JSON.parse(await readFile(statePath, 'utf8'))
  const stopped = harness({ dataDir: installed.dataDir, isInjected: { injected: true, active: false },
    hostInstallError: Object.assign(new Error('engine stopping'), { code: 'LINUX_ENGINE_STOPPING' }) })
  await stopped.service.ready
  const after = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(after.enabled, true)
  assert.equal(after.injectionActivated, true)
  assert.equal(after.pluginDirectory, before.pluginDirectory)
  assert.equal(stopped.calls.downloads, 0)
  const restarted = harness({ dataDir: installed.dataDir })
  await restarted.service.ready
  assert.equal((await restarted.service.status()).enabled, true)
  assert.equal(restarted.calls.hostInstalls.length, 1)
})
