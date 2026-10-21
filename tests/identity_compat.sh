#!/usr/bin/env bash
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CC="${CC:-cc}"
QEMU="${QEMU:-qemu-aarch64}"
SYSROOT="${AARCH64_SYSROOT:-/usr/aarch64-linux-gnu}"
RUNNER="${RUNNER:-}"

TARGET="$("$CC" -dumpmachine 2>/dev/null || true)"
RUNNER_CMD=()
QEMU_STYLE=0
if [ -n "$RUNNER" ]; then
    read -r -a RUNNER_CMD <<< "$RUNNER"
    case " $RUNNER " in *qemu*) QEMU_STYLE=1 ;; esac
elif [[ "$TARGET" == aarch64* ]]; then
    command -v "$QEMU" >/dev/null || {
        echo "identity_compat: $QEMU not found; set QEMU or RUNNER" >&2
        exit 1
    }
    read -r -a RUNNER_CMD <<< "$QEMU -L $SYSROOT"
    QEMU_STYLE=1
fi

"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror "$PROJECT/src/preload/hooks.c" -o "$TMP/preload.so" -ldl -pthread
mkdir -p "$TMP/root/usr/bin" "$TMP/root/usr/lib" "$TMP/root/tmp"
"$CC" -O2 -Wall -Wextra -Werror "$PROJECT/tests/helpers/identity_compat.c" -o "$TMP/root/usr/bin/identity-probe" -ldl
cat > "$TMP/custom.c" <<'EOF'
int mkstemp(char *tmpl) { (void)tmpl; return 4242; }
EOF
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror "$TMP/custom.c" -o "$TMP/root/usr/lib/bn-custom.so"
cat > "$TMP/deep.c" <<'EOF'
#include <stdbool.h>
#include <sys/stat.h>
bool bn_deep_probe(void) {
    struct stat st;
    return stat("/usr/bin/identity-probe", &st) == 0 && S_ISREG(st.st_mode);
}
EOF
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror "$TMP/deep.c" -o "$TMP/root/usr/lib/bn-deep.so"
cat > "$TMP/chain.c" <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
int bn_chain(void) { return 11; }
int bn_chain_lookup(void) { int (*next)(void) = (int (*)(void))dlsym(RTLD_NEXT, "bn_chain"); return next ? next() : -1; }
EOF
printf 'int bn_chain(void) { return 22; }\n' > "$TMP/next.c"
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror "$TMP/chain.c" -o "$TMP/chain.so" -ldl
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror "$TMP/next.c" -o "$TMP/next.so"
cp "$TMP/chain.so" "$TMP/root/usr/lib/bn-chain.so"

PRELOAD="$TMP/preload.so:$TMP/chain.so:$TMP/next.so"
ENV_PAIRS=(
    "BIONILUX_ROOTFS=$TMP/root"
    "BIONILUX_FAKE_ROOT=1"
    "BIONILUX_TARGET_EXE=/usr/bin/identity-probe"
    "BN_DEEP_LIBRARY=/usr/lib/bn-deep.so"
    "BN_CHAIN_LIBRARY=/usr/lib/bn-chain.so"
    "BN_CUSTOM_LIBRARY=/usr/lib/bn-custom.so"
    "BN_MKSTEMP_TEMPLATE=/tmp/bn-identity-XXXXXX"
    "BN_TMP_PHYSICAL=$TMP/root/tmp"
    "LD_PRELOAD=$PRELOAD"
)

if [ "${#RUNNER_CMD[@]}" -gt 0 ] && [ "$QEMU_STYLE" -eq 1 ]; then
    ARGS=()
    for pair in "${ENV_PAIRS[@]}"; do ARGS+=(-E "$pair"); done
    "${RUNNER_CMD[@]}" "${ARGS[@]}" "$TMP/root/usr/bin/identity-probe"
elif [ "${#RUNNER_CMD[@]}" -gt 0 ]; then
    env -i PATH=/usr/bin:/bin "${ENV_PAIRS[@]}" "${RUNNER_CMD[@]}" "$TMP/root/usr/bin/identity-probe"
else
    env -i PATH=/usr/bin:/bin "${ENV_PAIRS[@]}" "$TMP/root/usr/bin/identity-probe"
fi
