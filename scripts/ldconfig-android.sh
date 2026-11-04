#!/bin/sh
# bionilux-ldconfig-adapter-v1
# bionilux ldconfig adapter, installed as /usr/sbin/ldconfig.
#
# Debian's ldconfig is statically linked, so the preload cannot redirect its
# file accesses.  dpkg-divert keeps the real binary at
# /usr/sbin/ldconfig.distrib and puts this script in its place.  The adapter
# still builds a real cache with the real ldconfig: it only translates guest
# paths to physical paths under BIONILUX_ROOTFS.  That keeps `ldconfig -r /`
# (libc-bin's trigger) away from the Android host's read-only /etc.
#
# Anything it cannot reproduce is a hard error.  A silent success would leave
# a stale cache behind and make a broken package install look healthy.
set -u

die() {
    printf 'bionilux-ldconfig: %s\n' "$*" >&2
    exit 2
}

rootfs=${BIONILUX_ROOTFS:-}
if [ -z "$rootfs" ]; then
    self=$0
    case $self in
        /*) ;;
        *) self=$(readlink -f -- "$self" 2>/dev/null || true) ;;
    esac
    case $self in
        */usr/sbin/ldconfig) rootfs=${self%/usr/sbin/ldconfig} ;;
        *) die 'cannot derive the rootfs; set BIONILUX_ROOTFS' ;;
    esac
fi
case $rootfs in
    /*) ;;
    *) die "BIONILUX_ROOTFS must be absolute: $rootfs" ;;
esac
while :; do
    case $rootfs in
        ?*/) rootfs=${rootfs%/} ;;
        *) break ;;
    esac
done
[ -n "$rootfs" ] && [ "$rootfs" != / ] || die 'refusing to operate on the host root'
[ -d "$rootfs" ] || die "rootfs is not a directory: $rootfs"
# In a guest child, `cd rootfs && pwd -P` is answered by the preload's getcwd
# hook and unmaps the physical root back to `/`.  The manager supplies the
# final absolute path and the checks below stay in that namespace, so keep the
# string as given.
if [ -z "${BIONILUX_GUEST_SESSION:-}" ]; then
    rootfs=$(cd "$rootfs" && pwd -P) || die "cannot resolve rootfs: $rootfs"
fi

# Cache, configuration and library paths are always below the physical
# rootfs.  readlink -f works on those even in a guest; only the rootfs itself
# is rewritten by the getcwd hook, which is why it is not canonicalized above.
resolve_path() { readlink -f -- "$1" 2>/dev/null; }

distrib="$rootfs/usr/sbin/ldconfig.distrib"
[ -x "$distrib" ] || die "missing $distrib; run prepare-android-rootfs.sh"
# A mistaken diversion can leave the adapter at both names; refuse instead of
# re-entering it endlessly through --version or --help.
grep -q 'bionilux-ldconfig-adapter-v1' "$distrib" 2>/dev/null && \
    die "$distrib is an adapter, not the real ldconfig; reinstall libc-bin"

cache=
conf=
print_cache=0
flags=
root_arg=

while [ $# -gt 0 ]; do
    arg=$1
    case $arg in
        --) shift; [ $# -eq 0 ] || die 'positional library directories are not supported' ;;
        --help|--usage|--version) "$distrib" "$arg"; exit $? ;;
        --print-cache) print_cache=1; shift ;;
        --ignore-aux-cache) flags="$flags -i"; shift ;;
        --verbose) flags="$flags -v"; shift ;;
        --root=*) root_arg=${arg#--root=}; shift ;;
        --root) [ $# -ge 2 ] && [ -n "$2" ] || die '-r/--root requires a value'; root_arg=$2; shift 2 ;;
        --cache=*) cache=${arg#--cache=}; shift ;;
        --cache) [ $# -ge 2 ] && [ -n "$2" ] || die '-C/--cache requires a value'; cache=$2; shift 2 ;;
        --conf=*) conf=${arg#--conf=}; shift ;;
        --conf) [ $# -ge 2 ] && [ -n "$2" ] || die '-f/--conf requires a value'; conf=$2; shift 2 ;;
        -*)
            cluster=${arg#-}
            while [ -n "$cluster" ]; do
                ch=${cluster%"${cluster#?}"}
                cluster=${cluster#?}
                case $ch in
                    i|X|v) flags="$flags -$ch" ;;
                    p) print_cache=1 ;;
                    r|C|f)
                        if [ -n "$cluster" ]; then
                            value=$cluster; cluster=
                        else
                            [ $# -ge 2 ] && [ -n "$2" ] || die "-$ch requires a value"
                            value=$2; shift
                        fi
                        case $ch in r) root_arg=$value ;; C) cache=$value ;; f) conf=$value ;; esac
                        ;;
                    c|l|n|N) die "unsupported option: -$ch" ;;
                    *) die "unsupported option: -$ch" ;;
                esac
            done
            shift
            ;;
        *) die "positional library directories are not supported: $arg" ;;
    esac
done

if [ -n "$root_arg" ]; then
    while :; do
        case $root_arg in
            ?*/) root_arg=${root_arg%/} ;;
            *) break ;;
        esac
    done
    [ -n "$root_arg" ] || root_arg=/
    case $root_arg in
        /|"$rootfs") ;;
        *) die "nested ldconfig root is not supported: $root_arg" ;;
    esac
fi

