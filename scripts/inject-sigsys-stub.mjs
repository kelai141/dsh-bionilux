#!/usr/bin/env node
// Inject the SIGSYS entry stub into an AArch64 dynamic loader (Debian ld.so).
//
// Usage: node scripts/inject-sigsys-stub.mjs <loader.so> [--check|--verify] [--json]
//        --verify is accepted as a synonym for --check.
//
// Why this exists: an Android app process (targetSdk >= 29) inherits
// untrusted_app's seccomp allowlist with SECCOMP_RET_TRAP as the default
// action, so a denied syscall kills the thread with SIGSYS before any error can
// be returned. glibc issues set_robust_list/rseq from its own startup path and
// the build rewrites those two instruction sites to -ENOSYS
// (scripts/patch-android-glibc.mjs). Everything else the filter denies
// (unshare, mount, keyctl, io_uring_setup, bpf, SysV IPC, ...) would still kill
// the process on the spot. The stub installed here runs before the first rtld
// instruction: it unblocks SIGSYS, installs a handler that answers a trapped
// call with -ENOSYS, restores the entry registers and branches back to the
// loader's real entry point. See scripts/stub/sigsys_stub_aarch64.S.
//
// What is rewritten: exactly three fields plus the zero padding the stub is
// copied into.
//   e_entry              -> the cave address (the stub's first byte)
//   PT_LOAD[0].p_filesz  -> cave + stub length
//   PT_LOAD[0].p_memsz   -> cave + stub length
// Nothing is moved and no size is added: the cave is zero padding already
// present in the file between the read-only segment and the next segment, so
// the segment is only extended to cover it.
//
// Exit codes: 0 injected / already / skipped, 2 any refusal or structural
// mismatch (unknown loader, unexpected PT_LOAD[0], short or dirty cave,
// truncated or non-ELF input, --check against a loader without the stub).
// A non-AArch64 ELF is skipped, never injected: the encoding is AArch64 only,
// which mirrors scripts/patch-android-glibc.mjs.
//
// --json prints one line:
//   {status, file, entry, cave, originalEntry, stubBytes, loaderSha256}
// status: injected | already | skipped | unsupported
//   entry          e_entry after the step (the cave address when injected)
//   cave           file offset and address the stub lives at
//   originalEntry  e_entry before the step, i.e. the known loader entry
//                  (null when it could not be determined)
//   loaderSha256   SHA-256 of the loader file as it is after the step, which
//                  is the bytes that ship
//   reason         present only when status is unsupported
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ELF_MAGIC = 0x7f454c46;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EM_AARCH64 = 0xb7;
const ET_EXEC = 2;
const ET_DYN = 3;
const PT_LOAD = 1;
const PF_X = 0x1;
const PF_W = 0x2;
const PF_R = 0x4;
const EHDR_SIZE = 64;
const PHDR_SIZE = 56;
const E_ENTRY = 0x18;
const E_PHOFF = 0x20;
const E_PHENTSIZE = 0x36;
const E_PHNUM = 0x38;
const P_FILESZ = 32;
const P_MEMSZ = 40;

/* Loaders this tool knows how to repoint. The entry address identifies the
 * glibc build, and every structural assumption below was measured on that
 * exact file, so an entry that is not listed is a hard failure rather than a
 * silent skip. Add a row only together with its source. */
const KNOWN_ENTRIES = [
  {
    entry: 0x1b2c0,
    // Debian trixie arm64, glibc 2.41-12+deb13u4: /lib/ld-linux-aarch64.so.1,
    // 201344 bytes, sha256 1b882eddacd494b060413a8aa4f0a4754ee3f84775e68cecbf8a86092b59cca6,
    // build-id d7be73c7b2bf2531fb3e11318f0949141af7063a.
    // PT_LOAD[0] = {offset 0, vaddr 0, filesz = memsz = 0x27460, R|X};
    // next PT_LOAD starts at file offset 0x2e898, leaving 0x7428 zero bytes.
    source: 'Debian trixie glibc 2.41-12+deb13u4',
  },
];

