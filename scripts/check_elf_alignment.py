"""Check runtime ELF layout prerequisites without executing or extracting payloads.

Android's Bionic loader policy requires PT_LOAD p_align >= the requested page
size. Linux/glibc objects are checked for page-offset congruence instead: a low
p_align alone does NOT prove that glibc cannot load an otherwise congruent ELF.
Neither policy proves runtime support (glibc build assumptions, overlapping page
permissions, APK ZIP alignment and real device execution remain separate gates).
Release policy scans ARM64 guest payloads for 16384-byte kernels, x86_64 emulator
payloads for 4096-byte kernels; both own launcher/preload build contracts use
16384-byte declared alignment. The x86_64 guest scan is not a 16KB support claim.
"""

import argparse
import json
from pathlib import Path, PurePosixPath
import struct
import sys
import tarfile

MACHINES = {"aarch64": 183, "x86_64": 62}


def inspect_elf(stream, size, name, policy="android", page_size=16384, machine=None):
    """Return a runtime ELF record, or None for data/ET_REL objects."""
    stream.seek(0)
    ident = stream.read(16)
    if ident[:4] != b"\x7fELF":
        return None
    errors = []
    record = {"path": name, "policy": policy, "loads": [], "errors": errors}
    try:
        if len(ident) != 16 or ident[4] not in (1, 2) or ident[5] not in (1, 2) or ident[6] != 1:
            raise ValueError("invalid ELF identification")
        bits = 64 if ident[4] == 2 else 32
        endian = "<" if ident[5] == 1 else ">"
        header_fmt = endian + ("HHIQQQIHHHHHH" if bits == 64 else "HHIIIIIHHHHHH")
        header_size = 16 + struct.calcsize(header_fmt)
        header_bytes = stream.read(header_size - 16)
        if len(header_bytes) != header_size - 16:
            raise ValueError("truncated ELF header")
        header = struct.unpack(header_fmt, header_bytes)
        kind, elf_machine, version = header[:3]
        if kind not in (2, 3):
            return None
        record.update(bits=bits, machine=elf_machine, elf_type=kind)
        phoff, ehsize, phentsize, phnum = header[4], header[7], header[8], header[9]
        expected_phsize = 56 if bits == 64 else 32
        if version != 1 or ehsize != header_size:
            raise ValueError("invalid ELF header version/size")
        if machine is not None and elf_machine != machine:
            errors.append(f"machine {elf_machine} does not match expected {machine}")
        if not phnum or phnum == 65535:
            raise ValueError("missing or unsupported extended program headers")
        if phentsize != expected_phsize or phoff < header_size or phoff + phnum * phentsize > size:
            raise ValueError("invalid/truncated program header table")
        for index in range(phnum):
            stream.seek(phoff + index * phentsize)
            raw = stream.read(phentsize)
            if len(raw) != phentsize:
                raise ValueError("truncated program header")
            values = struct.unpack(endian + ("IIQQQQQQ" if bits == 64 else "IIIIIIII"), raw)
            if values[0] != 1:
                continue
            if bits == 64:
                _, flags, offset, vaddr, _, filesz, memsz, align = values
            else:
                _, offset, vaddr, _, filesz, memsz, flags, align = values
            load = dict(index=index, offset=offset, vaddr=vaddr, filesz=filesz,
                        memsz=memsz, align=align, flags=flags)
            record["loads"].append(load)
            if filesz > memsz or offset + filesz > size or vaddr + memsz > 1 << bits:
                errors.append(f"PT_LOAD[{index}] invalid file/memory extent")
            if align > 1 and (align & (align - 1) or (vaddr - offset) % align):
                errors.append(f"PT_LOAD[{index}] invalid declared alignment/congruence")
            if (vaddr - offset) % page_size:
                errors.append(f"PT_LOAD[{index}] offset/vaddr not congruent modulo {page_size}")
            if policy == "android" and align < page_size:
                errors.append(f"PT_LOAD[{index}] p_align {align} < {page_size}")
        if not record["loads"]:
            errors.append("runtime ELF has no PT_LOAD segments")
    except (ValueError, struct.error, OSError) as error:
        errors.append(str(error))
    return record


def scan_path(path, policy, page_size, machine):
    """Scan regular files by magic, including extensionless binaries and .node."""
    records = []

    def inspect(stream, size, name):
        record = inspect_elf(stream, size, name, policy, page_size, machine)
        if record is not None:
            records.append(record)

    if not path.exists():
        raise ValueError(f"missing input: {path}")
    if path.is_dir():
        # Do not follow directory/file symlinks into the host. Archive symlink
        # targets are scanned at their regular payload entry, never extracted.
        import os
        for parent, dirs, files in os.walk(path, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not (Path(parent) / d).is_symlink())
            for leaf in sorted(files):
                item = Path(parent) / leaf
                if item.is_symlink() or not item.is_file():
                    continue
                with item.open("rb") as stream:
                    inspect(stream, item.stat().st_size, str(item))
    elif path.name.endswith((".tar", ".tar.xz", ".tar.gz", ".tgz")):
        with tarfile.open(path, "r:*") as archive:
            for member in archive:
                pure = PurePosixPath(member.name)
                if pure.is_absolute() or ".." in pure.parts:
                    raise ValueError(f"unsafe archive member: {member.name}")
                if member.isfile():
                    with archive.extractfile(member) as stream:
                        inspect(stream, member.size, f"{path}!{member.name}")
    else:
        with path.open("rb") as stream:
            inspect(stream, path.stat().st_size, str(path))
    if not records:
        raise ValueError(f"no runtime ELF objects found in {path}")
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--policy", choices=("android", "guest"), required=True)
    parser.add_argument("--page-size", type=int, default=16384)
    parser.add_argument("--machine", choices=tuple(MACHINES))
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    if args.page_size < 4096 or args.page_size & (args.page_size - 1):
        parser.error("--page-size must be a power of two >= 4096")
    records, errors = [], []
    for path in args.paths:
        try:
            records.extend(scan_path(path, args.policy, args.page_size, MACHINES.get(args.machine)))
        except (OSError, ValueError, tarfile.TarError) as error:
            errors.append(str(error))
    failed = sum(bool(record["errors"]) for record in records)
    report = dict(page_size=args.page_size, policy=args.policy, runtime_device_tested=False,
                  checked=len(records), failed=failed, errors=errors, objects=records)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for record in records:
        for error in record["errors"]:
            print(f"{record['path']}: {error}", file=sys.stderr)
    for error in errors:
        print(error, file=sys.stderr)
    print(f"ELF {args.page_size}-byte {args.policy} layout prerequisites: "
          f"{len(records)} checked, {failed} failed; runtime/device execution NOT tested")
    return int(bool(failed or errors))


if __name__ == "__main__":
    sys.exit(main())
