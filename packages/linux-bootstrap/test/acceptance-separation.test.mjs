import test from 'node:test'
import assert from 'node:assert/strict'
import { runOptionalAcceptance, verifyPersistentSession, verifyToolUsability } from '../../../tests/acceptance/standalone-device.mjs'

test('serve mode records optional acceptance failure without claiming acceptance passed', async () => {
  const result = await runOptionalAcceptance(async () => { throw new Error('session reuse failed') }, { serveMode: true, explicitInstall: false })
  assert.equal(result.passed, false)
  assert.equal(result.failure.message, 'session reuse failed')
})

test('explicit install and non-service acceptance still fail on assertions', async () => {
  for (const options of [{ serveMode: true, explicitInstall: true }, { serveMode: false, explicitInstall: false }]) {
    await assert.rejects(runOptionalAcceptance(async () => { throw new Error('real assertion') }, options), /real assertion/)
  }
})

test('persistent session failure includes both commands upstream output and exit state', async () => {
  let runs = 0
  const registry = {
    open: async () => {},
    run: async () => ++runs === 1
      ? { exitCode: 0, stdout: 'opened:/workspace', stderr: 'first stderr' }
      : { exitCode: 0, stdout: '', stderr: 'lost output', timedOut: false },
  }
  await assert.rejects(verifyPersistentSession(registry), error => {
    assert.ok(error.message.includes('opened:/workspace'))
    assert.match(error.message, /lost output/)
    assert.match(error.message, /exitCode/)
    return true
  })
})

test('service usability requires real tool output, external command success and guest root', async () => {
  for (const result of [
    { exitCode: 1, stdout: 'standalone-x86_64\nguest-uid=0\n', stderr: 'linker failure' },
    { exitCode: 0, stdout: 'standalone-\nguest-uid=\n', stderr: '' },
    { exitCode: 0, stdout: 'standalone-x86_64\nguest-uid=10146\n', stderr: '' },
    { exitCode: 0, timedOut: true, stdout: 'standalone-x86_64\nguest-uid=0\n', stderr: '' },
  ]) {
    const runtime = { tools: new Map([['linux_bash', { execute: async () => result }]]) }
    await assert.rejects(verifyToolUsability(runtime, 'x64'))
  }
  const runtime = { tools: new Map([['linux_bash', { execute: async ({ command }) => {
    assert.match(command, /set -e/)
    assert.ok(command.includes('/usr/bin/uname'))
    assert.ok(command.includes('/usr/bin/id'))
    assert.ok(command.includes('/bin/ls'))
    return { exitCode: 0, stdout: 'standalone-x86_64\nguest-uid=0\n', stderr: '' }
  } }]]) }
  assert.equal((await verifyToolUsability(runtime, 'x64')).exitCode, 0)
})
