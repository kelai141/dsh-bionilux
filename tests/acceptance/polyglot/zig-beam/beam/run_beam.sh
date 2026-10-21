#!/bin/bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
BUILD="${BUILD:-$ROOT/../build}"
NIF_SO="${BN_NIF_SO:-$BUILD/bn_nif}"
OUT="${OUT:-$BUILD/beam-out}"
mkdir -p "$OUT"

export BN_NIF_PATH="$NIF_SO"
PASS_SPEC="${PASS_SPEC:-bn_nif_tests}"
FAIL_SPEC="${FAIL_SPEC:-bn_failing_tests}"
rc=0

echo "== compile test modules =="
erlc -o "$OUT" "$ROOT/bn_nif.erl" "$ROOT/bn_nif_tests.erl" "$ROOT/bn_failing_tests.erl"
erlc_rc=$?
echo "ERLC_RC=$erlc_rc"
[ "$erlc_rc" -eq 0 ] || rc=1

echo "== passing EUnit run =="
( cd "$OUT" && escript "$ROOT/eunit_gate.escript" "$PASS_SPEC" )
pass_rc=$?
echo "EUNIT_PASS_RC=$pass_rc"
[ "$pass_rc" -eq 0 ] || rc=1

echo "== deliberate failing EUnit run =="
( cd "$OUT" && escript "$ROOT/eunit_gate.escript" "$FAIL_SPEC" )
fail_rc=$?
echo "EUNIT_FAIL_RC=$fail_rc"
[ "$fail_rc" -eq 2 ] || rc=1

echo "BEAM_RC=$rc"
exit "$rc"
