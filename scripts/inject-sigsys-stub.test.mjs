import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_ENTRIES,
  STUB,
  STUB_BRANCH_OFFSET,
  STUB_HANDLER_OFFSET,
  STUB_HEX,
} from './inject-sigsys-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'inject-sigsys-stub.mjs');
const STUB_SOURCE = path.join(HERE, 'stub', 'sigsys_stub_aarch64.S');
const HANDLER_SOURCE = path.join(HERE, 'stub', 'handler_test_aarch64.c');

const EM_AARCH64 = 0xb7;
const EM_X86_64 = 0x3e;
const PT_LOAD = 1;
const PF_X = 0x1;
const PF_W = 0x2;
const PF_R = 0x4;
const KNOWN_ENTRY = KNOWN_ENTRIES[0].entry;
/* The synthetic loader mirrors the measured one: the entry sits inside the
 * read-only segment, the code cave is the zero padding after it. */
const LOAD0_END = 0x1c000;
const NEXT_LOAD_OFFSET = 0x1d000;

/* Build a minimal but structurally honest AArch64 loader: ELF header, two
 * PT_LOAD segments, a zero-filled gap between them and a known e_entry. */
function buildLoader(options = {}) {
  const entry = options.entry ?? KNOWN_ENTRY;
  const machine = options.machine ?? EM_AARCH64;
  const elfClass = options.elfClass ?? 2;
  const elfData = options.elfData ?? 1;
  const load0 = { flags: PF_R | PF_X, offset: 0, vaddr: 0, filesz: LOAD0_END, memsz: LOAD0_END, ...options.load0 };
  const next = {
    flags: PF_R | PF_W,
    offset: NEXT_LOAD_OFFSET,
    vaddr: NEXT_LOAD_OFFSET,
    filesz: 0x100,
    memsz: 0x100,
    ...options.next,
  };
  const tail = options.tail ?? 0x1000;
  const size = Math.max(entry + 4, next.offset + next.filesz + tail, 0x1000);
  const buffer = Buffer.alloc(size);
  buffer.write('\u007fELF', 0, 'latin1');
  buffer[4] = elfClass;
  buffer[5] = elfData;
  buffer[6] = 1;
  buffer.writeUInt16LE(options.type ?? 3, 0x10); // ET_DYN
  buffer.writeUInt16LE(machine, 0x12);
  buffer.writeUInt32LE(1, 0x14);
  buffer.writeBigUInt64LE(BigInt(entry), 0x18);
  buffer.writeBigUInt64LE(BigInt(options.phoff ?? 64), 0x20);
  buffer.writeUInt16LE(64, 0x34);
  buffer.writeUInt16LE(options.phentsize ?? 56, 0x36);
  buffer.writeUInt16LE(options.phnum ?? 2, 0x38);
  const writeLoad = (index, load) => {
    const at = (options.phoff ?? 64) + index * (options.phentsize ?? 56);
    buffer.writeUInt32LE(PT_LOAD, at);
    buffer.writeUInt32LE(load.flags, at + 4);
    buffer.writeBigUInt64LE(BigInt(load.offset), at + 8);
    buffer.writeBigUInt64LE(BigInt(load.vaddr), at + 16);
    buffer.writeBigUInt64LE(BigInt(load.vaddr), at + 24);
    buffer.writeBigUInt64LE(BigInt(load.filesz), at + 32);
    buffer.writeBigUInt64LE(BigInt(load.memsz), at + 40);
    buffer.writeBigUInt64LE(BigInt(load.align ?? 0x10000), at + 48);
  };
  writeLoad(0, load0);
  writeLoad(1, next);
  if (entry + 12 <= load0.filesz && entry + 12 <= buffer.length) {
    buffer.writeUInt32LE(0xd503245f, entry); // bti c, like rtld's first instruction
    buffer.writeUInt32LE(0xd280001d, entry + 4); // mov x29, #0
    buffer.writeUInt32LE(0xd280001e, entry + 8); // mov x30, #0
  }
  if (options.dirtyGapAt !== undefined) buffer[options.dirtyGapAt] = 0x7f;
  return buffer;
}

