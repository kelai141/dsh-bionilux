#!/bin/bash
# Real build acceptance inside the installed Linux environment.
set -euo pipefail
work=${1:-$PWD}
mkdir -p "$work"
cd "$work"
guest=$work/acceptance-final
mkdir -p "$guest"
version=1.5.7
archive=zstd-$version.tar.gz
expected=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
mkdir -p source-final artifacts-final
if [ ! -f "source-final/$archive" ]; then
    curl --fail --location --retry 3 "https://github.com/facebook/zstd/releases/download/v$version/$archive" -o "source-final/$archive"
fi
printf '%s  %s\n' "$expected" "source-final/$archive" | sha256sum --check --strict
if [ ! -d "source-final/zstd-$version" ]; then tar -xzf "source-final/$archive" -C source-final; fi
if [ ! -d "$guest/source" ]; then cp -R "source-final/zstd-$version" "$guest/source"; fi
cmake -S "$guest/source/build/cmake" -B "$guest/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DZSTD_BUILD_STATIC=ON -DZSTD_BUILD_SHARED=ON \
    -DZSTD_BUILD_PROGRAMS=ON -DZSTD_BUILD_TESTS=ON \
    -DCMAKE_INSTALL_PREFIX="$guest/install"
cmake --build "$guest/build" --parallel 4
ctest --test-dir "$guest/build" --output-on-failure --timeout 180 -R '^playTests$'
cmake --install "$guest/build"
tar -cf "$guest/corpus.tar" -C "$guest/source" lib programs tests
"$guest/build/programs/zstd" -9 -f "$guest/corpus.tar" -o "$guest/corpus.tar.zst"
"$guest/build/programs/zstd" -t "$guest/corpus.tar.zst"
"$guest/build/programs/zstd" -d -f "$guest/corpus.tar.zst" -o "$guest/roundtrip.tar"
cmp "$guest/corpus.tar" "$guest/roundtrip.tar"
tar -czf "$guest/zstd-$version-linux-x64.tar.gz" -C "$guest/install" .
cp "$guest/zstd-$version-linux-x64.tar.gz" artifacts-final/
sha256sum "$guest/zstd-$version-linux-x64.tar.gz"
printf 'standalone build, upstream playTests, roundtrip and packaging: PASS\n'
