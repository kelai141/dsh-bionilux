#!/usr/bin/env bash
# glob()/glob64() guest path semantics.
#
# glibc's glob() uses hidden __opendir/__stat calls, so it never reaches the
# preload's ordinary opendir()/stat() interposers. Absolute patterns used to
# return GLOB_NOMATCH. compat_glob.inc.c injects GLOB_ALTDIRFUNC callbacks on
# the first call; this probe asserts absolute matches, logical output, caller
# callbacks, DOOFFS/APPEND/NOCHECK, glob64 and stat error reporting.
#
#   tests/glob_compat.sh
set -u

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PROJECT/src/preload/hooks.c"
FRAGMENT="$PROJECT/src/preload/compat_glob.inc.c"
HELPER="$PROJECT/tests/helpers/glob_compat.c"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

G='\033[0;32m' R='\033[0;31m' Y='\033[1;33m' N='\033[0m'
pass() { printf "${G}[PASS]${N} %s\n" "$*"; }
fail() { printf "${R}[FAIL]${N} %s\n" "$*"; FAILED=$((FAILED + 1)); }
info() { printf "${Y}[info]${N} %s\n" "$*"; }
FAILED=0

[ -f "$FRAGMENT" ] || { echo "missing $FRAGMENT"; exit 1; }
command -v cc >/dev/null || { echo "no C compiler"; exit 1; }

PRELOAD="$TMP/libbionilux_preload.so"
ROOTFS="$TMP/rootfs"
BIN="$TMP/glob_compat"

info "building preload with the glob fragment"
if grep -q 'compat_glob.inc.c' "$SRC"; then
    BUILD_SRC="$SRC"
else
    cat > "$TMP/glob_hooks.c" <<EOF
#include "$SRC"
#include "$FRAGMENT"
EOF
    BUILD_SRC="$TMP/glob_hooks.c"
fi
cc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$PRELOAD" "$BUILD_SRC" -ldl -pthread || exit 1

info "building probe"
cc -O2 -Wall -Wextra -Werror -o "$BIN" "$HELPER" || exit 1

mkdir -p "$ROOTFS/tmp/globroot/sub"
chmod 755 "$TMP" "$ROOTFS"
printf 'alpha\n' > "$ROOTFS/tmp/globroot/alpha.txt"
printf 'beta\n' > "$ROOTFS/tmp/globroot/beta.txt"
printf 'gamma\n' > "$ROOTFS/tmp/globroot/sub/gamma.txt"
: > "$ROOTFS/tmp/globroot/notadir"
mkdir "$ROOTFS/tmp/globroot/errdir"
chmod 000 "$ROOTFS/tmp/globroot/errdir"
ln -s sub "$ROOTFS/tmp/globroot/linkdir"

run_probe() {
    ( cd "$ROOTFS" && env -i \
        "LD_PRELOAD=$PRELOAD" \
        "BIONILUX_ROOTFS=$ROOTFS" \
        "BIONILUX_FAKE_ROOT=1" \
        "$BIN" "$@" )
}

run_probe_unprivileged() {
    if [ "$(id -u)" -ne 0 ]; then
        run_probe "$@"
    elif command -v runuser >/dev/null 2>&1; then
        ( cd "$ROOTFS" && runuser -u nobody -- env -i \
            "LD_PRELOAD=$PRELOAD" \
            "BIONILUX_ROOTFS=$ROOTFS" \
            "BIONILUX_FAKE_ROOT=1" \
            "$BIN" "$@" )
    elif command -v setpriv >/dev/null 2>&1; then
        ( cd "$ROOTFS" && setpriv --reuid=65534 --regid=65534 --clear-groups env -i \
            "LD_PRELOAD=$PRELOAD" \
            "BIONILUX_ROOTFS=$ROOTFS" \
            "BIONILUX_FAKE_ROOT=1" \
            "$BIN" "$@" )
    else
        return 127
    fi
}

expect_line() { # expect_line <output> <exact line>
    printf '%s\n' "$1" | grep -Fqx -- "$2"
}

# 1. Absolute guest pattern matches inside the rootfs and stays logical.
OUT="$(run_probe abs '/tmp/globroot/*.txt')"
expect_line "$OUT" 'RC abs 0'                   && pass "absolute glob succeeds" || fail "absolute glob: $OUT"
expect_line "$OUT" 'COUNT abs 2'                && pass "absolute glob count" || fail "absolute count"
expect_line "$OUT" 'ENTRY abs 0 /tmp/globroot/alpha.txt' && pass "logical alpha entry" || fail "logical alpha"
expect_line "$OUT" 'ENTRY abs 1 /tmp/globroot/beta.txt'  && pass "logical beta entry" || fail "logical beta"
case "$OUT" in *"$ROOTFS"*) fail "absolute output contains physical rootfs prefix";; *) pass "no physical prefix";; esac
expect_line "$OUT" 'ALT abs no' && pass "injected ALT flag masked on success" || fail "ALT flag leaked"