async function withTempFile(t, bytes, name = 'loader.so') {
  const root = await mkdtemp(path.join(tmpdir(), 'sigsys-stub-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, bytes);
  return { root, file };
}

function cli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function json(result) {
  const lines = result.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one JSON line, got: ' + result.stdout);
  return JSON.parse(lines[0]);
}

function hasTool(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_ASSEMBLER = hasTool('aarch64-linux-gnu-as');
const HAS_OBJCOPY = hasTool('aarch64-linux-gnu-objcopy');
const HAS_CROSS_CC = hasTool('aarch64-linux-gnu-gcc', ['--version']);
const HAS_QEMU = hasTool('qemu-aarch64-static', ['--version']);
const NATIVE_AARCH64 = process.platform === 'linux' && process.arch === 'arm64';

/* Decode the two instruction forms the entry path is asserted on. */
function decodeMovz(word) {
  if (((word & 0xffe00000) >>> 0) !== 0xd2800000) return null; // MOVZ, hw = 0
  return { register: word & 0x1f, immediate: (word >>> 5) & 0xffff };
}

function decodeAdr(word, address) {
  if (((word & 0x9f000000) >>> 0) !== 0x10000000) return null;
  let immediate = (((word >>> 5) & 0x7ffff) << 2) | ((word >>> 29) & 0x3);
  if ((immediate & (1 << 20)) !== 0) immediate -= 1 << 21;
  return { register: word & 0x1f, target: address + immediate };
}

test('the entry path installs the handler and only then unblocks SIGSYS', () => {
  assert.equal(STUB.readUInt32LE(0), 0xd503245f, 'blob must start with bti c (magic word 0)');
  assert.equal(STUB.readUInt32LE(4), 0xd280001d, 'replay the displaced frame-pointer reset');
  assert.equal(STUB.readUInt32LE(2 * 4), 0xd101c3ff, 'entry path reserves 112 bytes (sub sp, sp, #112)');
  assert.equal(STUB.readUInt32LE(STUB_BRANCH_OFFSET), 0x14000000, 'branch placeholder "b ." moved');
  assert.equal(STUB.readUInt32LE(STUB_HANDLER_OFFSET), 0xd503245f, 'handler must start with bti c');

  /* Exactly two syscalls run before rtld, and they are rt_sigaction (134)
   * first and rt_sigprocmask (135) second: unblocking only after the handler is
   * installed leaves no window where a trapped call arrives unhandled. */
  const sites = [];
  for (let i = 0; i < STUB_BRANCH_OFFSET / 4; i += 1) {
    if (STUB.readUInt32LE(i * 4) === 0xd4000001) sites.push(i);
  }
  assert.equal(sites.length, 2, 'the entry path must issue exactly two syscalls');
  const argumentsBefore = sites.map((site, position) => {
    const registers = new Map();
    const start = position === 0 ? 0 : sites[position - 1] + 1;
    for (let i = start; i < site; i += 1) {
      const movz = decodeMovz(STUB.readUInt32LE(i * 4));
      if (movz !== null) registers.set(movz.register, movz.immediate);
    }
    return registers;
  });
  assert.equal(argumentsBefore[0].get(8), 134, 'the first guest syscall is rt_sigaction');
  assert.equal(argumentsBefore[1].get(8), 135, 'rt_sigprocmask is the second guest syscall');
  assert.deepEqual(
    argumentsBefore.map((registers) => registers.get(0)),
    [31, 1],
    'SIGSYS is signal 31, and rt_sigprocmask passes SIG_UNBLOCK = 1 (2 would be SIG_SETMASK)',
  );
  for (const [index, registers] of argumentsBefore.entries()) {
    assert.equal(registers.get(3), 8, 'sigsetsize is 8 on both calls (site ' + index + ')');
    assert.equal(registers.get(2), 0, 'the old action/set is NULL on both calls (site ' + index + ')');
  }

  /* The kernel sigaction is built as 32 stack bytes {handler, flags, 0, 0}:
   * a handler address, SA_SIGINFO as the only flag, and a zero mask. */
  const handlerAddress = (() => {
    for (let i = 0; i < STUB_BRANCH_OFFSET / 4; i += 1) {
      const adr = decodeAdr(STUB.readUInt32LE(i * 4), i * 4);
      if (adr !== null && adr.register === 4) return { index: i, ...adr };
    }
    return null;
  })();
  assert.notEqual(handlerAddress, null, 'no adr x4 for the handler');
  assert.equal(handlerAddress.target, STUB_HANDLER_OFFSET, 'ksa.handler must point at the handler');
  assert.equal(argumentsBefore[0].get(5), 4, 'sa_flags is SA_SIGINFO and nothing else');
  assert.equal(STUB.readUInt32LE((handlerAddress.index + 1) * 4), 0xd2800085, 'mov x5, #4 (SA_SIGINFO)');
  assert.equal(STUB.readUInt32LE((handlerAddress.index + 2) * 4), 0xa90517e4, 'stp x4, x5, [sp, #80]');
  assert.equal(
    STUB.readUInt32LE((handlerAddress.index + 3) * 4),
    0xa9067fff,
    'stp xzr, xzr, [sp, #96]: restorer = 0 and sa_mask = 0',
  );

  /* The procmask sigset is exactly {SIGSYS} = 1 << 30, and it is the last
   * eight bytes of the blob. */
  const setAddress = (() => {
    for (let i = sites[0] + 1; i < sites[1]; i += 1) {
      const adr = decodeAdr(STUB.readUInt32LE(i * 4), i * 4);
      if (adr !== null) return adr;
    }
    return null;
  })();
  assert.notEqual(setAddress, null, 'no adr for the SIGSYS sigset');
  assert.equal(STUB.readBigUInt64LE(setAddress.target), 0x40000000n, 'sigsys sigset is 1 << (31 - 1)');
  assert.equal(setAddress.target + 8, STUB.length, 'the sigset is the tail of the blob');
});

test('re-assembling the stub source reproduces the embedded bytes', {
  skip: HAS_ASSEMBLER && HAS_OBJCOPY ? false : 'no aarch64-linux-gnu-as/objcopy on PATH',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sigsys-stub-asm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const object = path.join(root, 'stub.o');
  const binary = path.join(root, 'stub.bin');
  execFileSync('aarch64-linux-gnu-as', ['-o', object, STUB_SOURCE], { stdio: 'pipe' });
  // The blob must need no linker and no relocations; a cross-symbol adr would
  // silently assemble to zero and objcopy would drop the fixup.
  const relocations = execFileSync('aarch64-linux-gnu-readelf', ['-r', object], { encoding: 'utf8' });
  assert.match(relocations, /There are no relocations in this file\./);
  execFileSync('aarch64-linux-gnu-objcopy', ['-O', 'binary', '--only-section=.text', object, binary]);
  const assembled = await readFile(binary);
  assert.equal(assembled.length, STUB.length, 'assembled stub length differs from STUB_HEX');
  assert.ok(assembled.equals(STUB), 'assembled stub differs from STUB_HEX; regenerate it');
});

test('injects at the cave without changing the loader entry address', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  const before = await readFile(file);
  const result = cli(file, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = json(result);
  assert.equal(report.status, 'injected');
  assert.equal(report.cave, LOAD0_END, 'cave is the first byte after PT_LOAD[0]');
  assert.equal(report.entry, KNOWN_ENTRY, 'glibc requires AT_ENTRY to retain _start');
  assert.equal(report.originalEntry, KNOWN_ENTRY);
  assert.equal(report.stubBytes, STUB.length);
  const after = await readFile(file);
  assert.equal(after.readBigUInt64LE(0x18), BigInt(KNOWN_ENTRY), 'e_entry field');
  const phdr0 = 64;
  assert.equal(after.readBigUInt64LE(phdr0 + 32), BigInt(LOAD0_END + STUB.length), 'p_filesz');
  assert.equal(after.readBigUInt64LE(phdr0 + 40), BigInt(LOAD0_END + STUB.length), 'p_memsz');
  // The cave holds the magic plus the stub with its branch patched back.
  assert.equal(after.subarray(LOAD0_END, LOAD0_END + 8).toString('hex'), '5f2403d51d0080d2');
  const hook = KNOWN_ENTRY + 4;
  const entryBranch = after.readUInt32LE(hook);
  assert.equal(entryBranch & 0xfc000000, 0x14000000);
  assert.equal(hook + (((entryBranch & 0x03ffffff) << 6) >> 6) * 4, LOAD0_END);
  const branch = after.readUInt32LE(LOAD0_END + STUB_BRANCH_OFFSET);
  assert.equal(branch & 0xfc000000, 0x14000000);
  const displacement = ((branch & 0x03ffffff) << 6) >> 6;
  assert.equal(LOAD0_END + STUB_BRANCH_OFFSET + displacement * 4, KNOWN_ENTRY + 8, 'branch target');
  // Only the entry instruction, PT_LOAD[0] and the cave change.
  const expected = Buffer.from(before);
  after.copy(expected, LOAD0_END, LOAD0_END, LOAD0_END + STUB.length);
  expected.writeUInt32LE(entryBranch, hook);
  expected.writeBigUInt64LE(BigInt(LOAD0_END + STUB.length), phdr0 + 32);
  expected.writeBigUInt64LE(BigInt(LOAD0_END + STUB.length), phdr0 + 40);
  assert.ok(after.equals(expected), 'injection touched bytes outside the documented fields');
  assert.equal(after.length, before.length, 'injection must not resize the loader');
});

test('injection is idempotent and the second run reports already', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  assert.equal(cli(file).status, 0);
  const once = await readFile(file);
  const second = cli(file, '--json');
  assert.equal(second.status, 0, second.stderr);
  const report = json(second);
  assert.equal(report.status, 'already');
  assert.equal(report.cave, LOAD0_END);
  assert.equal(report.originalEntry, KNOWN_ENTRY);
  assert.ok((await readFile(file)).equals(once), 'a second run rewrote the file');
  // The human-readable form says the same thing.
  const third = cli(file);
  assert.equal(third.status, 0);
  assert.match(third.stdout, /already carries the SIGSYS entry stub/);
});

test('--check passes on an injected loader and never writes', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  assert.equal(cli(file).status, 0);
  const before = await readFile(file);
  const result = cli(file, '--check', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result).status, 'already');
  assert.ok((await readFile(file)).equals(before), '--check modified the loader');
});

