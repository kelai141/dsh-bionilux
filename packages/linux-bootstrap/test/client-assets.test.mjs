/**
 * Asset selection and bridge preparation tests.
 *
 * Two invariants are pinned here:
 *   - an install stages the runtime plugin *and* the selected runtime's
 *     backend, rootfs and shared Node (staging only the plugin leaves the
 *     engine with nothing to consume);
 *   - every spec carries the shell `kind` (plugin/backend/rootfs/node), because
 *     the unpack rule differs: a rootfs legitimately contains symlinks and must
 *     not be unpacked with the plugin rule.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { ASSET_KINDS, AssetError, assetSpecsFor, isValidAsset, prepareAssets, selectRuntime, totalBytes } =
  await import('../client/assets.js')

const SHA = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)
const url = (name) => 'https://github.com/o/r/releases/download/v1.2.0/' + name
const asset = (name, sha, size) => ({ url: url(name), sha256: sha, size })

const manifest = {
  version: '1.2.0',
  plugins: { runtime: asset('linux-runtime-plugin.tar.xz', SHA, 10) },
  runtimes: [
    {
      id: 'debian-minimal',
      label: 'Debian minimal',
      architecture: 'arm64',
      backend: 'bionilux',
      backendAsset: asset('bionilux.tar.xz', SHA_B, 20),
      rootfsAsset: asset('rootfs.tar.xz', SHA_C, 30),
      nodeAsset: asset('node.tar.xz', SHA_D, 40),
    },
    {
      id: 'debian-minimal-x64',
      label: 'Debian minimal',
      architecture: 'x64',
      backend: 'bionilux',
      backendAsset: asset('bionilux-x64.tar.xz', SHA_B, 20),
    },
  ],
}

test('asset records need https, a hex digest and an integer size', () => {
  assert.equal(isValidAsset(asset('x.tar.xz', SHA, 1)), true)
  assert.equal(isValidAsset({ ...asset('x.tar.xz', SHA, 1), url: 'http://github.com/x' }), false)
  assert.equal(isValidAsset({ ...asset('x.tar.xz', SHA, 1), sha256: 'A'.repeat(64) }), false)
  assert.equal(isValidAsset({ ...asset('x.tar.xz', SHA, 1), size: -1 }), false)
  assert.equal(isValidAsset(null), false)
})

test('runtime selection honours the id, then the architecture, then the first entry', () => {
  assert.equal(selectRuntime(manifest, { runtimeId: 'debian-minimal-x64' })?.id, 'debian-minimal-x64')
  assert.equal(selectRuntime(manifest, { architecture: 'x64' })?.id, 'debian-minimal-x64')
  assert.equal(selectRuntime(manifest)?.id, 'debian-minimal')
  assert.equal(selectRuntime(manifest, { runtimeId: 'missing' }), null)
})

test('every install stages the plugin and the backend, rootfs and node', () => {
  const { runtime, specs } = assetSpecsFor(manifest, { runtimeId: 'debian-minimal' })
  assert.equal(runtime?.id, 'debian-minimal')
  assert.deepEqual(specs.map((spec) => spec.field), ['runtime-plugin', 'backendAsset', 'rootfsAsset', 'nodeAsset'])
  assert.deepEqual(specs.map((spec) => spec.kind), ['plugin', 'backend', 'rootfs', 'node'])
  assert.deepEqual(specs.map((spec) => spec.sha256), [SHA, SHA_B, SHA_C, SHA_D])
  assert.equal(totalBytes(specs), 100)
})

test('the kinds are the shell contract, not derived from the field name', () => {
  assert.deepEqual(ASSET_KINDS, {
    'runtime-plugin': 'plugin',
    backendAsset: 'backend',
    rootfsAsset: 'rootfs',
    nodeAsset: 'node',
  })
})

test('an architecture without the optional assets stages what the manifest lists', () => {
  const { specs } = assetSpecsFor(manifest, { runtimeId: 'debian-minimal-x64' })
  assert.deepEqual(specs.map((spec) => spec.kind), ['plugin', 'backend'])
})

/** Bridge double: accepts a spec, reports ok on the next poll. */
function bridgeDouble({ onPrepare } = {}) {
  const prepared = []
  let pending = null
  return {
    prepared,
    linuxAssetPrepare(specJson) {
      const spec = JSON.parse(specJson)
      prepared.push(spec)
      onPrepare?.(spec)
      if (spec.sha256 === 'f'.repeat(64)) return JSON.stringify({ ok: false, code: 'linux-asset-url-rejected', detail: 'rejected' })
      pending = spec.sha256
      return JSON.stringify({ ok: true, phase: 'running', sha256: spec.sha256 })
    },
    linuxAssetPrepareStatus() {
      return JSON.stringify({ phase: 'ok', sha256: pending })
    },
  }
}

