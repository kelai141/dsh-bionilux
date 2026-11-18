// Instruction-level patch for statically linked guest programs.
//
// Android's app seccomp filter (untrusted_app domain, targetSdk >= 29) answers
// a system call outside bionic's allowlist with SECCOMP_RET_TRAP, so a guest
// that makes one dies with SIGSYS ("Bad system call"). Two calls are made so
// early that no code of ours can answer them: the loader makes them while
// setting up TLS, and libc repeats them for every thread (see
// libc-seccomp-patch.js, which rewrites those sites inside the guest's libc).
// A statically linked program loads neither the loader stub nor the preload
// library: its calls are inlined `svc` instructions in its own text, so the
// file itself is the only place where the answer can change.
//
// This is the install-time half of what ssfuisu/cortex does in
// app/src/main/cpp/hook/static_programs.c (Apache-2.0, commit 072705c4): scan
// the executable segments of every static ELF under the rootfs, find the
// `movz w8|x8, #99|#293` whose `svc #0` follows, and replace that `svc` with
// an instruction that leaves a harmless answer without entering the kernel:
//
//   set_robust_list (99)    svc #0 -> nop              0xd503201f
//   rseq            (293)   svc #0 -> movn x0, #37     0x928004a0  (== -ENOSYS)
//
// set_robust_list becomes a NOP because aarch64 glibc assumes the call and
// never looks at its return value, so keeping x0 as the caller's first
// argument is more faithful than overwriting it. rseq must answer -ENOSYS:
// answering 0 would tell glibc the registration succeeded, and glibc would
// later use a thread area that was never registered. clone3 (435) is left
// alone: Android's allowlist permits it.
//
// The scan window is 16 instructions (64 bytes) after the `movz`, wider than
// the libc module's 12, because a statically linked binary may interleave
// argument setup between loading the call number and issuing the call. The
// window closes on anything that could change x8 or divert control flow, so a
// `movz` whose `svc` belongs to a different call is never rewritten by
// mistake. A static program that matches nothing is recorded as skipped, not
// treated as an error: it may legitimately contain none of these calls.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Records what was examined and patched, so a repeated ensure only re-reads files. */
const MARKER = ['var', 'lib', 'bionilux', 'guest-static-seccomp.json'];
const MARKER_SCHEMA_VERSION = 1;

/** Rootfs directories that hold runnable programs, relative to the rootfs root. */
export const DEFAULT_SCAN_DIRECTORIES = Object.freeze([
  'usr/bin',
  'usr/sbin',
  'bin',
  'sbin',
  'usr/local/bin',
  'usr/libexec',
]);

/** Per-pass safety limits: a large rootfs must not turn a launch into a crawl. */
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_FILE_SIZE = 64 * 1024 * 1024;
const DEFAULT_SCAN_BUDGET_MS = 30_000;

const ELF_MAGIC = 0x464c457f; // 0x7f 'E' 'L' 'F' read as a little-endian word
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const EM_AARCH64 = 0xb7;
const PT_LOAD = 1;
const PT_INTERP = 3;
const PF_X = 1;
const ELF64_HEADER_SIZE = 64;
const ELF64_PROGRAM_HEADER_SIZE = 56;
const ELF64_MAX_PROGRAM_HEADERS = 64;

/** The system calls this patch answers, and the instruction that answers them. */
const PATCHED_CALLS = new Map([
  [99, { name: 'set_robust_list', replacement: 0xd503201f }], // nop
  [293, { name: 'rseq', replacement: 0x928004a0 }], // movn x0, #37 == -ENOSYS
]);

const AARCH64_SVC = 0xd4000001;
const AARCH64_SVC_MASK = 0xffe0001f;
const AARCH64_MOVZ_X8_MASK = 0x7fe0001f;
const AARCH64_MOVZ_X8_VALUE = 0x52800008;