test('--check fails on a loader that is not injected yet', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  const before = await readFile(file);
  const result = cli(file, '--check', '--json');
  assert.equal(result.status, 2);
  const report = json(result);
  assert.equal(report.status, 'unsupported');
  assert.match(report.reason, /not injected/);
  assert.match(result.stderr, /not injected/);
  assert.ok((await readFile(file)).equals(before), '--check modified the loader');
});

test('refuses an unknown e_entry instead of skipping it', async (t) => {
  const { file } = await withTempFile(t, buildLoader({ entry: KNOWN_ENTRY + 4 }));
  const before = await readFile(file);
  const result = cli(file, '--json');
  assert.equal(result.status, 2);
  const report = json(result);
  assert.equal(report.status, 'unsupported');
  assert.match(report.reason, /not a known loader entry/);
  assert.ok((await readFile(file)).equals(before), 'a refused loader was modified');
});

test('refuses to replace an unexpected entry instruction', async (t) => {
  const loader = buildLoader();
  loader.writeUInt32LE(0xd503201f, KNOWN_ENTRY + 4);
  const { file } = await withTempFile(t, loader);
  const result = cli(file, '--json');
  assert.equal(result.status, 2);
  assert.match(json(result).reason, /unexpected frame-pointer reset/);
  assert.ok((await readFile(file)).equals(loader));
});

