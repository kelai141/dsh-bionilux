#!/usr/bin/env bash
# Python compatibility regressions: D02 xattr and D03 sem_open/shm_open.
#
# This is glibc host coverage, not an Android device claim.  It builds the
# preload exactly the way hooks.c will use it (hooks.c followed by the
# compat fragment), then runs a native probe and real Python under a
# synthetic guest rootfs.
#
#   tests/python_compat.sh
#
# Requires cc and python3.  WSL is a valid host.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
    # A failed fault-injection assertion must not leave the paused creator
    # alive or hold the semaphore directory lock for later tests.
    for task_pid in $(jobs -pr); do kill -9 "$task_pid" 2>/dev/null || true; done
    wait || true
    rm -rf "$TMP"
}
trap cleanup EXIT

CC=${CC:-cc}
PRELOAD="$TMP/preload.so"
HELPER="$TMP/python-compat"
FAULT_DSO="$TMP/sem_init_fault.so"
ROOTFS="$TMP/root"
FAILED=0
P08_PATH=""

pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }

command -v "$CC" >/dev/null || { echo "no C compiler ($CC)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "no python3" >&2; exit 1; }
command -v timeout >/dev/null || { echo "no timeout" >&2; exit 1; }

# ── build ───────────────────────────────────────────────────────────
# Once hooks.c includes the fragment, compile hooks.c directly.  Before that
# include lands, build the same translation unit in a temporary file so the
# fragment can still be tested on its own.
if grep -q 'compat_python.inc.c' "$PROJECT/src/preload/hooks.c"; then
    PRELOAD_SRC="$PROJECT/src/preload/hooks.c"
else
    cat > "$TMP/all.c" <<EOF
#include "$PROJECT/src/preload/hooks.c"
#include "$PROJECT/src/preload/compat_python.inc.c"
EOF
    PRELOAD_SRC="$TMP/all.c"
fi
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$PRELOAD" "$PRELOAD_SRC" \
    -ldl -pthread
"$CC" -O2 -Wall -Wextra -Werror -o "$HELPER" \
    "$PROJECT/tests/helpers/python_compat.c" -pthread -ldl

# Test-only sem_init interposer.  It pauses the creator after the temporary
# file exists but before the semaphore is initialised, which makes the
# SIGKILL window deterministic.
cat > "$TMP/sem_init_fault.c" <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int sem_init(sem_t *sem, int pshared, unsigned int value) {
    typedef int (*fn_t)(sem_t *, int, unsigned int);
    static fn_t real;
    if (!real) real = (fn_t)dlsym(RTLD_NEXT, "sem_init");
    if (!real) {
        errno = ENOSYS;
        return -1;
    }

    const char *pause_path = getenv("BN_SEM_FAULT_PAUSE");
    if (pause_path && *pause_path && value == 0x5a5a) {
        int fd = open(pause_path, O_WRONLY | O_CREAT | O_APPEND, 0600);
        if (fd >= 0) {
            dprintf(fd, "%ld\n", (long)getpid());
            close(fd);
        }
        for (;;) pause();
    }
    return real(sem, pshared, value);
}
EOF
"$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$FAULT_DSO" \
    "$TMP/sem_init_fault.c" -ldl

for symbol in getxattr lgetxattr setxattr lsetxattr removexattr lremovexattr \
    listxattr llistxattr shm_open shm_unlink sem_open sem_close sem_unlink; do
    if ! nm -D "$PRELOAD" | grep -E " T $symbol$" >/dev/null; then
        echo "missing exported symbol: $symbol" >&2
        exit 1
    fi
done

# ── synthetic rootfs ────────────────────────────────────────────────
mkdir -p "$ROOTFS"/{tmp,dev/shm,root}
chmod 1777 "$ROOTFS/tmp" "$ROOTFS/dev/shm"
for d in usr lib lib64 bin; do
    if [ -e "/$d" ]; then
        ln -s "/$d" "$ROOTFS/$d"
    fi
done

run_guest() {
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
        LD_PRELOAD="$PRELOAD" BIONILUX_PRELOAD="$PRELOAD" \
        BIONILUX_ROOTFS="$ROOTFS" BN_TEST_ROOT="$ROOTFS" \
        BN_P08_PATH="$P08_PATH" "$@"
}

run_fault() {
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
        LD_PRELOAD="$PRELOAD:$FAULT_DSO" BIONILUX_PRELOAD="$PRELOAD" \
        BIONILUX_ROOTFS="$ROOTFS" BN_TEST_ROOT="$ROOTFS" \
        BN_SEM_FAULT_PAUSE="$FAULT_PID_GUEST" "$@"
}

# ── native xattr, semaphore and shared-memory probes ───────────────
for mode in xattr sem sem-prefix sem-threads sem-fork sem-inherit shm; do
    if run_guest "$HELPER" "$mode"; then
        pass "native $mode"
    else
        fail "native $mode"
    fi
done

# Without a rootfs the hooks must delegate to the host's real symbols.
if env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
    LD_PRELOAD="$PRELOAD" "$HELPER" native; then
    pass "native delegation without BIONILUX_ROOTFS"
else
    fail "native delegation without BIONILUX_ROOTFS"
fi

# ── SIGKILL while the creator is inside sem_init ────────────────────
# The final name must not exist during initialisation.  A killed creator
# leaves a private temp file; the next sem_open must remove that abandoned
# inode under the directory lock, publish its own complete object, and leave no
# accumulation.  Repeat the cycle so a one-shot cleanup cannot pass this test.
SEMDIR="$ROOTFS/dev/shm/.bionilux-sem"
FAULT_PID_GUEST="/tmp/bn-sem-fault-$$.pid"
FAULT_PID_HOST="$ROOTFS$FAULT_PID_GUEST"

temp_count() {
    find "$SEMDIR" -maxdepth 1 -type f -name '.bn-sem-tmp-*' 2>/dev/null |
        wc -l | tr -d ' '
}

temp_one() {
    find "$SEMDIR" -maxdepth 1 -type f -name '.bn-sem-tmp-*' 2>/dev/null |
        head -n 1
}

wait_for_pause() {
    for _ in {1..100}; do
        [ -s "$FAULT_PID_HOST" ] && return 0
        sleep 0.05
    done
    return 1
}

proc_start() {
    sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
}

kill_ok=1
for cycle in 1 2 3; do
    FAULT_NAME="/bn-sem-kill-$$-$cycle"
    LEAF=${FAULT_NAME#/}
    rm -f "$FAULT_PID_HOST"
    run_fault "$HELPER" sem-create "$FAULT_NAME" 23130 &
    creator=$!
    if ! wait_for_pause; then
        kill -9 "$creator" 2>/dev/null || true
        wait "$creator" 2>/dev/null || true
        fail "SIGKILL cycle $cycle: creator never reached sem_init"
        kill_ok=0
        break
    fi
    child=$(cat "$FAULT_PID_HOST")
    case "$child" in
        ''|*[!0-9]*)
            kill -9 "$creator" 2>/dev/null || true
            wait "$creator" 2>/dev/null || true
            fail "SIGKILL cycle $cycle: bad creator pid '$child'"
            kill_ok=0
            break
            ;;
    esac
    if [ -e "$SEMDIR/$LEAF" ]; then
        kill -9 "$child" 2>/dev/null || true
        wait "$creator" 2>/dev/null || true
        fail "SIGKILL cycle $cycle: final name published before initialisation"
        kill_ok=0
        break
    fi
    if [ "$(temp_count)" -lt 1 ]; then
        kill -9 "$child" 2>/dev/null || true
        wait "$creator" 2>/dev/null || true
        fail "SIGKILL cycle $cycle: creator left no temporary file"
        kill_ok=0
        break
    fi

    kill -9 "$child" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    if [ -e "$SEMDIR/$LEAF" ]; then
        fail "SIGKILL cycle $cycle: final name appeared after creator death"
        kill_ok=0
        break
    fi
    if ! run_guest "$HELPER" sem-check "$FAULT_NAME" 7; then
        fail "SIGKILL cycle $cycle: successor could not use the name"
        kill_ok=0
        break
    fi
    if [ "$(temp_count)" -ne 0 ]; then
        fail "SIGKILL cycle $cycle: abandoned temp file was not removed"
        kill_ok=0
        break
    fi
done
if [ "$kill_ok" -eq 1 ]; then
    pass "three SIGKILL cycles leave no temp accumulation"
fi

# A second creator blocked on the directory lock must not observe or remove
# the first creator's unpublished temp file.  Killing the first creator lets
# the waiter proceed and clean that now-stale inode.
LIVE_OK=1
FAULT_NAME="/bn-sem-live-$$"
rm -f "$FAULT_PID_HOST"
run_fault "$HELPER" sem-create "$FAULT_NAME" 23130 &
creator=$!
if ! wait_for_pause; then
    kill -9 "$creator" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    fail "live creator: never reached sem_init"
    LIVE_OK=0
else
    child=$(cat "$FAULT_PID_HOST")
    if [ "$(temp_count)" -ne 1 ]; then
        fail "live creator: expected one temp file, got $(temp_count)"
        LIVE_OK=0
    else
        run_guest timeout 10 "$HELPER" sem-check "/bn-sem-waiter-$$" 7 \
            >"$TMP/live-waiter.log" 2>&1 &
        waiter=$!
        sleep 0.4
        if ! kill -0 "$waiter" 2>/dev/null; then
            fail "live creator: second opener did not wait for the lock"
            LIVE_OK=0
        elif [ "$(temp_count)" -ne 1 ]; then
            fail "live creator: waiter changed the private temp directory"
            LIVE_OK=0
        fi
        kill -9 "$child" 2>/dev/null || true
        wait "$creator" 2>/dev/null || true
        if [ "$LIVE_OK" -eq 1 ] && ! wait "$waiter"; then
            fail "live creator: waiter failed: $(cat "$TMP/live-waiter.log")"
            LIVE_OK=0
        fi
        if [ "$LIVE_OK" -eq 1 ]; then
            if [ -e "$SEMDIR/${FAULT_NAME#/}" ]; then
                fail "live creator: killed creator published a final name"
                LIVE_OK=0
            elif [ "$(temp_count)" -ne 0 ]; then
                fail "live creator: waiter left abandoned temp files"
                LIVE_OK=0
            fi
        fi
    fi
fi
if [ "$LIVE_OK" -eq 1 ]; then
    pass "concurrent opener waits and cleans only after creator death"
fi

# A temp whose encoded creator still exists with the same start time is not
# proven stale.  Simulate that by renaming a killed creator's temp to this
# shell's pid and real start-time token.
IDENTITY_OK=1
FAULT_NAME="/bn-sem-identity-$$"
rm -f "$FAULT_PID_HOST"
run_fault "$HELPER" sem-create "$FAULT_NAME" 23130 &
creator=$!
if wait_for_pause; then
    child=$(cat "$FAULT_PID_HOST")
    kill -9 "$child" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    stale=$(temp_one)
    shell_start=$(proc_start $$)
    if [ -z "$stale" ] || [ -z "$shell_start" ]; then
        fail "live identity: no temp file or shell start token"
        IDENTITY_OK=0
    else
        live_name="$SEMDIR/.bn-sem-tmp-$$-$shell_start-999999"
        mv "$stale" "$live_name" || { fail "live identity: rename failed"; IDENTITY_OK=0; }
        if [ "$IDENTITY_OK" -eq 1 ]; then
            if run_guest "$HELPER" sem-check "/bn-sem-identity-live-$$" 7; then
                if [ ! -e "$live_name" ]; then
                    fail "live identity: cleanup removed a live creator's temp"
                    IDENTITY_OK=0
                fi
            else
                fail "live identity: cleanup opener failed"
                IDENTITY_OK=0
            fi
            rm -f "$live_name"
        fi
    fi
else
    kill -9 "$creator" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    fail "live identity: never reached sem_init"
    IDENTITY_OK=0
fi
if [ "$IDENTITY_OK" -eq 1 ]; then
    pass "live creator identity protects its temp file"
fi

# Fork after the parent has cached its own start token.  The child's temp must
# carry the child pid and child start time, not the inherited parent token.
FORK_OK=1
FAULT_NAME="/bn-sem-fork-create-$$"
rm -f "$FAULT_PID_HOST"
run_fault "$HELPER" sem-fork-create "$FAULT_NAME" &
creator=$!
if ! wait_for_pause; then
    kill -9 "$creator" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    fail "fork creator: child never reached sem_init"
    FORK_OK=0
else
    child=$(cat "$FAULT_PID_HOST")
    child_start=$(proc_start "$child")
    stale=$(temp_one)
    if [ -z "$child_start" ] || [ -z "$stale" ]; then
        fail "fork creator: missing child start token or temp file"
        FORK_OK=0
    else
        expected_prefix=".bn-sem-tmp-$child-$child_start-"
        case "$(basename "$stale")" in
            "$expected_prefix"*) ;;
            *)
                fail "fork creator: temp name did not use the child identity"
                FORK_OK=0
                ;;
        esac
    fi
    kill -9 "$child" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    if [ "$FORK_OK" -eq 1 ]; then
        if [ -e "$SEMDIR/${FAULT_NAME#/}" ]; then
            fail "fork creator: final name appeared after child death"
            FORK_OK=0
        elif ! run_guest "$HELPER" sem-check "$FAULT_NAME" 7; then
            fail "fork creator: successor could not recover the name"
            FORK_OK=0
        elif [ "$(temp_count)" -ne 0 ]; then
            fail "fork creator: abandoned child temp was not removed"
            FORK_OK=0
        fi
    fi
