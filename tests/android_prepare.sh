#!/usr/bin/env bash
# Host-only tests for the Android ldconfig adapter.  They build a synthetic
# rootfs and use the host's real static ldconfig, so the cache proved here is a
# real cache.  No device is involved and no Android claim is made.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="$PROJECT/scripts/ldconfig-android.sh"
PREPARE="$PROJECT/scripts/prepare-android-rootfs.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/.android-prepare.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Static ldconfig and the adapter must run without bionilux's preload: the hook
# lives in this process and reroutes every execve, which would test the
# harness instead of the adapter.  Skip rather than misreport a result when the
# test is launched from inside a guest session.
if [ -n "${BIONILUX_BINARY_PATH:-}${BIONILUX_PRELOAD:-}${LD_PRELOAD:-}" ]; then
    echo 'skip: run from a clean Linux shell (no LD_PRELOAD/BIONILUX_* routing)' >&2
    exit 77
fi

for tool in cc ldconfig sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing $tool" >&2; exit 77; }
done
[ -x /usr/sbin/ldconfig ] || { echo 'missing /usr/sbin/ldconfig' >&2; exit 77; }

ROOT="$WORK/root with spaces"
mkdir -p "$ROOT/usr/sbin" "$ROOT/usr/lib" "$ROOT/etc/ld.so.conf.d" \
         "$ROOT/var/lib/dpkg" "$ROOT/var/lock" "$ROOT/tmp" "$ROOT/opt/extra-libs"

# A real shared object, plus one reachable only through /etc/ld.so.conf.
cat > "$WORK/fixture.c" <<'C'
int bionilux_fixture(void) { return 42; }
C
cc -shared -fPIC -Wl,-soname,libbnfixture.so.1 \
   -o "$ROOT/usr/lib/libbnfixture.so.1" "$WORK/fixture.c"
cc -shared -fPIC -Wl,-soname,libbnextra.so.1 \
   -o "$ROOT/opt/extra-libs/libbnextra.so.1" "$WORK/fixture.c"

cp /usr/sbin/ldconfig "$ROOT/usr/sbin/ldconfig.distrib"
cp "$ADAPTER" "$ROOT/usr/sbin/ldconfig"
chmod 0755 "$ROOT/usr/sbin/ldconfig.distrib" "$ROOT/usr/sbin/ldconfig"

printf 'include /etc/ld.so.conf.d/*.conf\n/opt/extra-libs\n' > "$ROOT/etc/ld.so.conf"
printf '/usr/lib\n' > "$ROOT/etc/ld.so.conf.d/multiarch.conf"

run() {
    # The hook reads the caller's environment, so clear the reroute variables
    # in this subshell before exec rather than only for the child command.
    (
        unset BIONILUX_BINARY_PATH BIONILUX_PRELOAD LD_PRELOAD
        export BIONILUX_ROOTFS="$ROOT"
        exec "$ROOT/usr/sbin/ldconfig" "$@"
    )
}
reject() {
    if "$@" > "$WORK/rejected.log" 2>&1; then
        echo "unexpected success: $*" >&2
        cat "$WORK/rejected.log" >&2
        exit 1
    fi
}

host_before=$(sha256sum /etc/ld.so.cache | cut -d' ' -f1)

# 1. libc-bin's trigger shape, `ldconfig -r /`: a real guest cache, and the
#    host cache untouched.
run -r / > /dev/null
[ -s "$ROOT/etc/ld.so.cache" ] || { echo 'no guest cache' >&2; exit 1; }
[ "$host_before" = "$(sha256sum /etc/ld.so.cache | cut -d' ' -f1)" ] || {
    echo 'host cache was modified' >&2; exit 1; }

# 2. The cache is genuine: ldconfig -p reads it and it names the guest files.
run -p > "$WORK/printed"
grep -q 'libbnfixture\.so\.1' "$WORK/printed"
grep -q 'libbnextra\.so\.1' "$WORK/printed"
grep -qF "$ROOT/opt/extra-libs/libbnextra.so.1" "$WORK/printed"
ldconfig -p -C "$ROOT/etc/ld.so.cache" > "$WORK/printed-host"
grep -q 'libbnfixture\.so\.1' "$WORK/printed-host"

# 3. Explicit cache and config, physical or guest form.
run -i -X -C "$ROOT/tmp/phys.cache" -f "$ROOT/etc/ld.so.conf" > /dev/null
run -i -X -C /tmp/guest.cache -f /etc/ld.so.conf > /dev/null
ldconfig -p -C "$ROOT/tmp/phys.cache" > "$WORK/phys-listed"
ldconfig -p -C "$ROOT/tmp/guest.cache" > "$WORK/guest-listed"
grep -q 'libbnfixture\.so\.1' "$WORK/phys-listed"
grep -q 'libbnfixture\.so\.1' "$WORK/guest-listed"

# 4. Concurrent triggers share one cache, and leave no lock or temp file.
pids=()
for _ in 1 2 3 4; do
    ( run -i -X -C "$ROOT/tmp/racy.cache" -f /etc/ld.so.conf >/dev/null ) &
    pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done
