#!/system/bin/sh
# Run the manager-device harness inside an ADB shell on the device.
#
# Usage: sh manager-device-run.sh [--all|--background|--slow-install|--verify-interrupted|--interrupt-suite]
#
# BN_APP and BN_FIXTURE must match the paths used by manager-device-bootstrap.sh.
# The manager itself runs on the app's host Node, while every guest process is
# started through the patched launcher. That is also the production split; the
# harness only substitutes a private data directory and fixture rootfs.
set -eu

APP=$BN_APP
APP_PACKAGE=$BN_PACKAGE
F=$BN_FIXTURE
STAGE=${1:---all}

test -n "$APP"
test -n "$APP_PACKAGE"
test -n "$F"
test -x "$APP/files/usr/bin/node"
test -f "$F/src/modules/manager.js"
test -f "$F/src/tests/acceptance/manager-device.mjs"

run_stage() {
  current=$1
  if [ "$(id -u)" = 0 ]; then
    exec run-as "$APP_PACKAGE" env BN_MANAGER_FIXTURE="$F" BN_MANAGER_MODULE="$F/src/modules/manager.js" BN_EXPECT_UID="$BN_EXPECT_UID" LD_LIBRARY_PATH="$APP/files/usr/lib" PATH="$APP/files/usr/bin:/system/bin" HOME="$APP/files/home" "$APP/files/usr/bin/node" "$F/src/tests/acceptance/manager-device.mjs" "$current"
  fi
  exec env BN_MANAGER_FIXTURE="$F" BN_MANAGER_MODULE="$F/src/modules/manager.js" BN_EXPECT_UID="$BN_EXPECT_UID" LD_LIBRARY_PATH="$APP/files/usr/lib" PATH="$APP/files/usr/bin:/system/bin" "$APP/files/usr/bin/node" "$F/src/tests/acceptance/manager-device.mjs" "$current"
}

if [ "$STAGE" = "--interrupt-suite" ]; then
  rm -f "$F/logs/slow-install-marker.json"
  ( run_stage --slow-install ) &
  child=$!
  waited=0
  while [ ! -f "$F/logs/slow-install-marker.json" ]; do
    if [ "$waited" -ge 900 ]; then
      echo "timed out waiting for slow-install-marker.json" >&2
      kill -9 "$child" 2>/dev/null || true
      exit 4
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$F/logs/slow-install-marker.json")
  test -n "$pid"
  kill -9 "$pid" 2>/dev/null || true
  kill -9 "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  echo "interrupted-manager-pid=$pid"
  run_stage --verify-interrupted
fi

run_stage "$STAGE"