/* The stub blob, assembled from scripts/stub/sigsys_stub_aarch64.S by
 *
 *   aarch64-linux-gnu-as -o /tmp/sigsys_stub.o scripts/stub/sigsys_stub_aarch64.S
 *   aarch64-linux-gnu-objcopy -O binary --only-section=.text \
 *     /tmp/sigsys_stub.o /tmp/sigsys_stub.bin
 *   xxd -p /tmp/sigsys_stub.bin | tr -d '\n'
 *
 * scripts/inject-sigsys-stub.test.mjs rebuilds the source when a cross
 * assembler is installed and fails if the bytes here differ. */
const STUB_HEX = `
  5f2403d51f2003d5ffc301d1e00700a9e20f01a9e41702a9e61f03a9e82704a9e4020010850080d2e41705a9ff7f06a9
  e1430191e00380d2020080d2030180d2c81080d2010000d4810b0010200080d2020080d2030180d2e81080d2010000d4
  e00740a9e20f41a9e41742a9e61f43a9e82744a9ffc30191000000145f2403d5410400b4220400b4230840b97f040071
  e1030054230440b9a3030035437c40f944060010450180d2868440f8df0003eba0000054a50400f181ffff54a3048092
  02000014030080d2435c00f943dc40f9640040b90780ba5227008072e603805206fcbf728500060abf00076be1000054
  65c05fb8a500060abf00076b600000546310009143dc00f9c0035fd6ff0301d1e00700a9e20f01a9ff7f02a9ff7f03a9
  e00380d2e1830091020080d2030180d2c81080d2010000d4481680d2010000d4e10300aa881580d2010000d4e20380d2
  681080d2010000d4e00740a9e20f41a9ff030191c0035fd6920000000000000090000000000000009100000000000000
  8f0000000000000093000000000000009500000000000000970000000000000098000000000000009f00000000000000
  63000000000000000000004000000000
`;
const STUB = Buffer.from(STUB_HEX.replace(/\s+/g, ''), 'hex');
/* "b ." at the end of the entry path: the injector rewrites this word with the
 * branch back to the original e_entry. If the source drifts, the assertion on
 * this word fails instead of shipping a stub that loops forever. */
const STUB_BRANCH_OFFSET = 0x78;
const STUB_BRANCH_PLACEHOLDER = 0x14000000;
const STUB_BRANCH_OPCODE = 0x14000000;
/* The first two instructions (bti c; nop) double as the injected marker. */
const STUB_MAGIC = STUB.subarray(0, 8);
/* Handler entry inside the blob; the unit test calls it as a plain function. */
const STUB_HANDLER_OFFSET = 0x7c;
/* Keep this much untouched zero padding between the stub and the next segment. */
const CAVE_HEADROOM = 16;

class Refusal extends Error {}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function parseHeader(buffer) {
  if (buffer.length < EHDR_SIZE || buffer.readUInt32BE(0) !== ELF_MAGIC) {
    throw new Refusal('not an ELF file');
  }
  if (buffer.readUInt16LE(0x12) !== EM_AARCH64) return null; // caller reports skipped
  if (buffer[4] !== ELFCLASS64 || buffer[5] !== ELFDATA2LSB || buffer[6] !== 1) {
    throw new Refusal('AArch64 but not a 64-bit little-endian ELF; this stub encoding does not apply');
  }
  const type = buffer.readUInt16LE(0x10);
  if (type !== ET_DYN && type !== ET_EXEC) {
    throw new Refusal('unexpected ELF type ' + type + '; a loader is ET_DYN or ET_EXEC');
  }
  const phoff = Number(buffer.readBigUInt64LE(E_PHOFF));
  const phentsize = buffer.readUInt16LE(E_PHENTSIZE);
  const phnum = buffer.readUInt16LE(E_PHNUM);
  if (phentsize !== PHDR_SIZE) {
    throw new Refusal('program header entry size ' + phentsize + ' is not ' + PHDR_SIZE);
  }
  if (phnum === 0 || phnum === 0xffff) {
    throw new Refusal('loader has an extended or empty program header table');
  }
  if (phoff < EHDR_SIZE || phoff + phnum * phentsize > buffer.length) {
    throw new Refusal('program header table runs outside the file');
  }
  return { type, entry: Number(buffer.readBigUInt64LE(E_ENTRY)), phoff, phentsize, phnum };
}