ldconfig -p -C "$ROOT/tmp/racy.cache" > "$WORK/racy-listed"
grep -q 'libbnfixture\.so\.1' "$WORK/racy-listed"
[ ! -e "$ROOT/var/lock/bionilux-ldconfig.lock" ] || { echo 'lock leaked' >&2; exit 1; }
ls "$ROOT/tmp" > "$WORK/tmp-entries"
if grep -q '^bionilux-ldconfig\.' "$WORK/tmp-entries"; then
    echo 'temporary configuration leaked' >&2; exit 1
fi

# 5. Anything the adapter cannot reproduce fails; it never exits 0.
reject run -c old
reject run -l /usr/lib
reject run -n /usr/lib
reject run /usr/lib
reject run -i -X -C "$ROOT/../escape.cache"
reject env -u BIONILUX_ROOTFS "$WORK/no-rootfs/usr/sbin/ldconfig"
# A symlinked directory inside the rootfs must not let the cache escape it.
mkdir -p "$WORK/outside"
ln -s "$WORK/outside" "$ROOT/escape-dir"
reject run -i -X -C "$ROOT/escape-dir/cache" -f /etc/ld.so.conf

# 6. Neither an explicit config nor an include may escape the rootfs.
printf 'include /../../etc/*.conf\n' > "$ROOT/tmp/escape.conf"
reject run -i -X -C "$ROOT/tmp/escape.cache" -f "$ROOT/tmp/escape.conf"
reject run -i -X -C "$ROOT/tmp/escape.cache" -f /../../etc/ld.so.conf

# 7. prepare-android-rootfs.sh: idempotent for its own diversion, and it
#    refuses a diversion owned by a package.
STUB="$WORK/dpkg-divert"
cat > "$STUB" <<'STUB'
#!/bin/sh
root=$DPKG_STUB_ROOT
state=$DPKG_STUB_ROOT/var/lib/dpkg/diversions
file=
for arg in "$@"; do
    case $arg in --*) ;; *) file=$arg ;; esac
done
case " $* " in
    *' --listpackage '*)
        [ -f "$state" ] || exit 0
        awk -F'|' -v f="$file" '$2 == f { print $1 }' "$state"
        ;;
    *' --truename '*)
        if [ -f "$state" ]; then
            found=$(awk -F'|' -v f="$file" '$2 == f { print $3 }' "$state")
            [ -n "$found" ] && { printf '%s\n' "$found"; exit 0; }
        fi
        printf '%s\n' "$file"
        ;;
    *' --add '*)
        printf 'LOCAL|/usr/sbin/ldconfig|/usr/sbin/ldconfig.distrib\n' > "$state"
        mv "$root/usr/sbin/ldconfig" "$root/usr/sbin/ldconfig.distrib"
        ;;
    *) exit 2 ;;
esac
STUB
chmod +x "$STUB"

LAUNCHER="$WORK/launcher"
cat > "$LAUNCHER" <<'LAUNCH'
#!/bin/sh
[ "$1" = --rootfs ] && shift 2
cmd=$1; shift
case $cmd in
    /usr/bin/dpkg-divert) exec "$DPKG_STUB" "$@" ;;
    /usr/sbin/ldconfig) BIONILUX_ROOTFS=$DPKG_STUB_ROOT exec "$DPKG_STUB_ROOT/usr/sbin/ldconfig" "$@" ;;
    *) exec "$DPKG_STUB_ROOT$cmd" "$@" ;;
esac
LAUNCH
chmod +x "$LAUNCHER"
export DPKG_STUB_ROOT="$ROOT" DPKG_STUB="$STUB"

# Start from an undiverted tree holding the real binary.
rm -f "$ROOT/usr/sbin/ldconfig.distrib" "$ROOT/var/lib/dpkg/diversions"
cp /usr/sbin/ldconfig "$ROOT/usr/sbin/ldconfig"

sh "$PREPARE" --rootfs "$ROOT" --launcher "$LAUNCHER" --preload "$STUB" > /dev/null
sh "$PREPARE" --rootfs "$ROOT" --launcher "$LAUNCHER" --preload "$STUB" > /dev/null
[ -s "$ROOT/etc/ld.so.cache" ]
grep -aq 'libbnfixture\.so\.1' "$ROOT/etc/ld.so.cache"

# A diversion owned by a package, or a local one with another target, is
# refused by --listpackage/--truename rather than silently overwritten.
printf 'libc6|/usr/sbin/ldconfig|/usr/sbin/ldconfig.distrib\n' > "$ROOT/var/lib/dpkg/diversions"
reject sh "$PREPARE" --rootfs "$ROOT" --launcher "$LAUNCHER" --preload "$STUB"
grep -q 'not local' "$WORK/rejected.log"

printf 'LOCAL|/usr/sbin/ldconfig|/usr/sbin/ldconfig.elsewhere\n' > "$ROOT/var/lib/dpkg/diversions"
reject sh "$PREPARE" --rootfs "$ROOT" --launcher "$LAUNCHER" --preload "$STUB"
grep -q 'not ours' "$WORK/rejected.log"

echo 'android prepare regressions passed'
