#!/usr/bin/env bash
# Build the glibc cache writer as a PIE for the guest's ordinary loader path.
# Source: GNU glibc 2.41 (LGPL-2.1-or-later), with the link changes below.
set -euo pipefail

if [[ $# != 3 ]]; then
    printf 'usage: %s <architecture> <output file> <work directory>\n' "$0" >&2
    exit 2
fi

case $1 in
    aarch64) host=aarch64-linux-gnu ;;
    x86_64) host=x86_64-linux-gnu ;;
    *) printf 'unsupported ldconfig architecture: %s\n' "$1" >&2; exit 2 ;;
esac
output=$(realpath -m "$2")
mkdir -p "$3"
work=$(mktemp -d "$(realpath "$3")/ldconfig.XXXXXX")
version=2.41
archive=$work/glibc-$version.tar.xz
curl --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 180 \
    "https://ftp.gnu.org/gnu/glibc/glibc-$version.tar.xz" --output "$archive"
printf '%s  %s\n' a5a26b22f545d6b7d7b3dd828e11e428f24f4fac43c934fb071b6a7d0828e901 "$archive" | sha256sum --check --strict
tar -xJf "$archive" -C "$work"
source=$work/glibc-$version
build=$work/build
mkdir "$build"

# ldconfig previously linked the private comparator from libc.a. Build just
# that function alongside the dynamic program. All cache rules stay upstream.
python3 - "$source/elf" <<'PY'
from pathlib import Path
import re
import sys

elf = Path(sys.argv[1])
makefile = elf / 'Makefile'
text, removed = re.subn(r'^others-static\s*\+= ldconfig\n', '', makefile.read_text(), flags=re.M)
modules, = re.findall(r'^ldconfig-modules := \\\n(.*?)^  # ldconfig-modules', text, flags=re.M | re.S)
assert removed == 1 and modules.count('static-stubs') == 1, 'glibc ldconfig rules changed'
makefile.write_text(text.replace(modules, modules.replace('static-stubs', 'ldconfig-cache-compare')))
cache = (elf / 'dl-cache.c').read_text()
comparator, = re.findall(r'^int\n_dl_cache_libcmp \(.*?^}\n', cache, flags=re.M | re.S)
(elf / 'ldconfig-cache-compare.c').write_text(cache[:cache.index('*/') + 2] + '\n\n' + comparator)
PY

build_machine=$(gcc -dumpmachine)
configure=(--build="$build_machine" --host="$host" --prefix=/usr --disable-werror --disable-profile)
compiler=gcc
strip=strip
if [[ "$host" != "$build_machine" ]]; then
    configure+=(--with-headers="/usr/$host/include")
    compiler=$host-gcc
    strip=$host-strip
fi
(cd "$build" && CC="$compiler" CFLAGS='-O2 -g0' "$source/configure" "${configure[@]}" && make -j"$(nproc)" lib)
make -r -C "$source/elf" objdir="$build" "$build/elf/ldconfig"
readelf -lW "$build/elf/ldconfig" | awk '$1 == "INTERP" { matched = 1 } END { exit !matched }'
"$strip" --strip-debug "$build/elf/ldconfig"
install -m 755 "$build/elf/ldconfig" "$output"
