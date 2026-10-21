#!/usr/bin/env bash
# Loader search paths and launch cwd, exercised with real shared libraries.
#
# The synthetic rootfs below contains only the fixtures. The loader and libc
# come from the host through symlinks, exactly like tests/make.sh, so every
# library assertion depends on the launcher translating guest paths rather
# than on something the host happens to provide.
#
# Scope and limits: the launched object's own DT_RPATH/DT_RUNPATH and the guest
# LD_LIBRARY_PATH are translated. The loader accepts a single --library-path
# list, so that list also applies to indirect lookups. A dependency's own
# RPATH/RUNPATH is not translated, and nothing here claims that every
# transitive dependency is resolved.
set -uo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${CC:-}" ]; then :; else CC=cc; fi

FAILED=0
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; FAILED=$((FAILED + 1)); }
info() { printf '[info] %s\n' "$*"; }

if [ -n "${BIONILUX_TEST_BIN:-}" ]; then
    BIN="$BIONILUX_TEST_BIN"
else
    BIN="$PROJECT/target/debug/bionilux"
    info "building launcher"
    ( cd "$PROJECT" && cargo build ) || exit 1
fi
[ -x "$BIN" ] || { echo "no launcher at $BIN"; exit 1; }

command -v "$CC" >/dev/null || { echo "no C compiler"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PRELOAD="$TMP/libbionilux_preload.so"
"$CC" -shared -fPIC -O2 -o "$PRELOAD" "$PROJECT/src/preload/hooks.c" -ldl -pthread || exit 1

ROOT="$TMP/root"
mkdir -p "$ROOT"/{bin,etc,opt/ldlib,opt/runlib,opt/rpathlib,opt/app/bin,opt/app/lib,usr/bin,old/session}
ln -s /lib "$ROOT/lib"
if [ -d /lib64 ]; then ln -s /lib64 "$ROOT/lib64"; fi
ln -s /bin/sh "$ROOT/bin/sh"
ln -s /bin/cat "$ROOT/usr/bin/cat"

build_lib() { # dir text
    "$CC" -shared -fPIC -Wl,-soname,libgreet.so -o "$1/libgreet.so" -xc - <<EOF
#include <stdio.h>
void greet(void) { puts("$2"); }
EOF
}
build_app() { # out args...
    local out="$1"
    shift
    "$CC" -O2 -o "$out" -xc - "$@" <<'EOF'
void greet(void);
int main(void) { greet(); return 0; }
EOF
}

build_lib "$ROOT/opt/ldlib" from-ld-library-path
build_lib "$ROOT/opt/runlib" from-runpath
build_lib "$ROOT/opt/rpathlib" from-rpath
build_lib "$ROOT/opt/app/lib" from-origin-runpath

build_app "$ROOT/opt/app/bin/ldpath-app" -L"$ROOT/opt/ldlib" -lgreet
build_app "$ROOT/opt/app/bin/origin-runpath-app" -L"$ROOT/opt/app/lib" -lgreet \
    -Wl,--enable-new-dtags,-rpath,'$ORIGIN/../lib'
build_app "$ROOT/opt/app/bin/abs-runpath-app" -L"$ROOT/opt/runlib" -lgreet \
    -Wl,--enable-new-dtags,-rpath,/opt/runlib
build_app "$ROOT/opt/app/bin/abs-rpath-app" -L"$ROOT/opt/rpathlib" -lgreet \
    -Wl,--disable-new-dtags,-rpath,/opt/rpathlib

# A probe whose /proc/self/exe only reads correctly when the preload is active,
# because the kernel would report the loader it was started with.
"$CC" -O2 -o "$ROOT/usr/bin/selfexe" -xc - <<'EOF'
#include <stdio.h>
#include <unistd.h>
int main(void) {
    char buf[4096];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (n < 0) return 1;
    buf[n] = 0;
    puts(buf);
    return 0;
}
EOF

# SDK entry points are usually symlinks. /proc/self/exe must report the
# resolved file, because the tool derives its layout from that directory.
mkdir -p "$ROOT/opt/dart-sdk/bin" "$ROOT/usr/local/bin"
cp "$ROOT/usr/bin/selfexe" "$ROOT/opt/dart-sdk/bin/dartlike"
ln -s ../../../opt/dart-sdk/bin/dartlike "$ROOT/usr/local/bin/dartlike"
printf '#!/usr/bin/selfexe\n' > "$ROOT/usr/bin/script-probe"
printf '#!/usr/bin/script-probe\n' > "$ROOT/usr/bin/nested-script-probe"
chmod +x "$ROOT/usr/bin/script-probe" "$ROOT/usr/bin/nested-script-probe"

case "$(uname -m)" in
    x86_64) LOADER=/lib64/ld-linux-x86-64.so.2 ;;
    aarch64|arm64) LOADER=/lib/ld-linux-aarch64.so.1 ;;
    *) echo "unsupported architecture: $(uname -m)"; exit 1 ;;
