/**
 * Regression tests for the client half of the experimental Linux bootstrap.
 *
 * The shipped Android shell mounts the Linux settings section from its own
 * responsive client plugin (same-origin routes). This package's client entry is
 * the upstream source of that surface, so its contract is pinned here:
 *
 *   - the section needs only `slots`: a page-side plugin can never receive the
 *     engine's `linuxBootstrap` service, so requiring it would make the entry
 *     unloadable (and would leave the settings page with no Linux section);
 *   - registration uses `{ name, id, order, label }` once, through
 *     `settings.section`;
 *   - the disposer the slot registry returns is owned by the context.
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

test('the client declares only the slots service (the engine service is not injectable in a page)', () => {
  assert.deepEqual([...client.inject], ['slots'])
})

test('apply registers the Linux environment into the settings.section slot once', () => {
  const host = fakeHost()
  client.apply(host.ctx)
  assert.deepEqual(host.injectedKeys, ['settings.section'])
  assert.equal(host.registered.length, 1)
  const { options, component } = host.registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'linux-environment')
  assert.equal(options.order, 95)
  assert.match(options.label(), /Linux/)
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

test('apply does not require the engine service to be injected', () => {
  const host = fakeHost()
  assert.equal(host.ctx.linuxBootstrap, undefined)
  assert.doesNotThrow(() => client.apply(host.ctx))
  assert.equal(host.registered.length, 1)
})
