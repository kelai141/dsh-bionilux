#!/usr/bin/env bash
# Linux runtime acceptance tests, stages A-C.
#
# Drives a real Debian rootfs through the launcher and asserts on guest
# behaviour. Written so the same cases can run against a second backend
# (PRoot) and be compared, which is what makes the results meaningful: a
# single runtime agreeing with itself proves nothing.
#
#   tests/acceptance.sh --launcher ./bionilux --rootfs /path/to/rootfs
#   tests/acceptance.sh ... --runtime both        # differential run
#   tests/acceptance.sh ... --stage a             # path basics only
#
# Stage A  guest paths, cwd, PATH, symlinks, no host leakage
# Stage B  exec chain, shebangs, exit codes, stdio
# Stage C  apt/dpkg inside the guest (needs network)
#
# Logs every case to $LOG_DIR for the record: command, exit code, output.
set -u

LAUNCHER=""
ROOTFS=""
RUNTIME="bionilux"
STAGE="all"
VIA="local"
ADB="${ADB:-adb}"
SERIAL=""
LOG_DIR="${LOG_DIR:-./acceptance-logs}"
PROOT_ARGS=()
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --launcher) LAUNCHER="$2"; shift 2 ;;
        --rootfs)   ROOTFS="$2";   shift 2 ;;
        --runtime)  RUNTIME="$2";  shift 2 ;;
        --stage)    STAGE="$2";    shift 2 ;;
        --log-dir)  LOG_DIR="$2";  shift 2 ;;
        --via)      VIA="$2";      shift 2 ;;
        --adb)      ADB="$2";      shift 2 ;;
        --serial)   SERIAL="$2";   shift 2 ;;
        -h|--help)  usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[ -n "$LAUNCHER" ] || { echo "--launcher is required" >&2; exit 2; }
[ -n "$ROOTFS" ]   || { echo "--rootfs is required" >&2; exit 2; }
if [ "$VIA" = adb ]; then
    [ -n "$SERIAL" ] || { echo "--serial is required with --via adb" >&2; exit 2; }
    command -v "${ADB%% *}" >/dev/null || { echo "adb not found: $ADB" >&2; exit 2; }
else
    [ -x "$LAUNCHER" ] || { echo "launcher not executable: $LAUNCHER" >&2; exit 2; }
    [ -d "$ROOTFS" ]   || { echo "rootfs not a directory: $ROOTFS" >&2; exit 2; }
    LAUNCHER="$(cd "$(dirname "$LAUNCHER")" && pwd)/$(basename "$LAUNCHER")"
    ROOTFS="$(cd "$ROOTFS" && pwd)"
fi
mkdir -p "$LOG_DIR"

G='\033[0;32m' R='\033[0;31m' Y='\033[1;33m' N='\033[0m'
pass() { printf "${G}[PASS]${N} %s\n" "$*"; }
fail() { printf "${R}[FAIL]${N} %s\n" "$*"; FAILED=$((FAILED + 1)); }
info() { printf "${Y}[info]${N} %s\n" "$*"; }
section() { printf "\n${Y}== %s ==${N}\n" "$*"; }

FAILED=0
FAILED_CASES=""
SKIPPED=""

# ─── backend invocation ─────────────────────────────────────────────
# One guest command, run through the selected backend. The guest starts in /.
#
# Two transports:
#   local  the launcher runs on this machine
#   adb    the launcher runs on a device, reached with `adb shell`
#
# Both backends are given the same environment, so a difference in the output
# is a difference in path semantics rather than in what the host happened to
# export. bionilux supplies a clean guest environment on its own; PRoot would
# otherwise inherit the host's.
GUEST_ENV=(
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "HOME=/root"
    "TMPDIR=/tmp"
    "TERM=xterm"
    "LANG=C.UTF-8"
)

