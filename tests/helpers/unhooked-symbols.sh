#!/bin/bash
# Which path- or process-taking libc functions do guest binaries import that our
# preload does not provide?
#
# Each one is a call libc then handles internally, resolving against the host
# instead of the guest. Scanning for them is how execvpe, remove, lchmod,
# statfs64, scandir*, and the posix_spawn_file_actions path helpers were found.
#
#   R=/path/to/rootfs PRE=/path/to/libbionilux_preload.so ./unhooked-symbols.sh
# Needs an aarch64 readelf, but nothing else, and no device.
# Public libc functions that guest binaries import but our preload does not
# provide. Each one is a call that libc handles internally, resolving paths
# against the host instead of the guest.
set -u
R=${R:-/root/armroot}
PRE=${PRE:-/root/work/bn-pre-aarch64.so}
RE=/usr/bin/aarch64-linux-gnu-readelf
defined() { "$RE" --dyn-syms -W "$1" 2>/dev/null | awk '{n=$8; sub(/@.*/,"",n); if ($4=="FUNC" && $7!="UND" && n!="") print n}'; }
imported() { "$RE" --dyn-syms -W "$1" 2>/dev/null | awk '{n=$8; sub(/@.*/,"",n); if ($7=="UND" && n!="") print n}'; }
export -f defined imported
export RE
defined "$PRE" | sort -u > /tmp/ours.txt
defined "$R/lib/aarch64-linux-gnu/libc.so.6" | sort -u > /tmp/libc.txt
{ for d in bin sbin usr/bin usr/sbin; do find "$R/$d" -maxdepth 1 -type f 2>/dev/null; done
  find "$R/lib/aarch64-linux-gnu" "$R/usr/lib/aarch64-linux-gnu" -maxdepth 1 \( -name '*.so' -o -name '*.so.*' \) -type f 2>/dev/null
} | sort -u > /tmp/objs.txt
xargs -a /tmp/objs.txt -P 8 -I{} bash -c 'imported "$@"' _ {} | sort -u > /tmp/imports.txt
echo "objects=$(wc -l < /tmp/objs.txt) ours=$(wc -l < /tmp/ours.txt) libc=$(wc -l < /tmp/libc.txt) imported=$(wc -l < /tmp/imports.txt)"
echo
echo "=== imported from libc, not provided by us (filtered to path/exec/process) ==="
comm -12 /tmp/imports.txt /tmp/libc.txt | comm -23 - /tmp/ours.txt \
  | grep -iE 'exec|spawn|open|creat|stat|link|chmod|chown|utime|truncate|remove|unlink|rename|symlink|readlink|mkdir|rmdir|dir|glob|access|chdir|chroot|realpath|path|temp|mknod|fifo|mount|xattr|fork|clone|system|popen|getpw|getgr|resolve|host|dl' \
  | grep -vE '^(pthread|sem_|shm_|timer|svc|xdr|openlog|openpty|pidfd|posix_openpt|regexec|svc|openpty)' || true