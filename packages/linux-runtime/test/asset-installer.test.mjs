import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installPluginAsset } from '../modules/asset-installer.js';

const temporaryRoot = path.join(os.tmpdir(), `bionilux-asset-tests-${process.pid}`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('the fetch fallback stops reading a body larger than the declared asset size', async () => {
  const expected = Buffer.from('ok');
  const asset = {
    url: 'https://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/plugin.tar.xz',
    sha256: sha256(expected),
    size: expected.length,
    unpackedSize: 1,
  };
  const root = path.join(temporaryRoot, 'oversized');
  const streamed = [];
  const fetchImpl = async () => ({
    ok: true,
    url: asset.url,
    body: (async function* () {
      streamed.push('first');
      yield Buffer.from('over');
      streamed.push('second');
      yield Buffer.from('size');
    })(),
  });

  try {
    await assert.rejects(() =>
      installPluginAsset({ asset, destinationRoot: root, fetchImpl, extractArchive: async () => {} }),
    );
    assert.deepEqual(streamed, ['first'], 'the download must stop as soon as it exceeds the declared size');
    assert.equal(existsSync(path.join(root, asset.sha256)), false);
    if (existsSync(root)) assert.deepEqual(await readdir(root), [], 'a rejected download must not leave staging state');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
