#!/bin/bash
# Runs inside the guest. Expects this directory at /root/polyglot/zig-beam and
# Zig 0.17.0 unpacked under /root/bn-fixes/fixes2-zig-beam.
set -uo pipefail

ROOT="${ROOT:-/root/polyglot/zig-beam}"
D="${D:-/root/bn-fixes/fixes2-zig-beam}"
ZIG_BIN="${ZIG_BIN:-$D/zig-x86_64-linux-0.17.0/zig}"
export ZIG="$ZIG_BIN"
BUILD="${BUILD:-$ROOT/native/build}"
export BUILD
ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-/tmp/zig017/global}"
export ZIG_GLOBAL_CACHE_DIR
mkdir -p "$D" "$BUILD"

exec > >(tee "$D/zig-beam.log") 2>&1

rc=0
echo "=== mixed C/Rust/Zig build ==="
bash "$ROOT/native/build.sh" || rc=$?
echo "BUILD_RC=$rc"

if [ "$rc" -eq 0 ]; then
    echo "=== C joint test (C -> Zig -> Rust -> C) ==="
    "$BUILD/joint_test"
    joint_rc=$?
    echo "JOINT_RC=$joint_rc"
    [ "$joint_rc" -eq 0 ] || rc=1

    echo "=== Zig test ==="
    "$BUILD/zig_test"
    zig_rc=$?
    echo "ZIG_TEST_RC=$zig_rc"
    [ "$zig_rc" -eq 0 ] || rc=1

    echo "=== BEAM NIF + EUnit gate ==="
    bash "$ROOT/beam/run_beam.sh" || rc=$?
fi

if [ "$rc" -eq 0 ]; then
    echo "RESULT|zig-beam-mixed|PASS|0"
else
    echo "RESULT|zig-beam-mixed|FAIL|$rc"
fi
exit "$rc"