fi
if [ "$FORK_OK" -eq 1 ]; then
    pass "forked creator uses its own pid and start token"
fi

# The same pid with a different start token is pid reuse, not a live creator.
REUSE_OK=1
FAULT_NAME="/bn-sem-reuse-$$"
rm -f "$FAULT_PID_HOST"
run_fault "$HELPER" sem-create "$FAULT_NAME" 23130 &
creator=$!
if wait_for_pause; then
    child=$(cat "$FAULT_PID_HOST")
    kill -9 "$child" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    stale=$(temp_one)
    shell_start=$(proc_start $$)
    if [ -z "$stale" ] || [ -z "$shell_start" ]; then
        fail "pid reuse: no temp file or shell start token"
        REUSE_OK=0
    else
        reuse_name="$SEMDIR/.bn-sem-tmp-$$-$((shell_start + 1))-999999"
        mv "$stale" "$reuse_name" || { fail "pid reuse: rename failed"; REUSE_OK=0; }
        if [ "$REUSE_OK" -eq 1 ]; then
            if ! run_guest "$HELPER" sem-check "/bn-sem-reuse-check-$$" 7; then
                fail "pid reuse: cleanup opener failed"
                REUSE_OK=0
            elif [ -e "$reuse_name" ]; then
                fail "pid reuse: mismatched start token was treated as live"
                REUSE_OK=0
            fi
            rm -f "$reuse_name"
        fi
    fi
