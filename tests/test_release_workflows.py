"""Release contract tests using actual tar.xz payloads and rejected inputs."""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("metadata", ROOT / "scripts/release_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)
SHA = "a" * 40


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for package in ("linux-runtime", "linux-bootstrap"):
            path = self.root / "packages" / package
            path.mkdir(parents=True)
            (path / "package.json").write_text('{"version":"0.5.0"}')

    @patch.object(metadata.subprocess, "check_output", return_value=SHA + "\n")
    def test_debug_identity_and_release_identity(self, _git):
        debug = metadata.identity(self.root, "", "123", "2")
        self.assertEqual(debug["tag"], "v0.5.0-debug.123.2")
        self.assertEqual(debug["package_version"], "0.5.0")
        release = metadata.identity(self.root, "v0.5.0", "123", "2")
        self.assertEqual(release["source_sha"], SHA)
        self.assertEqual(release["mode"], "release")

    def test_reject_wrong_version_and_shell_syntax(self):
        for tag in ("v9.0.0", "v0.5.0;echo bad", "v0.5.0\nother=value", "main", "../v0.5.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                metadata.identity(self.root, tag, "123", "2")

    def test_reject_disagreeing_packages(self):
        (self.root / "packages/linux-runtime/package.json").write_text('{"version":"0.6.0"}')
        with self.assertRaises(ValueError):
            metadata.identity(self.root, "v0.5.0", "123", "2")

    def test_notes_content_preserves_literal_shell_and_unicode(self):
        content = '# 更新\n$(touch BAD) `echo BAD` "quotes"\n'
        self.assertEqual(metadata.release_notes(self.root, content, "absent.md"), content)
        self.assertFalse((self.root / "BAD").exists())

    def test_notes_file_and_bom(self):
        (self.root / "notes.md").write_text("\ufeff# 更新\n", encoding="utf-8")
        self.assertEqual(metadata.release_notes(self.root, "", "notes.md"), "# 更新\n")

    def test_reject_empty_and_escaped_notes(self):
        for text, filename in ((" \n", "notes.md"), ("", "../outside.md"), ("", str(self.root / "notes.md"))):
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                metadata.release_notes(self.root, text, filename)

    @unittest.skipIf(os.name == "nt", "symlink creation needs Windows privileges")
    def test_reject_notes_symlink_outside_checkout(self):
        with tempfile.TemporaryDirectory() as outside:
            source = Path(outside) / "notes.md"
            source.write_text("not from this checkout")
            (self.root / "notes.md").symlink_to(source)
            with self.assertRaises(ValueError):
                metadata.release_notes(self.root, "", "notes.md")

    def test_release_cli_rejects_empty_tag(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/release_metadata.py"), "identity", "--release",
                                 "--root", str(self.root), "--output", str(self.root / "out.json")],
                                env={**os.environ, "BUILD_TAG": ""}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires an explicit tag", result.stderr)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archives = ["linux-bootstrap-plugin.tar.xz", "linux-runtime-plugin.tar.xz"]
        for arch, node in (("aarch64", "arm64"), ("x86_64", "x64")):
            self.archives.extend((f"bionilux-backend-{arch}.tar.xz", f"debian-minimal-{arch}.tar.xz",
                                  f"node-glibc-v24.22.0-linux-{node}.tar.xz"))
            (self.root / f"bionilux-{arch}").write_bytes(b"launcher fixture")
            (self.root / f"libbionilux_preload-{arch}.so").write_bytes(b"preload fixture")
        for name in self.archives:
            self.archive(name)
        (self.root / "BUILD_INFO.json").write_text(json.dumps({"tag": "v0.5.0", "version": "0.5.0", "source_sha": SHA}))

    def archive(self, name, member="bin/program"):
        with tarfile.open(self.root / name, "w:xz") as archive:
            info = tarfile.TarInfo(member)
            data = b"real archive payload for manifest tests\n"
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    def run_manifest(self, sha=SHA):
        return subprocess.run([sys.executable, str(ROOT / "scripts/build_release_manifest.py"), str(self.root),
                               "owner/repo", "v0.5.0", "0.5.0", "0.14.0", "24.22.0"],
                              env={**os.environ, "SOURCE_SHA": sha}, capture_output=True, text=True)

    def test_dual_arch_manifest_and_checksums(self):
        result = self.run_manifest()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / "linux-release.json").read_text())
        self.assertEqual([r["architecture"] for r in manifest["runtimes"]], ["arm64", "x64"])
        self.assertEqual(len((self.root / "SHA256SUMS").read_text().splitlines()), 14)

    def test_missing_architecture_fails(self):
        (self.root / "debian-minimal-aarch64.tar.xz").unlink()
        self.assertNotEqual(self.run_manifest().returncode, 0)

    def test_unsafe_archive_fails(self):
        self.archive(self.archives[0], "../outside")
        self.assertNotEqual(self.run_manifest().returncode, 0)

    def test_lfs_pointer_fails(self):
        (self.root / "bionilux-x86_64").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
        self.assertNotEqual(self.run_manifest().returncode, 0)

    def test_unexpected_asset_fails(self):
        (self.root / "unreviewed.txt").write_text("extra")
        self.assertNotEqual(self.run_manifest().returncode, 0)

    def test_wrong_source_fails_without_checksums(self):
        self.assertNotEqual(self.run_manifest("b" * 40).returncode, 0)
        self.assertFalse((self.root / "SHA256SUMS").exists())


if __name__ == "__main__":
    unittest.main()
