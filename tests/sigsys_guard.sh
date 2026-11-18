#!/usr/bin/env bash
# SIGSYS guard coverage for the preload library.
#
# The loader entry stub installs a PROCESS-WIDE SIGSYS handler that turns a
# seccomp-trapped syscall into -ENOSYS. A guest defeats it either by putting
# SIGSYS in its blocked set (a blocked synchronous signal kills the thread) or
# by installing its own disposition (nothing is left to fill in the result).
# src/preload/hooks.c guards both: SIGSYS never enters the blocked set and
# sigaction()/signal() calls are recorded while the runtime handler stays
# installed, with non-seccomp deliveries chained to the guest's handler.
#
# The entry stub is simulated by tests/helpers/sigsys_fakestub.c, which is
# listed after the preload library so its constructor runs first (glibc
# initializes LD_PRELOAD objects in reverse order). The trapped syscall comes
# from a seccomp filter the probe installs itself, so this runs on a plain host
# glibc without a device. Negative controls run the same scenario with the
# guard disabled and with the stub absent: both must die with SIGSYS, which is
# what makes the positive assertions meaningful.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CC="${CC:-cc}"

case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) echo "sigsys_guard: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" \
    "$PROJECT/src/preload/hooks.c" -ldl -pthread
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/fakestub.so" \
    "$PROJECT/tests/helpers/sigsys_fakestub.c"
"$CC" -O2 -Wall -Wextra -Werror -o "$TMP/probe" \
    "$PROJECT/tests/helpers/sigsys_guard.c"

FAILED=0
OUT=""
RC=0
STUB=1

# capture [ENV=value ...] -- runs the probe with the preload library and,
# unless STUB is 0, the simulated entry stub. The stub is deliberately listed
# last: glibc initializes preload objects in reverse order, so its constructor
# installs the handler before the preload library initializes.
capture() {
    local preload="$TMP/preload.so"
    if [ "$STUB" -eq 1 ]; then preload="$preload:$TMP/fakestub.so"; fi
    set +e
    OUT="$(env -i PATH=/usr/bin:/bin LD_PRELOAD="$preload" "$@" "$TMP/probe" "$MODE" 2>&1)"
    RC=$?
    set -e
}

expect() { # key expected
    local got
    got="$(printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | head -n1)"
    if [ "$got" = "$2" ]; then
        printf 'PASS %s = %s\n' "$1" "$2"
    else
        printf 'FAIL %s: expected %s, got %s\n' "$1" "$2" "$got" >&2
        printf '%s\n' "$OUT" | sed 's/^/    /' >&2
        FAILED=$((FAILED + 1))
    fi
}

expect_rc() { # expected status, description
    if [ "$RC" -eq "$1" ]; then
        printf 'PASS %s (exit %s)\n' "$2" "$RC"
    else
        printf 'FAIL %s: expected exit %s, got %s\n' "$2" "$1" "$RC" >&2
        printf '%s\n' "$OUT" | sed 's/^/    /' >&2
        FAILED=$((FAILED + 1))
    fi
}

MODE=guard
capture
expect_rc 0 "guarded run completes"
expect block_rc 0
expect blocked_sigsys 0
expect blocked_sigusr1 1
expect oldset_sigsys 0
expect oldset_sigusr1 0
expect raw_block_rc 0
expect blocked_after_raw 1
expect unblock_rc 0
expect blocked_after_unblock 0
expect install_rc 0
expect install_oldact_default 1
expect query_rc 0
expect query_same 1
expect reinstall_rc 0
expect reinstall_oldact_same 1
expect reject_rc -1
expect reject_errno 22
expect chained_calls 1
expect chained_code -6
expect trap_rc -1
expect trap_errno 38

# The stub marker is optional: the preload arms on the handler that is already
# installed when no marker was published.
MODE=guard
capture BN_FAKESTUB_NO_MARKER=1
expect_rc 0 "guarded run without a stub marker completes"
expect blocked_sigsys 0
expect trap_errno 38

# A marker that does not match the installed handler is an explicit veto.
MODE=plain
capture BN_FAKESTUB_NO_MARKER=1 BIONILUX_SIGSYS_STUB=deadbeef
expect_rc 0 "marker mismatch run completes"
expect blocked_sigsys 1
expect query_same 1

# A guest seccomp filter that tags its notification keeps control of it.
MODE=tagged
capture
expect_rc 0 "tagged run completes"
expect tagged_calls 1
expect tagged_code 1
expect tagged_errno 4660
expect trap_errno 38

# signal() is recorded and chained like sigaction().
MODE=signal
capture
expect_rc 0 "signal() run completes"
expect signal_previous_default 1
expect signal_calls 1
expect signal_query_same 1
expect signal_ignored 1

# Not taken over: the hooks must forward unchanged.
MODE=plain
STUB=0
capture
STUB=1
expect_rc 0 "unstubbed run completes"
expect block_rc 0
expect blocked_sigsys 1
expect install_rc 0
expect query_rc 0
expect query_same 1

# Guard armed: a guest that blocks SIGSYS and then trips the trap survives and
# sees -ENOSYS.
MODE=die
capture
expect_rc 0 "blocked SIGSYS survives with the guard"
expect blocked_sigsys 0
expect trap_rc -1
expect trap_errno 38
expect survived 1

# Same, with the guest resetting the disposition to SIG_DFL.
MODE=die-replace
capture
expect_rc 0 "replaced disposition survives with the guard"
expect replace_rc 0
expect trap_errno 38

# Negative control 1: the same scenario with the guard switched off dies with
# SIGSYS (159 = 128 + 31).
MODE=die
capture BIONILUX_SIGSYS_GUARD=0
expect_rc 159 "blocked SIGSYS dies without the guard"

MODE=die-replace
capture BIONILUX_SIGSYS_GUARD=0
expect_rc 159 "replaced disposition dies without the guard"

# Negative control 2: no entry stub at all, so the guard stays inactive and the
# same guest dies with SIGSYS even though the guard code is present.
STUB=0
MODE=die
capture
expect_rc 159 "blocked SIGSYS dies when no stub installed a handler"
STUB=1

if [ "$FAILED" -ne 0 ]; then
    printf '\n%d SIGSYS guard assertion(s) failed\n' "$FAILED" >&2
    exit 1
fi
printf '\nSIGSYS guard tests passed (host glibc, not Android validation)\n'