else
    kill -9 "$creator" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    fail "pid reuse: never reached sem_init"
    REUSE_OK=0
fi
if [ "$REUSE_OK" -eq 1 ]; then
    pass "pid reuse is detected by the encoded start token"
fi

# Foreign names, wrong magic, symlinks and a fresh legacy name must survive.
# An old zero-size legacy name is still eligible for reclamation.
SAFE_OK=1
foreign="$SEMDIR/.bn-sem-tmp-not-a-pid"
foreign_live="$SEMDIR/.bn-sem-tmp-$$-not-a-token"
wrong_magic="$SEMDIR/.bn-sem-tmp-999999-123-1"
legacy_old="$SEMDIR/.bn-sem-tmp-999999-1"
legacy_recent="$SEMDIR/.bn-sem-tmp-999999-2"
legacy_live="$SEMDIR/.bn-sem-tmp-$$-3"
legacy_future="$SEMDIR/.bn-sem-tmp-999998-4"
legacy_foreign="$SEMDIR/.bn-sem-tmp-999997-5"
symlink="$SEMDIR/.bn-sem-tmp-424242-777-1"
symlink_target="$TMP/sem-keep-target"
printf 'foreign\n' >"$foreign"
printf 'foreign-live\n' >"$foreign_live"
dd if=/dev/zero of="$wrong_magic" bs=48 count=1 status=none 2>/dev/null ||
    head -c 48 /dev/zero >"$wrong_magic"
