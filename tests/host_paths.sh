#!/usr/bin/env bash
# Real component walks must enter --host-path mounts, rather than shadow them.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cc -shared -fPIC -O2 -Wall -Wextra -Werror "$PROJECT/src/preload/hooks.c" -o "$TMP/preload.so" -ldl -pthread
mkdir -p "$TMP/root/tmp" "$TMP/exposed"
env BIONILUX_ROOTFS="$TMP/root" BIONILUX_HOST_PATHS="$TMP/exposed" LD_PRELOAD="$TMP/preload.so" \
    /usr/bin/mkdir -p "$TMP/exposed/one/two" "$TMP/exposed/three/four"
test -d "$TMP/exposed/one/two"
test -d "$TMP/exposed/three/four"
test ! -e "$TMP/root$TMP/exposed/one"
# A sibling with the same leading bytes is still a guest path.
env BIONILUX_ROOTFS="$TMP/root" BIONILUX_HOST_PATHS="$TMP/exposed" LD_PRELOAD="$TMP/preload.so" \
    /usr/bin/mkdir -p "$TMP/exposed-other/guest"
test -d "$TMP/root$TMP/exposed-other/guest"
test ! -e "$TMP/exposed-other"
printf 'host-path component walks: PASS\n'
