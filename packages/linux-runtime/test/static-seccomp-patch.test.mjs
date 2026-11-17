import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureGuestStaticSeccompPatch,
  findStaticCallSites,
  inspectGuestStaticElf,
  patchStaticGuestBuffer,
} from '../modules/static-seccomp-patch.js';

const SVC = 0xd4000001;
const NOP = 0xd503201f;
const MOVN_X0_ENOSYS = 0x928004a0;
const EM_AARCH64 = 0xb7;
const EM_X86_64 = 0x3e;
const PT_LOAD = 1;
const PT_INTERP = 3;
const WINDOW_INSTRUCTIONS = 16;
const MARKER_PARTS = ['var', 'lib', 'bionilux', 'guest-static-seccomp.json'];

/** MOVZ x8, #imm */
const movzX8 = (imm) => (0xd2800000 | ((imm & 0xffff) << 5) | 8) >>> 0;
/** MOVZ w8, #imm: the 32-bit form the scanner must accept too */
const movzW8 = (imm) => (0x52800000 | ((imm & 0xffff) << 5) | 8) >>> 0;

function words(...values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, index * 4));
  return buffer;
}

/**
 * Build a minimal little-endian ELF64 image with the segments the scanner
 * reads. Unused header fields stay zero, which a real linker also permits, so
 * the fixture exercises the same parser as a real program.
 */
function syntheticElf({
  type = 2,
  machine = EM_AARCH64,
  code = Buffer.alloc(0),
  data = null,
  interp = null,
} = {}) {
  const segments = [];
  if (interp !== null) {
    segments.push({ role: 'interp', type: PT_INTERP, flags: 4, bytes: Buffer.from(interp + '\0', 'latin1') });
  }
  segments.push({ role: 'text', type: PT_LOAD, flags: 4 | 1, bytes: code }); // PF_R | PF_X
  if (data !== null) {
    segments.push({ role: 'data', type: PT_LOAD, flags: 4 | 2, bytes: data }); // PF_R | PF_W
  }
  const headerSize = 64;
  let cursor = headerSize + segments.length * 56;
  for (const segment of segments) {
    cursor = Math.ceil(cursor / 16) * 16;
    segment.offset = cursor;
    cursor += segment.bytes.length;
  }
  const buffer = Buffer.alloc(cursor);
  buffer.write('\x7fELF', 0, 'latin1');
  buffer[4] = 2; // ELFCLASS64
  buffer[5] = 1; // ELFDATA2LSB
  buffer[6] = 1; // EV_CURRENT
  buffer.writeUInt16LE(type, 16); // ET_EXEC or ET_DYN
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20); // EV_CURRENT
  buffer.writeBigUInt64LE(0n, 24); // e_entry
  buffer.writeBigUInt64LE(BigInt(headerSize), 32); // e_phoff
  buffer.writeUInt16LE(headerSize, 52); // e_ehsize
  buffer.writeUInt16LE(56, 54); // e_phentsize
  buffer.writeUInt16LE(segments.length, 56); // e_phnum
  segments.forEach((segment, index) => {
    const base = headerSize + index * 56;
    buffer.writeUInt32LE(segment.type, base);
    buffer.writeUInt32LE(segment.flags, base + 4);
    buffer.writeBigUInt64LE(BigInt(segment.offset), base + 8); // p_offset
    buffer.writeBigUInt64LE(BigInt(segment.bytes.length), base + 32); // p_filesz
    buffer.writeBigUInt64LE(BigInt(segment.bytes.length), base + 40); // p_memsz
    buffer.writeBigUInt64LE(16n, base + 48); // p_align
    segment.bytes.copy(buffer, segment.offset);
  });
  const text = segments.find((segment) => segment.role === 'text');
  const dataSegment = segments.find((segment) => segment.role === 'data');
  return { buffer, textOffset: text.offset, dataOffset: dataSegment === undefined ? null : dataSegment.offset };
}

