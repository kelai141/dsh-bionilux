#!/usr/bin/env bash
# Host glibc regressions. No Android behavior is claimed by this suite.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CC="${CC:-cc}"
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" "$PROJECT/src/preload/hooks.c" -ldl -pthread
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/probe" "$PROJECT/tests/helpers/runtime.c" -pthread
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/launcher" "$PROJECT/tests/helpers/launcher.c"
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/hooks-unit" "$PROJECT/tests/helpers/hooks_unit.c" -ldl -pthread
mkdir -p "$TMP/root"/{etc,tmp,bin,usr/bin}
ln -s /lib "$TMP/root/lib"
ln -s /lib64 "$TMP/root/lib64"
ln -s /bin/sh "$TMP/root/bin/sh"
ln -s /usr/bin/env "$TMP/root/usr/bin/env"
ln -s /bin/sleep "$TMP/root/bin/sleep"
cp "$TMP/probe" "$TMP/root/usr/bin/bn-tool"
cp "$TMP/probe" "$TMP/root/usr/bin/bn-probe"
cp "$TMP/probe" "$TMP/root/tmp/local-probe"
mkdir -p "$TMP/root"/{first,second}
printf '#!/bn-missing-interpreter\n' > "$TMP/root/first/tool"
printf '#!/bn-no-executable\n' > "$TMP/root/first/denied-tool"
cp "$TMP/root/first/tool" "$TMP/root/first/missing-only"
cp "$TMP/root/first/denied-tool" "$TMP/root/first/all-denied"
chmod +x "$TMP/root/first/"*
cp "$TMP/probe" "$TMP/root/second/tool"
cp "$TMP/probe" "$TMP/root/second/denied-tool"
chmod +x "$TMP/root/usr/bin/bn-tool"
printf 'exit 23\n' > "$TMP/root/usr/bin/bn-text"
chmod +x "$TMP/root/usr/bin/bn-text"
printf 'bn-group:x:4242:alice,bob\n' > "$TMP/root/etc/group"
printf '::1 bn-v6\n' > "$TMP/root/etc/hosts"
printf 'not executable\n' > "$TMP/root/bn-no-executable"
printf '#!/bn-missing-interpreter\n' > "$TMP/root/usr/bin/bn-missing-interpreter"
printf '#!/bn-no-executable\n' > "$TMP/root/usr/bin/bn-denied-interpreter"
printf '#!/usr/bin/bn-loop\n' > "$TMP/root/usr/bin/bn-loop"
chmod +x "$TMP/root/usr/bin/"bn-{missing-interpreter,denied-interpreter,loop}
LAUNCHER="${BIONILUX_TEST_LAUNCHER:-$TMP/launcher}"
mkdir -p "$TMP/workspace"
printf host-workspace > "$TMP/workspace/marker"
FAILED=0
for test in group hosts spawn temporary readlink process pclose-race exec path-interpreters workspace; do
    if ! env -i PATH=/usr/bin:/bin LD_PRELOAD="$TMP/preload.so" \
        BIONILUX_HOST_PATHS="$TMP/workspace" BN_TEST_WORKSPACE="$TMP/workspace" \
        BIONILUX_PROCESS_SCOPE=bn-scope-fixture \
        BIONILUX_ROOTFS="$TMP/root" BIONILUX_BINARY_PATH="$LAUNCHER" BIONILUX_PRELOAD="$TMP/preload.so" \
        "$TMP/probe" "$test"; then
        echo "FAIL: $test" >&2
        FAILED=$((FAILED + 1))
    fi
done
env -i PATH=/usr/bin:/bin BIONILUX_ROOTFS="$TMP/root" BIONILUX_BINARY_PATH="$LAUNCHER" "$TMP/hooks-unit"
for test in group process; do
    env -i PATH=/usr/bin:/bin LD_PRELOAD="$TMP/preload.so" BIONILUX_DNS=0 \
        BIONILUX_ROOTFS="$TMP/root" BIONILUX_BINARY_PATH="$LAUNCHER" BIONILUX_PRELOAD="$TMP/preload.so" \
        "$TMP/probe" "$test"
done
if [ "$FAILED" -ne 0 ]; then exit 1; fi
python3 "$PROJECT/tests/interactive.py" "$TMP/root" "$TMP/preload.so" "$LAUNCHER"
if [ -n "${BIONILUX_TEST_LAUNCHER:-}" ]; then
    mkdir -p "$TMP/root/usr/lib"
    "$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -Werror -o "$TMP/root/usr/lib/marker.so" "$PROJECT/tests/helpers/preload_marker.c"
    output=$(env -i PATH=/usr/bin:/bin BIONILUX_ROOTFS="$TMP/root" \
        BIONILUX_BINARY_PATH="$LAUNCHER" BIONILUX_PRELOAD="$TMP/preload.so" \
        BN_PRELOAD_MARKER=1 LD_PRELOAD="$TMP/preload.so:$TMP/root/usr/lib/marker.so" \
        "$TMP/probe" preload)
    [ "$(printf '%s\n' "$output" | grep -cx preload-marker)" -eq 2 ]
    printf 'third-party guest LD_PRELOAD survives launcher without loading into it: OK\n'
fi
printf 'runtime regressions passed\n'
