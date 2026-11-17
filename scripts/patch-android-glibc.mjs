#!/usr/bin/env node
// Answer Android's trapped start-up system calls inside a guest glibc ELF.
//
// Usage: patch-android-glibc.mjs FILE...
//
// The loader the APK ships and every rootfs copy of libc/ld.so contain the same
// two inlined calls (set_robust_list, rseq). Android's app seccomp filter traps
// both with SIGSYS, and they run before any LD_PRELOAD constructor, so the
// instruction is the only place to change the answer. See
// packages/linux-runtime/modules/libc-seccomp-patch.js for the evidence.
//
// Non-aarch64 files are skipped: this encoding is AArch64 only, and the x86_64
// emulator images answer those calls. A file the patch was expected in but that
// contains no call site fails the run instead of shipping unpatched.
import { readFile, writeFile } from 'node:fs/promises';
import { patchAarch64GuestBuffer } from '../packages/linux-runtime/modules/libc-seccomp-patch.js';

const AARCH64_MACHINE = 0xb7;
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: patch-android-glibc.mjs FILE...');
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const original = await readFile(file);
  if (original.length < 20 || original.readUInt32BE(0) !== 0x7f454c46) {
    console.error(file + ': not an ELF file');
    failed = true;
    continue;
  }
  if (original.readUInt16LE(0x12) !== AARCH64_MACHINE) {
    console.log(file + ': skipped (not AArch64)');
    continue;
  }
  const { buffer, sites } = patchAarch64GuestBuffer(original);
  if (sites.length === 0) {
    console.error(file + ': no set_robust_list/rseq call site found; refusing to ship it unpatched');
    failed = true;
    continue;
  }
  await writeFile(file, buffer);
  console.log(file + ': ' + sites.map((site) => site.name + '@' + site.offset).join(', ') + ' -> -ENOSYS');
}
process.exit(failed ? 1 : 0);
