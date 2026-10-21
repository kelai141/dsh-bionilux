#!/usr/bin/env bash
# Host-only preparation and support-script regressions; no Android claims.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "$PROJECT/.prepare-rootfs.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PREP="$PROJECT/scripts/prepare-rootfs.sh"
ROOT="$WORK/root with spaces"
mkdir -p "$ROOT/usr/share" "$ROOT/etc" "$ROOT/nested/deep" "$ROOT/tmp" "$ROOT/var/tmp"
printf 'guest\n' > "$ROOT/usr/share/marker"
ln -s /usr/share/marker "$ROOT/entry"
ln -s /usr/share/marker "$ROOT/nested/deep/link"
ln -s / "$ROOT/root-link"
ln -s ../../../../usr/share/marker "$ROOT/nested/deep/escape"
ln -s ../usr/share/marker "$ROOT/root-escape"
ln -s /../../usr/share/marker "$ROOT/absolute-dotdot"
chmod 755 "$ROOT/tmp" "$ROOT/var/tmp"

reject() {
    if "$@" > "$WORK/rejected.log" 2>&1; then
        echo "unexpected success: $*" >&2
        exit 1
    fi
}

reject sh "$PREP" --rootfs /
reject sh "$PREP" --rootfs
reject sh "$PREP" --rootfs "$ROOT" --dry-run --verify
sh "$PREP" --rootfs "$ROOT" --dry-run > /dev/null
[ "$(stat -c %a "$ROOT/tmp")" = 755 ]
[ "$(readlink "$ROOT/entry")" = /usr/share/marker ]
reject sh "$PREP" --rootfs "$ROOT" --verify
[ "$(stat -c %a "$ROOT/tmp")" = 755 ]

sh "$PREP" --rootfs "$ROOT" --dns '1.1.1.1 2001:db8::1' > /dev/null
[ "$(readlink "$ROOT/entry")" = "$ROOT/usr/share/marker" ]
[ "$(cat "$ROOT/entry")" = guest ]
[ "$(cat "$ROOT/nested/deep/escape")" = guest ]
[ "$(cat "$ROOT/root-escape")" = guest ]
[ "$(cat "$ROOT/absolute-dotdot")" = guest ]
sh "$PREP" --rootfs "$ROOT" --verify --dns '1.1.1.1 2001:db8::1' > /dev/null
sh "$PREP" --rootfs "$ROOT" > /dev/null
[ "$(readlink "$ROOT/entry")" = "$ROOT/usr/share/marker" ]
chmod 755 "$ROOT/tmp"
reject sh "$PREP" --rootfs "$ROOT" --verify
sh "$PREP" --rootfs "$ROOT" --dry-run > /dev/null
[ "$(stat -c %a "$ROOT/tmp")" = 755 ]
chmod 1777 "$ROOT/tmp"

printf '# nameserver 1.1.1.1\nnameserver 11.1.1.10\n' > "$ROOT/etc/resolv.conf"
reject sh "$PREP" --rootfs "$ROOT" --verify --dns 1.1.1.1
sh "$PREP" --rootfs "$ROOT" --relative-links > /dev/null
[ "$(readlink "$ROOT/entry")" = usr/share/marker ]
[ "$(readlink "$ROOT/nested/deep/link")" = ../../usr/share/marker ]
[ "$(readlink "$ROOT/root-link")" = . ]
sh "$PREP" --rootfs "$ROOT" --relative-links > /dev/null
[ "$(readlink "$ROOT/entry")" = usr/share/marker ]
mv "$ROOT" "$WORK/moved"
ROOT="$WORK/moved"
sh "$PREP" --rootfs "$ROOT" --relative-links --verify > /dev/null
[ "$(cat "$ROOT/entry")" = guest ]
[ "$(cat "$ROOT/nested/deep/link")" = guest ]
[ "$(cat "$ROOT/nested/deep/escape")" = guest ]
[ "$(cat "$ROOT/root-escape")" = guest ]

mkdir -p "$WORK/fail/bin" "$WORK/fail/root"
ln -s /missing "$WORK/fail/root/link"
printf '#!/bin/sh\nexit 1\n' > "$WORK/fail/bin/ln"
chmod +x "$WORK/fail/bin/ln"
reject env PATH="$WORK/fail/bin:$PATH" sh "$PREP" --rootfs "$WORK/fail/root"
mkdir -p "$WORK/blocked/var"
printf 'not a directory\n' > "$WORK/blocked/var/tmp"
reject sh "$PREP" --rootfs "$WORK/blocked"

# CLI validation must fail before launching a guest or contacting a device.
reject bash "$PROJECT/tests/acceptance.sh" --runtime typo
reject bash "$PROJECT/tests/acceptance.sh" --via typo
reject bash "$PROJECT/tests/acceptance.sh" --via adb --runtime proot
reject bash "$PROJECT/tests/acceptance.sh" --launcher
reject bash "$PROJECT/tests/bench.sh" --runtime typo
reject bash "$PROJECT/tests/bench.sh" --runs 0
reject bash "$PROJECT/tests/bench.sh" --runs
reject bash "$PROJECT/setup" --root
reject bash "$PROJECT/setup" --unknown