esac

run() {
    env -i PATH=/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
        BIONILUX_PRELOAD="$PRELOAD" BIONILUX_FAKE_ROOT=1 "$@"
}
cwd_in() { # dir command...
    local dir="$1"
    shift
    ( cd "$dir" && "$@" )
}
check() { # description expected command...
    local desc="$1" want="$2"
    shift 2
    local out rc
    out="$("$@" 2>&1)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        fail "$desc: exit $rc"
        printf '%s\n' "$out" | sed 's/^/    /'
    elif [ "$out" = "$want" ]; then
        pass "$desc"
    else
        fail "$desc: expected '$want', got '$out'"
    fi
}
contains() { # description needle command...
    local desc="$1" needle="$2"
    shift 2
    local out rc
    out="$("$@" 2>&1)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        fail "$desc: exit $rc"
        printf '%s\n' "$out" | sed 's/^/    /'
    elif printf '%s\n' "$out" | grep -Fq -- "$needle"; then
        pass "$desc"
    else
        fail "$desc: output does not mention $needle"
        printf '%s\n' "$out" | sed 's/^/    /'
    fi
}

info "launcher: $BIN"
info "rootfs:   $ROOT"

# 1. The guest LD_LIBRARY_PATH names a directory the host does not have.
check "guest LD_LIBRARY_PATH is translated for the loader" from-ld-library-path \
    run LD_LIBRARY_PATH=/opt/ldlib "$BIN" --rootfs "$ROOT" /opt/app/bin/ldpath-app

# 2. DT_RUNPATH with $ORIGIN already points at a physical directory, because
#    the launcher hands the loader the physical main object.
check "DT_RUNPATH with ORIGIN resolves inside the rootfs" from-origin-runpath \
    run "$BIN" --rootfs "$ROOT" /opt/app/bin/origin-runpath-app

# 3. An absolute guest path in DT_RUNPATH or DT_RPATH has to be mapped; the
#    loader would otherwise read it as a host directory.
check "absolute DT_RUNPATH is mapped into the rootfs" from-runpath \
    run "$BIN" --rootfs "$ROOT" /opt/app/bin/abs-runpath-app
check "absolute DT_RPATH is mapped into the rootfs" from-rpath \
    run "$BIN" --rootfs "$ROOT" /opt/app/bin/abs-rpath-app

# 4. Ordering: RPATH before LD_LIBRARY_PATH, LD_LIBRARY_PATH before RUNPATH.
check "DT_RPATH keeps priority over LD_LIBRARY_PATH" from-rpath \
    run LD_LIBRARY_PATH=/opt/ldlib "$BIN" --rootfs "$ROOT" /opt/app/bin/abs-rpath-app
check "LD_LIBRARY_PATH keeps priority over DT_RUNPATH" from-ld-library-path \
    run LD_LIBRARY_PATH=/opt/ldlib "$BIN" --rootfs "$ROOT" /opt/app/bin/abs-runpath-app

# 5. A host directory on LD_LIBRARY_PATH must not leak into the guest.
mkdir -p "$TMP/hostlib"
build_lib "$TMP/hostlib" from-host
if run LD_LIBRARY_PATH="$TMP/hostlib" "$BIN" --rootfs "$ROOT" /opt/app/bin/ldpath-app \
    >/dev/null 2>&1; then
    fail "a host LD_LIBRARY_PATH entry leaked into the guest"
else
    pass "host LD_LIBRARY_PATH entries are not mapped"
fi

# 6. Directly executing the rootfs loader: the guest program after the options
#    must be mapped and the loader must still get physical library paths.
contains "ld.so --list maps the guest program and its libraries" \
    "$ROOT/opt/runlib/libgreet.so" \
    run "$BIN" --rootfs "$ROOT" "$LOADER" --list /opt/app/bin/abs-runpath-app
check "ld.so --verify accepts the mapped program" "" \
    run "$BIN" --rootfs "$ROOT" "$LOADER" --verify /opt/app/bin/abs-runpath-app
check "ld.so --library-path is translated" from-ld-library-path \
    run "$BIN" --rootfs "$ROOT" "$LOADER" --library-path /opt/ldlib /opt/app/bin/ldpath-app
check "ld.so still runs a program from the rootfs" from-origin-runpath \
    run "$BIN" --rootfs "$ROOT" "$LOADER" /opt/app/bin/origin-runpath-app

# Running a program through the loader is still a guest process: without the
# hook it would see host paths and report the loader as its executable.
printf 'guest-fixture\n' > "$ROOT/etc/fixture"
check "ld.so keeps guest path semantics for the program it runs" "guest-fixture" \
    run "$BIN" --rootfs "$ROOT" "$LOADER" /bin/sh -c 'cat /etc/fixture'