: >"$legacy_old"
touch -d '2 minutes ago' "$legacy_old"
: >"$legacy_recent"
: >"$legacy_live"
touch -d '2 minutes ago' "$legacy_live"
: >"$legacy_future"
touch -d '1 hour' "$legacy_future"
dd if=/dev/zero bs=48 count=1 2>/dev/null | tr '\0' 'A' >"$legacy_foreign"
touch -d '2 minutes ago' "$legacy_foreign"
printf 'keep\n' >"$symlink_target"
ln -s "$symlink_target" "$symlink"

if ! run_guest "$HELPER" sem-check "/bn-sem-safety-$$" 7; then
    fail "cleanup safety: opener failed"
    SAFE_OK=0
elif [ ! -e "$foreign" ]; then
    fail "cleanup safety: removed a foreign prefix file"
    SAFE_OK=0
elif [ ! -e "$foreign_live" ]; then
    fail "cleanup safety: removed a malformed file with a live pid"
    SAFE_OK=0
elif [ ! -e "$wrong_magic" ]; then
    fail "cleanup safety: removed a regular file with wrong magic"
    SAFE_OK=0
elif [ ! -e "$symlink" ] || [ ! -e "$symlink_target" ]; then
    fail "cleanup safety: followed or removed a symlink"
    SAFE_OK=0
