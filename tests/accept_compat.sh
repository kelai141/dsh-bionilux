#!/usr/bin/env bash
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" \
  "$PROJECT/src/preload/hooks.c" -ldl -pthread
cc -O2 -Wall -Wextra -Werror -o "$TMP/probe" "$PROJECT/tests/helpers/accept_compat.c"

status=0
"$TMP/probe" deny-accept || status=$?
if [[ "$status" != 77 ]]; then
  printf 'Expected unmodified libc to return ENOSYS, probe returned %s\n' "$status" >&2
  exit 1
fi
LD_PRELOAD="$TMP/preload.so" "$TMP/probe" deny-accept
printf 'accept4 compatibility under an accept-only denial: OK\n'