# A stand-in launcher isolates benchmark error handling and JSON serialization.
LAUNCHER="$WORK/launcher 'quoted'"
printf '#!/bin/sh\nexit 0\n' > "$LAUNCHER"
chmod +x "$LAUNCHER"
bash "$PROJECT/tests/bench.sh" --runtime bionilux --runs 1 \
    --launcher "$LAUNCHER" --rootfs "$ROOT" --log-dir "$WORK/bench" \
    --json "$WORK/results.json" > /dev/null
python3 - "$WORK/results.json" "$LAUNCHER" <<'PY'
import json
import sys
with open(sys.argv[1]) as stream:
    result = json.load(stream)
assert result['launcher'] == sys.argv[2]
assert len(result['results']) == 9
PY
printf '#!/bin/sh\nexit 7\n' > "$LAUNCHER"
reject bash "$PROJECT/tests/bench.sh" --runtime bionilux --runs 1 \
    --launcher "$LAUNCHER" --rootfs "$ROOT" --log-dir "$WORK/bench-failed"

# Both backend reports must retain failed statuses even when output matches.
mkdir -p "$WORK/backend-bin"
cat > "$WORK/backend-bin/proot" <<'MOCK'
#!/usr/bin/env bash
cmd="${!#}"
case "$cmd" in
    *apt-get*) echo fetch-ok; exit 7 ;;
    *dpkg*) echo audit-ok; exit 7 ;;
    *getent*) exit 1 ;;
    *) exit 0 ;;
esac
MOCK
chmod +x "$WORK/backend-bin/proot"
cp "$WORK/backend-bin/proot" "$LAUNCHER"
reject env PATH="$WORK/backend-bin:$PATH" bash "$PROJECT/tests/acceptance.sh" \
    --runtime both --stage c --launcher "$LAUNCHER" --rootfs "$ROOT" --log-dir "$WORK/acceptance"
for backend in bionilux proot; do
    grep -q 'exit:     7' "$WORK/acceptance/$backend.c01_apt_update_no_fetch_errors.log"
    grep -q 'exit:     7' "$WORK/acceptance/$backend.c06_dpkg_audit.log"
done

cc -O2 -Wall -Wextra -Werror -o "$WORK/self-call" "$PROJECT/tests/helpers/self_call.c"
printf '#!/bin/sh\nexit 0\n' > "$LAUNCHER"
BIONILUX_BINARY_PATH="$LAUNCHER" "$WORK/self-call" posix_spawn
printf '#!/bin/sh\nexit 7\n' > "$LAUNCHER"
status=0
BIONILUX_BINARY_PATH="$LAUNCHER" "$WORK/self-call" posix_spawn || status=$?
[ "$status" -eq 7 ]
cc -O2 -Wall -Wextra -Werror -o "$WORK/netprobe" "$PROJECT/tests/helpers/netprobe.c" -lresolv
long_label=$(printf '%063d' 0 | tr 0 a)
reject "$WORK/netprobe" udp 127.0.0.1 53 "$long_label.$long_label.$long_label.$long_label.$long_label"
grep -q 'status=bad-name' "$WORK/rejected.log"

# Installation uses local fixture artifacts and a fake curl: no downloads.
mkdir -p "$WORK/install-bin" "$WORK/archive/x86_64-linux-gnu"
printf 'fixture\n' > "$WORK/archive/x86_64-linux-gnu/libfixture"
tar -cf "$WORK/libs.tar" -C "$WORK/archive" x86_64-linux-gnu
cat > "$WORK/install-bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -eu
out=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        https:*) url="$1"; shift ;;
        *) shift ;;
    esac
done
printf '%s\n' "$url" >> "$MOCK_URLS"
if [ -z "$out" ]; then
    printf '%s\n' "${MOCK_RELEASE_JSON:-{\"tag_name\":\"v1.2.3\"}}"
elif [ "$out" = x86_64-libs.tar.xz ]; then
    cp "$MOCK_ARCHIVE" "$out"
else
    printf 'artifact\n' > "$out"
fi
MOCK
chmod +x "$WORK/install-bin/curl"
(
    cd "$WORK"
    env PATH="$WORK/install-bin:$PATH" MOCK_URLS="$WORK/urls" MOCK_ARCHIVE="$WORK/libs.tar" \
        BIONILUX_VERSION=1.2.3 BIONILUX_INSTALL_ROOT=unused \
        bash "$PROJECT/setup" --root 'relative install' > /dev/null
)
[ -f "$WORK/relative install/bin/bionilux" ]
[ -f "$WORK/relative install/glibc/lib/x86_64-linux-gnu/libfixture" ]
[ ! -e "$WORK/unused" ]
grep -q '^https://github.com/kelai141/dsh-bionilux/releases/download/v1.2.3/' "$WORK/urls"
env PATH="$WORK/install-bin:$PATH" MOCK_URLS="$WORK/urls" MOCK_ARCHIVE="$WORK/libs.tar" \
    MOCK_RELEASE_JSON='{"tag_name":"v1.2.3"}' BIONILUX_VERSION= \
    bash "$PROJECT/setup" --root "$WORK/latest-install" > /dev/null
[ -f "$WORK/latest-install/bin/bionilux" ]
reject env PATH="$WORK/install-bin:$PATH" MOCK_URLS="$WORK/urls" MOCK_RELEASE_JSON='{}' \
    BIONILUX_VERSION= bash "$PROJECT/setup" --root "$WORK/no-release"

printf 'rootfs and support-script regressions passed\n'