elif [ -e "$legacy_old" ]; then
    fail "cleanup safety: did not reclaim an old legacy temp"
    SAFE_OK=0
elif [ ! -e "$legacy_recent" ]; then
    fail "cleanup safety: removed a fresh legacy temp without a grace period"
    SAFE_OK=0
elif [ ! -e "$legacy_live" ]; then
    fail "cleanup safety: removed an old legacy temp whose pid is live"
    SAFE_OK=0
elif [ ! -e "$legacy_future" ]; then
    fail "cleanup safety: treated a future mtime as old"
    SAFE_OK=0
elif [ ! -e "$legacy_foreign" ]; then
    fail "cleanup safety: removed a legacy-named foreign completed header"
    SAFE_OK=0
fi
rm -f "$foreign" "$foreign_live" "$wrong_magic" "$legacy_recent" "$legacy_live" \
    "$legacy_future" "$legacy_foreign" "$symlink" "$symlink_target"
if [ "$SAFE_OK" -eq 1 ]; then
    pass "cleanup preserves foreign, wrong-magic and symlink entries"
fi

# A normal non-root app runs with a root-owned, mode-1777 /dev/shm and a
# root-owned 0777 protocol directory.  Ownership checks must use the real
# effective uid, not the guest's virtual root, and must not clean another
# uid's files.
NR_UID="$(getent passwd nobody 2>/dev/null | cut -d: -f3 || true)"
NR_GID="$(getent passwd nobody 2>/dev/null | cut -d: -f4 || true)"
if [ "$(id -u)" -eq 0 ] && [ -n "$NR_UID" ] && [ -n "$NR_GID" ] &&
   command -v setpriv >/dev/null; then
    NONROOT="$TMP/nonroot"
    NONROOT_SEM="$NONROOT/dev/shm/.bionilux-sem"
    NR_MARKER_GUEST="/tmp/bn-sem-nonroot-$$.pid"
    NR_MARKER_HOST="$NONROOT$NR_MARKER_GUEST"
    mkdir -p "$NONROOT"/{tmp,dev/shm}
    chmod 1777 "$NONROOT/tmp" "$NONROOT/dev/shm"
    mkdir -p "$NONROOT_SEM"
    chown 0:0 "$NONROOT_SEM"
    chmod 777 "$NONROOT_SEM"
    chmod 755 "$TMP" "$NONROOT" "$NONROOT/dev"

    run_nonroot() {
        setpriv --reuid="$NR_UID" --regid="$NR_GID" --clear-groups \
            env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
            LD_PRELOAD="$PRELOAD" BIONILUX_PRELOAD="$PRELOAD" \
            BIONILUX_ROOTFS="$NONROOT" BN_TEST_ROOT="$NONROOT" "$@"
    }
    run_nonroot_fault() {
        setpriv --reuid="$NR_UID" --regid="$NR_GID" --clear-groups \
            env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
            LD_PRELOAD="$PRELOAD:$FAULT_DSO" BIONILUX_PRELOAD="$PRELOAD" \
            BIONILUX_ROOTFS="$NONROOT" BN_TEST_ROOT="$NONROOT" \
            BN_SEM_FAULT_PAUSE="$NR_MARKER_GUEST" "$@"
    }

    NONROOT_OK=1
    if [ "$(stat -c %u "$NONROOT_SEM")" -ne 0 ] ||
       [ "$(stat -c %a "$NONROOT_SEM")" != 777 ]; then
        fail "non-root: protocol directory is not root-owned 0777"
        NONROOT_OK=0
    fi

    nr_name="/bn-sem-nonroot-$$"
    rm -f "$NR_MARKER_HOST"
    run_nonroot_fault "$HELPER" sem-create "$nr_name" 23130 &
    nrc=$!
    for _ in {1..100}; do
        [ -s "$NR_MARKER_HOST" ] && break
        sleep 0.05
    done
    if [ ! -s "$NR_MARKER_HOST" ]; then
        kill -9 "$nrc" 2>/dev/null || true
        wait "$nrc" 2>/dev/null || true
        fail "non-root: creator never reached sem_init"
        NONROOT_OK=0
    else
        nrchild=$(cat "$NR_MARKER_HOST")
        nrtemp=$(find "$NONROOT_SEM" -maxdepth 1 -type f -name '.bn-sem-tmp-*' |
                 head -n 1)
        if [ -z "$nrtemp" ]; then
            fail "non-root: creator left no temp file"
            NONROOT_OK=0
        elif [ "$(stat -c %u "$nrtemp")" -ne "$NR_UID" ]; then
            fail "non-root: temp file is not owned by the real app uid"
            NONROOT_OK=0
        fi
        kill -9 "$nrchild" 2>/dev/null || true
        wait "$nrc" 2>/dev/null || true
        if [ "$NONROOT_OK" -eq 1 ]; then
            if ! run_nonroot "$HELPER" sem-check "$nr_name" 7; then
                fail "non-root: successor could not recover the name"
                NONROOT_OK=0
            elif [ -n "$(find "$NONROOT_SEM" -maxdepth 1 -type f -name '.bn-sem-tmp-*')" ]; then
                fail "non-root: own abandoned temp was not removed"
                NONROOT_OK=0
            fi
        fi
    fi

    # A root-owned stale temp in the same 0777 directory belongs to another
    # real uid and must survive the non-root cleanup pass.
    ROOT_MARKER_GUEST="/tmp/bn-sem-root-$$.pid"
    ROOT_MARKER_HOST="$NONROOT$ROOT_MARKER_GUEST"
    root_name="/bn-sem-root-owner-$$"
    rm -f "$ROOT_MARKER_HOST"
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
        LD_PRELOAD="$PRELOAD:$FAULT_DSO" BIONILUX_PRELOAD="$PRELOAD" \
        BIONILUX_ROOTFS="$NONROOT" BN_TEST_ROOT="$NONROOT" \
        BN_SEM_FAULT_PAUSE="$ROOT_MARKER_GUEST" \
        "$HELPER" sem-create "$root_name" 23130 &
    rootc=$!
    for _ in {1..100}; do
        [ -s "$ROOT_MARKER_HOST" ] && break
        sleep 0.05
    done
    if [ ! -s "$ROOT_MARKER_HOST" ]; then
        kill -9 "$rootc" 2>/dev/null || true
        wait "$rootc" 2>/dev/null || true
        fail "non-root: root-owned fixture never reached sem_init"
        NONROOT_OK=0
    else
        rootchild=$(cat "$ROOT_MARKER_HOST")
        roottemp=$(find "$NONROOT_SEM" -maxdepth 1 -type f -name '.bn-sem-tmp-*' |
                   head -n 1)
        kill -9 "$rootchild" 2>/dev/null || true
        wait "$rootc" 2>/dev/null || true
        if [ -z "$roottemp" ] || [ "$(stat -c %u "$roottemp")" -ne 0 ]; then
            fail "non-root: root-owned fixture was not created"
            NONROOT_OK=0
        elif ! run_nonroot "$HELPER" sem-check "/bn-sem-nonroot-other-$$" 7; then
            fail "non-root: foreign-owner cleanup opener failed"
            NONROOT_OK=0
        elif [ ! -e "$roottemp" ]; then
            fail "non-root: removed another real uid's temp file"
            NONROOT_OK=0
        fi
        rm -f "$roottemp"
    fi
    if [ "$NONROOT_OK" -eq 1 ]; then
        pass "root-owned 0777 directory works for a non-root app uid"
    fi