function loadSegments(buffer, header) {
  const loads = [];
  for (let index = 0; index < header.phnum; index += 1) {
    const at = header.phoff + index * header.phentsize;
    if (buffer.readUInt32LE(at) !== PT_LOAD) continue;
    loads.push({
      index,
      headerOffset: at,
      flags: buffer.readUInt32LE(at + 4),
      offset: Number(buffer.readBigUInt64LE(at + 8)),
      vaddr: Number(buffer.readBigUInt64LE(at + 16)),
      filesz: Number(buffer.readBigUInt64LE(at + P_FILESZ)),
      memsz: Number(buffer.readBigUInt64LE(at + P_MEMSZ)),
    });
  }
  return loads;
}

/* A loader is mapped at its link addresses, so a file offset inside PT_LOAD[0]
 * is also its runtime address. PT_LOAD[0] is asserted to be (p_offset 0,
 * p_vaddr 0), which makes this the identity this tool depends on. */
const runtimeAddress = (primary, fileOffset) => primary.vaddr + fileOffset - primary.offset;

const isZeroRegion = (buffer, start, end) => buffer.subarray(start, end).every((byte) => byte === 0);

/* The blob as written for a given cave address: the assembled stub with its
 * trailing placeholder branch rewritten into "b <original entry>". */
function stubFor(primary, cave, originalEntry) {
  if (STUB.readUInt32LE(STUB_BRANCH_OFFSET) !== STUB_BRANCH_PLACEHOLDER) {
    throw new Refusal(
      'stub source and injector disagree: no "b ." placeholder at stub offset 0x' +
        STUB_BRANCH_OFFSET.toString(16),
    );
  }
  const blob = Buffer.from(STUB);
  const branchAt = cave + STUB_BRANCH_OFFSET;
  const displacement = originalEntry - runtimeAddress(primary, branchAt);
  if (displacement % 4 !== 0 || displacement < -0x8000000 || displacement >= 0x8000000) {
    throw new Refusal('branch from the cave back to e_entry is out of range (' + displacement + ')');
  }
  blob.writeUInt32LE(
    (STUB_BRANCH_OPCODE | ((displacement >> 2) & 0x03ffffff)) >>> 0,
    STUB_BRANCH_OFFSET,
  );
  return blob;
}

/* Decode the "b" at an absolute file offset (inside the mapped image) back to
 * the address it targets, which is how an injected loader is recognised. */
function branchTarget(primary, buffer, at) {
  const word = buffer.readUInt32LE(at);
  if ((word & 0xfc000000) !== STUB_BRANCH_OPCODE) {
    throw new Refusal('stub branch at 0x' + at.toString(16) + ' is not a "b" instruction');
  }
  const displacement = ((word & 0x03ffffff) << 6) >> 6; // sign-extend imm26
  return runtimeAddress(primary, at) + displacement * 4;
}