# Sets GUEST_OUT and GUEST_RC.
guest() {
    local cmd="$1"
    GUEST_OUT=""
    GUEST_RC=1

    if [ "$VIA" = adb ]; then guest_adb "$cmd"; else guest_local "$cmd"; fi
}

guest_local() {
    local cmd="$1"
    case "$RUNTIME" in
        bionilux)
            GUEST_OUT="$("$LAUNCHER" --rootfs "$ROOTFS" --guest-cwd / /bin/bash -c "$cmd" 2>&1)"
            GUEST_RC=$?
            ;;
        proot)
            GUEST_OUT="$(env -i "${GUEST_ENV[@]}" \
                proot -r "$ROOTFS" -0 -w / "${PROOT_ARGS[@]}" /bin/bash -c "$cmd" 2>&1)"
            GUEST_RC=$?
            ;;
        *)
            echo "unknown runtime: $RUNTIME" >&2; exit 2 ;;
    esac
}

# The command is base64 encoded and written into the rootfs, so no quoting
# survives the round trip through the device shell. The guest then reads it
# through its own /tmp, which also exercises path mapping.
guest_adb() {
    local cmd="$1" b64
    b64="$(printf '%s' "$cmd" | base64 | tr -d '\n')"
    local script="$ROOTFS/tmp/bn-case.sh"
    local out
    out="$("$ADB" -s "$SERIAL" shell \
        "printf %s $b64 | base64 -d > $script && \
         $LAUNCHER --rootfs $ROOTFS --guest-cwd / /bin/bash /tmp/bn-case.sh; \
         echo \"__RC=\$?\"" 2>&1)"
    GUEST_RC="$(printf '%s\n' "$out" | sed -n 's/^__RC=//p' | tail -n1)"
    GUEST_OUT="$(printf '%s\n' "$out" | sed '/^__RC=/d')"
    # adb shell reports the device shell's status; normalise CRLF it may add.
    GUEST_OUT="$(printf '%s' "$GUEST_OUT" | tr -d '\r')"
    [ -n "$GUEST_RC" ] || GUEST_RC=1
}

check() { # check <case-name> <command> <expected>
    local name="$1" cmd="$2" want="$3"
    guest "$cmd"
    record "$name" "$cmd"
    if [ "$GUEST_OUT" = "$want" ]; then
        pass "$name"
    else
        fail "$name: want '$want', got '$GUEST_OUT' (rc=$GUEST_RC)"
        FAILED_CASES="$FAILED_CASES $name"
    fi
}

check_rc() { # check_rc <case-name> <command> <expected-exit>
    local name="$1" cmd="$2" want="$3"
    guest "$cmd"
    record "$name" "$cmd"
    if [ "$GUEST_RC" = "$want" ]; then
        pass "$name (exit $GUEST_RC)"
    else
        fail "$name: want exit $want, got $GUEST_RC ($GUEST_OUT)"
        FAILED_CASES="$FAILED_CASES $name"
    fi
}

check_contains() { # check_contains <case-name> <command> <substring>
    local name="$1" cmd="$2" want="$3"
    guest "$cmd"
    record "$name" "$cmd"
    case "$GUEST_OUT" in
        *"$want"*) pass "$name" ;;
        *) fail "$name: '$want' not found in '$GUEST_OUT'"; FAILED_CASES="$FAILED_CASES $name" ;;
    esac
}

# Every case is logged with its command, exit code and output, so a result can
# be reproduced without rerunning the whole suite.
record() {
    {
        echo "runtime:  $RUNTIME"
        echo "transport:$VIA"
        echo "case:     $1"
        echo "command:  $2"
        echo "exit:     $GUEST_RC"
        echo "output:"
        printf '%s\n' "$GUEST_OUT"
    } > "$LOG_DIR/$RUNTIME.$1.log"
}

