"""Synthetic ELF layout tests; no compiler, guest, or device is required."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("elf_check", ROOT / "scripts/check_elf_alignment.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def elf(bits=64, endian="<", machine=62, kind=3, segments=None):
    segments = segments if segments is not None else [(0, 0, 256, 256, 16384)]
    ehsize, phsize = (64, 56) if bits == 64 else (52, 32)
    ident = b"\x7fELF" + bytes([2 if bits == 64 else 1, 1 if endian == "<" else 2, 1]) + bytes(9)
    fields = (kind, machine, 1, 0, ehsize, 0, 0, ehsize, phsize, len(segments), 0, 0, 0)
    header = ident + struct.pack(endian + ("HHIQQQIHHHHHH" if bits == 64 else "HHIIIIIHHHHHH"), *fields)
    phdrs = b""
    for offset, vaddr, filesz, memsz, align in segments:
        values = (1, 5, offset, vaddr, 0, filesz, memsz, align) if bits == 64 else (1, offset, vaddr, 0, filesz, memsz, 5, align)
        phdrs += struct.pack(endian + ("IIQQQQQQ" if bits == 64 else "IIIIIIII"), *values)
    length = max([len(header + phdrs)] + [offset + filesz for offset, _, filesz, _, _ in segments])
    return (header + phdrs).ljust(length, b"\0")


def inspect(data, policy="android", machine=None):
    return checker.inspect_elf(io.BytesIO(data), len(data), "fixture", policy, 16384, machine)


class LayoutTests(unittest.TestCase):
    def test_both_classes_endianness_and_runtime_types(self):
        for bits in (32, 64):
            for endian in ("<", ">"):
                for kind in (2, 3):
                    with self.subTest(bits=bits, endian=endian, kind=kind):
                        self.assertEqual(inspect(elf(bits=bits, endian=endian, kind=kind))["errors"], [])

    def test_16k_and_64k_declared_alignment(self):
        for align in (16384, 65536):
            self.assertEqual(inspect(elf(segments=[(0, 0, 256, 256, align)]))["errors"], [])

    def test_android_rejects_4k_align_even_if_congruent(self):
        data = elf(segments=[(0, 0, 256, 256, 4096)])
        self.assertTrue(any("p_align" in error for error in inspect(data)["errors"]))
        self.assertEqual(inspect(data, "guest")["errors"], [])

    def test_guest_accepts_no_declared_alignment_only_when_page_congruent(self):
        for align in (0, 1):
            data = elf(segments=[(0, 0, 256, 256, align)])
            self.assertEqual(inspect(data, "guest")["errors"], [])
            self.assertTrue(inspect(data, "android")["errors"])

    def test_glibc_rejects_actual_page_incongruence_not_only_low_align(self):
        data = elf(segments=[(0, 4096, 256, 256, 4096)])
        self.assertTrue(any("modulo 16384" in error for error in inspect(data, "guest")["errors"]))

    def test_x86_emulator_4k_policy_does_not_disable_arm64_16k_gate(self):
        data = elf(segments=[(0, 4096, 256, 256, 4096)])
        good = checker.inspect_elf(io.BytesIO(data), len(data), "x64-emulator", "guest", 4096, 62)
        bad = checker.inspect_elf(io.BytesIO(data), len(data), "arm64-device", "guest", 16384, 62)
        self.assertEqual(good["errors"], [])
        self.assertTrue(bad["errors"])

    def test_nonzero_congruent_offsets(self):
        data = elf(segments=[(4096, 20480, 64, 128, 16384)])
        self.assertEqual(inspect(data)["errors"], [])

    def test_every_load_segment_is_checked(self):
        data = elf(segments=[(0, 0, 256, 256, 16384), (4096, 8192, 64, 128, 4096)])
        result = inspect(data, "guest")
        self.assertEqual(len(result["loads"]), 2)
        self.assertTrue(any("PT_LOAD[1]" in error for error in result["errors"]))

    def test_malformed_declared_alignment(self):
        self.assertTrue(inspect(elf(segments=[(0, 0, 256, 256, 24576)]))["errors"])
        self.assertTrue(inspect(elf(segments=[(0, 4096, 256, 256, 16384)]))["errors"])

    def test_file_and_memory_extents(self):
        self.assertTrue(inspect(elf(segments=[(0, 0, 256, 128, 16384)]))["errors"])
        self.assertTrue(inspect(elf()[:-1])["errors"])
        self.assertTrue(inspect(elf(segments=[(0, (1 << 64) - 16384, 256, 32768, 16384)]))["errors"])

    def test_invalid_header_table_and_missing_loads(self):
        self.assertTrue(inspect(b"\x7fELF")["errors"])
        self.assertTrue(inspect(elf()[:80])["errors"])
        self.assertTrue(inspect(elf(segments=[]))["errors"])
        data = bytearray(elf())
        struct.pack_into("<H", data, 54, 65535)  # Invalid e_phentsize.
        self.assertTrue(inspect(data)["errors"])
        data = bytearray(elf())
        struct.pack_into("<I", data, 64, 4)  # PT_NOTE rather than PT_LOAD.
        self.assertTrue(inspect(data)["errors"])

    def test_invalid_identification_and_extended_phnum(self):
        for offset, value in ((4, 0), (5, 0), (6, 0)):
            data = bytearray(elf())
            data[offset] = value
            self.assertTrue(inspect(data)["errors"])
        data = bytearray(elf())
        struct.pack_into("<H", data, 56, 65535)
        self.assertTrue(inspect(data)["errors"])

    def test_expected_architecture(self):
        self.assertEqual(inspect(elf(machine=183), machine=183)["errors"], [])
        self.assertTrue(inspect(elf(machine=62), machine=183)["errors"])

    def test_data_and_relocatable_objects_are_not_runtime_elf(self):
        self.assertIsNone(inspect(b"not ELF"))
        self.assertIsNone(inspect(elf(kind=1)))


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, name, members):
        path = self.root / name
        with tarfile.open(path, "w:xz") as archive:
            for leaf, data in members:
                member = tarfile.TarInfo(leaf)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return path

    def test_archive_scans_extensionless_binaries_loader_and_native_modules(self):
        path = self.archive("payload.tar.xz", [("bin/node", elf()), ("lib/ld.so", elf()),
                                              ("lib/addon.node", elf()), ("README", b"data")])
        records = checker.scan_path(path, "guest", 16384, 62)
        self.assertEqual(len(records), 3)
        self.assertTrue(any("!bin/node" in record["path"] for record in records))
        self.assertFalse((self.root / "bin").exists())

    def test_recursive_directory_scan(self):
        (self.root / "usr/lib").mkdir(parents=True)
        (self.root / "usr/lib/libc.so.6").write_bytes(elf())
        self.assertEqual(len(checker.scan_path(self.root, "guest", 16384, 62)), 1)

    def test_unsafe_archive_paths_are_not_extracted_or_accepted(self):
        for leaf in ("/escape", "../escape"):
            with self.subTest(leaf=leaf), self.assertRaises(ValueError):
                checker.scan_path(self.archive("bad.tar.xz", [(leaf, elf())]), "guest", 16384, 62)

    def test_no_runtime_elf_and_missing_inputs_fail_closed(self):
        for path in (self.root / "absent", self.archive("empty.tar.xz", [("README", b"data")])):
            with self.subTest(path=path), self.assertRaises(ValueError):
                checker.scan_path(path, "guest", 16384, 62)

    def test_failure_still_writes_machine_readable_evidence(self):
        path = self.archive("rootfs.tar.xz", [("lib/libc.so.6", elf(segments=[(0, 4096, 256, 256, 4096)]))])
        report = self.root / "report.json"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = checker.main(["--policy", "guest", "--machine", "x86_64", "--report", str(report), str(path)])
        self.assertEqual(result, 1)
        data = json.loads(report.read_text())
        self.assertEqual(data["checked"], 1)
        self.assertEqual(data["failed"], 1)
        self.assertFalse(data["runtime_device_tested"])
        self.assertTrue(data["objects"][0]["loads"])


if __name__ == "__main__":
    unittest.main()
