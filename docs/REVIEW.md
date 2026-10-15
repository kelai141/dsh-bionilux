# Runtime review and regression evidence — 2026-10-15

## Scope and provenance

Reviewed the complete tracked source, build/install scripts, tests, documentation,
and the changes in PR #1. That PR merged as `697ead1` on
2026-10-15 at 14:16:57 UTC, so this work is a follow-up rather than an update to
an open PR. The original local checkout was `26b5a0b`; it was clean before work.
The pre-PR implementation is also used to check that compatibility fixes do not
silently remove the established Box64 execution route.

The review separates source-confirmed defects, host/emulation observations, and
Android-only validation. Historical device results in PR #1 are not new results
from this review. No Android device was available. A review is not a proof of
complete libc compatibility or exhaustive security coverage; no earlier formal
coverage ledger was supplied.

## Confirmed fixes

| Area | Source defect and correction | Regression evidence |
| --- | --- | --- |
| Exec chain | A resolved PATH target pointed into a returned stack frame; reroute now owns strings, preserves argv0 and delimits launcher options. | Native exec/spawn probes, custom argv0 and hyphen-prefixed CLI unit tests. |
| Exec semantics | Empty/relative PATH entries, execve versus execvp lookup, execvpe caller PATH, text-script fallback, missing shebang interpreters and posix_spawn error-number contracts were inconsistent. | Direct API tests, including ENOENT/EACCES/ENOEXEC/ELOOP, unchanged spawn PIDs, executable text without a shebang and PATH continuation past missing/denied interpreters. |
| Environment | Recursive launches reset activated environments; minimal envp and `env -i` lost the rootfs. | Rust environment regressions and real child execution with no accidental HOME inheritance. |
| LD_PRELOAD | Guest libraries must not be loaded into the Bionic launcher, but must survive into the next glibc guest. | Private transport state is consumed before guest execution; native end-to-end preload marker check. |
| Shell processes | Fixed-size unsynchronized popen bookkeeping lost children; a closing writer could leak into a concurrent child; fork-child allocation, EINTR and signal/cancellation handling were unsafe. | 40 simultaneous streams, blocked write-close/concurrent-spawn EOF regression, threaded churn, raw exit statuses, interrupted pclose, cancelled system and signal restoration. |
| DNS | Query trailer capacity, legacy IPv6 function-pointer ABIs, config refresh, search continuation and unbounded TCP stages were incorrect. | Buffer canaries, IPv6 hosts queries, isolated loopback DNS replies, fragmented TCP prefixes and a stalled-peer deadline. |
| Memory/API bounds | Group member pointers were misaligned and insufficiently sized; fortified wrappers ignored object bounds. | Small/misaligned buffers, real member lists, expected checked-call aborts, UBSan and AArch64 emulation. |
| Filesystem | Logical readlink truncation, trailing directory syntax and dirfd-aware link-copy fallback were inconsistent. | Short readlink buffers, ENOTDIR, directory-FD copies, symlink handling, mode preservation and EEXIST. |
| Temporary files | Custom random-name generation and negative suffix arithmetic replaced libc semantics. | Mapped libc temporary creation retains suffixes, flags and secure name generation. |
| Launcher | Invalid/relative configuration, working-directory selection, script permission checks, env shebangs and no-preload planning had gaps. | Rust regression tests, including quoted env split strings and exposed workspace paths. |
| Toolchain | Existing smoke assertions could hide child failures and did not exercise Make. | Real Make direct recipes, shell expansion, recursive make, pipe jobserver FDs, cc/cc1/as/collect2/ld and the compiled program. |
| Preparation/install | Dry-run/verify mutated the tree; relative links, relocation, root rejection and CLI/install path handling were inconsistent. | Synthetic preparation, relocation, verification, installer and harness checks. |
| Delivery | Releases did not depend on test jobs; diagnostic and acceptance assertions could falsely pass. | Mandatory runtime/support CI jobs and release gates; APT/audit statuses are checked. |

## Verification and reproduction

The final local pass succeeds: **63 Rust tests**, fmt, strict clippy, native path
and support suites, native/real-launcher runtime and Make suites, non-recovering
UBSan, AArch64 glibc cross-build/QEMU, strict GCC static analysis (`-fanalyzer`)
and shell syntax checks. No tests are removed or weakened to obtain this result.
ShellCheck is not installed locally and is not counted as a passing local check.

Local target-controlled execution runs inside a disposable WSL Linux sandbox:
network namespace with loopback only; private mount/PID namespaces; unprivileged
UID 65534 with no capabilities; read-only toolchain; no host home, credentials,
Git metadata or sockets; allowlisted environment; scratch-local HOME/temp/cache;
2 GiB scratch tmpfs, 3 GiB virtual-address limit, two CPUs, process/FD/file-size
limits, and a 900-second outer wall-clock timeout. Only cached dependencies are
used, with Cargo offline. Source changes are not executed directly on Windows.

