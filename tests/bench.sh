#!/usr/bin/env bash
# End-to-end performance comparison of the runtime backends.
#
# Every case runs a real guest command through the complete runtime: launcher,
# loader, preload hook and guest shell. That is deliberate — a microbenchmark
# that only exercises the path hook measures none of the pieces that dominate
# an actual workload, and would flatter the result.
#
# Reports the median of N runs plus the spread, because a single number hides
# the variance that matters when deciding a default backend.
#
#   tests/bench.sh --launcher PATH --rootfs DIR [--runtime both]
#                 [--runs 5] [--json out.json]
#
# Both backends run on the same machine, against the same rootfs, with the same
# environment. Numbers from different devices are not comparable, and a device
# that translates x86_64 through a native bridge is not comparable to one that
# runs it natively.
set -u

LAUNCHER=""
ROOTFS=""
RUNTIMES="bionilux proot"
RUNS=5
JSON=""
LOG_DIR="${LOG_DIR:-./bench-logs}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
    case "$1" in
        --launcher) LAUNCHER="$2"; shift 2 ;;
        --rootfs)   ROOTFS="$2";   shift 2 ;;
        --runtime)  RUNTIMES="$(echo "$2" | tr ',' ' ')"; shift 2 ;;
        --runs)     RUNS="$2";     shift 2 ;;
        --json)     JSON="$2";     shift 2 ;;
        --log-dir)  LOG_DIR="$2";  shift 2 ;;
        -h|--help)  usage ;;
        *) echo "unknown argument: $1" >&2; usage ;;
    esac
done

[ -n "$LAUNCHER" ] || usage
[ -n "$ROOTFS" ] || usage
[ -x "$LAUNCHER" ] || { echo "launcher not executable: $LAUNCHER" >&2; exit 2; }
[ -d "$ROOTFS" ] || { echo "not a directory: $ROOTFS" >&2; exit 2; }
LAUNCHER="$(cd "$(dirname "$LAUNCHER")" && pwd)/$(basename "$LAUNCHER")"
ROOTFS="$(cd "$ROOTFS" && pwd)"
mkdir -p "$LOG_DIR"

GUEST_ENV=(
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "HOME=/root" "TMPDIR=/tmp" "TERM=xterm" "LANG=C.UTF-8"
)

# ─── measurement ────────────────────────────────────────────────────
# Milliseconds for one guest command, using bash's EPOCHREALTIME so no
# external timer process is needed inside the measured region.
time_guest() {
    local runtime="$1" cmd="$2" start end
    start=$(date +%s%N)
    case "$runtime" in
        bionilux) "$LAUNCHER" --rootfs "$ROOTFS" --guest-cwd / /bin/bash -c "$cmd" ;;
        proot)    env -i "${GUEST_ENV[@]}" proot -r "$ROOTFS" -0 -w / \
                      /bin/bash -c "$cmd" ;;
    esac >/dev/null 2>&1
    end=$(date +%s%N)
    echo $(( (end - start) / 1000000 ))
}

median() {
    printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END {
        if (NR % 2) print a[(NR+1)/2]; else print int((a[NR/2] + a[NR/2+1]) / 2)
    }'
}

spread() {
    printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END {
        if (NR < 2) { print 0; exit } print a[NR] - a[1]
    }'
}

# One warm-up run is discarded: the first execution pays for page cache misses
# on the launcher, loader and preload, which is a property of the machine
# rather than of the backend.
measure() {
    local runtime="$1" name="$2" cmd="$3"
    local samples=() i ms
    time_guest "$runtime" "$cmd" >/dev/null
    for i in $(seq 1 "$RUNS"); do
        ms=$(time_guest "$runtime" "$cmd")
        samples+=("$ms")
    done
    local med spr
    med=$(median "${samples[@]}")
    spr=$(spread "${samples[@]}")
    printf '%s\t%s\t%s\t%s\t%s\n' "$runtime" "$name" "$med" "$spr" "${samples[*]}" \
        >> "$LOG_DIR/raw.tsv"
    printf '  %-28s median %6s ms   spread %5s ms\n' "$name" "$med" "$spr"
    MEDIANS+=("$runtime|$name|$med|$spr")
}

# ─── cases ──────────────────────────────────────────────────────────
# Each name says what dominates, so the result can be read without guessing.
declare -a MEDIANS=()
declare -a CASE_NAMES=(
    "cold_start=/bin/true"
    "shell_start=/bin/bash -c :"
    "spawn_1=/bin/echo x (launcher + loader + preload + exec)"
    "spawn_20=20 sequential spawns"
    "open_200_inproc=200 opens inside one process (no spawn)"
    "stat_200_inproc=200 stats inside one process (no spawn)"
    "relative_200_inproc=200 relative-path stats, one process"
    "dotdot_100_inproc=100 traversals with .., one process"
    "pipe_pipeline=small shell pipeline"
)

