#!/usr/bin/env bash
set -euo pipefail

backend=${1:?Usage: build-box64.sh BACKEND}
project=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Box64 v0.4.4. Use a full commit to keep rebuilds independent of moving tags.
source_commit=2f130fab1d6e1a4ee8a71dc60cfdfcc839ad192a
git init -q "$work/source"
timeout --kill-after=15s 300s git -C "$work/source" fetch --depth=1 \
  https://github.com/ptitSeb/box64.git "$source_commit"
git -C "$work/source" checkout --detach "$source_commit"

cmake -S "$work/source" -B "$work/build" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
  -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++ \
  -DARM64=ON -DNOLOADADDR=ON -DBOX32=OFF -DCMAKE_EXE_LINKER_FLAGS=-Wl,-z,max-page-size=16384
cmake --build "$work/build" --target box64 --parallel "$(nproc)"

binary="$backend/bin/box64-glibc"
install -m 0755 "$work/build/box64" "$binary"
aarch64-linux-gnu-strip --strip-unneeded "$binary"
install -D -m 0644 "$work/source/LICENSE" "$backend/lib/box64-LICENSE"
readelf -lW "$binary" | grep -F 'Requesting program interpreter: /lib/ld-linux-aarch64.so.1'
python3 "$project/scripts/check_elf_alignment.py" --policy android --machine aarch64 "$binary"

# AAPT2 needs the x86-64 unwinder. Box64 provides wrappers for its other libc
# dependencies, so this backend does not carry an additional Debian rootfs.
debian_pool=https://deb.debian.org/debian/pool/main/g/gcc-14
libgcc_version=14.2.0-19
curl --fail --location --connect-timeout 15 --retry 2 --max-time 120 \
  "$debian_pool/libgcc-s1_${libgcc_version}_amd64.deb" -o "$work/libgcc.deb"
curl --fail --location --connect-timeout 15 --retry 2 --max-time 120 \
  "$debian_pool/gcc-14-base_${libgcc_version}_amd64.deb" -o "$work/gcc-base.deb"
(
  cd "$work"
  sha256sum --check --strict <<'SUMS'
3c71917b490d1a17aed43196a2787a256ecf060526cdb20216a74bedc061b150  libgcc.deb
5b6825de4263824b78c4c51f6476414f3b4e89c2ab63e81dc8b9b5501e867cf6  gcc-base.deb
SUMS
)
dpkg-deb -x "$work/libgcc.deb" "$work/libgcc"
dpkg-deb -x "$work/gcc-base.deb" "$work/gcc-base"
guest_libs="$backend/lib/box64-x86_64"
install -D -m 0644 "$work/libgcc/usr/lib/x86_64-linux-gnu/libgcc_s.so.1" "$guest_libs/libgcc_s.so.1"
install -m 0644 "$work/gcc-base/usr/share/doc/gcc-14-base/copyright" "$guest_libs/libgcc-COPYRIGHT"
printf 'Debian GCC source for libgcc_s.so.1\n%s/gcc-14_%s.dsc\n%s/gcc-14_%s.orig.tar.gz\n%s/gcc-14_%s.debian.tar.xz\n' \
  "$debian_pool" "$libgcc_version" "$debian_pool" "$libgcc_version" "$debian_pool" "$libgcc_version" \
  > "$guest_libs/libgcc-SOURCE"
python3 "$project/scripts/check_elf_alignment.py" --policy guest --page-size 4096 --machine x86_64 "$guest_libs/libgcc_s.so.1"
printf 'Box64 and libgcc compressed payload: %s bytes\n' "$(cat "$binary" "$guest_libs/libgcc_s.so.1" | xz -c | wc -c)"
