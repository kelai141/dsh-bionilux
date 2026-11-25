from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]


class DebianAptCacheCleanupTests(unittest.TestCase):
    def test_debug_build_workflow_removes_and_rejects_apt_binary_caches(self):
        workflow = (REPO_ROOT / ".github" / "workflows" / "debug-build.yml").read_text(encoding="utf-8")
        self.assertIn('"$rootfs/var/cache/apt/pkgcache.bin"', workflow)
        self.assertIn('"$rootfs/var/cache/apt/srcpkgcache.bin"', workflow)
        self.assertIn("var/cache/apt/(pkgcache|srcpkgcache)\\.bin", workflow)
        self.assertIn("var/lib/dpkg/status", workflow)
        self.assertIn("etc/apt/sources\\.list", workflow)


if __name__ == "__main__":
    unittest.main()
