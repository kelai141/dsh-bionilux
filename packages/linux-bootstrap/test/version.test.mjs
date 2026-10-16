import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion } from '../src/version.js'

test('compares stable and prerelease semantic versions', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1)
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0+build.3'), 0)
})

test('rejects invalid semantic versions', () => {
  assert.equal(parseVersion('latest'), null)
  assert.equal(parseVersion('1.0.0-01'), null)
  assert.throws(() => compareVersions('1.x', '1.0.0'), /Invalid semantic version/)
})
