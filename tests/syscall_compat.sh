#!/usr/bin/env bash
# Regression coverage for libc syscall() path forwarding.
#
# Julia/libuv call syscall(SYS_statx, ...) directly; named statx() hooks do
# not see that. This test proves the syscall() interposer maps statx,
# newfstatat, openat and readlinkat, forwards unknown numbers (0-6 args and
# errno), and leaves fork/vfork working.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CC="${CC:-cc}"

case "$(uname -m)" in
    x86_64|aarch64) ;;
    *) echo "syscall_compat: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" \
    "$PROJECT/src/preload/hooks.c" -ldl -pthread
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/probe" \
    "$PROJECT/tests/helpers/syscall_compat.c"

ROOT="$TMP/root"
mkdir -p "$ROOT/etc" "$ROOT/usr/bin" "$ROOT/tmp"
TAG="syscall-compat-$$"
GUEST="/etc/$TAG-guest"
LINK="/etc/$TAG-link"
printf 'guest-statx\n' > "$ROOT$GUEST"
ln -s "$ROOT$GUEST" "$ROOT$LINK"
printf 'host-only\n' > "$TMP/host-only"

run_probe() {
    env -i PATH=/usr/bin:/bin LD_PRELOAD="$TMP/preload.so" \
        BIONILUX_TARGET_EXE=/usr/bin/node \
        BN_SYSCALL_GUEST="$GUEST" BN_SYSCALL_HOST="$TMP/host-only" \
        BN_SYSCALL_LINK="$LINK" BN_SYSCALL_LINK_TARGET="$GUEST" "$@" "$TMP/probe"
}

OUT="$(run_probe BIONILUX_ROOTFS="$ROOT" BIONILUX_FAKE_ROOT=1)"
expect() {
    local got
    got="$(printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | head -n1)"
    if [ "$got" = "$2" ]; then
        printf 'PASS %s = %s\n' "$1" "$2"
    else
        printf 'FAIL %s: expected %s, got %s\n' "$1" "$2" "$got" >&2
        exit 1
    fi
}

expect statx_guest       "ok:guest-statx"
expect statx_uid         "0"
expect statx_gid         "0"
expect statx_host        "errno:2"
expect statx_empty       "ok"
expect newfstatat_guest  "ok"
expect newfstatat_uid    "0"
expect newfstatat_gid    "0"
expect openat_guest      "ok:guest-statx"
expect readlinkat_guest  "$GUEST"
expect readlink_exe      "/usr/bin/node"
expect unknown_0         "ok"
expect unknown_1         "errno:9"
expect unknown_2         "ok"
expect unknown_3         "ok"
expect unknown_4         "ok"
expect unknown_5         "ok"
expect unknown_6         "ok"
expect fork              "ok"
expect vfork             "ok"
expect raw_statx_guest   "errno:2"

# Without a rootfs the same paths must behave like the host: the rootfs-only
# marker disappears and the host-only file becomes visible.
OUT="$(run_probe)"
expect statx_guest       "errno:2"
expect statx_host        "ok:host-only"
expect openat_guest      "errno:2"
expect readlinkat_guest  "errno:2"
expect raw_statx_guest   "errno:2"
expect fork              "ok"
expect vfork             "ok"

printf 'syscall compatibility tests passed\n'
