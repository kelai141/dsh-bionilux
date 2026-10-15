#!/usr/bin/env bash
# Guest path semantics for the LD_PRELOAD hook.
#
# Builds tests/helpers/paths.c and runs it under libbionilux_preload.so with a
# synthetic rootfs. Every assertion here is about the invariant that matters
# most: a guest path resolves inside the rootfs or not at all — it is never
# silently answered by the host.
#
# Runs on any glibc Linux host, so it does not need an Android device. The
# launcher itself is covered separately by cargo test and tests/smoke.sh.
#
#   tests/preload_paths.sh            # uses the host's glibc
set -u

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PROJECT/src/preload/hooks.c"
HELPER="$PROJECT/tests/helpers/paths.c"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f /tmp/bn-written' EXIT

G='\033[0;32m' R='\033[0;31m' Y='\033[1;33m' N='\033[0m'
pass() { printf "${G}[PASS]${N} %s\n" "$*"; }
fail() { printf "${R}[FAIL]${N} %s\n" "$*"; FAILED=$((FAILED + 1)); }
info() { printf "${Y}[info]${N} %s\n" "$*"; }
FAILED=0

PRELOAD="$TMP/libbionilux_preload.so"
ROOTFS="$TMP/rootfs"

# The probe writes to /tmp/bn-written. With a rootfs that must land inside the
# guest; without one it legitimately lands on the host, so start clean.
rm -f /tmp/bn-written

# ─── build ──────────────────────────────────────────────────────────
command -v cc >/dev/null || { echo "no C compiler"; exit 1; }

info "building preload"
cc -shared -fPIC -O2 -Wall -Wextra -o "$PRELOAD" "$SRC" -ldl || exit 1

# Build the probe twice. Debian and Ubuntu enable _FORTIFY_SOURCE for packaged
# software, which routes calls such as open() and realpath() through __*_chk
# entry points; both paths must behave identically.
cc -O2 -Wall -Wextra -o "$TMP/paths" "$HELPER" || exit 1
cc -O2 -Wall -Wextra -D_FORTIFY_SOURCE=2 -o "$TMP/paths-fortified" "$HELPER" || exit 1
PROBE=paths

# ─── synthetic rootfs ───────────────────────────────────────────────
# The guest deliberately disagrees with the host wherever it overlaps, so a
# host fallback would be visible as the wrong content rather than as an error.
mkdir -p "$ROOTFS"/{etc,usr/bin,usr/share,usr/lib,var,tmp,proc,dev}
echo "guest-etc"    > "$ROOTFS/etc/bn-marker"
echo "guest-share"  > "$ROOTFS/usr/share/bn-marker"
echo "guest-tool"   > "$ROOTFS/usr/bin/bn-tool"
chmod 755 "$ROOTFS/usr/bin/bn-tool"

# A file that exists on the host as a sibling of the rootfs. Guest semantics
# place it outside the guest, so reaching it means a ".." traversal escaped.
echo "HOST" > "$TMP/escape-target"

# The host has /etc/os-release and /etc/hostname. Leaving them out of the
# rootfs makes any host fallback immediately detectable.
[ -e /etc/os-release ] || info "/etc/os-release missing on host, weak test"

run_probe() {
    local bin="${1:-paths}"
    local envargs=(
        "LD_PRELOAD=$PRELOAD"
        "BIONILUX_ROOTFS=$ROOTFS"
        "BIONILUX_FAKE_ROOT=${BIONILUX_FAKE_ROOT:-1}"
        "PATH=/usr/bin:/bin"
    )
    [ -n "${BIONILUX_DEBUG:-}" ] && envargs+=("BIONILUX_DEBUG=$BIONILUX_DEBUG")
    ( cd "$ROOTFS" && env -i "${envargs[@]}" "$TMP/$bin" )
}

# Assert the whole probe output, so a regression in any single call is a
# failure rather than something that has to be noticed by eye.
expect_all() { # expect_all <output> <key> <expected>
    local got
    got="$(printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n1)"
    if [ "$got" = "$3" ]; then
        pass "$2 = $3"
    else
        fail "$2: expected '$3', got '$got'"
    fi
}

expect() { # expect <key> <expected>
    local got
    got="$(printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | head -n1)"
    if [ "$got" = "$2" ]; then
        pass "$1 = $2"
    else
        fail "$1: expected '$2', got '$got'"
    fi
}

# ─── run ────────────────────────────────────────────────────────────
info "running probe against $ROOTFS"
OUT="$(run_probe)" || { echo "$OUT"; exit 1; }
if [ -n "${VERBOSE:-}" ]; then printf '%s\n' "$OUT"; fi