async function rootfsWithPrograms(programs) {
  const root = await mkdtemp(path.join(tmpdir(), 'guest-static-'));
  for (const [relative, bytes] of Object.entries(programs)) {
    const full = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  return root;
}

function programPath(root, relative) {
  return path.join(root, ...relative.split('/'));
}

async function readMarkerOf(root) {
  return JSON.parse(await readFile(path.join(root, ...MARKER_PARTS), 'utf8'));
}

test('rewrites set_robust_list and rseq call sites inside the executable segment', () => {
  const code = words(
    NOP, movzX8(99), SVC,
    NOP, movzW8(293), SVC,
    movzX8(435), SVC,
    movzX8(64), SVC,
  );
  const { buffer: elf, textOffset } = syntheticElf({ code });
  const { buffer: patched, sites } = patchStaticGuestBuffer(elf);
  assert.deepEqual(sites.map((site) => site.name), ['set_robust_list', 'rseq']);
  assert.deepEqual(sites.map((site) => site.offset), [textOffset + 8, textOffset + 20]);
  assert.equal(patched.readUInt32LE(textOffset + 8), NOP);
  assert.equal(patched.readUInt32LE(textOffset + 20), MOVN_X0_ENOSYS);
  // The movz that loads the call number stays, exactly as in the libc patch.
  assert.equal(patched.readUInt32LE(textOffset + 4), movzX8(99));
  assert.equal(patched.readUInt32LE(textOffset + 16), movzW8(293));
  // clone3 and an unrelated call are left byte for byte alone.
  assert.equal(patched.readUInt32LE(textOffset + 28), SVC);
  assert.equal(patched.readUInt32LE(textOffset + 36), SVC);
});

test('rejects every instruction that can close the syscall window', () => {
  const closing = new Map([
    ['b', 0x14000002],
    ['bl', 0x94000002],
    ['b.cond', 0x54000040],
    ['cbz', 0xb4000040],
    ['cbnz', 0xb5000040],
    ['tbz', 0x36000048],
    ['tbnz', 0x37000048],
    ['br', 0xd61f0000],
    ['blr', 0xd63f0000],
    ['ret', 0xd65f03c0],
    ['a write to x8', movzX8(64)],
    ['another svc', 0xd4000021],
  ]);
  for (const [name, instruction] of closing) {
    assert.deepEqual(
      findStaticCallSites(words(movzX8(99), instruction, SVC)),
      [],
      'window must close on ' + name,
    );
    assert.deepEqual(
      findStaticCallSites(words(movzW8(293), instruction, SVC)),
      [],
      'window must close on ' + name + ' after movz w8',
    );
  }
});

test('accepts a svc inside the 16-instruction window and rejects one past it', () => {
  const inside = words(movzX8(99), ...Array(WINDOW_INSTRUCTIONS - 1).fill(NOP), SVC);
  const sites = findStaticCallSites(inside);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].offset, WINDOW_INSTRUCTIONS * 4);
  const outside = words(movzX8(99), ...Array(WINDOW_INSTRUCTIONS).fill(NOP), SVC);
  assert.deepEqual(findStaticCallSites(outside), []);
});

test('scans only executable load segments', () => {
  const planted = words(movzX8(99), SVC);
  const { buffer: elf, dataOffset } = syntheticElf({ code: words(NOP), data: planted });
  const { buffer: patched, sites } = patchStaticGuestBuffer(elf);
  assert.deepEqual(sites, []);
  assert.deepEqual(patched, elf);
  assert.equal(patched.readUInt32LE(dataOffset), movzX8(99));
  assert.equal(patched.readUInt32LE(dataOffset + 4), SVC);
});

