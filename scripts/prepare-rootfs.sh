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
#  2. Name resolution. Android has no /etc/resolv.conf, and its network stack
#     does not let a guest use raw DNS, so the resolver configuration has to be
#     supplied from outside. This script only writes what it is told to; the
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
        --rootfs)          ROOTFS="$2"; shift 2 ;;
        --dns)             DNS="$2"; shift 2 ;;
        --relative-links)  MODE=relative; shift ;;
        --dry-run)         DRY=1; shift ;;
        --verify)          VERIFY=1; shift ;;
        -h|--help)         sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$ROOTFS" ] || { echo "--rootfs is required" >&2; exit 2; }
[ -d "$ROOTFS" ] || { echo "not a directory: $ROOTFS" >&2; exit 2; }

# An absolute path is required: rewritten link targets must be absolute, and a
# relative --rootfs argument would produce nonsense.
ROOTFS="$(cd "$ROOTFS" && pwd)"
ROOTFS="${ROOTFS%/}"

# Count absolute links that still point outside the rootfs.
count_external_links() {
    find "$ROOTFS" -type l 2>/dev/null | while IFS= read -r l; do
        t=$(readlink "$l" 2>/dev/null) || continue
        case "$t" in
            /*) case "$t" in "$ROOTFS"/*) ;; *) echo "$l" ;; esac ;;
        esac
    done | wc -l
}

# ── 1. absolute symlinks ────────────────────────────────────────────
echo "== absolute symlinks under $ROOTFS"
before=$(count_external_links)

if [ "$before" -gt 0 ] && [ "$VERIFY" = 1 ]; then
    echo "NEEDS-FIX $before absolute link(s) point outside the rootfs:"
    find "$ROOTFS" -type l 2>/dev/null | while IFS= read -r l; do
        t=$(readlink "$l" 2>/dev/null) || continue
        case "$t" in
            /*) case "$t" in "$ROOTFS"/*) ;; *) echo "  ${l#"$ROOTFS"} -> $t" ;; esac ;;
        esac
    done | head -10
    exit 1
fi

if [ "$DRY" = 1 ]; then
    echo "would rewrite $before absolute link(s) (mode: $MODE)"
else
    fixed=0
    find "$ROOTFS" -type l 2>/dev/null | while IFS= read -r link; do
        target=$(readlink "$link" 2>/dev/null) || continue
        case "$target" in
            /*) ;;
            *) continue ;;
        esac
        case "$target" in
            "$ROOTFS"/*) continue ;;
        esac

        if [ "$MODE" = relative ]; then
            # Walk up from the link's directory to the common ancestor, then
            # down to the target.
            link_rel=$(dirname "${link#"$ROOTFS"}")
            up=$(printf '%s' "$link_rel" | tr -cd '/' | wc -c)
            # dirname gives /a/b for a/b/c, so the depth equals the slash count.
            prefix=""
            i=0
            while [ "$i" -lt "$up" ]; do prefix="$prefix../"; i=$((i + 1)); done
            new_target="$prefix${target#/}"
        else
            new_target="$ROOTFS$target"
        fi

        ln -sfn "$new_target" "$link" \
            && fixed=$((fixed + 1)) \
            || echo "WARN: could not rewrite $link" >&2
    done
    after=$(count_external_links)
    echo "rewrote $((before - after)) link(s); external links now: $after"
fi

# ── 2. resolver configuration ───────────────────────────────────────
if [ -n "$DNS" ]; then
    if [ "$VERIFY" = 1 ]; then
        current=$(cat "$ROOTFS/etc/resolv.conf" 2>/dev/null || true)
        for ns in $DNS; do
            case "$current" in
                *"$ns"*) ;;
                *) echo "NEEDS-FIX /etc/resolv.conf is missing nameserver $ns"; exit 1 ;;
            esac
        done
        echo "/etc/resolv.conf ok"
    elif [ "$DRY" = 1 ]; then
        echo "would write /etc/resolv.conf with: $DNS"
    else
        mkdir -p "$ROOTFS/etc"
        {
            echo "# Written by bionilux prepare-rootfs.sh."
            echo "# Android has no /etc/resolv.conf and does not let a guest use"
            echo "# raw DNS, so these servers are supplied by the host application."
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
        mkdir -p "$ROOTFS/$d" 2>/dev/null || true
    fi
done
chmod 1777 "$ROOTFS/tmp" 2>/dev/null || true
chmod 1777 "$ROOTFS/var/tmp" 2>/dev/null || true

echo "done"
