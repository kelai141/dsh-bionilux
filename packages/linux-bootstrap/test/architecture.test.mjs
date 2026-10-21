import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMobileBootstrap, DEFAULT_RUNTIME_ID, DEFAULT_RUNTIME_IDS, defaultRuntimeIdForArch } from '../src/index.js'
import { validateManifestShape, selectRuntimeForArch } from '../src/manifest.js'
import { DEFAULT_RUNTIME_IDS as RUNTIME_DEFAULT_RUNTIME_IDS } from '../../linux-runtime/modules/manifest.js'

const root = path.join(os.tmpdir(), `bionilux-architecture-tests-${process.pid}`)
after(async () => { await rm(root, { recursive: true, force: true }) })

const archive = Buffer.from('architecture selection runtime archive')
const sha256 = createHash('sha256').update(archive).digest('hex')
const entrySource = 'export function apply() {}'

function runtimePackage(version) {
  return JSON.stringify({ name: '@dsh-android/linux-runtime', version })
}

function asset(version, name) {
  const tag = `v${version}`
  return {
    url: `https://github.com/acme/dsh-bionilux/releases/download/${tag}/${name}`,
    sha256,
    size: archive.length,
    unpackedSize: Buffer.byteLength(runtimePackage(version)) + Buffer.byteLength(entrySource),
    pluginReleaseUrl: `https://github.com/acme/dsh-bionilux/releases/tag/${tag}`,
  }
}

function runtime(version, id, architecture) {
  return {
    id,
    label: `Debian minimal ${architecture}`,
    architecture,
    backend: 'bionilux',
    backendAsset: asset(version, `bionilux-${architecture}.tar.xz`),
    rootfsAsset: asset(version, `rootfs-${architecture}.tar.xz`),
    nodeAsset: asset(version, `node-${architecture}.tar.xz`),
  }
}

function manifest(version = '1.1.0', runtimes = [
  runtime(version, 'debian-minimal', 'arm64'),
  runtime(version, 'debian-minimal-x64', 'x64'),
]) {
  return {
    schemaVersion: 1,
    version,
    minMobileVersion: '0.14.0',
    plugins: {
      bootstrap: asset(version, 'linux-bootstrap-plugin.tar.xz'),
      runtime: asset(version, 'linux-runtime-plugin.tar.xz'),
    },
    runtimes,
  }
}