# 2. A physical host pattern already under the rootfs is not prefixed twice.
OUT="$(run_probe physical "$ROOTFS/tmp/globroot/*.txt")"
expect_line "$OUT" 'RC abs 0' && pass "physical pattern succeeds" || fail "physical pattern: $OUT"
expect_line "$OUT" "ENTRY abs 0 $ROOTFS/tmp/globroot/alpha.txt" && pass "physical path unchanged" || fail "physical entry"
case "$OUT" in *"$ROOTFS$ROOTFS"*) fail "double rootfs prefix";; *) pass "no double prefix";; esac

# 3. Relative patterns keep working; cwd is already the physical rootfs cwd.
OUT="$(run_probe rel '/tmp/globroot' '*.txt')"
expect_line "$OUT" 'RC rel 0' && pass "relative glob succeeds" || fail "relative glob: $OUT"
expect_line "$OUT" 'COUNT rel 2' && pass "relative glob count" || fail "relative count"

# 4. GLOB_NOCHECK returns the pattern unchanged for a missing path.
OUT="$(run_probe nocheck '/tmp/globroot/missing/*.txt')"
expect_line "$OUT" 'RC nocheck 0' && pass "GLOB_NOCHECK returns pattern" || fail "NOCHECK rc: $OUT"
expect_line "$OUT" 'ENTRY nocheck 0 /tmp/globroot/missing/*.txt' && pass "NOCHECK logical pattern" || fail "NOCHECK pattern"

# 5. A plain missing path stays GLOB_NOMATCH.
OUT="$(run_probe abs '/tmp/globroot/missing.txt')"
expect_line "$OUT" 'RC abs 3' && pass "missing path is GLOB_NOMATCH" || fail "missing rc: $OUT"
expect_line "$OUT" 'COUNT abs 0' && pass "missing path has no entries" || fail "missing count"

# 6. GLOB_DOOFFS keeps the caller's offset slots.
OUT="$(run_probe dooffs '/tmp/globroot/*.txt')"
expect_line "$OUT" 'ENTRY dooffs 0 (null)' && pass "DOOFFS slot 0" || fail "DOOFFS slot0: $OUT"
expect_line "$OUT" 'ENTRY dooffs 1 (null)' && pass "DOOFFS slot 1" || fail "DOOFFS slot1"
expect_line "$OUT" 'ENTRY dooffs 2 /tmp/globroot/alpha.txt' && pass "DOOFFS first entry at offset" || fail "DOOFFS first"

# 7. GLOB_APPEND adds to the previous result without losing entries.
OUT="$(run_probe append '/tmp/globroot/')"
expect_line "$OUT" 'RC append 0' && pass "GLOB_APPEND succeeds" || fail "APPEND rc: $OUT"
expect_line "$OUT" 'COUNT append 2' && pass "GLOB_APPEND combined count" || fail "APPEND count"
expect_line "$OUT" 'ENTRY append 0 /tmp/globroot/alpha.txt' && pass "APPEND keeps first result" || fail "APPEND first"
expect_line "$OUT" 'ENTRY append 1 /tmp/globroot/beta.txt' && pass "APPEND adds second result" || fail "APPEND second"

# 8. Caller-supplied GLOB_ALTDIRFUNC is respected, not overwritten.
OUT="$(run_probe altdir '/tmp/globroot/*.txt')"
expect_line "$OUT" 'RC altdir 0' && pass "caller callbacks succeed" || fail "altdir rc: $OUT"
printf '%s\n' "$OUT" | grep -q '^CUSTOM_OPENDIR ' && pass "caller opendir used" || fail "caller opendir not used"
expect_line "$OUT" 'COUNT altdir 2' && pass "caller callbacks count" || fail "altdir count"

# 9. An unreadable directory reports through errfunc and GLOB_ABORTED.
if [ "$(id -u)" -eq 0 ] && ! command -v runuser >/dev/null 2>&1 && ! command -v setpriv >/dev/null 2>&1; then
    info "skipping EACCES errfunc probe: no privilege-drop tool available as root"
else
    OUT="$(run_probe_unprivileged errfunc '/tmp/globroot/errdir/*.txt')"
    expect_line "$OUT" 'RC errfunc 2' && pass "stat error returns GLOB_ABORTED" || fail "errfunc rc: $OUT"
    printf '%s\n' "$OUT" | grep -q '^ERRCOUNT [1-9]' && pass "errfunc invoked" || fail "errfunc not invoked"
    expect_line "$OUT" 'ERRNO 13' && pass "errfunc reports EACCES" || fail "errno not EACCES"
fi

# 10. glob64 uses the 64-bit callback types.
OUT="$(run_probe glob64 '/tmp/globroot/*.txt')"
expect_line "$OUT" 'RC glob64 0' && pass "glob64 absolute succeeds" || fail "glob64: $OUT"
expect_line "$OUT" 'COUNT glob64 2' && pass "glob64 count" || fail "glob64 count"
expect_line "$OUT" 'ENTRY glob64 0 /tmp/globroot/alpha.txt' && pass "glob64 logical entry" || fail "glob64 entry"

# 11. Directory symlinks and GLOB_MARK still work through the callbacks.
OUT="$(run_probe abs '/tmp/globroot/linkdir/*.txt')"
expect_line "$OUT" 'ENTRY abs 0 /tmp/globroot/linkdir/gamma.txt' && pass "symlink directory traversal" || fail "symlink: $OUT"
OUT="$(run_probe mark '/tmp/globroot/*')"
expect_line "$OUT" 'ENTRY mark 3 /tmp/globroot/linkdir/' && pass "GLOB_MARK marks symlinked directories" || fail "GLOB_MARK symlink: $OUT"
expect_line "$OUT" 'ENTRY mark 5 /tmp/globroot/sub/' && pass "GLOB_MARK marks directories" || fail "GLOB_MARK: $OUT"

if [ "$FAILED" -eq 0 ]; then
    printf "${G}glob compatibility: all checks passed${N}\n"
    exit 0
fi
printf "${R}glob compatibility: %d failed${N}\n" "$FAILED"
exit 1