const fast = () => Promise.resolve()

test('prepareAssets hands the shell the url, digest, size and kind for each asset', async () => {
  const bridge = bridgeDouble()
  const { specs } = assetSpecsFor(manifest, { runtimeId: 'debian-minimal' })
  await prepareAssets({ bridge, specs, sleepImpl: fast })
  assert.deepEqual(bridge.prepared, [
    { url: url('linux-runtime-plugin.tar.xz'), sha256: SHA, size: 10, kind: 'plugin' },
    { url: url('bionilux.tar.xz'), sha256: SHA_B, size: 20, kind: 'backend' },
    { url: url('rootfs.tar.xz'), sha256: SHA_C, size: 30, kind: 'rootfs' },
    { url: url('node.tar.xz'), sha256: SHA_D, size: 40, kind: 'node' },
  ])
})

test('progress reports each asset once it is staged', async () => {
  const seen = []
  const { specs } = assetSpecsFor(manifest, { runtimeId: 'debian-minimal-x64' })
  await prepareAssets({
    bridge: bridgeDouble(),
    specs,
    sleepImpl: fast,
    onProgress: (item) => seen.push(item.index + ':' + item.field + ':' + item.phase),
  })
  assert.ok(seen.includes('1:runtime-plugin:staged'))
  assert.ok(seen.includes('2:backendAsset:staged'))
})

test('a rejected asset fails closed with the shell code', async () => {
  const bridge = bridgeDouble()
  await assert.rejects(
    () => prepareAssets({
      bridge,
      specs: [{ id: 'x', field: 'nodeAsset', kind: 'node', url: url('node.tar.xz'), sha256: 'f'.repeat(64), size: 1 }],
      sleepImpl: fast,
    }),
    (error) => error instanceof AssetError && error.code === 'linux-asset-url-rejected',
  )
})

test('a staged digest that does not match the manifest is refused', async () => {
  const bridge = {
    linuxAssetPrepare: () => JSON.stringify({ ok: true, phase: 'running' }),
    linuxAssetPrepareStatus: () => JSON.stringify({ phase: 'ok', sha256: SHA_B }),
  }
  await assert.rejects(
    () => prepareAssets({
      bridge,
      specs: [{ id: 'x', field: 'rootfsAsset', kind: 'rootfs', url: url('rootfs.tar.xz'), sha256: SHA_C, size: 1 }],
      sleepImpl: fast,
    }),
    (error) => error instanceof AssetError && error.code === 'linux-asset-digest-mismatch',
  )
})

test('a missing bridge is an explicit error, never a silent success', async () => {
  await assert.rejects(
    () => prepareAssets({ bridge: {}, specs: [], sleepImpl: fast }),
    (error) => error instanceof AssetError && error.code === 'linux-asset-bridge-missing',
  )
  await assert.rejects(
    () => prepareAssets({
      bridge: {},
      specs: [{ id: 'x', field: 'nodeAsset', kind: 'node', url: url('node.tar.xz'), sha256: SHA, size: 1 }],
      sleepImpl: fast,
    }),
    (error) => error instanceof AssetError && error.code === 'linux-asset-bridge-missing',
  )
})