else
    printf '[SKIP] non-root ownership test (needs root, setpriv and nobody)\n'
fi

# ── P08: cp -RpL source that exists only in the guest ──────────────
SRC="$ROOTFS/root/polyglot/projects/erlang-cowboy/src"
DST="$ROOTFS/root/bn-fixes/cowboy-copy"
mkdir -p "$SRC/sub" "$ROOTFS/root/bn-fixes"
printf 'erlang\n' > "$SRC/cowboy.erl"
printf 'nested\n' > "$SRC/sub/nested.erl"
python3 - "$SRC/cowboy.erl" <<'PY'
import os, sys
os.setxattr(sys.argv[1], "user.p08", b"preserve-me")
PY

if P08_PATH=/root/polyglot/projects/erlang-cowboy/src run_guest "$HELPER" p08; then
    pass "P08 llistxattr on a guest-only directory"
else
    fail "P08 llistxattr on a guest-only directory"
fi

rm -rf "$DST"
if output="$(run_guest cp -RpL /root/polyglot/projects/erlang-cowboy/src \
        /root/bn-fixes/cowboy-copy 2>&1)"; then
    if [ -f "$DST/cowboy.erl" ] && [ -f "$DST/sub/nested.erl" ] &&
       ! printf '%s\n' "$output" | grep -qiE 'ENOENT|preserving'; then
        pass "P08 cp -RpL copied a guest-only tree"
    else
        fail "P08 cp -RpL output or result was wrong: $output"
    fi