On a disposable glibc Linux host with the existing compiler/Rust tools:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
cc -O0 -Wall -Wextra -Werror -fanalyzer -c src/preload/hooks.c -o /tmp/hooks-analyzed.o
bash tests/preload_paths.sh
bash tests/prepare_rootfs.sh
bash tests/runtime.sh
bash tests/ubsan.sh
bash tests/make.sh
BIONILUX_TEST_LAUNCHER="$PWD/target/debug/bionilux" bash tests/runtime.sh
BIONILUX_TEST_LAUNCHER="$PWD/target/debug/bionilux" bash tests/make.sh
bash tests/aarch64.sh
```

The AArch64 script requires the GNU cross compiler, its glibc sysroot and
`qemu-aarch64`; it invokes QEMU explicitly. It is not a substitute for an Android
kernel, Bionic, SELinux, storage policy or an actual Box64 run. The PTY checks
exercise native Bash cwd, Ctrl-C, Ctrl-Z, fg and clean exit. The synthetic native
rootfs deliberately links to host glibc/toolchain files, not a downloaded Debian
image. That fixture validates mapping/execution, not Debian package installation.

UBSan uses non-recovering checks. ASan/TSan are not claimed: their large shadow
address spaces conflict with this sandbox's address-space limit. Android NDK
compilation is separately covered by the existing CI job, not by QEMU.

## Independent review close-out

An independent final-diff review found a concurrent write-pclose descriptor leak
and missing synchronous shebang-interpreter errors. The targeted follow-up also
identified PATH search stopping prematurely after a missing/denied interpreter.
New deterministic regressions failed before each correction, then passed after
fixing descriptor bookkeeping, interpreter preflight and per-candidate PATH
continuation. Explicit-path errors and final EACCES precedence remain covered.
The independent reviewer closed the remaining PATH finding by source review;
no significant issue remained in that focused correction or its regressions.

## Security boundary

This is a same-UID compatibility runtime, **not a security sandbox**. Fake root
and path hooks do not grant privilege or isolate hostile guest code. The source
memory-safety defects above are corrected without claiming a demonstrated
privilege escalation or remote exploit.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| — | — | — | — | No demonstrated trust-boundary exploit established by this review. | — |

## Remaining limitations and unvalidated behavior

- Static programs, direct syscalls, hidden libc calls and certain loader-internal
  operations cannot be made chroot-equivalent by PLT interposition.
- Lexical dot-segment handling is not a complete symlink-aware VFS. Descriptor
  execution of deleted files/memfds and rename races are not fully virtualized.
- A relative spawn target combined with later chdir file actions needs further
  conformance coverage; opaque libc action objects limit parent-side resolution.
- Fake ownership is not persistent per-file UID/GID metadata. Copy fallback is
  not a true hard link: inode identity, shared writes, ACLs and xattrs differ.
- The custom resolver is not all of glibc NSS: IPv6 nameserver transport, full
  NSS modules, every resolver option and exact address ordering remain gaps.
  Hosts/passwd/group readers also have bounded record/database sizes.
- Real Box64 execution, its loader/library wrapping and cross-architecture
  performance require an ARM64 environment. Architecture planning tests alone
  cannot establish that behavior.
- External Box64 and Ubuntu daily build inputs remain moving upstream inputs;
  HTTPS improves transport but does not establish fully reproducible artifacts.
- Device acceptance/smoke tests require their documented Android prerequisites;
  their absence is not converted into a successful local test result.

## ARM64 Android device checklist

1. Install inside the application's executable private files directory; prepare
   and verify the actual final RootFS, including absolute/relative symlinks.
2. Check Bionic launcher to glibc guest transitions with sanitized host preloads,
   additional guest preloads, custom envp, env -i, activated PATH and custom cwd.
3. Run GNU Make direct/shell/recursive recipes and `-j8 --jobserver-style=pipe`,
   a real C/C++ toolchain and representative kernel/dependency build workloads.
4. Run Bash/readline under a real PTY: Ctrl-C, Ctrl-Z, fg/bg, window resize and
   terminal restoration; repeat threaded subprocess/popen workloads and inspect
   zombie, FD and memory growth.
5. Exercise apt install/update, maintainer scripts, git HTTPS, Python virtualenvs
   and Agent CLI workloads without disabling certificate verification; require
   successful empty `dpkg --audit` output.
6. Exercise actual Android DNS, IPv4/IPv6 networks, VPN/Private DNS, restricted
   netlink/getifaddrs, storage/FUSE permissions, SELinux and 16 KiB-page devices.
7. Separately validate the restored native-loader/Box64 path with matching host
   and x86 libraries; do not infer cross-architecture success from native tests.