test('refuses a cave that is not zero-filled', async (t) => {
  const { file } = await withTempFile(t, buildLoader({ dirtyGapAt: LOAD0_END + 0x200 }));
  const before = await readFile(file);
  const result = cli(file, '--json');
  assert.equal(result.status, 2);
  assert.match(json(result).reason, /are not all zero/);
  assert.ok((await readFile(file)).equals(before));
});

test('refuses a gap that is too small for the stub', async (t) => {
  const tooSmall = LOAD0_END + STUB.length + 8; // 8 < the 16 bytes of headroom
  const { file } = await withTempFile(t, buildLoader({ next: { offset: tooSmall, vaddr: tooSmall } }));
  const before = await readFile(file);
  const result = cli(file, '--json');
  assert.equal(result.status, 2);
  assert.match(json(result).reason, /the stub needs/);
  assert.ok((await readFile(file)).equals(before));
});

test('refuses a PT_LOAD[0] that is not (offset 0, vaddr 0, R|X, filesz == memsz)', async (t) => {
  const cases = [
    [{ offset: 0x1000, vaddr: 0, filesz: LOAD0_END, memsz: LOAD0_END }, /expected \(0, 0\)/],
    [{ offset: 0, vaddr: 0x1000, filesz: LOAD0_END, memsz: LOAD0_END }, /expected \(0, 0\)/],
    [{ offset: 0, vaddr: 0, flags: PF_R | PF_W | PF_X, filesz: LOAD0_END, memsz: LOAD0_END }, /not R\|X/],
    [{ offset: 0, vaddr: 0, filesz: LOAD0_END, memsz: LOAD0_END + 0x10 }, /!= p_memsz/],
  ];
  for (const [load0, reason] of cases) {
    const { file } = await withTempFile(t, buildLoader({ load0 }));
    const result = cli(file, '--json');
    assert.equal(result.status, 2, JSON.stringify(load0));
    assert.match(json(result).reason, reason);
  }
});

