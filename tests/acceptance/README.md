# Manager device acceptance

These scripts exercise the Linux runtime manager lifecycle on the real Android
host and guest split. The manager runs on the app's host Node under app UID
10052; guest commands run through the patched Bionilux launcher. Downloads are
synthetic fixture payloads, so this is not production asset, installer or APK
validation.

## Files

- `manager-device.mjs`: reusable harness. It records every observation with
  `actual: true` and the real `/proc` UID.
- `manager-device-bootstrap.sh`: builds the private minimal rootfs fixture from
  an existing guest rootfs, the patched launcher and preload. It writes only
  under `BN_FIXTURE`.
- `manager-device-run.sh`: runs one harness stage as the app UID. Use
  `--all`, `--interrupt-suite`, `--overlap`, `--escaped`, `--restart` or
  `--background`.

## Host test

`packages/linux-runtime/test/process-scope.test.mjs` uses the public
`createManager` and real `spawnCommand` lifecycle on Linux. Its launcher
fixture is `/usr/bin/env`, so manager commands become real host shell
commands. It covers:

- a `setsid` daemon whose command promise has already settled is killed by
  `uninstall` and by `dispose`;
- unrelated same-UID processes with another tag or no tag survive;
- a daemon left by an owner killed with SIGKILL is cleaned by a new owner on
  `dispose` and on `install`.

Run it with:

    node --test packages/linux-runtime/test/process-scope.test.mjs

## Device fixture

    BN_APP=/data/data/com.dsharnessmobile.shell \
    BN_APP_UID=10052 \
    BN_FIXTURE=/data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/manager-device-bnx \
    BN_SOURCE_ROOTFS=/data/data/com.dsharnessmobile.shell/files/bnrt/rootfs \
    BN_LAUNCHER=/data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/fixes2-bionilux4 \
    BN_PRELOAD=/data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/fixes2-preload-final2.so \
    BN_PACKAGE_SRC=<fixture>/pkg-src \
    BN_HARNESS_SRC=<fixture>/harness-src/manager-device.mjs \
    sh manager-device-bootstrap.sh

The repository package and harness sources must be copied into `BN_PACKAGE_SRC`
and `BN_HARNESS_SRC` first. The harness defaults to the repository-relative
manager import; set `BN_MANAGER_MODULE` when using the private fixture layout.

Run:

    BN_APP=/data/data/com.dsharnessmobile.shell \
    BN_PACKAGE=com.dsharnessmobile.shell \
    BN_FIXTURE=/data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/manager-device-bnx \
    BN_EXPECT_UID=10052 \
    sh manager-device-run.sh --all

## Process-scope contract exercised

The manager tags each managed command environment with
`BIONILUX_PROCESS_SCOPE`, the deterministic SHA-256 of the canonical
`dataDir`. It is an ownership tag, not a secret. Management scans `/proc` for
the same real UID and the exact NUL-terminated environment tag, checks the
PID start time before signalling, uses TERM then KILL, and fails closed if a
tagged process remains. It runs on install, reinstall, uninstall and dispose,
not as a passive timer. A new host owner computes the same tag and can clean an
escaped daemon left by an owner that exited uncleanly.

The device suite also starts a `setsid` grandchild through `env -i`. With the
final2 preload the tag is cached privately and restored for the exec, so the
raw `/proc/<pid>/environ` still exposes it even though the logical environment
was cleared. That daemon is killed on uninstall. An unrelated same-UID process
without the tag must survive.

The scan does not claim to own processes whose `/proc/<pid>/environ` is
unreadable or lacks the exact tag. Worker threads and isolated VM contexts have
separate registries. Stable existing path aliases to the same directory, such as
`/data/data/<pkg>` and `/data/user/0/<pkg>` when they resolve to the same
canonical directory, are folded into one owner and process-scope identity.
Do not replace the `dataDir` path or its symlink target while a manager is
live; that external mutation is outside the contract. Cross-process writers
remain outside the in-process registry. This is lifecycle cleanup, not a
security containment boundary.

The earlier evidence showing an escaped `setsid` child surviving uninstall is
kept in the previous evidence directory. New runs must assert that the child is
dead.
