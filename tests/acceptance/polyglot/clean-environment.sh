#!/usr/bin/env bash
# Real language child APIs with empty envp, followed by another exec. This is
# a guest/device acceptance script, not an automatic host CI test.
set -euo pipefail
: "${BN_NODE_PROJECT:?set BN_NODE_PROJECT to a real project with zod installed}"
cd "$BN_NODE_PROJECT"
node <<'JS'
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const source = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const {z} = require('zod');
  assert.equal(z.number().parse(42), 42);
  assert.ok(fs.statSync('/etc/debian_version').isFile());
  assert.equal(fs.readlinkSync('/proc/self/exe'), process.execPath);
  assert.deepEqual(Object.keys(process.env).sort(), ['PATH']);
  const marker = process.argv[1];
  if (marker) assert.ok(fs.readFileSync('/proc/self/environ', 'utf8').split(String.fromCharCode(0)).includes(marker));
  const next = require('node:child_process').spawnSync(process.execPath,
    ['-e', "require('node:assert/strict').deepEqual(Object.keys(process.env).sort(), ['PATH']); require('node:fs').statSync('/etc/debian_version'); if(process.argv[1])require('node:assert/strict').ok(require('node:fs').readFileSync('/proc/self/environ','utf8').split(String.fromCharCode(0)).includes(process.argv[1]))", marker],
    {env:process.env, encoding:'utf8'});
  assert.equal(next.status, 0, next.stderr);
`;
const marker = process.env.BIONILUX_PROCESS_SCOPE ? 'BIONILUX_PROCESS_SCOPE=' + process.env.BIONILUX_PROCESS_SCOPE : '';
const result = spawnSync(process.execPath, ['-e', source, marker], {
  env: {PATH: process.env.PATH}, encoding:'utf8'
});
assert.equal(result.status, 0, result.stderr);
console.log('Node zod + empty-env child/grandchild PASS');
JS
python3 <<'PY'
import os, subprocess, sys
source = '''
import os, subprocess, sys
assert not any(k.startswith('BIONILUX_') or k == 'LD_PRELOAD' for k in os.environ)
assert os.path.isfile('/etc/debian_version')
assert os.readlink('/proc/self/exe') == os.path.realpath(sys.executable), (sys.executable, os.readlink('/proc/self/exe'))
marker = sys.argv[1]
if marker:
    assert marker.encode() in open('/proc/self/environ', 'rb').read().split(bytes([0]))
subprocess.run([sys.executable, '-c', "import os,sys; assert os.path.isfile('/etc/debian_version'); assert not any(k.startswith('BIONILUX_') or k == 'LD_PRELOAD' for k in os.environ); assert not sys.argv[1] or sys.argv[1].encode() in open('/proc/self/environ','rb').read().split(bytes([0]))", marker], check=True, env={})
'''
marker = 'BIONILUX_PROCESS_SCOPE=' + os.environ['BIONILUX_PROCESS_SCOPE'] if 'BIONILUX_PROCESS_SCOPE' in os.environ else ''
subprocess.run([sys.executable, '-c', source, marker], env={}, check=True)
print('Python empty-env child/grandchild PASS')
PY
echo CLEAN_ENVIRONMENT_ACCEPTANCE_PASS
