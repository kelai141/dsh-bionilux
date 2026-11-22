// Guest glibc adaptation for Android's app seccomp filter.
//
// An app process with targetSdk >= 29 inherits Android's seccomp filter for the
// untrusted_app domain: an allowlist built from bionic's own needs whose default
// action is SECCOMP_RET_TRAP, so a system call bionic never makes kills the
// process with SIGSYS ("Bad system call"). glibc issues two of those so early
// that no code of an LD_PRELOAD hook has run yet, which is why a preload-side
// SIGSYS handler cannot save the process. They do not come from libc's own
// initialisation: the loader makes them for the first thread while setting up
// TLS (init_tls -> __tls_init_tp in sysdeps/nptl/dl-tls_init_tp.c, before any
// relocation), and libc repeats set_robust_list for every thread it starts
// (nptl/pthread_create.c, start_thread):
//
//   set_robust_list  nptl registers the robust-futex list of the current thread.
//   rseq             restartable sequences (glibc >= 2.35).
//
// The per-thread site cannot be left to a SIGSYS handler even in principle:
// start_thread blocks every signal before it calls these, and a trapped system
// call while SIGSYS is blocked is fatal -- the kernel resets the handler to the
// default action and kills the thread.
//
// Both are best-effort, so answering -ENOSYS is exactly what a kernel without
// those features would do. The calls are inlined `svc` instructions in the
// guest's libc, so the only place to change the answer is the instruction
// itself. Each site is rewritten to a single instruction that leaves -ENOSYS in
// x0 and issues no system call:
//
//   svc #0        (0xd4000001)   ->   movn x0, #37   (0x928004a0)  == -ENOSYS
//
// Measured on vivo V2425A (Android 17, targetSdk 34, arm64): /usr/bin/true and
// dpkg-divert from the Debian rootfs both die at set_robust_list; with those
// two calls answered by -ENOSYS both run to completion. The same three sites
// carry the only two trapped calls in Debian trixie's glibc 2.41 aarch64.
//
// x86_64 guests are left alone: Android's emulator images answer these calls,
// and the patch would need a different instruction sequence there. A libc whose
// code does not match the expected shapes is reported, never guessed at:
// silently doing nothing would move the failure back to a "Bad system call"
// nobody can place.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Records which libc digest is patched, so a repeated ensure costs one read. */
const MARKER = ['var', 'lib', 'bionilux', 'guest-libc-seccomp.json'];

/** aarch64 system call numbers whose answer has to change. */
const AARCH64_CALLS = new Map([
  [99, 'set_robust_list'],
  [293, 'rseq'],
]);

const AARCH64_SVC = 0xd4000001;
const AARCH64_SVC_MASK = 0xffe0001f;
const AARCH64_MOVN_X0_ENOSYS = 0x928004a0;

/** Decode a MOVZ/MOVN that writes x8; returns the opcode and immediate, or null. */
function decodeMoveToX8(word) {
  if ((word & 0x1f) !== 8) return null;
  if (((word >>> 23) & 0x3f) !== 0x25) return null;
  // 64-bit form only: both call numbers fit in 16 bits, so glibc emits MOVZ x8.
  if (((word >>> 31) & 1) !== 1) return null;
  const opc = (word >>> 29) & 3;
  const shift = ((word >>> 21) & 3) * 16;
  const imm = ((word >>> 5) & 0xffff) << shift;
  if (opc === 2) return { opcode: 'movz', imm };
  if (opc === 0) return { opcode: 'movn', imm };
  return null;
}

/**
 * Find the aarch64 call sites of the trapped start-up calls.
 *
 * A site is an `svc #0` whose preceding instructions -- inside twelve, the
 * window glibc's syscall macro spans -- load the call number into x8. Reading
 * the number from the instruction instead of a fixed offset keeps this valid
 * for any glibc build that uses the same macro.
 */
export function findAarch64CallSites(buffer) {
  const words = Math.floor(buffer.length / 4);
  const sites = [];
  for (let index = 0; index < words; index += 1) {
    const word = buffer.readUInt32LE(index * 4) >>> 0;
    if ((word & AARCH64_SVC_MASK) >>> 0 !== AARCH64_SVC) continue;
    for (let back = 1; back <= 12 && index - back >= 0; back += 1) {
      const move = decodeMoveToX8(buffer.readUInt32LE((index - back) * 4) >>> 0);
      if (move === null) continue;
      if (move.opcode === 'movz') {
        const name = AARCH64_CALLS.get(move.imm);
        if (name !== undefined) sites.push({ offset: index * 4, syscall: move.imm, name });
      }
      break;
    }
  }
  return sites;
}

