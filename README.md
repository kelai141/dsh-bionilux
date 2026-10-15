# bionilux — the DSH Mobile Linux runtime

**This is DSH Mobile's Linux runtime.** It hosts a full Debian user space inside
an Android app process: real `apt`/`dpkg`, working DNS and TLS, native-speed
glibc execution, and no PRoot. It is a *component* of DSH Mobile, driven by a
Cordis plugin — not a standalone Termux utility.

This repository is a fork of [`theonuverse/bionilux`](https://github.com/theonuverse/bionilux).
Upstream solves "run one glibc binary on Termux". This fork solves "be the Linux
runtime of an Android app": the guest is a `rootfs` with its own path semantics,
the launcher takes no hardcoded host path, and the Android directories the app
must reach are configuration, not constants.

> **Definition.** bionilux runs the *guest's* user space, not the host's. A path
> the guest names is resolved inside its rootfs or not at all; the host file
> system of the same name is never a fallback.

Verified on a real arm64 device (vivo V2425A, Android 16 / SDK 36, SELinux
enforcing, no root) and on an x86_64 emulator.

## What this fork adds over upstream

| Area | Change |
|------|--------|
| Path semantics | A rootfs is the guest's `/`. Guest paths never fall through to the host, `..` is clamped at the guest root, and `getcwd()`/`readlink()` report guest paths. |
| No hardcoded paths | Every Termux path is derived from the install prefix. The same build runs from Termux's `$PREFIX` or from an app's private `files/` directory. |
| Android directories | `/sdcard`, `/storage/emulated/0` and the host app's private data directory are reachable through their own names, configured by `--host-path` / `BIONILUX_HOST_PATHS`. |
| DNS | Resolved from the *guest's* `/etc/resolv.conf` and `/etc/hosts` by the preload. Without this, glibc reads the host's files, finds none, and every lookup fails with `EAI_AGAIN`. |
| Package management | `apt-get update` and `apt-get install` work, including the debconf frontends, `dpkg`'s postinst scripts and `ca-certificates`. |
| Identity | The guest is told it is root, consistently: `getuid()` and `stat()` agree, so `git`, `dpkg` and `tar` accept their own working trees. |
| Native paths | `--print-config`, `--rootfs`, `--guest-cwd`, `--host-path`, `--no-android-paths`. |

## Quick start

The runtime is installed under a prefix the app owns; `PREFIX/files/...` layout
is derived, not assumed.

```bash
# One-time rootfs preparation: absolute symlinks, resolver, directories.
scripts/prepare-rootfs.sh --rootfs /path/to/rootfs --dns <nameserver>

export BIONILUX_ROOTFS=/path/to/rootfs
bionilux /bin/bash -c 'cat /etc/os-release; apt-get update'

# Health check: the plugin registers the tool only when this says yes.
bionilux --print-config | grep -E 'ROOTFS_ENABLED|ROOTFS_LOADER'
```

Reaching the Android side of the device:

```bash
bionilux --rootfs "$R" --host-path /data/local/tmp /bin/sh -c 'ls /data/local/tmp'
bionilux --rootfs "$R" --no-android-paths /bin/sh -c 'ls /sdcard'   # refused
```

With the runtime installed inside an app's own `files/` directory, the guest
sees that private directory under its **own absolute Android path** — so the app
and the guest share one copy of the data:

```bash
# runtime at /data/data/<pkg>/files/bnrt, PREFIX=/data/data/<pkg>/files/usr
bionilux --rootfs "$R" --print-config | grep HOST_PATHS
#   HOST_PATHS=/data/data/<pkg>
bionilux --rootfs "$R" /bin/sh -c 'cat /data/data/<pkg>/files/app-state.json'
```

## Guest path semantics

* Only absolute paths are rewritten; a path already inside the rootfs is left
  alone, so nothing is prefixed twice.
* `/proc`, `/sys` and `/dev` stay with the host kernel. `/dev/shm` is the
  exception, because POSIX shared memory must land somewhere writable.
* Relative paths without `..` pass through: the physical working directory is
  already inside the rootfs. A relative path containing `..` is resolved against
  the *guest* working directory first, with `..` clamped at the guest root.
* A path that is missing from the rootfs is still rewritten, so the kernel
  reports `ENOENT` instead of quietly exposing the host's file of that name.

Configuration, in `--print-config` order:

| Option | Environment | Purpose |
|--------|-------------|---------|
| `--rootfs DIR` | `BIONILUX_ROOTFS` | The guest's `/` |
| `--guest-cwd DIR` | `BIONILUX_GUEST_CWD` | The guest's initial working directory |
| `--host-path DIR` | `BIONILUX_HOST_PATHS` | A host directory the guest reaches by its own path (repeatable) |
| `--no-android-paths` | `BIONILUX_ANDROID_PATHS=0` | Drop the `/sdcard` defaults |
| `--print-config` | — | Resolved configuration, for health checks |

## Verified on device

| Capability | Evidence |
|------------|----------|
| Debian rootfs runs | Debian 13 trixie, glibc 2.41, `HOST_ARCH=Aarch64` |
| DNS | `getent hosts deb.debian.org` -> `146.75.114.132` |
| HTTPS + trust store | `curl -sS -o /dev/null -w '%{http_code}' https://github.com` -> `200`, no `GIT_SSL_NO_VERIFY` |
| Package management | `apt-get update` fetched 9.7 MB; `build-essential`, `git`, `ca-certificates`, `strace` install |
| Toolchain | gcc 14.2.0, git 2.47.3, make 4.4.1 |
| Source control | `git clone`, `git status`, `git log` on a fresh clone |
| Traversal | `find` over the guest's `/etc`, `/usr`, `/var` and a cloned repo |
| Android public storage | guest writes `/sdcard/bn-visible.txt`, readable by the host |
| Android private data | guest reads and writes the app's own `files/` directory by its native path |

## Known limitations

Some are Android platform facts, some are inherent to doing this with
`LD_PRELOAD` rather than a kernel sandbox. They are documented rather than
papered over.

**Platform restrictions (not fixable in the runtime).**

* **Hard links are refused** device-wide — including inside the app's own
  private directory. `dpkg` needs `link()` for its backup step, so the preload
  falls back to copying.
* **`mkfifo()` fails with `EACCES`** for the shell UID (SELinux), so GNU make
  cannot create its default FIFO jobserver. It does not need to: `make -jN
  --jobserver-style=pipe` uses a pipe instead and works — verified with `-j8`
  in a kernel build.
* **`ldconfig` is statically linked**, so no preload can map it; it writes to
  Android's read-only `/etc`. `prepare-rootfs.sh` installs a shim.
* **Static binaries** are outside `LD_PRELOAD`'s reach entirely.

A fresh rootfs also needs `scripts/prepare-rootfs.sh` before anything else: it
rewrites the **absolute** symlinks a Debian rootfs contains, which the kernel
otherwise resolves against the *host* root — that is what makes `/usr/bin/awk`
and `/usr/bin/which` work at all.

**`LD_PRELOAD` reaches only public, PLT-crossing functions.** glibc's *internal*
calls never leave the library, so anything libc does for itself resolves against
the host. Each case is handled at the public API the program actually calls:

| Bypassed internally | Handled by |
|---------------------|-----------|
| `/etc/resolv.conf`, `/etc/hosts` | `getaddrinfo`, `gethostbyname*` resolve with the guest's files |
| `/etc/passwd`, `/etc/group` | `getpwnam*`, `getpwuid*`, `getgrnam*`, `getgrgid*` |
| `/bin/sh` for `system`/`popen` | `system`, `popen`, `pclose` |
| `mkstemp`'s own `open` | `mkstemp`/`mkostemp`/`mkstemps` and their `64` spellings |
| `dlopen` of a path | `dlopen` — a language runtime's extension module, PAM, NSS plugins |
| `readlink("/proc/self/fd/N")` | the physical path is used internally, the guest path is presented |

**Where the preload cannot reach.** The one class that needed an extra idea is
`eaccess()`/`euidaccess()`: glibc implements it in user space — it cannot use
the `access(2)` syscall, which tests the real uid, so it `stat()`s the path
itself and compares the mode bits. That stat is an internal call no preload can
see, so an absolute guest path reached the host and reported `ENOENT`. GNU make
uses `eaccess()` to decide whether a recipe command is executable, and when it
says no, make reports "No such file or directory" and gives up **without
forking** — a syscall trace of the failing recipe contains no `clone`, `fork` or
`execve` at all. Recipes whose command went through a shell were unaffected, so
only make's direct-exec path broke. Mapping the path fixes it.

## How it works

Termux uses Android's Bionic libc. Released Linux binaries are linked against
glibc and expect a dynamic linker (`/lib/ld-linux-aarch64.so.1`) that does not
exist on Android, so the kernel refuses them with `ENOENT`. The fix is to invoke
the glibc loader by hand and keep every child on the same path:

```
kernel reads ELF header -> PT_INTERP missing -> ENOENT
bionilux: execve(ld-linux-aarch64.so.1, --argv0 target target ..., env)
          with LD_PRELOAD=<our hooks> and a rootfs-aware environment
```

Two components:

* **The launcher** — a small Rust binary built for Bionic. It reads the target's
  ELF header, decides on an interpreter, and calls `execve()`.
* **The preload library** — built for glibc, injected into every guest process.
  It reroutes `exec*`/`posix_spawn*` so children stay in the guest, gives the
  guest its own view of the file system, and implements the public APIs that the
  blocked libc internals stand in for.

No `ptrace`, no sandbox: guest code runs at native speed. The trade-off is that
the file system is not virtualised for libc's internal use, which is why the
table above exists.

## Architecture

```
        bionilux <target>
              │
       read ELF header
              │
   ┌──────────┼───────────┬─────────────┐
   ▼          ▼           ▼             ▼
bionic     aarch64     x86_64        shebang
/static    glibc       glibc         script
   │          │           │             │
   │          ▼           ▼             │
   │      ld-linux   ld-linux +         │
   │      +preload   box64 +preload     │
   ▼          ▼           ▼             ▼
execve    target      x86_64 bin    interpreter
native    runs        runs under    resolved and
                      box64         rerun
```

With a rootfs configured, the launcher additionally maps the target into it and
exports the guest environment before the loader runs.

## Preload hooks

The constructor resolves symbols with `dlsym(RTLD_NEXT, ...)` and hooks:

**Process**

| Hook | Behaviour |
|------|-----------|
| `execve`, `execv`, `execvp`, `execl*`, `fexecve`, `execveat` | Reroute through the launcher; a bare name is resolved against the **guest's** `PATH`, never the host's |
| `posix_spawn`, `posix_spawnp` | Same reroute, into the launcher |
| `system`, `popen`, `pclose` | Run `/bin/sh -c` through the launcher with `LD_PRELOAD` stripped |
| `fork`, `vfork` | Keep the guest environment coherent |

**File system**

| Hook | Behaviour |
|------|-----------|
| `open*`, `openat*`, `creat`, `creat64` | Map the guest path into the rootfs |
| `stat`, `lstat`, `stat64`, `fstatat*`, `statx`, `fstat`, `fstat64` | Map the path, then report the guest's own identity for the owner |
| `opendir`, `scandir`, `scandirat`, `readdir` | Map the path |
| `mkdir`, `rmdir`, `unlink`, `unlinkat`, `remove`, `rename*`, `link`, `linkat`, `symlink*` | Map the path; `link`/`linkat` copy when the platform refuses hard links |
| `chmod`, `fchmod`, `fchmodat`, `chown`, `lchown`, `fchownat`, `utime*`, `utimensat`, `lutimes`, `truncate`, `truncate64` | Map the path |
| `mkstemp`, `mkostemp`, `mkstemps`, `mkostemps` (+ `64` spellings), `mkdtemp`, `mkfifo*`, `mknod*` | Map the template, creating it here because libc's internal `open`/`mkdir` would not be intercepted |
| `readlink`, `readlinkat`, `realpath`, `__realpath_chk`, `getcwd`, `chdir`, `fchdir` | Present the guest's view of the path |
| `statfs`, `statfs64`, `statvfs`, `statvfs64` | Map the path |
| `dlopen` | Map an absolute library path |
| `access`, `faccessat` | Map the path |

**Identity and name resolution**

| Hook | Behaviour |
|------|-----------|
| `getuid`, `geteuid`, `getgid`, `getegid`, `getres*id` | Report the guest's (virtual) identity |
| `setuid`, `setgid`, `setre*id`, `setres*id`, `setgroups` | Record the request and succeed; the host uid cannot change |
| `getpwnam*`, `getpwuid*`, `getgrnam*`, `getgrgid*` | Read the guest's `/etc/passwd` and `/etc/group` |
| `getaddrinfo`, `gethostbyname*` | Query using the guest's resolver, then hand numeric addresses back to glibc so it keeps its service and socket semantics |

`va_list` is a struct on aarch64, not an array — the `execl*` conversions take a
pointer so the caller's position advances. That bug only appeared on hardware.

## Build from source

The launcher is Rust; the preload is C. On Windows the MSVC host has no
`link.exe`, so build with the self-contained GNU host toolchain and the Android
NDK linker:

```bash
# Launcher (aarch64 Android)
cargo +stable-x86_64-pc-windows-gnu build --release --target aarch64-linux-android
#   CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=<ndk>/aarch64-linux-android24-clang.cmd

# Preload (aarch64 glibc)
aarch64-linux-gnu-gcc -shared -fPIC -O2 -o libbionilux_preload.so src/preload/hooks.c \
    -Wl,--dynamic-linker=/lib/ld-linux-aarch64.so.1 \
    -Wl,-rpath,/usr/lib/aarch64-linux-gnu
```

`tests/helpers/preload_paths.sh` builds and exercises the preload against the
host glibc, so the path layer can be tested with no device attached.

## Testing

Four layers. Only the last needs a device.

* **Unit tests** — `cargo test`. Run them on a Unix host; the project uses
  Unix-only APIs.
* **Host hook tests** — `tests/preload_paths.sh`. Guest paths resolve inside a
  synthetic rootfs, host files of the same name are unreachable, `..` cannot
  escape, and a `_FORTIFY_SOURCE` build behaves identically.
* **Acceptance** — `tests/acceptance.sh` drives a real Debian rootfs through the
  runtime, and can run the same cases through PRoot for comparison or against a
  device over `adb`.
* **On device** — `tests/smoke.sh` for the upstream exec/shebang cases, plus the
  capability table above.

Diagnostics kept in the tree, because each one cracked a real bug:
`tests/helpers/netprobe.c` (interface, resolver state, raw UDP/TCP DNS),
`tests/helpers/ftsprobe.c` (what `fts(3)` — and therefore `find` and `rm -rf` —
sees behind the preload), `tests/helpers/privprobe.c` (the negative result that
`GLIBC_PRIVATE` symbols cannot be interposed).

## Documentation

| Document | Contents |
|----------|----------|
| [`docs/README.md`](docs/README.md) | Orientation and reading order |
| [`docs/HARDCODING.md`](docs/HARDCODING.md) | The runtime contract: what may be hardcoded and what must be derived |
| [`docs/ROOTFS.md`](docs/ROOTFS.md) | Path mapping rules and the cases they cannot cover |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why the runtime is built this way |
| [`docs/STATUS.md`](docs/STATUS.md) | What works, what does not, and the evidence |
| [`docs/PERF.md`](docs/PERF.md) | Measured numbers against PRoot |

## Relationship to upstream

Upstream bionilux runs a glibc binary on Termux; this fork runs a Debian guest
inside an app. The ELF classification, loader invocation and child-rerouting
design are upstream's. Everything about the guest file system, the guest
identity, name resolution, package management and Android path access is this
fork's, and it is tested on a device rather than on a desktop.

`x86_64` support through `box64-glibc` is inherited from upstream and unchanged;
this fork does not depend on it.