test('inspects static AArch64 images and explains every skip', () => {
  assert.deepEqual(
    inspectGuestStaticElf(syntheticElf({ code: words(NOP) }).buffer),
    { static: true, machine: EM_AARCH64, reason: 'static AArch64 ELF' },
  );
  const dynamic = inspectGuestStaticElf(syntheticElf({ code: words(NOP), interp: '/lib/ld-linux-aarch64.so.1' }).buffer);
  assert.equal(dynamic.static, false);
  assert.match(dynamic.reason, /PT_INTERP/);
  const foreign = inspectGuestStaticElf(syntheticElf({ machine: EM_X86_64, code: words(NOP) }).buffer);
  assert.equal(foreign.static, false);
  assert.match(foreign.reason, /not an AArch64 ELF/);
  const script = inspectGuestStaticElf(Buffer.from('#!/bin/sh\n', 'latin1'));
  assert.equal(script.static, false);
  assert.match(script.reason, /not an ELF64/);
  const dynamicPatch = patchStaticGuestBuffer(
    syntheticElf({ code: words(movzX8(99), SVC), interp: '/lib/ld-linux-aarch64.so.1' }).buffer,
  );
  assert.deepEqual(dynamicPatch.sites, []);
  assert.equal(dynamicPatch.segments, 0);
});

