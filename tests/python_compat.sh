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

# ── native xattr, semaphore and shared-memory probes ───────────────
for mode in xattr sem sem-threads sem-fork sem-inherit shm; do
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
# The final name must not exist during initialisation.  After the creator is
# killed, a successor must be able to create a complete semaphore with its own
# value; only a temp file may be left behind.
FAULT_NAME="/bn-sem-kill-$$"
PID_GUEST="/tmp/bn-sem-kill-$$.pid"
PID_HOST="$ROOTFS$PID_GUEST"
SEMDIR="$ROOTFS/dev/shm/.bionilux-sem"
LEAF=$(basename "$FAULT_NAME")
rm -f "$PID_HOST"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp \
    LD_PRELOAD="$PRELOAD:$FAULT_DSO" BIONILUX_PRELOAD="$PRELOAD" \
    BIONILUX_ROOTFS="$ROOTFS" BN_TEST_ROOT="$ROOTFS" \
    BN_SEM_FAULT_PAUSE="$PID_GUEST" \
    "$HELPER" sem-create "$FAULT_NAME" 23130 &
creator=$!
for _ in {1..100}; do
    [ -s "$PID_HOST" ] && break
    sleep 0.05
done
if [ ! -s "$PID_HOST" ]; then
    kill -9 "$creator" 2>/dev/null || true
    wait "$creator" 2>/dev/null || true
    fail "SIGKILL: creator never reached sem_init"
else
    child=$(cat "$PID_HOST")
    case "$child" in
        ''|*[!0-9]*) fail "SIGKILL: bad creator pid '$child'" ;;
    esac

    if [ -e "$SEMDIR/$LEAF" ]; then
        fail "SIGKILL: final name was published before initialisation"
    elif ! compgen -G "$SEMDIR/.bn-sem-tmp-*" >/dev/null; then
        fail "SIGKILL: creator left no temporary file"
    else
        kill -9 "$child" 2>/dev/null || true
        wait "$creator" 2>/dev/null || true
        if [ -e "$SEMDIR/$LEAF" ]; then
            fail "SIGKILL: final name appeared after creator death"
        elif run_guest "$HELPER" sem-check "$FAULT_NAME" 7; then
            pass "SIGKILL during sem_init leaves a reusable name"
        else
            fail "SIGKILL during sem_init poisoned the name"
        fi
    fi
fi
rm -f "$SEMDIR"/.bn-sem-tmp-* "$PID_HOST"

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