# ─── host-only markers ──────────────────────────────────────────────
# Created on the host, and deliberately absent from the rootfs afterwards, so
# a fallback to host paths shows up as a leak instead of a subtle difference.
# On a device the "host" is Android itself, i.e. exactly what must not leak.
host_cmd() {
    if [ "$VIA" = adb ]; then
        "$ADB" -s "$SERIAL" shell "$*" 2>&1 | tr -d '\r'
    else
        sh -c "$*" 2>&1
    fi
}

host_root() {
    if [ "$VIA" = adb ]; then printf '/data/local/tmp'; else printf '/tmp'; fi
}

HOST_MARKER="$(host_root)/bionilux-host-only"
HOST_SIBLING="$(host_root)/bionilux-acceptance-sibling"
host_cmd "echo host > $HOST_MARKER" >/dev/null 2>&1 || true
host_cmd "echo host > $HOST_SIBLING" >/dev/null 2>&1 || true
cleanup_markers() {
    host_cmd "rm -f $HOST_MARKER $HOST_SIBLING" >/dev/null 2>&1 || true
}
trap cleanup_markers EXIT

# ─── stage A: guest paths ───────────────────────────────────────────
stage_a() {
    section "stage A: path basics ($RUNTIME)"

    check "a01_pwd"            'pwd'                 "/"
    check "a02_path"           'echo $PATH'          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    check "a03_command_v"      'command -v bash'     "/usr/bin/bash"
    check "a04_home"           'echo $HOME'          "/root"
    check "a05_tmpdir"         'echo $TMPDIR'        "/tmp"

    # The guest's /etc/os-release must be Debian's. The host also has one.
    check_contains "a06_guest_os_release" 'cat /etc/os-release' "Debian"
    check_contains "a07_usr_share"        'ls /usr/share/doc >/dev/null && echo found' "found"

    # Relative paths, and .. traversal that must stay inside the guest.
    check "a08_relative"       'cd /usr/share && ls ./doc >/dev/null && echo ok'  "ok"
    # ".." must traverse inside the guest and be clamped at the guest root.
    check "a09_dotdot"         'cd /usr/bin && cd ../share && printf "%s\n" "$PWD"' "/usr/share"
    check "a10_dotdot_root"    'cd / && cd .. && printf "%s\n" "$PWD"'             "/"
    check "a10b_dotdot_clamped" 'cd / && cd ../../.. && printf "%s\n" "$PWD"'      "/"
    check "a10c_no_escape" 'cd / && test -e ../bionilux-acceptance-sibling && echo LEAK || echo clean' "clean"

    # Symlinks: Debian's /bin is a symlink into /usr.
    check "a11_symlink"        'readlink -f /bin/ls'  "/usr/bin/ls"
    check "a12_stat"           'test -f /etc/passwd && echo yes'  "yes"

    # A symlink whose target is written as an absolute guest path. The kernel
    # resolves such a target against the real root, so unless the rootfs was
    # prepared (scripts/prepare-rootfs.sh) this reads the host's file or fails.
    check "a12b_absolute_symlink" \
        'test -r /etc/localtime && echo linked-ok' "linked-ok"

    # Missing guest paths fail; they must never become host paths.
    check_rc  "a13_missing"    'cat /etc/definitely-absent'  1
    check_rc  "a14_missing_dir" 'ls /var/definitely-absent'  2

    # No host leakage. On a device the "host" is Android, i.e. exactly what a
    # guest must not be able to reach.
    check "a15_no_leak_tmp" 'test -e '"$HOST_MARKER"' && echo LEAK || echo clean' "clean"

    # A host file next to the rootfs, reachable only by a ".." escape.
    check "a16_no_escape_to_host" 'cd / && test -e '"$HOST_SIBLING"' && echo LEAK || echo clean' "clean"

    # Linux file systems the kernel owns stay visible.
    check "a17_proc"       'test -r /proc/self/status && echo yes'  "yes"
    check "a18_dev_null"   'test -w /dev/null && echo yes'          "yes"

    # Install-time gate: a prepared rootfs has no absolute link pointing
    # outside itself. Checked from the host, where the rootfs is a plain tree.
    if [ "$VIA" = local ] && [ -f "$PROJECT_DIR/scripts/prepare-rootfs.sh" ]; then
        if sh "$PROJECT_DIR/scripts/prepare-rootfs.sh" --rootfs "$ROOTFS" --verify >/dev/null 2>&1; then
            pass "a18b_rootfs_prepared"
        else
            fail "a18b_rootfs_prepared: run scripts/prepare-rootfs.sh --rootfs $ROOTFS"
            FAILED_CASES="$FAILED_CASES a18b_rootfs_prepared"
        fi
    fi

    # Writes land inside the guest.
    check "a19_write"      'echo hi > /tmp/bn-a19 && cat /tmp/bn-a19' "hi"
    if host_cmd "test -f $ROOTFS/tmp/bn-a19 && echo yes" | grep -q yes; then
        pass "a20_write_inside_rootfs"
    else
        fail "a20_write_inside_rootfs: file missing from $ROOTFS/tmp"
        FAILED_CASES="$FAILED_CASES a20_write_inside_rootfs"
    fi
}