/**
 * Instructions after the `movz` in which the matching `svc` may still appear.
 * Cortex's static_programs.c uses the same 16; the libc patch's 12 comes from
 * a different macro and is too narrow for statically linked glibc, where the
 * call number may be loaded before the argument registers are filled.
 */
const WINDOW_INSTRUCTIONS = 16;

/**
 * Conditions that close the window. Each entry masks a whole instruction class,
 * so a match is accepted only while every instruction between the `movz` and
 * the `svc` is a plain one:
 *
 *   0x0000001f / 0x00000008  Rd field is x8 (any instruction writing x8)
 *   0xffe0001f / 0xd4000001  any svc (a non-zero immediate svc is another call)
 *   0x7c000000 / 0x14000000  b, bl
 *   0xff000010 / 0x54000000  b.cond (bit 4 is the condition's low bit)
 *   0x7e000000 / 0x34000000  cbz, cbnz
 *   0x7e000000 / 0x36000000  tbz, tbnz
 *   0xfe000000 / 0xd6000000  br, blr, ret
 *
 * Constants and the closing conditions follow ssfuisu/cortex
 * app/src/main/cpp/hook/static_programs.c (Apache-2.0); the scan and the
 * bookkeeping below are new.
 */
const WINDOW_CLOSING_MASKS = Object.freeze([
  { mask: 0x0000001f, value: 0x00000008, reason: 'writes x8' },
  { mask: AARCH64_SVC_MASK, value: AARCH64_SVC, reason: 'another svc' },
  { mask: 0x7c000000, value: 0x14000000, reason: 'b or bl' },
  { mask: 0xff000010, value: 0x54000000, reason: 'b.cond' },
  { mask: 0x7e000000, value: 0x34000000, reason: 'cbz or cbnz' },
  { mask: 0x7e000000, value: 0x36000000, reason: 'tbz or tbnz' },
  { mask: 0xfe000000, value: 0xd6000000, reason: 'br, blr or ret' },
]);

function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Read the aarch64 `movz w8|x8, #imm` that loads a system call number, or null. */
function decodeMovzToX8(word) {
  if (((word & AARCH64_MOVZ_X8_MASK) >>> 0) !== AARCH64_MOVZ_X8_VALUE) return null;
  return (word >>> 5) & 0xffff;
}

/** True when the instruction makes the current `movz` unmatchable. */
function closesWindow(word) {
  for (const rule of WINDOW_CLOSING_MASKS) {
    if (((word & rule.mask) >>> 0) === rule.value) return true;
  }
  return false;
}

/**
 * Find the call sites of the trapped start-up calls in a raw instruction stream.
 *
 * A site is an `svc #0` whose preceding `movz w8|x8` loads 99 or 293, within
 * WINDOW_INSTRUCTIONS instructions and with no window-closing instruction in
 * between. Offsets are relative to the start of `code`.
 */
export function findStaticCallSites(code) {
  const words = Math.floor(code.length / 4);
  const sites = [];
  for (let index = 0; index < words; index += 1) {
    const syscall = decodeMovzToX8(code.readUInt32LE(index * 4) >>> 0);
    if (syscall === null) continue;
    const call = PATCHED_CALLS.get(syscall);
    if (call === undefined) continue;
    for (let step = 1; step <= WINDOW_INSTRUCTIONS; step += 1) {
      const next = index + step;
      if (next >= words) break;
      const word = code.readUInt32LE(next * 4) >>> 0;
      if (word === AARCH64_SVC) {
        sites.push({
          offset: next * 4,
          movzOffset: index * 4,
          syscall,
          name: call.name,
          replacement: call.replacement,
        });
        break;
      }
      if (closesWindow(word)) break;
    }
  }
  return sites;
}

/**
 * Parse the little-endian ELF64 header and program headers this module needs.
 *
 * Only fields the scan actually uses are read; a synthetic or unusual file with
 * zeroed section headers parses fine, while a truncated program header table is
 * rejected instead of being read out of bounds.
 */