function response(value, url = '') {
  const bytes = Buffer.from(JSON.stringify(value))
  return {
    ok: true,
    status: 200,
    url,
    json: async () => value,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function harness({
  dataDir = path.join(root, `state-${Math.random().toString(16).slice(2)}`),
  arch,
  latestVersion = '1.1.0',
  runtimes,
  currentVersion = { value: '0.14.0' },
  isInjected,
} = {}) {
  const calls = {
    manifestFetches: 0,
    downloads: 0,
    hostInstalls: [],
    managerInstalls: [],
    managerReinstalls: [],
  }
  const runtimeManager = {
    install: async (...args) => {
      calls.managerInstalls.push(args)
    },
    reinstall: async (...args) => {
      calls.managerReinstalls.push(args)
    },
    uninstall: async () => {},
    status: async () => ({ healthy: true }),
  }
  const service = createMobileBootstrap({
    dataDir,
    ...(arch === undefined ? {} : { arch }),
    releaseUrl: 'https://api.github.com/repos/acme/dsh-bionilux/releases/latest',
    appVersionProvider: () => currentVersion.value,
    pluginHost: {
      install: async (input) => {
        calls.hostInstalls.push(input)
        return { manager: runtimeManager, rollback: async () => {} }
      },
      uninstall: async () => {},
      isInjected: async () => isInjected ?? { injected: true, active: true },
    },
    downloadAsset: async () => {
      calls.downloads += 1
      return archive
    },
    extractArchive: async (_asset, destination) => {
      await writeFile(path.join(destination, 'package.json'), runtimePackage(latestVersion))
      await mkdir(path.join(destination, 'lib'), { recursive: true })
      await writeFile(path.join(destination, 'lib', 'index.js'), entrySource)
    },
    fetchImpl: async (url) => {
      calls.manifestFetches += 1
      if (url.includes('api.github.com')) {
        return response({
          tag_name: `v${latestVersion}`,
          assets: [{
            name: 'linux-release.json',
            size: Buffer.byteLength(JSON.stringify(manifest(latestVersion, runtimes))),
            digest: null,
            browser_download_url: `https://github.com/acme/dsh-bionilux/releases/download/v${latestVersion}/linux-release.json`,
          }],
        }, url)
      }
      return response(manifest(latestVersion, runtimes), url)
    },
  })
  return { service, calls, dataDir, currentVersion }
}

test('dual-arch manifests are legal and status defaults follow the host architecture', async () => {
  assert.deepEqual(DEFAULT_RUNTIME_IDS, RUNTIME_DEFAULT_RUNTIME_IDS)
  assert.equal(DEFAULT_RUNTIME_ID, 'debian-minimal') // compatibility export, not host selection
  assert.equal(defaultRuntimeIdForArch('arm64'), 'debian-minimal')
  assert.equal(defaultRuntimeIdForArch('x64'), 'debian-minimal-x64')
  assert.equal(validateManifestShape(manifest('1.1.0')).runtimes.length, 2)

  for (const [arch, expected] of [['arm64', 'debian-minimal'], ['x64', 'debian-minimal-x64']]) {
    const value = harness({ arch })
    await value.service.ready
    await value.service.checkForUpdates({ source: 'manual' })
    const status = await value.service.status()

    assert.equal(status.architecture, arch)
    assert.equal(status.defaultRuntimeId, expected)
    assert.equal(status.runtimes.length, 1)
    assert.equal(status.runtimes[0].id, expected)
    assert.equal(status.runtimes[0].architecture, arch)
  }
})

test('an x64 host installs the x64 runtime when no runtime id is supplied', async () => {
  const value = harness({ arch: 'x64' })
  await value.service.ready
  const status = await value.service.install({ confirmed: true, activate: true })

  assert.equal(value.calls.hostInstalls.length, 1)
  assert.equal(value.calls.hostInstalls[0].config.arch, 'x64')
  assert.equal(value.calls.hostInstalls[0].config.runtimeId, 'debian-minimal-x64')
  assert.equal(value.calls.managerInstalls.length, 1)
  assert.equal(value.calls.managerInstalls[0][1], 'debian-minimal-x64')
  assert.equal(status.defaultRuntimeId, 'debian-minimal-x64')
  assert.equal(status.runtimeId, 'debian-minimal-x64')

  const state = JSON.parse(await readFile(path.join(value.dataDir, 'linux-bootstrap-state.json'), 'utf8'))
  assert.equal(state.runtimeId, 'debian-minimal-x64')
})

test('an explicit runtime for another architecture is rejected before host activation', async () => {
  const value = harness({ arch: 'x64' })
  await value.service.ready

  await assert.rejects(
    () => value.service.install({ runtimeId: 'debian-minimal', confirmed: true, activate: true }),
    /Runtime debian-minimal targets arm64, but this host is x64/,
  )
  assert.equal(value.calls.downloads, 0)
  assert.equal(value.calls.hostInstalls.length, 0)
  assert.equal(value.calls.managerInstalls.length, 0)
})

test('an x64 host fails closed when the manifest has no x64 runtime', async () => {
  const value = harness({
    arch: 'x64',
    runtimes: [runtime('1.1.0', 'debian-minimal', 'arm64')],
  })
  await value.service.ready

  await assert.rejects(
    () => value.service.install({ confirmed: true, activate: true }),
    /Runtime debian-minimal-x64 for x64 is not present in the release manifest/,
  )
  assert.equal(value.calls.downloads, 0, 'a missing x64 runtime must not fall back to arm64 assets')
  assert.equal(value.calls.hostInstalls.length, 0)
})

test('reinstall and automatic update keep the installed x64 runtime id', async () => {
  const value = harness({ arch: 'x64' })
  await value.service.ready
  await value.service.install({ confirmed: true, activate: true })
  await value.service.reinstall({ confirmed: true, activate: true })

  assert.equal(value.calls.managerReinstalls.length, 1)
  assert.equal(value.calls.managerReinstalls[0][1], 'debian-minimal-x64')

  await value.service.setAutoUpdateEnabled(true)
  value.currentVersion.value = '0.15.0'
  const reopened = harness({
    dataDir: value.dataDir,
    arch: 'x64',
    latestVersion: '1.2.0',
    currentVersion: value.currentVersion,
  })
  await reopened.service.ready

  assert.equal(reopened.calls.managerInstalls.length, 1)
  assert.equal(reopened.calls.managerInstalls[0][1], 'debian-minimal-x64')
  assert.equal(reopened.calls.hostInstalls[0].config.arch, 'x64')
})

test('manifest validation rejects duplicates but preserves explicitly selected custom runtimes', () => {
  const base = manifest('1.1.0')
  const duplicate = structuredClone(base)
  duplicate.runtimes.push({ ...duplicate.runtimes[1] })
  assert.throws(() => validateManifestShape(duplicate), /duplicate runtime id debian-minimal-x64/)

  const custom = structuredClone(base)
  custom.runtimes[1].id = 'debian-x64'
  const validated = validateManifestShape(custom)
  assert.equal(selectRuntimeForArch(validated, 'debian-x64', 'x64').id, 'debian-x64')
  assert.throws(() => selectRuntimeForArch(validated, undefined, 'x64'), /debian-minimal-x64.*not present/)

  const invalidArchitecture = structuredClone(base)
  invalidArchitecture.runtimes[1].architecture = 'riscv64'
  assert.throws(() => validateManifestShape(invalidArchitecture), /architecture must be arm64 or x64/)

  const x64Only = manifest('1.1.0', [runtime('1.1.0', 'debian-minimal-x64', 'x64')])
  assert.equal(validateManifestShape(x64Only).runtimes.length, 1)
})

test('bootstrap derives arch from process.arch and rejects an unsupported override', async () => {
  assert.throws(() => harness({ arch: 'riscv64' }), /arch must be arm64 or x64/)
  if (!['arm64', 'x64'].includes(process.arch)) return

  const value = harness({})
  const status = await value.service.status()
  assert.equal(status.architecture, process.arch)
  assert.equal(status.defaultRuntimeId, defaultRuntimeIdForArch(process.arch))
})