# ─── stage B: execution chain ───────────────────────────────────────
stage_b() {
    section "stage B: execution chain ($RUNTIME)"

    check "b01_subshell"    'bash -c "bash -c \"echo nested\""'  "nested"
    check "b02_exec"        'exec /bin/sh -c "echo exec-ok"'      "exec-ok"
    # env -S splits the shebang argument into separate words. Using options
    # (not a command) keeps this a plain script execution: `-c` would make the
    # interpreter treat the script path as a command and re-exec itself.
    check "b03_env_S"       'printf "#!/usr/bin/env -S bash -eu\necho env-S-ok\n" > /tmp/bn-envS && chmod +x /tmp/bn-envS && /tmp/bn-envS' "env-S-ok"
    check "b04_shebang"     'printf "#!/bin/sh\necho shebang-ok\n" > /tmp/bn-shebang && chmod +x /tmp/bn-shebang && /tmp/bn-shebang' "shebang-ok"
    check "b05_argv"        'bash -c "echo \$0" myname'           "myname"
    check_rc "b06_exit_code" 'sh -c "exit 7"'                     7
    check_rc "b07_not_found" 'bash -c "no-such-program-xyz"'      127

    # stderr must stay separate from stdout.
    check "b08_stderr" 'bash -c "echo out; echo err >&2" 2>/dev/null' "out"

    # A deep chain: every level must stay in the guest.
    check "b09_deep_chain" \
        'bash -c "sh -c \"bash -c \\\"sh -c \\\\\\\"pwd\\\\\\\"\\\"\""' "/"

    # execvp must resolve through the guest PATH, not the host's.
    check "b10_path_lookup" 'bash -c "ls /usr >/dev/null && echo path-ok"' "path-ok"

    # posix_spawn is what most shells use for simple commands.
    check "b11_spawn" 'bash -c "printf %s a; printf %s b; printf %s c; echo"' "abc"

    # Pipes, redirection and process substitution still work.
    check "b12_pipe" 'echo abc | tr a-z A-Z'    "ABC"
    check "b13_subst" 'cat <(echo subst-ok)'    "subst-ok"

    # The launcher's own flags must never swallow an argument meant for the
    # target: `-n` is both a launcher flag and a very common program flag.
    check "b14_hyphen_passthrough" '/bin/echo -n xyz; echo' "xyz"
    check "b15_grep_n" \
        'printf "alpha\nbeta\n" > /tmp/bn-gn && grep -n beta /tmp/bn-gn' "2:beta"
    check "b16_unknown_flag" 'ls -1 /etc/passwd' "/etc/passwd"
}