function parseElf64(buffer) {
  if (buffer.length < ELF64_HEADER_SIZE) return null;
  if (buffer.readUInt32LE(0) !== ELF_MAGIC) return null;
  if (buffer[4] !== ELF_CLASS_64 || buffer[5] !== ELF_DATA_LITTLE_ENDIAN) return null;
  const machine = buffer.readUInt16LE(18);
  const programHeaderOffset = Number(buffer.readBigUInt64LE(32));
  const programHeaderSize = buffer.readUInt16LE(54);
  const programHeaderCount = buffer.readUInt16LE(56);
  if (programHeaderSize < ELF64_PROGRAM_HEADER_SIZE) return null;
  if (programHeaderCount < 1 || programHeaderCount > ELF64_MAX_PROGRAM_HEADERS) return null;
  if (programHeaderOffset < ELF64_HEADER_SIZE || programHeaderOffset + programHeaderCount * programHeaderSize > buffer.length) return null;
  const executableSegments = [];
  let hasInterp = false;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const base = programHeaderOffset + index * programHeaderSize;
    const type = buffer.readUInt32LE(base);
    const flags = buffer.readUInt32LE(base + 4);
    const offset = Number(buffer.readBigUInt64LE(base + 8));
    const fileSize = Number(buffer.readBigUInt64LE(base + 32));
    if (type === PT_INTERP) hasInterp = true;
    if (type !== PT_LOAD || (flags & PF_X) === 0 || fileSize === 0) continue;
    if (offset >= buffer.length) continue;
    const end = Math.min(offset + fileSize, buffer.length);
    if (end - offset < 8) continue;
    executableSegments.push({ offset, fileSize: end - offset });
  }
  return { machine, hasInterp, executableSegments };
}

/**
 * Classify an ELF image the way the static patch needs it.
 *
 * @returns {{ static: boolean, machine: number|null, reason: string }}
 */
export function inspectGuestStaticElf(buffer) {
  const elf = parseElf64(buffer);
  if (elf === null) return { static: false, machine: null, reason: 'not an ELF64 little-endian file' };
  if (elf.machine !== EM_AARCH64) {
    return { static: false, machine: elf.machine, reason: 'not an AArch64 ELF' };
  }
  if (elf.hasInterp) return { static: false, machine: elf.machine, reason: 'dynamic ELF (has PT_INTERP)' };
  return { static: true, machine: elf.machine, reason: 'static AArch64 ELF' };
}

/**
 * Rewrite the trapped calls inside a statically linked AArch64 ELF image.
 *
 * Only executable load segments are scanned, and only the `svc` of a matched
 * site is replaced; the `movz` that loads the call number stays, exactly as in
 * the libc patch. Dynamic ELFs, other machines and non-ELF buffers come back
 * byte for byte unchanged with no sites.
 */
export function patchStaticGuestBuffer(buffer) {
  const patched = Buffer.from(buffer);
  const elf = parseElf64(buffer);
  if (elf === null || elf.machine !== EM_AARCH64 || elf.hasInterp) {
    return { buffer: patched, sites: [], segments: 0 };
  }
  const sites = [];
  const seenOffsets = new Set();
  for (const segment of elf.executableSegments) {
    // Clamp to whole instructions: a segment whose file range is not a multiple
    // of four must not make the decoder read past its end.
    const start = Math.ceil(segment.offset / 4) * 4;
    const end = Math.floor((segment.offset + segment.fileSize) / 4) * 4;
    if (end - start < 8) continue;
    const code = buffer.subarray(start, end);
    for (const site of findStaticCallSites(code)) {
      const fileOffset = start + site.offset;
      if (seenOffsets.has(fileOffset)) continue;
      seenOffsets.add(fileOffset);
      sites.push({
        offset: fileOffset,
        movzOffset: start + site.movzOffset,
        syscall: site.syscall,
        name: site.name,
      });
      patched.writeUInt32LE(site.replacement, fileOffset);
    }
  }
  sites.sort((left, right) => left.offset - right.offset);
  return { buffer: patched, sites, segments: elf.executableSegments.length };
}