/* Decide the outcome for one loader without writing anything. */
function plan(buffer) {
  const header = parseHeader(buffer);
  if (header === null) return { kind: 'skip' };
  const loads = loadSegments(buffer, header);
  if (loads.length < 2) {
    throw new Refusal(
      'loader has ' + loads.length + ' PT_LOAD segment(s); the cave is the gap before a second one',
    );
  }
  const primary = loads[0];
  if (primary.offset !== 0 || primary.vaddr !== 0) {
    throw new Refusal(
      'PT_LOAD[0] is at (p_offset 0x' + primary.offset.toString(16) + ', p_vaddr 0x' +
        primary.vaddr.toString(16) + '), expected (0, 0)',
    );
  }
  if ((primary.flags & (PF_R | PF_X)) !== (PF_R | PF_X) || (primary.flags & PF_W) !== 0) {
    throw new Refusal('PT_LOAD[0] flags ' + primary.flags + ' are not R|X');
  }
  if (primary.filesz !== primary.memsz) {
    throw new Refusal(
      'PT_LOAD[0] p_filesz 0x' + primary.filesz.toString(16) + ' != p_memsz 0x' +
        primary.memsz.toString(16) + '; the cave is only covered by extending both',
    );
  }
  /* "the first following PT_LOAD start": the closest segment start after the
   * read-only one, which bounds the zero padding the stub is copied into. */
  const nextStart = loads.slice(1).reduce((lowest, load) => Math.min(lowest, load.offset), Infinity);
  const known = KNOWN_ENTRIES.find((candidate) => candidate.entry === header.entry);
  if (known === undefined) return alreadyInjected(buffer, header, primary, nextStart);
  return { kind: 'inject', header, primary, nextStart, known };
}

function alreadyInjected(buffer, header, primary, nextStart) {
  const cave = header.entry;
  const unknown = new Refusal(
    'e_entry 0x' + cave.toString(16) + ' is not a known loader entry and does not start the stub; ' +
      'known entries: ' + KNOWN_ENTRIES.map((candidate) => '0x' + candidate.entry.toString(16)).join(', '),
  );
  if (cave % 8 !== 0 || cave < 8 || cave + STUB.length > buffer.length) throw unknown;
  if (buffer.compare(STUB_MAGIC, 0, STUB_MAGIC.length, cave, cave + STUB_MAGIC.length) !== 0) {
    throw unknown;
  }
  const end = cave + STUB.length;
  if (primary.filesz !== end || primary.memsz !== end) {
    throw new Refusal(
      'entry stub is present at 0x' + cave.toString(16) + ' but PT_LOAD[0] covers 0x' +
        primary.filesz.toString(16) + '/0x' + primary.memsz.toString(16) + ' bytes instead of 0x' +
        end.toString(16),
    );
  }
  if (end > nextStart) {
    throw new Refusal(
      'entry stub at 0x' + cave.toString(16) + ' overlaps the next PT_LOAD at 0x' + nextStart.toString(16),
    );
  }
  const originalEntry = branchTarget(primary, buffer, cave + STUB_BRANCH_OFFSET);
  if (!KNOWN_ENTRIES.some((candidate) => candidate.entry === originalEntry)) {
    throw new Refusal(
      'entry stub at 0x' + cave.toString(16) + ' branches to 0x' + originalEntry.toString(16) +
        ', which is not a known loader entry',
    );
  }
  const expected = stubFor(primary, cave, originalEntry);
  if (buffer.compare(expected, 0, expected.length, cave, end) !== 0) {
    throw new Refusal('entry stub at 0x' + cave.toString(16) + ' does not match this tool\'s blob');
  }
  if (!isZeroRegion(buffer, end, nextStart)) {
    throw new Refusal('padding after the entry stub at 0x' + end.toString(16) + ' is not zero');
  }
  return { kind: 'already', header, primary, cave, originalEntry };
}

