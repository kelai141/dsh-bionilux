import test from 'node:test'
import assert from 'node:assert/strict'

import { EXPERIMENTAL_NOTICE, autoUpdateAvailable, describeVersionStatus } from '../src/status.js'

test('the section states that the plugin is experimental and not enabled by default', () => {
  assert.match(EXPERIMENTAL_NOTICE, /experimental/)
  assert.match(EXPERIMENTAL_NOTICE, /内部插件/)
  assert.match(EXPERIMENTAL_NOTICE, /内置（hard）/)
  assert.match(EXPERIMENTAL_NOTICE, /默认不启用/)
  assert.match(EXPERIMENTAL_NOTICE, /不会自动启用/)
})

test('an uninstalled environment is described as opt-in, not as an error', () => {
  const text = describeVersionStatus({ installed: false, autoUpdate: false })
  assert.match(text, /尚未安装/)
  assert.match(text, /默认不启用/)
})

test('the installed state names the Linux version and the app-version baseline', () => {
  const text = describeVersionStatus({
    installed: true,
    version: '1.1.0',
    mobileVersion: '0.15.0',
    installedSystemMobileVersion: '0.14.0',
    injectionActivated: true,
  })
  assert.match(text, /已安装 Linux 运行时 1\.1\.0/)
  assert.match(text, /当前 DSH Mobile 0\.15\.0/)
  assert.match(text, /安装时 DSH Mobile 0\.14\.0/)
  assert.equal(text.includes('自动更新已停止'), false)
})

test('a plugin removed or disabled by the user is reported as stopped, not silently healthy', () => {
  const text = describeVersionStatus({
    installed: true,
    version: '1.1.0',
    mobileVersion: '0.15.0',
    installedSystemMobileVersion: '0.15.0',
    injectionActivated: false,
  })
  assert.match(text, /插件已被移除或停用，自动更新已停止/)
})

test('an available update and a blocked downgrade are both surfaced', () => {
  assert.match(
    describeVersionStatus({ installed: true, version: '1.1.0', updateAvailable: true, availableVersion: '1.2.0', injectionActivated: true }),
    /可更新至 1\.2\.0/,
  )
  assert.match(
    describeVersionStatus({ installed: true, version: '1.1.0', updateBlocked: true, injectionActivated: true }),
    /已阻止降级/,
  )
})

test('auto-update is only operable once a runtime is installed', () => {
  assert.equal(autoUpdateAvailable(null), false)
  assert.equal(autoUpdateAvailable({ installed: false }), false)
  assert.equal(autoUpdateAvailable({ installed: true }), true)
})
