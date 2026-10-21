#!/bin/bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
BUILD="$ROOT/build"
ZIG="${ZIG:-zig}"
ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-/tmp/zig-cache}"
export ZIG BUILD ZIG_GLOBAL_CACHE_DIR

rc=0
bash "$ROOT/build.sh" || rc=$?
echo "BUILD_RC=$rc"
[ "$rc" -eq 0 ] || exit "$rc"

"$BUILD/joint_test"
joint_rc=$?
echo "JOINT_RC=$joint_rc"
[ "$joint_rc" -eq 0 ] || rc=1

"$BUILD/zig_test"
zig_rc=$?
echo "ZIG_TEST_RC=$zig_rc"
[ "$zig_rc" -eq 0 ] || rc=1

exit "$rc"