# 1. guest content wins over host content at the same path
expect fopen_etc          "guest-etc"
expect open_usr_share     "guest-share"

# 2. a path the host has must not leak into the guest
expect guest_only_fail    "errno:2"        # ENOENT

# 3. metadata and directory IO
expect stat_guest_file    "1"
expect lstat_guest_file   "1"
expect stat_missing       "1"
expect access_guest       "1"
expect access_missing     "1"
expect statvfs_root       "1"
expect opendir_usr_bin    "1"
expect readdir_finds_bn_tool "1"

# 4. kernel file systems stay with the kernel
expect dev_null_writable  "1"
expect proc_self_exe      "1"
expect proc_self_status   "1"

# 5. the guest sees its own working directory
expect getcwd_at_root        "/"
expect getcwd_after_chdir    "/usr/share"
expect getcwd_back_at_root   "/"

# 6. writes land inside the guest, not on the host
expect create_in_guest    "1"
if [ -f "$ROOTFS/tmp/bn-written" ]; then
    pass "written file exists inside the rootfs"
else
    fail "written file missing from the rootfs"
fi
if [ -e /tmp/bn-written ]; then
    fail "written file leaked to the host /tmp"
else
    pass "no leak to the host /tmp"
fi

expect mkdir_guest        "1"
expect rmdir_guest        "1"

# 7. symlink round trip: created with a guest target, read back as one
expect symlink_create     "1"
expect readlink           "/etc/bn-marker"
expect open_through_link  "guest-etc"

# 8. realpath reports the guest's view
expect realpath           "/usr/share/bn-marker"

# 9. identity, needed by apt and dpkg
expect uid                "0"
expect euid               "0"
expect gid                "0"

# 10. relative paths still work
expect stat_relative      "1"

# 11. ".." cannot climb out of the guest, but still traverses inside it
expect escape_from_root      "errno:2"
expect dotdot_stays_inside   "guest-etc"
expect escape_from_usr       "errno:2"
expect dotdot_deep_inside    "guest-etc"
expect escape_absolute       "errno:2"

# ─── the fortified build must behave identically ────────────────────
# Packaged Debian software is compiled with _FORTIFY_SOURCE, which rewrites
# open(), realpath() and getcwd() into __*_chk entry points. If those are not
# hooked, a hardened guest binary silently sees host paths.
info "running the _FORTIFY_SOURCE build"
OUT_FORT="$(run_probe paths-fortified)" || { echo "$OUT_FORT"; exit 1; }
if [ "$OUT" = "$OUT_FORT" ]; then
    pass "fortified build matches the plain build"
else
    fail "fortified build differs from the plain build"
    diff <(printf '%s\n' "$OUT") <(printf '%s\n' "$OUT_FORT") || true
fi
expect_all "$OUT_FORT" realpath     "/usr/share/bn-marker"
expect_all "$OUT_FORT" getcwd_after_chdir "/usr/share"
expect_all "$OUT_FORT" fopen_etc    "guest-etc"
expect_all "$OUT_FORT" open_usr_share "guest-share"
expect_all "$OUT_FORT" guest_only_fail "errno:2"
expect_all "$OUT_FORT" readlink     "/etc/bn-marker"

# ─── the same binary with no rootfs must behave like upstream ───────
info "checking that an unset BIONILUX_ROOTFS disables all mapping"
OUT="$( cd / && env -i LD_PRELOAD="$PRELOAD" PATH=/usr/bin:/bin "$TMP/paths" )" || true
if printf '%s\n' "$OUT" | grep -q '^getcwd_at_root=/'; then
    pass "rootfs disabled: transparent"
else
    fail "rootfs disabled: unexpected output"
fi
if printf '%s\n' "$OUT" | grep -q '^fopen_etc=errno:2$'; then
    pass "rootfs disabled: no synthetic guest content"
else
    fail "rootfs disabled: guest content appeared without a rootfs"
fi

# ─── fake root off must report the real uid ─────────────────────────
info "checking BIONILUX_FAKE_ROOT=0"
OUT="$(BIONILUX_FAKE_ROOT=0 run_probe)"
if [ "$(printf '%s\n' "$OUT" | sed -n 's/^uid=//p')" = "$(id -u)" ]; then
    pass "BIONILUX_FAKE_ROOT=0 reports the real uid"
else
    fail "BIONILUX_FAKE_ROOT=0 did not report the real uid"
fi

# ─── summary ────────────────────────────────────────────────────────
if [ "$FAILED" -eq 0 ]; then
    printf "\n${G}preload path tests passed${N}\n"
    exit 0
else
    printf "\n${R}%d assertion(s) failed${N}\n" "$FAILED"
    exit 1
fi
