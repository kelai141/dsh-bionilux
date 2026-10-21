#!/bin/bash
# Build the mixed C/Rust/Zig fixture with the toolchain selected by the
# manifests: Zig 0.17.0 has the std API both upstream projects require.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
BUILD="${BUILD:-$ROOT/build}"
ZIG="${ZIG:-zig}"
CARGO="${CARGO:-cargo}"
ERL="${ERL:-erl}"
ZIG_TARGET="${ZIG_TARGET:-x86_64-linux-gnu.2.35}"
RUST_TARGET="$ROOT/rust/bn_rust/target"

mkdir -p "$BUILD"
export CARGO_TARGET_DIR="$RUST_TARGET"

echo "== versions =="
"$ZIG" version
"$CARGO" --version
rustc --version
gcc --version | head -1

echo "== rust staticlib =="
cd "$ROOT/rust/bn_rust"
if [ -f Cargo.lock ] || [ -d "$HOME/.cargo/registry" ]; then
    "$CARGO" build --release --offline
else
    "$CARGO" build --release
fi

echo "== C object =="
cd "$ROOT"
REL_BUILD=$(realpath --relative-to="$ROOT" "$BUILD")
"$ZIG" cc -target "$ZIG_TARGET" -O2 -fPIC -I c -c c/bn_core.c -o "$REL_BUILD/bn_core.o"

echo "== Zig static library =="
"$ZIG" build-lib -target "$ZIG_TARGET" -static -OReleaseSafe -fPIC -lc -I c \
    zig/bn_zig.zig "$REL_BUILD/bn_core.o" \
    -femit-bin="$REL_BUILD/libbn_zig.a"

echo "== Zig tests =="
GCC_EH_ARG=-lgcc_s
for candidate in libgcc_s.so.1 libgcc_s.so; do
    path=$(gcc -print-file-name="$candidate")
    if [ -f "$path" ]; then
        cp -L "$path" "$REL_BUILD/libgcc_s.so.1"
        GCC_EH_ARG="$REL_BUILD/libgcc_s.so.1"
        break
    fi
done
"$ZIG" test -target "$ZIG_TARGET" -OReleaseSafe -lc -I c \
    zig/bn_zig.zig "$REL_BUILD/bn_core.o" rust/bn_rust/target/release/libbn_rust.a $GCC_EH_ARG \
    --test-no-exec -femit-bin="$REL_BUILD/zig_test"

echo "== C joint executable =="
"$ZIG" cc -target "$ZIG_TARGET" -O2 -I c joint_test.c "$REL_BUILD/bn_core.o" \
    "$REL_BUILD/libbn_zig.a" rust/bn_rust/target/release/libbn_rust.a $GCC_EH_ARG \
    -lc -lpthread -ldl -lm -o "$REL_BUILD/joint_test"

echo "== NIF shared object =="
RUNTIME_DIR="${BIONILUX_RUNTIME_DIR:-/data/data/com.dsharnessmobile.shell/files/bnrt}"
ERL_INC="${ERL_INC_OVERRIDE:-$RUNTIME_DIR/rootfs/usr/lib/erlang/usr/include}"
if [ ! -f "$ERL_INC/erl_nif.h" ]; then
    ERL_ROOT=$("$ERL" -noshell -eval 'io:format("~s", [code:root_dir()]), halt().')
    ERL_INC="$ERL_ROOT/usr/include"
fi
test -f "$ERL_INC/erl_nif.h"
"$ZIG" cc -target "$ZIG_TARGET" -shared -fPIC -O2 -I c -I "$ERL_INC" bn_nif.c \
    "$REL_BUILD/bn_core.o" "$REL_BUILD/libbn_zig.a" \
    rust/bn_rust/target/release/libbn_rust.a $GCC_EH_ARG \
    -lc -lpthread -ldl -lm -o "$REL_BUILD/bn_nif.so"

echo "BUILD_OK"
