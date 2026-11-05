/**
 * Route client tests: the settings section talks to the engine over the
 * authenticated same-origin routes, so the request shapes are a contract.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { createApi, PATHS, RouteError } = await import('../client/api.js')

/** Fake fetch recording method/body and replaying canned answers. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (path, init) => {
    calls.push({
      path,
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      credentials: init.credentials,
    })
    const route = routes[path]
    if (route === undefined) throw new Error('unexpected fetch: ' + path)
    const status = route.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => route.body ?? {} }
  }
  return { calls, impl }
}

test('status is a credentialed GET that never caches', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.status]: { body: { installed: false } } })
  const status = await createApi({ fetchImpl: impl }).status()
  assert.equal(status.installed, false)
  assert.deepEqual(calls, [{ path: PATHS.status, method: 'GET', body: undefined, credentials: 'same-origin' }])
})

test('a fresh host discovers the manifest before the first one-click install', async () => {
  let checked = false
  const calls = []
  const manifest = { version: '0.5.0' }
  const api = createApi({ fetchImpl: async (path) => {
    calls.push(path)
    if (path === PATHS.check) checked = true
    return { ok: true, status: 200, json: async () => path === PATHS.manifest ? { manifest: checked ? manifest : null } : { installed: false } }
  } })
  assert.deepEqual(await api.manifest(), manifest)
  assert.deepEqual(calls, [PATHS.manifest, PATHS.check, PATHS.manifest])
})

test('install posts confirmed+activate and forwards the runtime id', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.install]: { body: { installed: true } } })
  await createApi({ fetchImpl: impl }).install({ runtimeId: 'debian-minimal' })
  assert.deepEqual(calls[0].body, { confirmed: true, runtimeId: 'debian-minimal' })
})

test('install omits the runtime id when the host did not pick one', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.install]: { body: { installed: true } } })
  await createApi({ fetchImpl: impl }).install()
  assert.deepEqual(calls[0].body, { confirmed: true })
})

test('reinstall and uninstall require confirmation', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.reinstall]: { body: {} }, [PATHS.uninstall]: { body: {} } })
  const api = createApi({ fetchImpl: impl })
  await api.reinstall()
  await api.uninstall()
  assert.deepEqual(calls.map((call) => call.body), [{ confirmed: true }, { confirmed: true }])
})

test('the auto-update preference picks the matching route', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.autoUpdateOn]: { body: {} }, [PATHS.autoUpdateOff]: { body: {} } })
  const api = createApi({ fetchImpl: impl })
  await api.setAutoUpdate(true)
  await api.setAutoUpdate(false)
  assert.deepEqual(calls.map((call) => call.path), [PATHS.autoUpdateOn, PATHS.autoUpdateOff])
})

test('the host error string reaches the caller instead of a bare status code', async () => {
  const { impl } = fakeFetch({ [PATHS.install]: { status: 409, body: { error: '另一项 Linux 环境操作正在进行，请稍后重试。' } } })
  await assert.rejects(
    () => createApi({ fetchImpl: impl }).install({ runtimeId: 'debian-minimal' }),
    (error) => error instanceof RouteError && error.status === 409 && /另一项/.test(error.message),
  )
})

test('the manifest comes from /manifest when the host serves it', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.manifest]: { body: { manifest: { version: '1.2.0', runtimes: [] } } } })
  const manifest = await createApi({ fetchImpl: impl }).manifest()
  assert.equal(manifest.version, '1.2.0')
  assert.equal(calls.length, 1)
})

test('a host without /manifest falls back to exactly one check', async () => {
  const { calls, impl } = fakeFetch({
    [PATHS.manifest]: { status: 404, body: { error: 'not found' } },
    [PATHS.check]: { body: { manifest: { version: '1.2.0', runtimes: [] } } },
  })
  const manifest = await createApi({ fetchImpl: impl }).manifest()
  assert.equal(manifest.version, '1.2.0')
  assert.deepEqual(calls.map((call) => call.path), [PATHS.manifest, PATHS.check])
})

test('other manifest failures are not masked by the check fallback', async () => {
  const { calls, impl } = fakeFetch({ [PATHS.manifest]: { status: 503, body: { error: '未启用' } } })
  await assert.rejects(() => createApi({ fetchImpl: impl }).manifest(), /未启用/)
  assert.equal(calls.length, 1)
})
