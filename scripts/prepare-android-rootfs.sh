#!/bin/sh
# Android-only preparation for a Debian rootfs, run after prepare-rootfs.sh.
#
# libc-bin's dpkg trigger runs /usr/sbin/ldconfig, which is a static binary and
# therefore outside preload control.  On an unprivileged Android app, `-r /`
# makes it write the host's read-only /etc.  This script installs a local dpkg
# diversion that keeps the real binary as ldconfig.distrib and replaces the
# command with scripts/ldconfig-android.sh, which redirects every path into
# BIONILUX_ROOTFS.  A package upgrade keeps the diversion, so the adapter
# survives libc-bin updates.
#
# Usage:
#   prepare-android-rootfs.sh --rootfs DIR --launcher FILE --preload FILE
#                             [--linker FILE]
#
# All paths must be absolute.  The launcher runs guest commands with
# BIONILUX_ROOTFS, BIONILUX_PRELOAD and BIONILUX_FAKE_ROOT=1.
#
# --linker runs the launcher through the system dynamic linker:
#   FILE --rootfs DIR <cmd>   becomes   LINKER FILE --rootfs DIR <cmd>
# This is required on Android when the launcher sits on the app data partition.
# An app with targetSdk >= 29 may not execve that file directly -- the kernel
# refuses and bionic reports it as "Permission denied" -- while executing the
# system linker is allowed, and the linker then maps the launcher as a shared
# object.  Without it, install fails at the first guest command.
set -eu

rootfs=
launcher=
preload=
linker=

die() {
    printf 'prepare-android-rootfs: %s\n' "$*" >&2
    exit 2
}

while [ $# -gt 0 ]; do
    case $1 in
        --rootfs|--launcher|--preload|--linker)
            [ $# -ge 2 ] && [ -n "$2" ] || die "$1 requires a value"
            case $1 in
                --rootfs) rootfs=$2 ;;
                --launcher) launcher=$2 ;;
                --preload) preload=$2 ;;
                --linker) linker=$2 ;;
            esac
            shift 2
            ;;
        -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$rootfs" ]   || die '--rootfs is required'
[ -n "$launcher" ] || die '--launcher is required'
[ -n "$preload" ]  || die '--preload is required'
for p in "$rootfs" "$launcher" "$preload"; do
    case $p in /*) ;; *) die "path must be absolute: $p" ;; esac
done
[ -d "$rootfs" ] || die "rootfs is not a directory: $rootfs"
[ -x "$launcher" ] || die "launcher is not executable: $launcher"
[ -f "$preload" ] || die "preload library is missing: $preload"
if [ -n "$linker" ]; then
    case $linker in /*) ;; *) die "path must be absolute: $linker" ;; esac
    [ -x "$linker" ] || die "linker is not executable: $linker"
fi
rootfs=${rootfs%/}
[ -n "$rootfs" ] && [ "$rootfs" != / ] || die 'refusing to prepare the host root'

here=$(cd "$(dirname "$0")" && pwd -P)
adapter=${BIONILUX_LDCONFIG_ADAPTER:-$here/ldconfig-android.sh}
[ -f "$adapter" ] || die "adapter script is missing: $adapter"
grep -q 'bionilux-ldconfig-adapter-v1' "$adapter" || die "not the ldconfig adapter: $adapter"

# Runs the launcher, through the system linker when one was supplied.
# Its own function so every call site keeps one argument order.
run_launcher() {
    if [ -n "$linker" ]; then
        "$linker" "$launcher" "$@"
    else
        "$launcher" "$@"
    fi
}

guest() {
    BIONILUX_ROOTFS=$rootfs \
    BIONILUX_PRELOAD=$preload \
    BIONILUX_FAKE_ROOT=1 \
    run_launcher --rootfs "$rootfs" "$@"
}

ldconfig=$rootfs/usr/sbin/ldconfig
distrib=$rootfs/usr/sbin/ldconfig.distrib

# Ownership is decided from dpkg's machine-readable answers, not from the
# human-readable --list text: that text is translated and its wording differs
# between dpkg versions.  An empty owner with the original truename means the
# file is not diverted; LOCAL with our target is the diversion this script
# owns.  Anything else belongs to a package or another local rule.
owner=$(guest /usr/bin/dpkg-divert --listpackage /usr/sbin/ldconfig) || die 'cannot read the ldconfig diversion owner'
truename=$(guest /usr/bin/dpkg-divert --truename /usr/sbin/ldconfig) || die 'cannot read the ldconfig diversion target'

if [ -z "$owner" ]; then
    case $truename in
        ''|/usr/sbin/ldconfig)
            [ -e "$ldconfig" ] || die 'the rootfs has no /usr/sbin/ldconfig to divert'
            if ! guest /usr/bin/dpkg-divert --local --rename --add /usr/sbin/ldconfig; then
                die 'dpkg-divert failed; is dpkg installed in the rootfs?'
            fi
            ;;
        *)
            die "/usr/sbin/ldconfig is already diverted to $truename by an unknown owner"
            ;;
    esac
elif [ "$owner" = LOCAL ]; then
    case $truename in
        /usr/sbin/ldconfig.distrib) ;;
        *) die "/usr/sbin/ldconfig is diverted to $truename by a local rule that is not ours" ;;
    esac
else
    die "/usr/sbin/ldconfig diversion is not local (owned by $owner)"
fi
[ -x "$distrib" ] || die "missing $distrib after diversion"

tmp=$rootfs/usr/sbin/.ldconfig.adapter.$$
rm -f "$tmp"
cp "$adapter" "$tmp" || die 'cannot copy the adapter'
chmod 0755 "$tmp" || die 'cannot make the adapter executable'
mv -f "$tmp" "$ldconfig" || { rm -f "$tmp"; die 'cannot install the adapter'; }

guest /usr/sbin/ldconfig.distrib --version >/dev/null || die "the diverted ldconfig failed (exit $?)"

# Build the cache now.  Package triggers rebuild it later; doing it here proves
# the adapter works on this rootfs and leaves a usable cache after install.
if ! guest /usr/sbin/ldconfig; then
    die 'the ldconfig adapter failed to build the guest cache'
fi
cache=$rootfs/etc/ld.so.cache
[ -s "$cache" ] || die "no cache was written to $cache"
if ! guest /usr/sbin/ldconfig -p >/dev/null; then
    die 'the guest cache cannot be read back by ldconfig -p'
fi

printf 'ldconfig adapter installed; guest cache is %s bytes\n' "$(wc -c < "$cache")"
