#!/usr/bin/env bash
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TMP/preload.so" "$PROJECT/src/preload/hooks.c" -ldl -pthread
cat > "$TMP/audit.c" <<'C'
#include <errno.h>
#include <stdlib.h>
int audit_open(void) { const char *s=getenv("BN_AUDIT_TEST_RESULT"); if(s) return atoi(s); errno=EACCES; return -1; }
C
cat > "$TMP/probe.c" <<'C'
#include <assert.h>
#include <errno.h>
#include <stdlib.h>
int audit_open(void);
int main(int argc,char **argv) { assert(argc==3); errno=0; assert(audit_open()==atoi(argv[1])); assert(errno==atoi(argv[2])); }
C
cc -shared -fPIC -o "$TMP/mock.so" "$TMP/audit.c"
cc -o "$TMP/probe" "$TMP/probe.c" -L"$TMP" -l:mock.so -Wl,-rpath,"$TMP"
mkdir -p "$TMP/root"
env LD_PRELOAD="$TMP/preload.so" BIONILUX_ROOTFS="$TMP/root" BIONILUX_FAKE_ROOT=1 "$TMP/probe" -1 93
env LD_PRELOAD="$TMP/preload.so" BIONILUX_ROOTFS="$TMP/root" BIONILUX_FAKE_ROOT=0 "$TMP/probe" -1 13
env LD_PRELOAD="$TMP/preload.so" BIONILUX_FAKE_ROOT=1 "$TMP/probe" -1 13
env LD_PRELOAD="$TMP/preload.so" BIONILUX_ROOTFS="$TMP/root" BIONILUX_FAKE_ROOT=1 BN_AUDIT_TEST_RESULT=42 "$TMP/probe" 42 0
echo 'audit permission refusal maps to unsupported only in virtual-root guests: OK'