else
    fail "P08 cp -RpL failed: $output"
fi

# ── real Python: xattr, multiprocessing semaphores, shared memory ──
cat > "$ROOTFS/tmp/python_compat_probe.py" <<'PY'
import errno
import faulthandler
import multiprocessing as mp
import os
import shutil
from multiprocessing import shared_memory

faulthandler.dump_traceback_later(20, repeat=False)


def xattr_probe():
    src = "/tmp/bn-python-xattr-src"
    dst = "/tmp/bn-python-xattr-dst"
    for path in (src, dst):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    with open(src, "wb") as stream:
        stream.write(b"python")

    os.setxattr(src, "user.python", b"python-value")
    assert os.getxattr(src, "user.python") == b"python-value"
    assert "user.python" in os.listxattr(src)
    assert "user.python" in os.listxattr(src, follow_symlinks=False)
    with open(src, "rb") as stream:
        assert stream.read() == b"python"

    os.setxattr(src, "user.copy", b"copy-me")
    print("stage: copy2", flush=True)
    shutil.copy2(src, dst)
    assert os.getxattr(dst, "user.copy") == b"copy-me"

    directory = "/tmp/bn-python-xattr-dir"
    shutil.rmtree(directory, ignore_errors=True)
    os.mkdir(directory)
    assert os.listxattr(directory) >= []
    assert os.listxattr(directory, follow_symlinks=False) >= []

    os.removexattr(src, "user.python")
    try:
        os.getxattr(src, "user.python")
    except OSError as error:
        assert error.errno == errno.ENODATA
    else:
        raise AssertionError("removed xattr was still readable")

    missing = "/tmp/bn-python-xattr-missing"
    try:
        os.getxattr(missing, "user.python")
    except OSError as error:
        assert error.errno == errno.ENOENT
    else:
        raise AssertionError("missing guest path fell back to the host")