test('ensure patches a static program once, records both digests and reports already', async () => {
  const code = words(NOP, movzX8(99), SVC, movzW8(293), SVC);
  const { buffer: elf, textOffset } = syntheticElf({ code });
  const root = await rootfsWithPrograms({ 'usr/bin/probe': elf });
  const first = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(first.status, 'patched');
  assert.equal(first.counters.patched, 1);
  assert.deepEqual(first.results.map((entry) => entry.status), ['patched']);
  assert.deepEqual(first.results[0].sites.map((site) => site.name), ['set_robust_list', 'rseq']);
  assert.deepEqual(first.failures, []);
  const written = await readFile(programPath(root, 'usr/bin/probe'));
  assert.equal(written.readUInt32LE(textOffset + 8), NOP);
  assert.equal(written.readUInt32LE(textOffset + 16), MOVN_X0_ENOSYS);
  const marker = await readMarkerOf(root);
  assert.equal(marker.schemaVersion, 1);
  const entry = marker.files['usr/bin/probe'];
  assert.match(entry.originalDigest, /^[0-9a-f]{64}$/);
  assert.match(entry.patchedDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(entry.originalDigest, entry.patchedDigest);
  assert.deepEqual(entry.patchedSites.map((site) => site.name), ['set_robust_list', 'rseq']);
  assert.deepEqual(entry.patchedSites.map((site) => site.offset), [textOffset + 8, textOffset + 16]);

  const second = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(second.status, 'already');
  assert.deepEqual(second.results.map((entry) => entry.status), ['already']);
  assert.deepEqual(await readFile(programPath(root, 'usr/bin/probe')), written);
});

test('ensure patches again when the program file is replaced', async () => {
  const root = await rootfsWithPrograms({ 'usr/bin/probe': syntheticElf({ code: words(movzX8(99), SVC) }).buffer });
  assert.equal((await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' })).status, 'patched');
  // A reinstall or an upgrade puts a fresh, unpatched and different file back.
  await writeFile(programPath(root, 'usr/bin/probe'), syntheticElf({ code: words(NOP, movzX8(293), SVC, NOP) }).buffer);
  const again = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(again.status, 'patched');
  assert.deepEqual(again.results[0].sites.map((site) => site.name), ['rseq']);
});

test('ensure records a static program without call sites as skipped and does not fail', async () => {
  const elf = syntheticElf({ code: words(NOP, NOP, NOP, NOP) }).buffer;
  const root = await rootfsWithPrograms({ 'usr/bin/quiet': elf });
  const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(result.status, 'already');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.results, [
    { path: 'usr/bin/quiet', status: 'skipped', reason: 'no set_robust_list/rseq call site matched' },
  ]);
  assert.deepEqual(await readFile(programPath(root, 'usr/bin/quiet')), elf);
  const marker = await readMarkerOf(root);
  assert.equal(marker.files['usr/bin/quiet'].patchedDigest, null);
  assert.deepEqual(marker.files['usr/bin/quiet'].patchedSites, []);
  const second = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.deepEqual(second.results.map((entry) => entry.status), ['already']);
});

test('ensure leaves dynamic and foreign-architecture programs alone', async () => {
  const dynamic = syntheticElf({ code: words(movzX8(99), SVC), interp: '/lib/ld-linux-aarch64.so.1' }).buffer;
  const foreign = syntheticElf({ machine: EM_X86_64, code: words(movzX8(99), SVC) }).buffer;
  const root = await rootfsWithPrograms({ 'usr/bin/dynamic': dynamic, 'usr/bin/foreign': foreign });
  const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(result.status, 'already');
  assert.deepEqual(result.results, []);
  assert.deepEqual(await readFile(programPath(root, 'usr/bin/dynamic')), dynamic);
  assert.deepEqual(await readFile(programPath(root, 'usr/bin/foreign')), foreign);
  await assert.rejects(readFile(path.join(root, ...MARKER_PARTS)), { code: 'ENOENT' });
});

test('ensure scans the default directories recursively and leaves other trees alone', async () => {
  const planted = words(movzX8(99), SVC);
  const elsewhere = syntheticElf({ code: planted }).buffer;
  const root = await rootfsWithPrograms({
    'usr/local/bin/local-tool': syntheticElf({ code: planted }).buffer,
    'usr/libexec/deep/nested/tool': syntheticElf({ code: planted }).buffer,
    'opt/elsewhere/tool': elsewhere,
  });
  const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
  assert.equal(result.status, 'patched');
  // Directory order decides scan order: usr/local/bin comes before usr/libexec.
  assert.deepEqual(result.results.map((entry) => entry.path), [
    'usr/local/bin/local-tool',
    'usr/libexec/deep/nested/tool',
  ]);
  assert.deepEqual(await readFile(programPath(root, 'opt/elsewhere/tool')), elsewhere);
});

test('ensure records a program above the size limit as skipped', async () => {
  const elf = syntheticElf({ code: words(movzX8(99), SVC) }).buffer;
  const root = await rootfsWithPrograms({ 'usr/bin/large': elf });
  const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64', maxFileSize: 8 });
  assert.equal(result.status, 'already');
  assert.deepEqual(result.results, [
    { path: 'usr/bin/large', status: 'skipped', reason: 'file is larger than 8 bytes' },
  ]);
  assert.deepEqual(await readFile(programPath(root, 'usr/bin/large')), elf);
});

test('ensure stops at the file limit and records that the scan was truncated', async () => {
  const planted = () => syntheticElf({ code: words(movzX8(99), SVC) }).buffer;
  const root = await rootfsWithPrograms({
    'usr/bin/a': planted(),
    'usr/bin/b': planted(),
    'usr/bin/c': planted(),
  });
  const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64', maxFiles: 2 });
  assert.equal(result.limits.reached, true);
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.results.map((entry) => entry.path), ['usr/bin/a', 'usr/bin/b']);
});

test('ensure skips unsupported architectures and a missing rootfs', async () => {
  const root = await rootfsWithPrograms({ 'usr/bin/probe': syntheticElf({ code: words(movzX8(99), SVC) }).buffer });
  const foreign = await ensureGuestStaticSeccompPatch(root, { architecture: 'x64' });
  assert.equal(foreign.status, 'skipped');
  assert.match(foreign.reason, /unsupported architecture x64/);
  assert.deepEqual(foreign.failures, []);
  const missing = await ensureGuestStaticSeccompPatch(path.join(root, 'absent'), { architecture: 'arm64' });
  assert.equal(missing.status, 'skipped');
  assert.match(missing.reason, /not present/);
  await rm(root, { recursive: true, force: true });
});

test('patches static-PIE (ET_DYN without PT_INTERP) and deduplicates overlapping PT_LOAD segments', () => {
  const code = words(movzX8(99), SVC);
  const { buffer: pie, textOffset } = syntheticElf({ type: 3, code });
  assert.equal(inspectGuestStaticElf(pie).static, true);
  const { buffer: patched, sites } = patchStaticGuestBuffer(pie);
  assert.equal(sites.length, 1);
  assert.equal(patched.readUInt32LE(textOffset + 4), NOP);

  // Duplicate the executable PT_LOAD header into the second slot so two segments cover the same bytes.
  const { buffer: dup } = syntheticElf({ type: 3, code, data: words(NOP) });
  const phoff = Number(dup.readBigUInt64LE(32));
  dup.copy(dup, phoff + 56, phoff, phoff + 56);
  const dupResult = patchStaticGuestBuffer(dup);
  assert.equal(dupResult.segments, 2);
  assert.equal(dupResult.sites.length, 1);
});

test('ensure handles malformed ELFs without failing and ignores symlinks', async () => {
  const valid = syntheticElf({ code: words(movzX8(99), SVC) }).buffer;
  const badPhoff = syntheticElf({ code: words(NOP) }).buffer;
  badPhoff.writeBigUInt64LE(0n, 32); // e_phoff inside ELF header
  const badSize = syntheticElf({ code: words(NOP) }).buffer;
  badSize.writeUInt16LE(8, 54); // e_phentsize < 56

  const root = await rootfsWithPrograms({
    'usr/bin/valid': valid,
    'usr/bin/bad-phoff': badPhoff,
    'usr/bin/bad-size': badSize,
  });
  try {
    await symlink('usr/bin', path.join(root, 'bin'));
    await symlink('valid', path.join(root, 'usr', 'bin', 'valid-link'));

    const first = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
    assert.equal(first.status, 'patched');
    assert.equal(first.counters.patched, 1);
    assert.equal(first.counters.skipped, 2);
    assert.deepEqual(first.failures, []);
    const byPath = new Map(first.results.map((entry) => [entry.path, entry]));
    assert.match(byPath.get('usr/bin/bad-phoff').reason, /malformed ELF/);
    assert.match(byPath.get('usr/bin/bad-size').reason, /malformed ELF/);
    assert.equal(byPath.has('bin/valid'), false);
    assert.equal(byPath.has('usr/bin/valid-link'), false);

    const second = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
    assert.equal(second.status, 'already');
    assert.equal(second.counters.already, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensure recovers from corrupt marker entries and serializes concurrent calls', async () => {
  const { buffer: elf, textOffset } = syntheticElf({ code: words(movzX8(99), SVC, movzX8(293), SVC) });
  const root = await rootfsWithPrograms({ 'usr/bin/probe': elf });
  try {
    const markerDir = path.join(root, ...MARKER_PARTS.slice(0, -1));
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      path.join(root, ...MARKER_PARTS),
      JSON.stringify({ schemaVersion: 1, files: { 'usr/bin/probe': null, 'usr/bin/bad': 'oops' } }),
    );

    const [first, second, third] = await Promise.all([
      ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' }),
      ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' }),
      ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' }),
    ]);

    const statuses = [first.status, second.status, third.status];
    assert.equal(statuses.filter((s) => s === 'patched').length, 1);
    assert.equal(statuses.filter((s) => s === 'already').length, 2);

    const written = await readFile(programPath(root, 'usr/bin/probe'));
    assert.equal(written.readUInt32LE(textOffset + 4), NOP);
    assert.equal(written.readUInt32LE(textOffset + 12), MOVN_X0_ENOSYS);

    const markerEntries = await readdir(markerDir);
    assert.deepEqual(markerEntries, ['guest-static-seccomp.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensure reports write failures as failed instead of silently skipping', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root bypasses 0444 file permissions');
    return;
  }
  const elf = syntheticElf({ code: words(movzX8(99), SVC) }).buffer;
  const root = await rootfsWithPrograms({ 'usr/bin/readonly': elf });
  const filePath = programPath(root, 'usr/bin/readonly');
  try {
    await chmod(filePath, 0o444);
    const result = await ensureGuestStaticSeccompPatch(root, { architecture: 'arm64' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, 'usr/bin/readonly');
  } finally {
    await chmod(filePath, 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