test('skips a non-AArch64 ELF and leaves it untouched', async (t) => {
  const { file } = await withTempFile(t, buildLoader({ machine: EM_X86_64, entry: 0x401000 }));
  const before = await readFile(file);
  const result = cli(file, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = json(result);
  assert.equal(report.status, 'skipped');
  assert.equal(report.entry, null);
  assert.equal(report.stubBytes, 0);
  assert.ok((await readFile(file)).equals(before));
  const human = cli(file);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /skipped \(not AArch64\)/);
  // --check on a non-AArch64 file is a skip too, not a failure.
  assert.equal(cli(file, '--check').status, 0);
});

test('fails on a non-ELF file and on a broken header', async (t) => {
  const { file: notElfFile } = await withTempFile(t, Buffer.from('#!/bin/sh\necho hi\n', 'utf8'), 'not-elf');
  const notElf = cli(notElfFile, '--json');
  assert.equal(notElf.status, 2);
  assert.match(json(notElf).reason, /not an ELF file/);

  const outside = buildLoader();
  outside.writeBigUInt64LE(0x1ffffn, 0x20); // e_phoff past the end of the file
  const { file: truncated } = await withTempFile(t, outside);
  const result = cli(truncated);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /program header table runs outside the file/);

  const { file: badEntrySize } = await withTempFile(t, buildLoader({ phentsize: 32 }));
  assert.equal(cli(badEntrySize).status, 2);

  const { file: bigEndian } = await withTempFile(t, buildLoader({ elfData: 2 }));
  assert.equal(cli(bigEndian).status, 2);
  assert.match(cli(bigEndian).stderr, /little-endian/);

  const { file: elf32 } = await withTempFile(t, buildLoader({ elfClass: 1 }));
  assert.equal(cli(elf32).status, 2);

  const singleLoad = buildLoader();
  singleLoad.writeUInt16LE(1, 0x38); // phnum: only PT_LOAD[0], no cave bound
  const { file: oneSegment } = await withTempFile(t, singleLoad);
  const noCave = cli(oneSegment);
  assert.equal(noCave.status, 2);
  assert.match(noCave.stderr, /PT_LOAD segment/);
});

test('detects a corrupted stub instead of accepting it', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  assert.equal(cli(file).status, 0);
  const corrupted = await readFile(file);
  corrupted[LOAD0_END + STUB_HANDLER_OFFSET + 4] ^= 0xff; // break one handler word
  await writeFile(file, corrupted);
  const result = cli(file, '--check', '--json');
  assert.equal(result.status, 2);
  assert.match(json(result).reason, /does not match this tool's blob/);
});

test('detects a stub whose PT_LOAD[0] fields do not cover it', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  assert.equal(cli(file).status, 0);
  const broken = await readFile(file);
  broken.writeBigUInt64LE(BigInt(LOAD0_END + 0x100), 64 + 32);
  await writeFile(file, broken);
  const result = cli(file, '--json');
  assert.equal(result.status, 2);
  assert.equal(json(result).status, 'unsupported');
});

