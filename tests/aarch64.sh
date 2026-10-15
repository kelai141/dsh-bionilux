#!/usr/bin/env bash
# AArch64 glibc user-mode emulation only, not Android/Bionic/SELinux validation.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CC="${CC:-aarch64-linux-gnu-gcc}"
QEMU="${QEMU:-qemu-aarch64}"
SYSROOT="${AARCH64_SYSROOT:-/usr/aarch64-linux-gnu}"
command -v "$CC" >/dev/null
command -v "$QEMU" >/dev/null
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" "$PROJECT/src/preload/hooks.c" -ldl -pthread
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/probe" "$PROJECT/tests/helpers/runtime.c" -pthread
"$CC" -O2 -Wall -Wextra -Werror -Wl,--export-dynamic -o "$TMP/unit" "$PROJECT/tests/helpers/hooks_unit.c" -ldl -pthread
mkdir -p "$TMP/root"/{etc,tmp,usr/bin}
printf 'bn-group:x:4242:alice,bob\n' > "$TMP/root/etc/group"
printf '::1 bn-v6\n' > "$TMP/root/etc/hosts"
printf 'not executable\n' > "$TMP/root/bn-no-executable"
printf '#!/bn-missing-interpreter\n' > "$TMP/root/usr/bin/bn-missing-interpreter"
printf '#!/bn-no-executable\n' > "$TMP/root/usr/bin/bn-denied-interpreter"
printf '#!/usr/bin/bn-loop\n' > "$TMP/root/usr/bin/bn-loop"
chmod +x "$TMP/root/usr/bin/"bn-{missing-interpreter,denied-interpreter,loop}
cp "$TMP/probe" "$TMP/root/usr/bin/bn-tool"
for test in group hosts spawn temporary readlink; do
    "$QEMU" -L "$SYSROOT" -E "BIONILUX_ROOTFS=$TMP/root" \
        -E BIONILUX_BINARY_PATH=/fixture-launcher -E "LD_PRELOAD=$TMP/preload.so" \
        "$TMP/probe" "$test"
done
"$QEMU" -L "$SYSROOT" -E "BIONILUX_ROOTFS=$TMP/root" \
    -E BIONILUX_BINARY_PATH=/fixture-launcher -E PATH=/usr/bin:/bin "$TMP/unit"
printf 'AArch64 glibc compile and QEMU regressions: OK (not Android validation)\n'
