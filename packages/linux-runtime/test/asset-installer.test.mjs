import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

for (const behavior of ['resume', 'restart', 'wrong range']) {
  test(`the fetch fallback handles ${behavior} after a partial transfer`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bionilux-download-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from('abcdef');
    const asset = {
      url: 'https://github.com/kelai141/dsh-bionilux/releases/download/v1.0.0/plugin.tar.xz',
      sha256: sha256(bytes), size: bytes.length, unpackedSize: 1,
    };
    const requests = [];
    const fetchImpl = async (_url, options) => {
      requests.push(options.headers?.Range);
      if (requests.length === 1) {
        return { ok: true, status: 200, body: (async function* () {
          yield bytes.subarray(0, 3);
          throw new Error('disconnected');
        })() };
      }
      if (behavior === 'restart') return new Response(bytes);
      return new Response(bytes.subarray(3), {
        status: 206,
        headers: { 'Content-Range': behavior === 'wrong range' ? 'bytes 2-5/6' : 'bytes 3-5/6' },
      });
    };
    const install = () => installPluginAsset({
      asset, destinationRoot: root, fetchImpl,
      extractArchive: async (archive, stage) => {
        assert.deepEqual(await readFile(archive), bytes);
        await writeFile(path.join(stage, 'entry'), '1');
      },
    });
    if (behavior === 'wrong range') {
      await assert.rejects(install, /unexpected Content-Range/);
      assert.deepEqual(await readdir(root), []);
    } else {
      assert.equal((await install()).reused, false);
    }
    assert.deepEqual(requests, [undefined, 'bytes=3-']);
  });
}