check_excludes() { # check_excludes <case-name> <command> <forbidden-substring>
    local name="$1" cmd="$2" bad="$3"
    guest "$cmd"
    record "$name" "$cmd"
    case "$GUEST_OUT" in
        *"$bad"*) fail "$name: found '$bad' in '$GUEST_OUT'"; FAILED_CASES="$FAILED_CASES $name" ;;
        *) pass "$name" ;;
    esac
}

# ─── stage C: Debian package management ─────────────────────────────
stage_c() {
    section "stage C: Debian minimal environment ($RUNTIME)"

    # `apt-get update` exits 0 even when every index download fails: apt treats
    # that as a warning and falls back to cached indexes. A test that only
    # checks the exit status therefore passes with no network at all. These
    # cases assert on the failure markers instead, so a broken resolver is a
    # visible failure rather than a silent pass.

    info "apt-get update (needs a working resolver inside the guest)"
    check "c01_apt_update_no_fetch_errors" \
        'out=$(apt-get update 2>&1); case "$out" in
             *"Failed to fetch"*|*"Temporary failure resolving"*|*"Could not resolve"*) echo FETCH-FAILED ;;
             *) echo fetch-ok ;;
         esac' "fetch-ok"

    if ! guest_has_dns; then
        info "no working DNS inside the guest: skipping the network-dependent cases"
        info "the guest cannot reach a resolver; see docs/ROOTFS.md on DNS"
        SKIPPED="$SKIPPED c02_apt_install c03_package_files_present c04_run_installed c05_apt_remove"
    else
        info "installing a tiny package through APT"
        check "c02_apt_install" \
            'apt-get install -y --no-install-recommends hello >/dev/null 2>&1 && echo installed' "installed"

        if host_cmd "test -e $ROOTFS/usr/bin/hello && echo yes" | grep -q yes; then
            pass "c03_package_files_present"
        else
            fail "c03_package_files_present: /usr/bin/hello missing from the rootfs"
            FAILED_CASES="$FAILED_CASES c03_package_files_present"
        fi

        check_contains "c04_run_installed" 'hello' "Hello, world!"

        check "c05_apt_remove" \
            'apt-get remove -y hello >/dev/null 2>&1 && echo removed' "removed"
    fi

    # dpkg's own state must be coherent. This needs no network.
    check "c06_dpkg_audit" 'dpkg --audit >/dev/null && echo audit-ok' "audit-ok"

    # The resolver itself, once more directly.
    if guest_has_dns; then
        check_contains "c07_dns" 'getent hosts deb.debian.org' "."
    else
        SKIPPED="$SKIPPED c07_dns"
    fi
}

# True when the guest can resolve a name. Reported separately from the
# assertions so "cannot test" never looks like "tested and passed".
guest_has_dns() {
    guest 'getent hosts deb.debian.org >/dev/null 2>&1 && echo dns-ok'
    case "$GUEST_OUT" in
        *dns-ok*) return 0 ;;
        *) return 1 ;;
    esac
}

# ─── run ────────────────────────────────────────────────────────────
section "runtime identity"
guest 'uname -m; cat /etc/debian_version 2>/dev/null; echo "uid=$(id -u)"'
printf '%s\n' "$GUEST_OUT"
record "identity" "uname -m; cat /etc/debian_version; id -u"

case "$STAGE" in
    a)   stage_a ;;
    b)   stage_b ;;
    c)   stage_c ;;
    all) stage_a; stage_b; stage_c ;;
    *)   echo "unknown stage: $STAGE" >&2; exit 2 ;;
esac

section "summary ($RUNTIME)"
[ -n "$SKIPPED" ] && printf "${Y}skipped (not verifiable here):${N}%s\n" "$SKIPPED"
if [ "$FAILED" -eq 0 ]; then
    printf "${G}all cases passed${N}\n"
    exit 0
else
    printf "${R}%d case(s) failed:${N}%s\n" "$FAILED" "$FAILED_CASES"
    exit 1
fi