# The distinction matters: a case that spawns a process per iteration measures
# process creation, not path handling. The in-process cases isolate mapping,
# because bash performs the open/stat itself with no fork.
case_cmd() {
    case "$1" in
        cold_start)        echo '/bin/true' ;;
        shell_start)       echo ':' ;;
        spawn_1)           echo '/bin/echo x' ;;
        spawn_20)          echo 'i=0; while [ $i -lt 20 ]; do /bin/true; i=$((i+1)); done' ;;
        open_200_inproc)   echo 'i=0; while [ $i -lt 200 ]; do exec 3</etc/os-release; exec 3<&-; i=$((i+1)); done' ;;
        stat_200_inproc)   echo 'i=0; while [ $i -lt 200 ]; do test -e /usr/bin/bash; i=$((i+1)); done' ;;
        relative_200_inproc) echo 'cd /usr/share; i=0; while [ $i -lt 200 ]; do test -e ./doc; i=$((i+1)); done' ;;
        dotdot_100_inproc) echo 'i=0; while [ $i -lt 100 ]; do test -e ../etc/hostname; i=$((i+1)); done' ;;
        pipe_pipeline)     echo 'echo abc | tr a-z A-Z | cat >/dev/null' ;;
    esac
}

: > "$LOG_DIR/raw.tsv"

printf 'runtime benchmark: %s runs per case (median, after one warm-up)\n' "$RUNS"
printf 'launcher: %s\nrootfs:   %s\n' "$LAUNCHER" "$ROOTFS"

for runtime in $RUNTIMES; do
    if [ "$runtime" = proot ] && ! command -v proot >/dev/null; then
        echo "proot not installed, skipping"
        continue
    fi
    printf '\n== %s ==\n' "$runtime"
    for entry in "${CASE_NAMES[@]}"; do
        name="${entry%%=*}"
        measure "$runtime" "$name" "$(case_cmd "$name")"
    done
done

# ─── comparison ─────────────────────────────────────────────────────
med_of() { # med_of <runtime> <case>
    awk -F'\t' -v r="$1" -v c="$2" '$1==r && $2==c { print $3 }' "$LOG_DIR/raw.tsv"
}

printf '\n== comparison ==\n'
printf '%-24s %10s %10s %8s\n' "case" "bionilux" "proot" "ratio"
for entry in "${CASE_NAMES[@]}"; do
    name="${entry%%=*}"
    b=$(med_of bionilux "$name"); p=$(med_of proot "$name")
    if [ -n "$b" ] && [ -n "$p" ] && [ "$b" -gt 0 ]; then
        ratio=$(awk -v b="$b" -v p="$p" 'BEGIN { printf "%.2fx", p / b }')
        printf '%-24s %8s ms %8s ms %8s\n' "$name" "$b" "$p" "$ratio"
    fi
done

# Per-operation figures, which are what a workload actually multiplies.
printf '\n== derived per-operation cost ==\n'
for rt in $RUNTIMES; do
    s1=$(med_of "$rt" spawn_1); s20=$(med_of "$rt" spawn_20)
    o200=$(med_of "$rt" open_200_inproc); base=$(med_of "$rt" shell_start)
    [ -n "$s1" ] && [ -n "$s20" ] && \
        awk -v r="$rt" -v a="$s1" -v b="$s20" \
            'BEGIN { printf "  %-10s per extra process spawn: %.2f ms\n", r, (b - a) / 19 }'
    [ -n "$o200" ] && [ -n "$base" ] && \
        awk -v r="$rt" -v a="$o200" -v b="$base" \
            'BEGIN { printf "  %-10s per open (in-process):   %.3f ms\n", r, (a - b) / 200 }'
done

if [ -n "$JSON" ]; then
    {
        printf '{\n  "runs": %s,\n  "launcher": "%s",\n  "rootfs": "%s",\n  "results": [\n' \
            "$RUNS" "$LAUNCHER" "$ROOTFS"
        first=1
        awk -F'\t' '{
            if (!first) printf ",\n"
            first=0
            printf "    {\"runtime\": \"%s\", \"case\": \"%s\", \"median_ms\": %s, \"spread_ms\": %s}", $1, $2, $3, $4
        } END { printf "\n" }' "$LOG_DIR/raw.tsv"
        printf '  ]\n}\n'
    } > "$JSON"
    echo "wrote $JSON"
fi