check "ld.so reports the guest program as /proc/self/exe" "/usr/bin/selfexe" \
    run "$BIN" --rootfs "$ROOT" "$LOADER" /usr/bin/selfexe

check "a symlinked entry point reports its resolved target" "/opt/dart-sdk/bin/dartlike" \
    run "$BIN" --rootfs "$ROOT" /usr/local/bin/dartlike
if env -i PATH=/usr/bin:/bin HOME=/tmp "$BIN" --rootfs "$ROOT" "$LOADER" --verify /usr/bin/selfexe \
    >/dev/null 2>&1; then
    pass "ld.so --verify does not require the hook"
else
    fail "ld.so --verify does not require the hook"
fi

# 7. cwd: a compiler started by go from a build directory keeps that directory
#    when it is an authorized host path; anything else keeps the guest default.
WORK="$TMP/workspace"
mkdir -p "$WORK"
check "explicit launch keeps an authorized workspace cwd" "$WORK" \
    cwd_in "$WORK" run "$BIN" --rootfs "$ROOT" --host-path "$WORK" /bin/sh -c 'pwd'
HOSTONLY="$TMP/host-only"
mkdir -p "$HOSTONLY"
check "initial launch from a host-only cwd uses the guest default" "/" \
    cwd_in "$HOSTONLY" run "$BIN" --rootfs "$ROOT" /bin/sh -c 'pwd'
check "--guest-cwd wins over the inherited directory" "/etc" \
    cwd_in "$WORK" run "$BIN" --rootfs "$ROOT" --host-path "$WORK" --guest-cwd /etc /bin/sh -c 'pwd'

# 7b. A static Go child raw-execs bionilux, so it carries no BINARY_PATH; the
# session marker is what keeps the inherited GUEST_CWD a default instead of an
# overwriting instruction.
check "the launcher marks its guest environment" "1" \
    run "$BIN" --rootfs "$ROOT" /bin/sh -c 'printf "%s" "$BIONILUX_GUEST_SESSION"'
check "nested explicit launcher keeps the physical workspace cwd" "$WORK" \
    cwd_in "$WORK" run BIONILUX_GUEST_SESSION=1 BIONILUX_GUEST_CWD=/old/session \
    "$BIN" --rootfs "$ROOT" --host-path "$WORK" /bin/sh -c 'pwd'
check "nested explicit launcher still honours --guest-cwd" "/etc" \
    cwd_in "$WORK" run BIONILUX_GUEST_SESSION=1 BIONILUX_GUEST_CWD=/old/session \
    "$BIN" --rootfs "$ROOT" --host-path "$WORK" --guest-cwd /etc /bin/sh -c 'pwd'
check "a first entry still honours the configured GUEST_CWD" "/old/session" \
    cwd_in "$WORK" run BIONILUX_GUEST_CWD=/old/session \
    "$BIN" --rootfs "$ROOT" --host-path "$WORK" /bin/sh -c 'pwd'

# 8. TLS trust store: only filled in when the guest owns the file and did not
#    set the variable itself.
check "a shebang script reports its interpreter as /proc/self/exe" "/usr/bin/selfexe" \
    run "$BIN" --rootfs "$ROOT" /usr/bin/script-probe
check "nested shebangs report the final interpreter" "/usr/bin/selfexe" \
    run "$BIN" --rootfs "$ROOT" /usr/bin/nested-script-probe

check "SSL_CERT_FILE stays unset without a guest bundle" "" \
    run "$BIN" --rootfs "$ROOT" /bin/sh -c 'printf "%s" "$SSL_CERT_FILE"'
mkdir -p "$ROOT/etc/ssl/certs"
printf 'test-ca\n' > "$ROOT/etc/ssl/certs/ca-certificates.crt"
check "SSL_CERT_FILE points at the guest bundle" "$ROOT/etc/ssl/certs/ca-certificates.crt" \
    run "$BIN" --rootfs "$ROOT" /bin/sh -c 'printf "%s" "$SSL_CERT_FILE"'
check "SSL_CERT_DIR points at the guest directory" "$ROOT/etc/ssl/certs" \
    run "$BIN" --rootfs "$ROOT" /bin/sh -c 'printf "%s" "$SSL_CERT_DIR"'
check "an explicit SSL_CERT_FILE is preserved" "/guest/custom.pem" \
    run SSL_CERT_FILE=/guest/custom.pem "$BIN" --rootfs "$ROOT" /bin/sh -c 'printf "%s" "$SSL_CERT_FILE"'

if [ "$FAILED" -eq 0 ]; then
    printf '\nloader search path and launch cwd tests passed\n'
    exit 0
else
    printf '\n%d assertion(s) failed\n' "$FAILED"
    exit 1
fi