# Reject a lexical `..` component.  Symlink resolution is checked separately
# with readlink -f once the target exists.
reject_dotdot() {
    case "/$1/" in
        *'/../'*) die "path escapes the rootfs: $1" ;;
    esac
}

physical() {
    reject_dotdot "$1"
    case $1 in
        "$rootfs"|"$rootfs"/*) printf '%s' "$1" ;;
        /*) printf '%s%s' "$rootfs" "$1" ;;
        *) die "relative path is not supported: $1" ;;
    esac
}

cache_phys=$(physical "${cache:-/etc/ld.so.cache}")
cache_dir=${cache_phys%/*}
[ -d "$cache_dir" ] || die "cache directory does not exist: $cache_dir"
[ ! -d "$cache_phys" ] || die "cache path is a directory: $cache_phys"
cache_dir_real=$(resolve_path "$cache_dir") || die "cannot resolve $cache_dir"
case $cache_dir_real in
    "$rootfs"|"$rootfs"/*) ;;
    *) die "cache directory escapes the rootfs: $cache_dir_real" ;;
esac

mkdir -p "$rootfs/tmp" 2>/dev/null || die "cannot create $rootfs/tmp"
lockdir="$rootfs/var/lock/bionilux-ldconfig.lock"

tmp_conf=
locked=0
cleanup() {
    [ -n "$tmp_conf" ] && rm -f "$tmp_conf"
    [ "$locked" = 1 ] && rm -rf "$lockdir"
    return 0
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ "$print_cache" = 1 ]; then
    "$distrib" -p -C "$cache_phys"
    exit $?
fi

mkdir -p "$rootfs/var/lock" 2>/dev/null || die "cannot create $rootfs/var/lock"
tries=0
while ! mkdir "$lockdir" 2>/dev/null; do
    owner=$(cat "$lockdir/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
        rm -rf "$lockdir" 2>/dev/null || true
        continue
    fi
    tries=$((tries + 1))
    [ "$tries" -lt 600 ] || die "timed out waiting for $lockdir"
    sleep 0.1 2>/dev/null || sleep 1
done
printf '%s\n' "$$" > "$lockdir/pid" 2>/dev/null || true
locked=1

tmp_conf=$(mktemp "$rootfs/tmp/bionilux-ldconfig.XXXXXX") || die 'cannot create a temporary configuration'

# Append the physical directory behind a guest directory, if it exists.
add_dir() {
    reject_dotdot "$1"
    [ -d "$rootfs$1" ] || return 0
    resolved=$(resolve_path "$rootfs$1") || die "cannot resolve $rootfs$1"
    case $resolved in
        "$rootfs"|"$rootfs"/*) ;;
        *) die "library directory escapes the rootfs: $1" ;;
    esac
    printf '%s\n' "$rootfs$1" >> "$tmp_conf"
    return 0
}

# The guest's own library directories always belong in the cache.  Listing
# them explicitly also keeps this independent of /etc/ld.so.conf contents.
for dir in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib; do add_dir "$dir"; done
for dir in "$rootfs"/lib/*-linux-gnu "$rootfs"/usr/lib/*-linux-gnu; do
    [ -d "$dir" ] || continue
    printf '%s\n' "$dir" >> "$tmp_conf"
done

flatten_conf() (
    file=$1
    depth=$2
    [ "$depth" -le 8 ] || die "include nesting is too deep: $file"
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%%#*}
        line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -n "$line" ] || continue
        case $line in
            include\ *)
                pattern=${line#include }
                pattern=$(printf '%s' "$pattern" | sed 's/^[[:space:]]*//')
                case $pattern in
                    /*) reject_dotdot "$pattern" ;;
                    *) die "relative include is not supported: $pattern" ;;
                esac
                for included in "$rootfs"$pattern; do
                    [ -f "$included" ] || continue
                    real=$(resolve_path "$included") || die "cannot resolve $included"
                    case $real in
                        "$rootfs"|"$rootfs"/*) ;;
                        *) die "include escapes the rootfs: $included" ;;
                    esac
                    flatten_conf "${included#"$rootfs"}" $((depth + 1)) || exit 2
                done
                ;;
            /*) add_dir "$line" ;;
            *) die "unsupported ld.so.conf directive: $line" ;;
        esac
    done < "$rootfs$file"
)

if [ -n "$conf" ]; then
    conf_guest=$conf
    case $conf_guest in "$rootfs"*) conf_guest=${conf_guest#"$rootfs"} ;; esac
    case $conf_guest in /*) ;; *) die "relative configuration is not supported: $conf" ;; esac
    reject_dotdot "$conf_guest"
    [ -f "$rootfs$conf_guest" ] || die "configuration file does not exist: $conf"
    conf_real=$(resolve_path "$rootfs$conf_guest") || die "cannot resolve $conf"
    case $conf_real in
        "$rootfs"|"$rootfs"/*) ;;
        *) die "configuration escapes the rootfs: $conf" ;;
    esac
    flatten_conf "$conf_guest" 0 || exit 2
elif [ -f "$rootfs/etc/ld.so.conf" ]; then
    flatten_conf /etc/ld.so.conf 0 || exit 2
fi

# The real binary records physical paths.  Those are what the guest's loader
# resolves after the preload maps /lib/... to the same files.
"$distrib" $flags -i -X -C "$cache_phys" -f "$tmp_conf"
status=$?
exit "$status"
