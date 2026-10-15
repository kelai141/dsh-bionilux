#!/usr/bin/env bash
# Run the complete host hook suite with non-recovering undefined-behavior checks.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cc" <<'WRAPPER'
#!/bin/sh
exec cc -fsanitize=undefined -fno-sanitize-recover=all "$@"
WRAPPER
chmod +x "$TMP/cc"
CC="$TMP/cc" bash "$PROJECT/tests/runtime.sh"