def semaphore_probe(ctx):
    start = ctx.Semaphore(0)
    done = ctx.Semaphore(0)

    def child():
        print("stage: semaphore child enter", flush=True)
        start.acquire()
        print("stage: semaphore child acquired", flush=True)
        done.release()
        print("stage: semaphore child released", flush=True)

    process = ctx.Process(target=child)
    print("stage: semaphore start", flush=True)
    process.start()
    start.release()
    print("stage: semaphore parent released", flush=True)
    done.acquire()
    print("stage: semaphore parent acquired", flush=True)
    process.join(10)
    assert process.exitcode == 0, process.exitcode
    print("stage: semaphore done", flush=True)


def shared_memory_probe(ctx):
    shm = shared_memory.SharedMemory(create=True, size=4096)
    shm.buf[:6] = b"python"

    def child(name):
        child_shm = shared_memory.SharedMemory(name=name)
        assert bytes(child_shm.buf[:6]) == b"python"
        child_shm.buf[:5] = b"child"
        child_shm.close()

    process = ctx.Process(target=child, args=(shm.name,))
    print("stage: shared_memory start", flush=True)
    process.start()
    process.join(10)
    assert process.exitcode == 0, process.exitcode
    assert bytes(shm.buf[:5]) == b"child"
    print("stage: shared_memory done", flush=True)
    shm.close()
    shm.unlink()


print("stage: xattr", flush=True)
xattr_probe()
print("stage: xattr done", flush=True)
ctx = mp.get_context("fork")
semaphore_probe(ctx)
shared_memory_probe(ctx)
print("PYTHON-COMPAT-OK")
PY

if output="$(run_guest timeout 60 python3 /tmp/python_compat_probe.py 2>&1)"; then
    if printf '%s\n' "$output" | grep -qx 'PYTHON-COMPAT-OK'; then
        pass "Python xattr, multiprocessing semaphore and shared_memory"
    else
        fail "Python probe produced no completion marker: $output"
    fi
else
    fail "Python probe failed: $output"
fi

if [ "$FAILED" -ne 0 ]; then
    printf '%d python compatibility check(s) failed\n' "$FAILED" >&2
    exit 1
fi
printf 'python compatibility: all checks passed\n'