/** In-process serialization per rootfs so concurrent calls cannot race on in-place binary writes. */
const ACTIVE_PATCHES = new Map();

async function withRootfsLock(rootfs, fn) {
  const key = path.resolve(rootfs);
  const previous = ACTIVE_PATCHES.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  ACTIVE_PATCHES.set(key, current);
  try {
    return await current;
  } finally {
    if (ACTIVE_PATCHES.get(key) === current) ACTIVE_PATCHES.delete(key);
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read the bookkeeping file; a missing, damaged or foreign version costs one rescan. */
async function readMarker(markerPath) {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8'));
    if (isPlainRecord(parsed) && parsed.schemaVersion === MARKER_SCHEMA_VERSION && isPlainRecord(parsed.files)) {
      const files = {};
      for (const [key, entry] of Object.entries(parsed.files)) {
        if (isPlainRecord(entry)) files[key] = entry;
      }
      return files;
    }
  } catch {
    // Fall through to an empty record.
  }
  return {};
}

/** Persist the bookkeeping file via a sibling temp file so a crash never truncates it. */
async function writeMarkerAtomic(markerPath, recordedFiles) {
  const directory = path.dirname(markerPath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.guest-static-seccomp-${process.pid}-${randomUUID()}.tmp`);
  const payload = JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, files: recordedFiles }, null, 2) + '\n';
  try {
    await writeFile(tempPath, payload);
    await rename(tempPath, markerPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Probe an ELF without reading the whole file.
 *
 * Most programs under a rootfs directory are dynamically linked, and their
 * bytes are never needed here, so the header and program header table are read
 * first and only a static AArch64 ELF is loaded in full.
 */
async function probeProgram(filePath, size) {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(ELF64_HEADER_SIZE);
    const headerRead = await handle.read(header, 0, ELF64_HEADER_SIZE, 0);
    if (headerRead.bytesRead < ELF64_HEADER_SIZE) return { kind: 'ignored' };
    if (header.readUInt32LE(0) !== ELF_MAGIC) return { kind: 'ignored' };
    if (header[4] !== ELF_CLASS_64 || header[5] !== ELF_DATA_LITTLE_ENDIAN) return { kind: 'ignored' };
    if (header.readUInt16LE(18) !== EM_AARCH64) return { kind: 'ignored' };
    const programHeaderOffset = Number(header.readBigUInt64LE(32));
    const programHeaderSize = header.readUInt16LE(54);
    const programHeaderCount = header.readUInt16LE(56);
    if (programHeaderSize < ELF64_PROGRAM_HEADER_SIZE) {
      return { kind: 'malformed', reason: 'program header entry is smaller than 56 bytes' };
    }
    if (programHeaderCount < 1 || programHeaderCount > ELF64_MAX_PROGRAM_HEADERS) {
      return { kind: 'malformed', reason: 'unexpected number of program headers' };
    }
    const tableSize = programHeaderCount * programHeaderSize;
    if (programHeaderOffset < ELF64_HEADER_SIZE || programHeaderOffset + tableSize > size) {
      return { kind: 'malformed', reason: 'program header table offset or size is invalid' };
    }
    const table = Buffer.alloc(tableSize);
    const tableRead = await handle.read(table, 0, tableSize, programHeaderOffset);
    if (tableRead.bytesRead < tableSize) {
      return { kind: 'malformed', reason: 'short read of the program header table' };
    }
    for (let index = 0; index < programHeaderCount; index += 1) {
      if (table.readUInt32LE(index * programHeaderSize) === PT_INTERP) return { kind: 'dynamic' };
    }
    return { kind: 'static' };
  } finally {
    await handle.close();
  }
}

/** Collect rootfs-relative file paths beneath the configured scan directories. */
async function collectCandidates(rootfs, directories, limits, state) {
  const candidates = [];
  const outOfBudget = () => Date.now() - state.startedAt > limits.budgetMs;
  const walk = async (relativeDirectory) => {
    if (state.limitReached) return;
    if (candidates.length >= limits.maxFiles || outOfBudget()) {
      state.limitReached = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(path.join(rootfs, relativeDirectory), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      state.failures.push({ path: relativeDirectory, reason: 'cannot list directory: ' + (error.code ?? error.message) });
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (candidates.length >= limits.maxFiles || outOfBudget()) {
        state.limitReached = true;
        return;
      }
      const relative = relativeDirectory + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      // Symlinks are left alone: the target is either scanned under its own
      // merged-usr path or outside the rootfs, and both must not be patched
      // twice.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile()) {
        // Some filesystems report DT_UNKNOWN; resolve the type when they do.
        let info;
        try {
          info = await lstat(path.join(rootfs, relative));
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          await walk(relative);
          continue;
        }
        if (!info.isFile()) continue;
      }
      candidates.push(relative);
    }
  };
  for (const directory of directories) {
    if (state.limitReached) break;
    let info;
    try {
      info = await lstat(path.join(rootfs, directory));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      state.failures.push({ path: directory, reason: 'cannot inspect directory: ' + (error.code ?? error.message) });
      continue;
    }
    if (!info.isDirectory()) continue; // merged-usr symlink or plain file
    await walk(directory);
  }
  return candidates;
}

/**
 * Examine one candidate file and patch it when it is a static AArch64 program.
 *
 * Returns null for files that are not static AArch64 ELFs, and an entry for
 * every static program (patched, already in the desired state, or skipped
 * because nothing matched). `changed` tells ensure whether the marker has to be
 * written again.
 */
async function patchCandidate(rootfs, relative, limits, recordedFiles) {
  const fullPath = path.join(rootfs, relative);
  let size;
  try {
    size = (await stat(fullPath)).size;
  } catch (error) {
    // A file removed between the directory walk and this read is not a patch
    // failure; there is nothing left to patch.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (size > limits.maxFileSize) {
    return {
      entry: { path: relative, status: 'skipped', reason: 'file is larger than ' + limits.maxFileSize + ' bytes' },
      changed: false,
    };
  }
  const probe = await probeProgram(fullPath, size);
  if (probe.kind === 'ignored' || probe.kind === 'dynamic') return null;
  const original = await readFile(fullPath);
  const digest = digestOf(original);
  const recorded = recordedFiles[relative];
  if (probe.kind === 'malformed') {
    const reason = 'malformed ELF: ' + probe.reason;
    if (recorded !== undefined && recorded.originalDigest === digest) {
      return { entry: { path: relative, status: 'already', reason }, changed: false };
    }
    recordedFiles[relative] = { originalDigest: digest, patchedDigest: null, patchedSites: [], skipped: reason };
    return { entry: { path: relative, status: 'skipped', reason }, changed: true };
  }
  if (recorded !== undefined && recorded.patchedDigest === digest) {
    return { entry: { path: relative, status: 'already' }, changed: false };
  }
  if (recorded !== undefined && recorded.patchedDigest === null && recorded.originalDigest === digest) {
    return { entry: { path: relative, status: 'already', reason: 'no call site matched on an earlier pass' }, changed: false };
  }
  const { buffer, sites } = patchStaticGuestBuffer(original);
  if (sites.length === 0) {
    const reason = 'no set_robust_list/rseq call site matched';
    recordedFiles[relative] = { originalDigest: digest, patchedDigest: null, patchedSites: [], skipped: reason };
    return { entry: { path: relative, status: 'skipped', reason }, changed: true };
  }
  // Write in place, like the libc patch: the mode and the inode stay untouched.
  // A busy or read-only file is reported by the caller as a failure rather than
  // silently leaving a program that would still die at its first trapped call.
  await writeFile(fullPath, buffer);
  const patchedSites = sites.map((site) => ({ offset: site.offset, syscall: site.syscall, name: site.name }));
  recordedFiles[relative] = { originalDigest: digest, patchedDigest: digestOf(buffer), patchedSites };
  return { entry: { path: relative, status: 'patched', sites: patchedSites }, changed: true };
}

/**
 * Answer the trapped start-up calls inside every static program of a guest rootfs.
 *
 * Idempotent through the marker: each static program is recorded by path with
 * its digest before and after patching, so a repeated ensure costs one read per
 * program. A program whose bytes changed (a package upgrade) or that was
 * replaced by a fresh unpatched copy is patched again. Programs with no matching
 * call site are recorded as skipped and never fail the pass, while a file that
 * cannot be rewritten is reported in `failures` and makes the status 'failed'.
 *
 * @param {string} rootfs guest rootfs root
 * @param {{
 *   architecture?: string,
 *   log?: (line: string) => void,
 *   scanDirectories?: string[],
 *   maxFiles?: number,
 *   maxFileSize?: number,
 *   scanBudgetMs?: number,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function ensureGuestStaticSeccompPatch(rootfs, options = {}) {
  const log = options.log ?? (() => {});
  const markerPath = path.join(rootfs, ...MARKER);
  if (options.architecture !== undefined && options.architecture !== 'arm64') {
    return {
      status: 'skipped',
      rootfs,
      markerPath,
      reason: 'unsupported architecture ' + options.architecture,
      scanned: 0,
      results: [],
      failures: [],
    };
  }
  if (!existsSync(rootfs)) {
    return {
      status: 'skipped',
      rootfs,
      markerPath,
      reason: 'guest rootfs is not present',
      scanned: 0,
      results: [],
      failures: [],
    };
  }
  return withRootfsLock(rootfs, async () => {
    const limits = {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      maxFileSize: options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      budgetMs: options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS,
    };
    const directories = options.scanDirectories ?? DEFAULT_SCAN_DIRECTORIES;
    const startedAt = Date.now();
    const recordedFiles = await readMarker(markerPath);
    const state = { startedAt, limitReached: false, failures: [] };
    const results = [];
    const counters = { scanned: 0, ignored: 0, patched: 0, already: 0, skipped: 0 };
    let dirty = false;
    const candidates = await collectCandidates(rootfs, directories, limits, state);
    for (const relative of candidates) {
      if (Date.now() - startedAt > limits.budgetMs) {
        state.limitReached = true;
        break;
      }
      counters.scanned += 1;
      let outcome;
      try {
        outcome = await patchCandidate(rootfs, relative, limits, recordedFiles);
      } catch (error) {
        const failure = {
          path: relative,
          reason: (error.code !== undefined ? error.code + ': ' : '') + (error.message ?? String(error)),
        };
        state.failures.push(failure);
        continue;
      }
      if (outcome === null) {
        counters.ignored += 1;
        continue;
      }
      if (outcome.entry.status === 'patched') counters.patched += 1;
      else if (outcome.entry.status === 'already') counters.already += 1;
      else counters.skipped += 1;
      if (outcome.changed) dirty = true;
      results.push(outcome.entry);
      if (outcome.entry.status === 'patched') {
        log(
          'guest static program patched: ' + relative + ' (' +
          outcome.entry.sites.map((site) => site.name).join(', ') + ')',
        );
      }
    }
    if (dirty) {
      await writeMarkerAtomic(markerPath, recordedFiles);
    }
    const failures = state.failures;
    const status = failures.length > 0 ? 'failed' : counters.patched > 0 ? 'patched' : 'already';
    return {
      status,
      rootfs,
      markerPath,
      scanned: counters.scanned,
      counters,
      results,
      failures,
      limits: { ...limits, reached: state.limitReached },
    };
  });
}
