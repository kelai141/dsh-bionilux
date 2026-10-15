#!/usr/bin/env bash
# Real native toolchain through the hooks and a test-only native launcher.
# This is glibc host coverage, not a Bionic/Android integration test.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" "$PROJECT/src/preload/hooks.c" -ldl -pthread
cc -O2 -Wall -Wextra -Werror -o "$TMP/launcher" "$PROJECT/tests/helpers/launcher.c"
cc -O2 -Wall -Wextra -Werror -o "$TMP/probe" "$PROJECT/tests/helpers/runtime.c" -pthread
LAUNCHER="${BIONILUX_TEST_LAUNCHER:-$TMP/launcher}"
ROOT="$TMP/root"
mkdir -p "$ROOT"/{bin,usr/bin,tmp/build}
for tool in sh true false sleep cat; do ln -s "$(type -P "$tool")" "$ROOT/bin/$tool"; done
for tool in make cc gcc as ld; do ln -s "$(type -P "$tool")" "$ROOT/usr/bin/$tool"; done
ln -s /usr/lib "$ROOT/usr/lib"
ln -s /usr/include "$ROOT/usr/include"
if [ -d /usr/libexec ]; then ln -s /usr/libexec "$ROOT/usr/libexec"; fi
ln -s /lib "$ROOT/lib"
ln -s /lib64 "$ROOT/lib64"
cp "$TMP/probe" "$ROOT/usr/bin/bn-probe"
printf '#include <stdio.h>\nint main(void) { puts("compiled-in-guest"); return 0; }\n' > "$ROOT/tmp/build/hello.c"
cat > "$ROOT/tmp/build/Makefile" <<'MAKEFILE'
SHELL := /bin/sh
RESULT := $(shell /bin/sh -c 'printf shell-ok')
ifneq ($(RESULT),shell-ok)
$(error shell expansion failed)
endif
.PHONY: all direct recursive child nested one two failing
all: direct recursive hello
	./hello
direct:
	/usr/bin/bn-probe success
recursive:
	+$(MAKE) -f Makefile child
child:
	+/usr/bin/bn-probe jobserver
	+$(MAKE) -f Makefile nested
nested: one two
one two:
	/bin/true
hello: hello.c
	/usr/bin/cc hello.c -o hello
failing:
	/bin/false
MAKEFILE
OPTIONS=(-j4)
# Make <4.4 already uses pipes; newer make needs the explicit Android-safe style.
if make --help | grep -q -- --jobserver-style; then OPTIONS+=(--jobserver-style=pipe); fi
run_make() {
    (cd "$ROOT/tmp/build" && env -i PATH=/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
        BIONILUX_DEBUG="${BIONILUX_DEBUG:-}" BIONILUX_ROOTFS="$ROOT" BIONILUX_BINARY_PATH="$LAUNCHER" \
        BIONILUX_PRELOAD="$TMP/preload.so" LD_PRELOAD="$TMP/preload.so" \
        /usr/bin/make "${OPTIONS[@]}" "$@")
}
run_make all > "$TMP/output" 2>&1 || { cat "$TMP/output"; exit 1; }
grep -q '^compiled-in-guest$' "$TMP/output"
if grep -qi 'jobserver unavailable' "$TMP/output"; then cat "$TMP/output"; exit 1; fi
if run_make failing > "$TMP/failure" 2>&1; then echo 'make hid a failed recipe' >&2; exit 1; fi
printf 'GNU Make direct/shell/recursive recipes, inherited pipe jobserver and C toolchain: OK\n'