test('usage is one loader plus optional flags', async () => {
  assert.equal(cli().status, 2);
  assert.equal(cli('--check').status, 2);
  assert.equal(cli('a.so', 'b.so').status, 2);
  assert.equal(cli('a.so', '--wat').status, 2);
  const missing = cli('definitely-absent-loader.so', '--json');
  assert.equal(missing.status, 2);
  assert.match(json(missing).reason, /cannot read/);
});

test('the handler answers the frames it is given (offline aarch64 harness)', {
  skip: NATIVE_AARCH64 || (HAS_CROSS_CC && HAS_QEMU) ? false
    : 'no aarch64-linux-gnu-gcc plus qemu-aarch64-static on PATH',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sigsys-stub-handler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stubFile = path.join(root, 'sigsys_stub.bin');
  const binary = path.join(root, 'handler_test');
  await writeFile(stubFile, STUB);
  const compiler = NATIVE_AARCH64 && !hasTool('aarch64-linux-gnu-gcc', ['--version']) ? 'cc' : 'aarch64-linux-gnu-gcc';
  execFileSync(compiler, ['-O1', '-static', '-Wall', '-Wextra', '-o', binary, HANDLER_SOURCE], { stdio: 'pipe' });
  const args = [binary, stubFile, STUB_HANDLER_OFFSET.toString(16)];
  const output = NATIVE_AARCH64
    ? execFileSync(binary, args.slice(1), { encoding: 'utf8' })
    : execFileSync('qemu-aarch64-static', args, { encoding: 'utf8' });
  t.diagnostic(output.trim());
  assert.match(output, /^PASS 0 check\(s\) failed$/m);
  for (const expected of [
    'trapped rseq returns -ENOSYS',
    'an advanced pc is left alone',
    'pstate is untouched',
    '__reserved is untouched',
    'synthesised success for setuid',
    'synthesised success for set_robust_list',
    'trapped clone3 (435) answers -ENOSYS',
    'trapped unshare (97) answers -ENOSYS',
    'trapped rseq (293) answers -ENOSYS',
    'trapped number 511 (511) answers -ENOSYS',
    'an unadvanced pc is stepped over the svc',
    'two adjacent svcs are not mistaken',
    'a non-SYS_SECCOMP signal drops our handler to SIG_DFL',
    'a tagged SYS_SECCOMP signal is re-queued',
  ]) {
    assert.ok(output.includes(expected), 'harness did not report: ' + expected);
  }
  assert.doesNotMatch(output, /^FAIL /m);
});

test('a real Debian loader, when BIONILUX_TEST_LOADER points at one', {
  skip: process.env.BIONILUX_TEST_LOADER ? false : 'set BIONILUX_TEST_LOADER to a real ld-linux-aarch64.so.1',
}, async (t) => {
  const { file } = await withTempFile(t, await readFile(process.env.BIONILUX_TEST_LOADER), 'ld-linux-aarch64.so.1');
  const injected = cli(file, '--json');
  assert.equal(injected.status, 0, injected.stderr);
  const report = json(injected);
  assert.equal(report.status, 'injected');
  assert.ok(KNOWN_ENTRIES.some((candidate) => candidate.entry === report.originalEntry));
  assert.equal(report.entry, report.originalEntry, 'e_entry must still point to _start');
  assert.equal(cli(file, '--check').status, 0);
  assert.equal(json(cli(file, '--json')).status, 'already');
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(report.cave, report.cave + 8).toString('hex'), '5f2403d51d0080d2');
  assert.equal(bytes.readBigUInt64LE(0x18), BigInt(report.originalEntry));
  await chmod(file, 0o755);
  const version = NATIVE_AARCH64
    ? execFileSync(file, ['--version'], { encoding: 'utf8' })
    : execFileSync('qemu-aarch64-static', [file, '--version'], { encoding: 'utf8' });
  assert.match(version, /^ld\.so \(Debian GLIBC/m);
});

test('the injector never ships a blob without the magic at the cave', async (t) => {
  const { file } = await withTempFile(t, buildLoader());
  const result = cli(file, '--json');
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(file);
  const { cave } = json(result);
  assert.deepEqual([...bytes.subarray(cave, cave + 8)], [...STUB.subarray(0, 8)]);
  assert.equal(STUB_HEX.replace(/\s+/g, '').length, STUB.length * 2, 'STUB_HEX is the blob, in hex');
});
