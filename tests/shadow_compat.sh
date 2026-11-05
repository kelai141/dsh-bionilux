#!/usr/bin/env bash
# shadow/glibc account locking on a guest rootfs, without adb.
#
# Covers:
#   * real multi-process fcntl mutex on <rootfs>/etc/.pwd.lock
#   * bounded contention and failure, not merely a successful lckpwdf()
#   * a helper that makes every link(2)/linkat(2) return EPERM, as Android does
#   * nlink 2 only for /etc/{passwd,shadow,group,gshadow}.<pid> -> <db>.lock
#   * ordinary copy fallbacks, fstat(), host passthrough and record cleanup
#
# This is a host glibc test; it is not evidence for Android device behaviour.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'for pid in $(jobs -pr); do kill -9 "$pid" 2>/dev/null || true; done; rm -rf "$TMP"' EXIT

CC=${CC:-cc}
PRELOAD="$TMP/preload.so"
HELPER="$TMP/shadow-compat"
ROOT="$TMP/root"
READY="$ROOT/tmp/shadow-ready"
FAILED=0

pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }

command -v "$CC" >/dev/null || { echo "no C compiler ($CC)" >&2; exit 1; }
command -v timeout >/dev/null || { echo "no timeout" >&2; exit 1; }

info() { printf '[INFO] %s\n' "$*"; }
info "building preload from complete hooks.c"
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$PRELOAD" \
    "$PROJECT/src/preload/hooks.c" -ldl -pthread || exit 1
"$CC" -O2 -Wall -Wextra -Werror -o "$HELPER" \
    "$PROJECT/tests/helpers/shadow_compat.c" -ldl || exit 1

mkdir -p "$ROOT/etc" "$ROOT/tmp"
guest() {
    env -i PATH=/usr/bin:/bin LD_PRELOAD="$PRELOAD" \
        BN_SHADOW_READY=/tmp/shadow-ready \
        BIONILUX_ROOTFS="$ROOT" BIONILUX_FAKE_ROOT=1 "$@"
}

info "same-process lock is not re-entrant"
if guest "$HELPER" sameproc; then pass "same-process double lock/unlock"; else fail "same-process lock semantics"; fi

info "two guest processes contend on the physical guest lock file"
rm -f "$READY"
guest "$HELPER" lock-hold 1800 >"$TMP/holder.log" 2>&1 &
holder=$!
ready_wait=0
while [ ! -e "$READY" ] && [ "$ready_wait" -lt 200 ]; do
    sleep 0.05
    ready_wait=$((ready_wait + 1))
done
if [ -e "$READY" ]; then
    if guest "$HELPER" lock-wait 1200 5000 OK >"$TMP/waiter.log" 2>&1; then
        pass "second process waited for the holder and then acquired the lock"
    else
        fail "second process did not acquire the lock after contention"
        cat "$TMP/waiter.log" >&2
    fi
else
    fail "lock holder never became ready"
    cat "$TMP/holder.log" >&2
fi
wait "$holder" || fail "lock holder failed"

info "contention returns after the 15 second bound"
rm -f "$READY"
guest "$HELPER" lock-hold 18000 >"$TMP/long-holder.log" 2>&1 &
holder=$!
ready_wait=0
while [ ! -e "$READY" ] && [ "$ready_wait" -lt 200 ]; do
    sleep 0.05
    ready_wait=$((ready_wait + 1))
done
if [ -e "$READY" ]; then
    if timeout 24 env -i PATH=/usr/bin:/bin LD_PRELOAD="$PRELOAD" \
        BN_SHADOW_READY=/tmp/shadow-ready BIONILUX_ROOTFS="$ROOT" \
        BIONILUX_FAKE_ROOT=1 "$HELPER" lock-wait 14500 19000 FAIL \
        >"$TMP/timeout.log" 2>&1; then
        pass "lock contention fails with EAGAIN after 15 seconds"
    else
        fail "lock wait exceeded its bound or returned early"
        cat "$TMP/timeout.log" >&2
    fi
else
    fail "long lock holder never became ready"
    cat "$TMP/long-holder.log" >&2
fi
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true

info "simulated Android hard-link refusal"
if guest "$HELPER" protocol; then
    pass "shadow copy protocol reports nlink 2 only for its exact temporary file"
else
    fail "shadow copy protocol regression"
fi

info "ordinary stat and non-guest processes"
if "$HELPER" host; then pass "host stat, temporary file and nlink helper passthrough"; else fail "host passthrough"; fi

if [ "$FAILED" -ne 0 ]; then
    echo "$FAILED shadow compatibility check(s) failed" >&2
    exit 1
fi
echo 'shadow account lock and narrow nlink protocol: OK'
