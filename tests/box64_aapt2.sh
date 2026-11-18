#!/usr/bin/env bash
# A real AGP aapt2 under the packaged ARM64 Box64, with an ARM glibc sysroot.
# This checks the daemon protocol and payload. Android execution needs a device.
set -euo pipefail
backend=${1:?Usage: box64_aapt2.sh BACKEND ARM_GLIBC_SYSROOT [AAPT2_JAR]}
sysroot=${2:?Missing ARM64 glibc sysroot}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jar=${3:-$work/aapt2.jar}
version=8.8.2-12006047
if [[ $# -lt 3 ]]; then
  curl --fail --location --connect-timeout 15 --retry 2 --max-time 120 \
    "https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/$version/aapt2-$version-linux.jar" \
    -o "$jar"
fi
printf '%s  %s\n' be548b5ec223fc866ac8025bc782635531ded6f26f3681e2fec91c68e95608ba "$jar" \
  | sha256sum --check --strict
unzip -p "$jar" aapt2 > "$work/aapt2"
chmod 755 "$work/aapt2"
mkdir -p "$work/res/values" "$work/out"
printf '<resources><string name="app_name">Bionilux</string></resources>\n' > "$work/res/values/strings.xml"

# QEMU hosts the interpreter here. Android's native ARM64 runtime uses Box64's
# normal execution mode. Quiet diagnostics must preserve the daemon handshake.
runner=(timeout 90 "${QEMU_AARCH64:-qemu-aarch64-static}" -L "$sysroot"
  -E BOX64_LOG=0 -E BOX64_NOBANNER=1 -E BOX64_DYNAREC=0
  -E "BOX64_LD_LIBRARY_PATH=$backend/lib/box64-x86_64" "$backend/bin/box64-glibc" "$work/aapt2")
"${runner[@]}" version > "$work/version" 2>&1 || { cat "$work/version"; exit 1; }
grep -F '2.19-12006047' "$work/version"
if ! printf 'compile\n-o\n%s/out\n%s/res/values/strings.xml\n\nquit\n\n' "$work" "$work" \
  | "${runner[@]}" daemon > "$work/stdout" 2> "$work/stderr"; then
  cat "$work/stdout" "$work/stderr"
  exit 1
fi
diff -u <(printf 'Ready\nExiting daemon\n') "$work/stdout"
grep -Fx Done "$work/stderr"
test -s "$work/out/values_strings.arsc.flat"