/**
 * Rewrite every site so the call answers -ENOSYS without entering the kernel.
 *
 * The same two calls appear in the loader the APK ships and in every rootfs
 * copy of libc, so this works on either ELF.
 */
export function patchAarch64GuestBuffer(buffer) {
  const sites = findAarch64CallSites(buffer);
  const patched = Buffer.from(buffer);
  for (const site of sites) patched.writeUInt32LE(AARCH64_MOVN_X0_ENOSYS, site.offset);
  return { buffer: patched, sites };
}

/** Locate the guest libc, following the merged-usr layouts Debian ships. */
export function guestLibcPath(rootfs) {
  const candidates = [
    ['usr', 'lib', 'aarch64-linux-gnu', 'libc.so.6'],
    ['lib', 'aarch64-linux-gnu', 'libc.so.6'],
  ];
  for (const parts of candidates) {
    const candidate = path.join(rootfs, ...parts);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(rootfs, 'usr', 'lib', 'aarch64-linux-gnu', 'libc.so.6');
}

function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Answer the two trapped start-up calls of the guest's glibc with -ENOSYS.
 *
 * Idempotent through the marker: the patched digest is recorded, so repeated
 * ensures cost one read. A libc whose bytes changed (a package upgrade) is
 * patched again.
 *
 * @param {string} rootfs guest rootfs root
 * @param {{ architecture?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<{ status: string, path: string, sites?: object[], reason?: string }>}
 */
export async function ensureGuestLibcSeccompPatch(rootfs, options = {}) {
  const log = options.log ?? (() => {});
  const libc = guestLibcPath(rootfs);
  if (options.architecture !== undefined && options.architecture !== 'arm64') {
    return { status: 'skipped', path: libc, reason: 'unsupported architecture ' + options.architecture };
  }
  if (!existsSync(libc)) {
    return { status: 'skipped', path: libc, reason: 'guest libc is not present' };
  }
  const target = await realpath(libc);
  const root = await realpath(rootfs);
  if (!target.startsWith(root + path.sep)) throw new Error('guest libc resolves outside the rootfs');
  const identity = await stat(target, { bigint: true });
  const original = await readFile(target);
  const digest = digestOf(original);
  const markerPath = path.join(rootfs, ...MARKER);
  const markerDirectory = path.dirname(markerPath);
  await mkdir(markerDirectory, { recursive: true });
  if (await realpath(markerDirectory) !== path.join(root, ...MARKER.slice(0, -1))) {
    throw new Error('guest libc marker directory resolves through a symlink');
  }
  const readMarker = async () => {
    try {
      if (await realpath(markerPath) !== path.join(root, ...MARKER)) return null;
      return JSON.parse(await readFile(markerPath, 'utf8'));
    } catch {
      return null;
    }
  };
  const marker = await readMarker();
  if (marker !== null && marker.patchedDigest === digest) {
    return { status: 'already', path: libc };
  }
  const { buffer, sites } = patchAarch64GuestBuffer(original);
  if (sites.length === 0) {
    return {
      status: 'unsupported',
      path: libc,
      reason: 'no set_robust_list/rseq call site matched; the guest libc changed shape',
    };
  }
  const suffix = '.' + randomUUID() + '.tmp';
  const stagedLibc = target + suffix;
  const stagedMarker = markerPath + suffix;
  try {
    await writeFile(stagedLibc, buffer, { flag: 'wx', mode: Number(identity.mode & 0o777n) });
    await writeFile(stagedMarker, JSON.stringify({
      schemaVersion: 1,
      originalDigest: digest,
      patchedDigest: digestOf(buffer),
      sites: sites.map((site) => ({ offset: site.offset, syscall: site.syscall, name: site.name })),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const current = await stat(target, { bigint: true });
    if (current.ino !== identity.ino || current.dev !== identity.dev || current.ctimeNs !== identity.ctimeNs) {
      throw new Error('guest libc changed during compatibility preparation; retry after the package operation finishes');
    }
    // Publish the expected digest first. An interrupted rename leaves the
    // original libc available for another attempt.
    await rename(stagedMarker, markerPath);
    // Existing processes may still map the previous inode.
    await rename(stagedLibc, target);
  } finally {
    await rm(stagedLibc, { force: true });
    await rm(stagedMarker, { force: true });
  }
  log('guest libc: answered ' + sites.map((site) => site.name).join(', ') + ' with -ENOSYS');
  return { status: 'patched', path: libc, sites };
}
