#!/bin/sh
# Prepare a Debian rootfs for bionilux / the DSH Linux runtime.
#
# Two things a rootfs needs before a guest can use it on Android, both of which
# bionilux deliberately does *not* fix at run time:
#
#  1. Absolute symbolic links. A Debian rootfs contains links such as
#     /etc/localtime -> /usr/share/zoneinfo/Etc/UTC. The kernel resolves that
#     target against the real root, so inside a guest it silently reaches the
#     *host's* file of the same name instead of the guest's. Rewriting them to
#     point inside the rootfs keeps resolution where it belongs. Relative links
#     need no work: they already resolve inside the guest.
#
#  2. Name resolution. Android has no standard /etc/resolv.conf, so the guest's
#     resolver configuration must be supplied from outside. DNS reachability
#     depends on the device and network. This script only writes what it is told to; the
#     DSH plugin is responsible for learning the device's DNS servers and
#     passing them here.
#
# Usage:
#   prepare-rootfs.sh --rootfs DIR [--dns "1.2.3.4 5.6.7.8"] [--relative-links]
#                     [--dry-run] [--verify]
#
#   --rootfs DIR        rootfs to modify (required)
#   --dns "A B"         write /etc/resolv.conf with these nameservers
#   --relative-links    rewrite absolute links as relative instead of
#                       rootfs-absolute. Keeps the rootfs relocatable, but the
#                       guest then sees a relative link target.
#   --dry-run           report what would change, change nothing
#   --verify            only check, and fail if anything needs fixing
set -eu

ROOTFS=""
DNS=""
MODE=absolute
DRY=0
VERIFY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --rootfs|--dns)
            [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 requires a value" >&2; exit 2; }
            case "$1" in --rootfs) ROOTFS="$2" ;; --dns) DNS="$2" ;; esac
            shift 2 ;;
        --relative-links)  MODE=relative; shift ;;
        --dry-run)         DRY=1; shift ;;
        --verify)          VERIFY=1; shift ;;
        -h|--help)         sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$ROOTFS" ] || { echo "--rootfs is required" >&2; exit 2; }
[ -d "$ROOTFS" ] || { echo "not a directory: $ROOTFS" >&2; exit 2; }

[ "$DRY$VERIFY" != 11 ] || { echo "--dry-run and --verify are mutually exclusive" >&2; exit 2; }
ROOTFS="$(cd "$ROOTFS" && pwd -P)"
[ "$ROOTFS" != / ] || { echo "refusing to prepare the host root /" >&2; exit 2; }
ROOTFS="${ROOTFS%/}"

# Capture find's status before entering a pipeline: unreadable trees must fail.
links=$(find "$ROOTFS" -type l) || exit 1
count_pending_links() {
    printf '%s\n' "$links" | while IFS= read -r link; do
        [ -n "$link" ] || continue
        target=$(readlink "$link") || exit 1
        case "$target" in
            "$ROOTFS"|"$ROOTFS"/*) [ "$MODE" != relative ] || echo "$link" ;;
            /*) echo "$link" ;;
        esac
    done | wc -l
}

echo "== absolute symlinks under $ROOTFS"
before=$(count_pending_links)
if [ "$VERIFY" = 1 ]; then
    [ "$before" -eq 0 ] || { echo "NEEDS-FIX $before absolute link(s) need rewriting"; exit 1; }
elif [ "$DRY" = 1 ]; then
    echo "would rewrite $before absolute link(s) (mode: $MODE)"
else
    printf '%s\n' "$links" | while IFS= read -r link; do
        [ -n "$link" ] || continue
        target=$(readlink "$link") || exit 1
        case "$target" in /*) ;; *) continue ;; esac
        case "$target" in
            "$ROOTFS") guest_target=/ ;;
            "$ROOTFS"/*) guest_target="${target#"$ROOTFS"}" ;;
            *) guest_target="$target" ;;
        esac
        if [ "$MODE" = relative ]; then
            directory=$(dirname "${link#"$ROOTFS"/}")
            prefix=""
            while [ "$directory" != . ]; do
                prefix="../$prefix"
                directory=$(dirname "$directory")
            done
            new_target="$prefix${guest_target#/}"
            [ -n "$new_target" ] || new_target=.
        else
            new_target="$ROOTFS$guest_target"
        fi
        [ "$target" != "$new_target" ] || continue
        ln -sfn "$new_target" "$link" || exit 1
    done
    after=$(count_pending_links)
    [ "$after" -eq 0 ] || { echo "NEEDS-FIX $after link(s) still need rewriting" >&2; exit 1; }
    echo "rewrote $before link(s); pending links now: $after"
fi

# ── 2. resolver configuration ───────────────────────────────────────
if [ -n "$DNS" ]; then
    if [ "$VERIFY" = 1 ]; then
        for ns in $DNS; do
            awk -v ns="$ns" '$1 == "nameserver" && $2 == ns { found=1 } END { exit !found }' \
                "$ROOTFS/etc/resolv.conf" || {
                echo "NEEDS-FIX /etc/resolv.conf is missing nameserver $ns"; exit 1;
            }
        done
        echo "/etc/resolv.conf ok"
    elif [ "$DRY" = 1 ]; then
        echo "would write /etc/resolv.conf with: $DNS"
    else
        mkdir -p "$ROOTFS/etc"
        {
            echo "# Written by bionilux prepare-rootfs.sh."
            echo "# DNS servers supplied by the host application."
            for ns in $DNS; do echo "nameserver $ns"; done
        } > "$ROOTFS/etc/resolv.conf"
        echo "wrote /etc/resolv.conf: $(echo "$DNS" | tr ' ' ',')"
    fi
fi

# ── 3. directories the guest expects to exist ───────────────────────
for d in tmp var/tmp proc sys dev dev/shm root; do
    if [ "$DRY" = 1 ]; then
        [ -d "$ROOTFS/$d" ] || echo "would create /$d"
    elif [ "$VERIFY" = 1 ]; then
        [ -d "$ROOTFS/$d" ] || { echo "NEEDS-FIX /$d missing"; exit 1; }
    else
        mkdir -p "$ROOTFS/$d"
    fi
done
for d in tmp var/tmp; do
    if [ "$VERIFY" = 1 ]; then
        [ "$(stat -c %a "$ROOTFS/$d")" = 1777 ] || {
            echo "NEEDS-FIX /$d must have mode 1777"; exit 1;
        }
    elif [ "$DRY" = 1 ]; then
        if [ ! -d "$ROOTFS/$d" ] || [ "$(stat -c %a "$ROOTFS/$d")" != 1777 ]; then
            echo "would set /$d mode to 1777"
        fi
    else
        chmod 1777 "$ROOTFS/$d"
    fi
done

echo "done"
