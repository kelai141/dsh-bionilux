import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureGuestLibcSeccompPatch,
  findAarch64CallSites,
  guestLibcPath,
  patchAarch64GuestBuffer,
} from '../modules/libc-seccomp-patch.js';

const SVC = 0xd4000001;
const MOVN_X0_ENOSYS = 0x928004a0;
const NOP = 0xd503201f;

/** MOVZ x8, #imm */
const movzX8 = (imm) => (0xd2800000 | ((imm & 0xffff) << 5) | 8) >>> 0;

function words(...values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
  return buffer;
}

test('finds set_robust_list and rseq call sites by their call number', () => {
  const buffer = words(
    NOP, movzX8(99), SVC,
    NOP, NOP, movzX8(293), SVC,
    // A neighbouring call that must stay untouched.
    movzX8(98), SVC,
  );
  const sites = findAarch64CallSites(buffer);
  assert.deepEqual(sites.map((site) => site.name), ['set_robust_list', 'rseq']);
  assert.deepEqual(sites.map((site) => site.offset), [8, 24]);
});

test('rewrites the trapped calls to -ENOSYS and leaves the rest byte for byte', () => {
  const buffer = words(NOP, movzX8(99), SVC, NOP, movzX8(293), SVC);
  const { buffer: patched, sites } = patchAarch64GuestBuffer(buffer);
  assert.equal(sites.length, 2);
  assert.equal(patched.readUInt32LE(8), MOVN_X0_ENOSYS);
  assert.equal(patched.readUInt32LE(20), MOVN_X0_ENOSYS);
  // The MOVZ that loads the call number stays: it is harmless and pitfalls no reader.
  assert.equal(patched.readUInt32LE(4), movzX8(99));
  assert.equal(patched.readUInt32LE(0), NOP);
  // Patching an already patched libc finds nothing: no site, no drift.
  assert.equal(findAarch64CallSites(patched).length, 0);
});

test('ignores a call number that is loaded further back than the syscall macro window', () => {
  const buffer = words(movzX8(99), NOP, NOP, NOP, NOP, NOP, NOP, NOP, NOP, NOP, NOP, NOP, NOP, SVC);
  assert.equal(findAarch64CallSites(buffer).length, 0);
});

async function rootfsWithLibc(bytes) {
  const root = await mkdtemp(path.join(tmpdir(), 'guest-libc-'));
  const libc = path.join(root, 'usr', 'lib', 'aarch64-linux-gnu');
  await mkdir(libc, { recursive: true });
  await writeFile(path.join(libc, 'libc.so.6'), bytes);
  return root;
}

test('ensure patches once and records the digest, then reports already', async () => {
  const root = await rootfsWithLibc(words(NOP, movzX8(99), SVC, movzX8(293), SVC));
  const first = await ensureGuestLibcSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(first.status, 'patched');
  assert.deepEqual(first.sites.map((site) => site.name), ['set_robust_list', 'rseq']);
  const marker = JSON.parse(await readFile(path.join(root, 'var', 'lib', 'bionilux', 'guest-libc-seccomp.json'), 'utf8'));
  assert.equal(marker.schemaVersion, 1);
  assert.deepEqual(marker.sites.map((site) => site.name), ['set_robust_list', 'rseq']);
  assert.match(marker.patchedDigest, /^[0-9a-f]{64}$/);

  const second = await ensureGuestLibcSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(second.status, 'already');
});

test('ensure patches again when the libc bytes changed underneath', async () => {
  const root = await rootfsWithLibc(words(NOP, movzX8(99), SVC));
  assert.equal((await ensureGuestLibcSeccompPatch(root, { architecture: 'arm64' })).status, 'patched');
  // An upgrade replaces the file with an unpatched, different build.
  const replacement = words(NOP, movzX8(99), SVC, NOP, NOP);
  await writeFile(guestLibcPath(root), replacement);
  const previous = await open(guestLibcPath(root), 'r');
  try {
    const again = await ensureGuestLibcSeccompPatch(root, { architecture: 'arm64' });
    assert.equal(again.status, 'patched');
    assert.deepEqual(await previous.readFile(), replacement);
    assert.equal((await readFile(guestLibcPath(root))).readUInt32LE(8), MOVN_X0_ENOSYS);
  } finally {
    await previous.close();
  }
});

test('ensure refuses to guess when no call site matches', async () => {
  const root = await rootfsWithLibc(words(NOP, NOP, NOP, NOP));
  const result = await ensureGuestLibcSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(result.status, 'unsupported');
  assert.match(result.reason, /changed shape/);
});

test('ensure leaves other architectures and a missing libc alone', async () => {
  const root = await rootfsWithLibc(words(NOP, movzX8(99), SVC));
  assert.deepEqual(
    await ensureGuestLibcSeccompPatch(root, { architecture: 'x64' }),
    { status: 'skipped', path: guestLibcPath(root), reason: 'unsupported architecture x64' },
  );
  const empty = await mkdtemp(path.join(tmpdir(), 'guest-libc-empty-'));
  const missing = await ensureGuestLibcSeccompPatch(empty, { architecture: 'arm64' });
  assert.equal(missing.status, 'skipped');
  assert.match(missing.reason, /not present/);
});
