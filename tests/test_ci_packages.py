"""Signed APT fallback contract and fake-process tests, without network/root."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "scripts/ci-install-packages.sh").read_text(encoding="utf-8")


class SourceContractTests(unittest.TestCase):
    def test_strict_bounded_authenticated_apt(self):
        for text in ("set -euo pipefail", "180s apt-get", "600s apt-get", "--kill-after=15s",
                     "Acquire::Retries=2", "APT::Update::Error-Mode=any", "Acquire::ForceIPv4=true",
                     "Acquire::AllowInsecureRepositories=false", "APT::Get::AllowUnauthenticated=false"):
            self.assertIn(text, SCRIPT)
        for text in ("--allow-unauthenticated", "trusted=yes", "Verify-Peer=false", "rm -rf", "/etc/resolv.conf"):
            self.assertNotIn(text, SCRIPT)

    def test_mirror_is_exact_signed_ubuntu_amd64_source(self):
        for text in ("https://mirrors.edge.kernel.org/ubuntu", "noble noble-updates noble-backports noble-security",
                     "main universe restricted multiverse", "Architectures: amd64",
                     "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", '!= ubuntu', '!= 24.04', '!= amd64'):
            self.assertIn(text, SCRIPT)

    def test_sources_and_lists_are_per_command_not_global(self):
        self.assertIn('Dir::Etc::sourcelist=$work/fallback.sources', SCRIPT)
        self.assertIn('Dir::Etc::sourceparts=-', SCRIPT)
        self.assertIn('Dir::State::lists=$work/lists', SCRIPT)
        self.assertIn('"$PWD/target/independent-linux/ci-apt/run.XXXXXX"', SCRIPT)
        self.assertNotIn('/etc/apt/sources', SCRIPT)
        self.assertIn('NO_PUBKEY|BADSIG|EXPKEYSIG', SCRIPT)
        self.assertIn('Temporary failure resolving', SCRIPT)

    def test_workflows_use_shared_script_and_keep_required_cross(self):
        for name in ("ci.yml", "debug-build.yml"):
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn('bash scripts/ci-install-packages.sh gcc-aarch64-linux-gnu qemu-user', text)
            self.assertIn('bash tests/aarch64.sh', text)
            self.assertIn('python3 tests/test_ci_packages.py -v', text)
        text = (ROOT / ".github/workflows/debug-build.yml").read_text(encoding="utf-8")
        self.assertIn('bash scripts/ci-install-packages.sh $packages', text)
        self.assertLess(text.index('Native and host regressions'), text.index('Install AArch64 glibc test tools'))


@unittest.skipIf(os.name == "nt" or not shutil.which("bash"), "fake Bash processes run in Linux CI")
class FakeProcessTests(unittest.TestCase):
    def run_case(self, failure="", platform="ubuntu", architecture="amd64", fallback_failure=False, install_failure=False, normal_status=100, dns_failure=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / "bin"
            bindir.mkdir()
            release = root / "os-release"
            release.write_text(f'ID={platform}\nVERSION_ID=24.04\n')
            keyring = root / "archive-keyring.gpg"
            keyring.write_text("fixture")
            # Replace only host identity/keyring fixture paths, not script logic.
            script = SCRIPT.replace('. /etc/os-release', '. "' + str(release) + '"').replace(
                'keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg', 'keyring="' + str(keyring) + '"')
            local = root / "install.sh"
            local.write_text(script)
            stub = r'''#!PYTHON
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "sudo": os.execvp(args[0], args)
if name == "timeout": os.execvp(args[3], args[3:])
if name == "dpkg": print(os.environ["TEST_ARCH"]); sys.exit(0)
if name == "getent": sys.exit(int(os.environ["TEST_DNS_FAILURE"]))
with open(os.environ["TEST_LOG"], "a") as stream: stream.write(json.dumps(args) + "\n")
fallback = any("Dir::Etc::sourcelist=" in arg for arg in args)
if "update" in args:
    if fallback and os.environ["TEST_FALLBACK_FAILURE"] == "1": print("NO_PUBKEY badkey"); sys.exit(100)
    if not fallback and os.environ["TEST_FAILURE"]: print(os.environ["TEST_FAILURE"]); sys.exit(int(os.environ["TEST_NORMAL_STATUS"]))
if "install" in args and os.environ["TEST_INSTALL_FAILURE"] == "1": sys.exit(100)
sys.exit(0)
'''.replace("PYTHON", sys.executable)
            for name in ("sudo", "timeout", "apt-get", "dpkg", "getent"):
                path = bindir / name
                path.write_text(stub)
                path.chmod(0o755)
            log = root / "commands.jsonl"
            result = subprocess.run(["bash", str(local), "gcc-aarch64-linux-gnu", "qemu-user"], cwd=root,
                env={**os.environ, "PATH": str(bindir) + os.pathsep + os.environ["PATH"], "TEST_ARCH": architecture,
                     "TEST_LOG": str(log), "TEST_FAILURE": failure, "TEST_FALLBACK_FAILURE": str(int(fallback_failure)),
                     "TEST_INSTALL_FAILURE": str(int(install_failure)), "TEST_NORMAL_STATUS": str(normal_status),
                     "TEST_DNS_FAILURE": str(int(dns_failure))}, capture_output=True, text=True, timeout=15)
            commands = [json.loads(line) for line in log.read_text().splitlines()]
            sources = list(root.glob("target/independent-linux/ci-apt/run.*/fallback.sources"))
            return result.returncode, commands, [path.read_text() for path in sources]

    def test_normal_success_never_uses_fallback(self):
        rc, commands, sources = self.run_case()
        self.assertEqual(rc, 0)
        self.assertEqual(len(commands), 2)
        self.assertEqual(sources, [])

    def test_dns_failure_retries_signed_override_for_update_and_install(self):
        rc, commands, sources = self.run_case("Temporary failure resolving archive.ubuntu.com")
        self.assertEqual(rc, 0)
        self.assertEqual(len(commands), 3)
        self.assertTrue(all(any("Dir::Etc::sourcelist=" in arg for arg in cmd) for cmd in commands[1:]))
        self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", sources[0])

    def test_integrity_failure_does_not_fallback_even_with_network_error(self):
        for error in ("NO_PUBKEY", "BADSIG", "Hash Sum mismatch", "Certificate verification failed"):
            rc, commands, sources = self.run_case(error + " Temporary failure resolving host")
            self.assertEqual(rc, 100)
            self.assertEqual(len(commands), 1)
            self.assertEqual(sources, [])

    def test_unknown_failure_and_other_platforms_fail_closed(self):
        for failure, platform, arch in (("unknown failure", "ubuntu", "amd64"),
                ("Could not resolve host", "debian", "amd64"), ("Could not resolve host", "ubuntu", "arm64")):
            rc, commands, sources = self.run_case(failure, platform, arch)
            self.assertEqual(rc, 100)
            self.assertEqual(len(commands), 1)
            self.assertEqual(sources, [])

    def test_timeout_requires_positive_network_evidence(self):
        rc, commands, sources = self.run_case("Ign: mirror", normal_status=124)
        self.assertEqual(rc, 124)
        self.assertEqual(len(commands), 1)
        self.assertEqual(sources, [])
        self.assertEqual(self.run_case("Ign: mirror", normal_status=124, dns_failure=True)[0], 0)
        self.assertEqual(self.run_case("Could not resolve host", normal_status=124)[0], 0)
        self.assertEqual(self.run_case("BADSIG", normal_status=124, dns_failure=True)[0], 124)

    def test_fallback_or_install_failure_stays_failure(self):
        self.assertEqual(self.run_case("Could not resolve host", fallback_failure=True)[0], 100)
        self.assertEqual(self.run_case(install_failure=True)[0], 100)


if __name__ == "__main__":
    unittest.main()
