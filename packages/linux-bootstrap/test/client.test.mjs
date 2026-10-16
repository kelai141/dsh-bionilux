/**
 * Regression tests for the client half of the experimental Linux bootstrap.
 *
 * The client is loaded by the DSH Mobile UI host, so its registration contract
 * is a cross-package interface: the host supplies `react` and the `slots`
 * service, and reads the section back from the `settings.section` slot. The
 * DSH Mobile host's own client plugins (`dsh-client-ui-responsive`,
 * `dsh-android-vdisplay`) are the reference for that shape, and these tests pin
 * this package to it:
 *
 *   - `slots` is declared in `inject` next to `linuxBootstrap`
 *   - registration uses `{ name, id, order, label }`
 *   - the disposer the slot registry returns is owned by the context
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./react-resolver.mjs', import.meta.url)

const client = await import('../client/index.js')

function fakeHost({ withEffect = true } = {}) {
  const registered = []
  const injectedKeys = []
  let effectRuns = 0
  const ctx = {
    linuxBootstrap: { subscribe: () => () => {}, status: async () => ({}) },
    slots: {
      inject(key, factory) {
        injectedKeys.push(key)
        return factory()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  if (withEffect) {
    ctx.effect = (callback) => {
      effectRuns += 1
      return callback()
    }
  }
  return { ctx, registered, injectedKeys, effectRuns: () => effectRuns }
}

test('the client declares the slots service alongside the bootstrap service', () => {
  assert.deepEqual([...client.inject].sort(), ['linuxBootstrap', 'slots'])
})

test('apply registers the Linux environment into the settings.section slot', () => {
  const host = fakeHost()
  client.apply(host.ctx)
  assert.deepEqual(host.injectedKeys, ['settings.section'])
  assert.equal(host.registered.length, 1)
  const { options, component } = host.registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'linux-environment')
  assert.equal(options.order, 80)
  assert.equal(options.label(), 'Linux环境')
  assert.equal(typeof component, 'function')
})

test('a configured order wins over the default', () => {
  const host = fakeHost()
  client.apply(host.ctx, { order: 12 })
  assert.equal(host.registered[0].options.order, 12)
})

test('the registration is routed through ctx.effect so a reload disposes it', () => {
  const host = fakeHost()
  client.apply(host.ctx)
  assert.equal(host.effectRuns(), 1, 'the slot disposer must be owned by the context')
})

test('apply still registers when the context exposes no effect helper', () => {
  const host = fakeHost({ withEffect: false })
  client.apply(host.ctx)
  assert.equal(host.effectRuns(), 0)
  assert.equal(host.registered.length, 1)
})

test('apply refuses to run without the linuxBootstrap service', () => {
  const host = fakeHost()
  delete host.ctx.linuxBootstrap
  assert.throws(() => client.apply(host.ctx), /linuxBootstrap service injection is required/)
})