function inject(buffer, decision) {
  const { header, primary, nextStart } = decision;
  const originalEntry = header.entry;
  const cave = primary.filesz;
  if (cave % 8 !== 0) {
    throw new Refusal(
      'cave would start at file offset 0x' + cave.toString(16) + ', which is not 8-byte aligned',
    );
  }
  const gap = nextStart - cave;
  const needed = STUB.length + CAVE_HEADROOM;
  if (gap < needed) {
    throw new Refusal(
      'only ' + gap + ' bytes between PT_LOAD[0] (ends at 0x' + cave.toString(16) +
        ') and the next PT_LOAD (0x' + nextStart.toString(16) + '); the stub needs ' + needed,
    );
  }
  if (!isZeroRegion(buffer, cave, nextStart)) {
    throw new Refusal(
      'bytes between PT_LOAD[0] and the next PT_LOAD (0x' + cave.toString(16) + '..0x' +
        nextStart.toString(16) + ') are not all zero; refusing to overwrite file data',
    );
  }
  const blob = stubFor(primary, cave, originalEntry);
  const out = Buffer.from(buffer);
  blob.copy(out, cave);
  out.writeBigUInt64LE(BigInt(runtimeAddress(primary, cave)), E_ENTRY);
  const end = BigInt(cave + STUB.length);
  out.writeBigUInt64LE(end, primary.headerOffset + P_FILESZ);
  out.writeBigUInt64LE(end, primary.headerOffset + P_MEMSZ);
  return { buffer: out, cave, originalEntry };
}

function parseArguments(argv) {
  const flags = new Set();
  const files = [];
  for (const argument of argv) {
    if (argument === '--check' || argument === '--verify') flags.add('--check');
    else if (argument === '--json') flags.add(argument);
    else if (argument.startsWith('-')) throw new Refusal('unknown option ' + argument);
    else files.push(argument);
  }
  if (files.length !== 1) throw new Refusal('expected exactly one loader file');
  return { file: files[0], check: flags.has('--check'), json: flags.has('--json') };
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error('usage: inject-sigsys-stub.mjs <loader.so> [--check] [--json]');
    console.error('inject-sigsys-stub.mjs: ' + error.message);
    return 2;
  }
  const { file, check, json } = options;
  const report = (status, fields, exitCode, human) => {
    if (json) console.log(JSON.stringify({ status, file, ...fields }));
    else if (human !== undefined) console.log(file + ': ' + human);
    return exitCode;
  };
  let original;
  try {
    original = await readFile(file);
  } catch (error) {
    if (json) console.log(JSON.stringify({ status: 'unsupported', file, reason: 'cannot read: ' + error.message }));
    console.error(file + ': cannot read: ' + error.message);
    return 2;
  }
  const digest = sha256(original);
  try {
    const decision = plan(original);
    if (decision.kind === 'skip') {
      return report(
        'skipped',
        { entry: null, cave: null, originalEntry: null, stubBytes: 0, loaderSha256: digest },
        0,
        'skipped (not AArch64)',
      );
    }
    if (decision.kind === 'already') {
      return report(
        'already',
        {
          entry: decision.cave,
          cave: decision.cave,
          originalEntry: decision.originalEntry,
          stubBytes: STUB.length,
          loaderSha256: digest,
        },
        0,
        'already carries the SIGSYS entry stub at 0x' + decision.cave.toString(16) + ' (' +
          STUB.length + ' bytes)',
      );
    }
    if (check) {
      throw new Refusal(
        'the SIGSYS entry stub is not injected (e_entry 0x' + decision.header.entry.toString(16) +
          ' is ' + decision.known.source + '); run without --check to inject it',
      );
    }
    const result = inject(original, decision);
    await writeFile(file, result.buffer);
    return report(
      'injected',
      {
        entry: result.cave,
        cave: result.cave,
        originalEntry: result.originalEntry,
        stubBytes: STUB.length,
        loaderSha256: sha256(result.buffer),
      },
      0,
      'injected SIGSYS entry stub at 0x' + result.cave.toString(16) + ' (' + STUB.length +
        ' bytes), e_entry 0x' + result.originalEntry.toString(16) + ' -> 0x' +
        result.cave.toString(16) + ', PT_LOAD[0] filesz/memsz 0x' +
        (result.cave + STUB.length).toString(16),
    );
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (json) console.log(JSON.stringify({ status: 'unsupported', file, reason: error.message }));
    console.error(file + ': ' + error.message);
    return 2;
  }
}

const invokedDirectly = typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { KNOWN_ENTRIES, STUB, STUB_BRANCH_OFFSET, STUB_HANDLER_OFFSET, STUB_HEX, main };