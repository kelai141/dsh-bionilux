#!/system/bin/sh
# Build the private Android fixture used by manager-device.mjs.
#
# This script is deliberately separate from the harness: the harness is the
# reusable test, this script is the exact reproduction setup. It only writes
# under BN_FIXTURE and refuses a fixture path outside BN_APP.
#
# Required:
#   BN_APP             app private directory (for example /data/data/com.dsharnessmobile.shell)
#   BN_APP_UID         numeric Android UID that will run the manager
#   BN_FIXTURE         private fixture directory under BN_APP
#   BN_SOURCE_ROOTFS   existing guest rootfs to copy the minimal runtime from
#   BN_LAUNCHER        patched bionilux binary
#   BN_PRELOAD         matching preload shared object
#   BN_PACKAGE_SRC     directory containing modules/ and package.json
#   BN_HARNESS_SRC     manager-device.mjs
#
# The fixture is a minimal rootfs, not a production rootfs. Its only purpose is
# to make real guest processes start through the patched launcher.
set -eu

test -n "$BN_APP"
test -n "$BN_APP_UID"
test -n "$BN_FIXTURE"
test -n "$BN_SOURCE_ROOTFS"
test -n "$BN_LAUNCHER"
test -n "$BN_PRELOAD"
test -n "$BN_PACKAGE_SRC"
test -n "$BN_HARNESS_SRC"

case "$BN_FIXTURE" in
  "$BN_APP"/*) ;;
  *) echo "BN_FIXTURE must stay under BN_APP" >&2; exit 2 ;;
esac

F="$BN_FIXTURE"
O="$BN_SOURCE_ROOTFS"
R="$F/fixture/rootfs"
L="$R/usr/lib/x86_64-linux-gnu"

rm -rf "$F/fixture" "$F/src"
rm -rf "$F/data-main" "$F/data-background" "$F/data-overlap" "$F/data-dispose" "$F/data-interrupted" "$F/data-escaped" "$F/data-restart"
mkdir -p "$F/data" "$F/logs" "$F/src/modules" "$F/src/tests/acceptance"
mkdir -p "$F/fixture/backend/bin" "$F/fixture/backend/lib" "$F/fixture/backend/scripts"
mkdir -p "$R/tmp" "$R/etc"
mkdir -p "$R/usr/bin" "$R/usr/lib" "$R/usr/lib64" "$R/usr/share" "$R/usr/lib/node_modules/npm"
mkdir -p "$L" "$F/fixture/node/bin" "$F/fixture/node/lib/node_modules/npm"

cp -R "$BN_PACKAGE_SRC"/. "$F/src/"
cp "$BN_HARNESS_SRC" "$F/src/tests/acceptance/manager-device.mjs"

cp "$BN_LAUNCHER" "$F/fixture/backend/bin/bionilux"
cp "$BN_PRELOAD" "$F/fixture/backend/lib/libbionilux_preload.so"
chmod 755 "$F/fixture/backend/bin/bionilux"

cat > "$F/fixture/backend/scripts/prepare-rootfs.sh" <<'PREPARE'
#!/bin/sh
set -eu
rootfs=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rootfs) rootfs=$2; shift 2 ;;
    --relative-links) shift ;;
    *) shift ;;
  esac
done
test -n "$rootfs"
test -d "$rootfs"
printf 'prepared\n' > "$rootfs/etc/manager-fixture-prepared"
PREPARE
chmod 755 "$F/fixture/backend/scripts/prepare-rootfs.sh"

for f in bash dash node env; do
  cp "$O/usr/bin/$f" "$R/usr/bin/$f"
  chmod 755 "$R/usr/bin/$f"
done
ln -sfn dash "$R/usr/bin/sh"
for f in apt-get dpkg; do
  printf '#!/bin/sh\nexit 99\n' > "$R/usr/bin/$f"
  chmod 755 "$R/usr/bin/$f"
done

cp_lib() {
  name=$1
  found=0
  for candidate in "$O/usr/lib/x86_64-linux-gnu/$name"*; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      cp -a "$candidate" "$L/"
      found=1
    fi
  done
  if [ "$found" = 0 ]; then
    echo "missing guest library: $name" >&2
    exit 3
  fi
}

cp_lib libc.so.6
cp_lib libm.so.6
cp_lib libtinfo.so.6
cp_lib libnode.so.115
cp_lib libstdc++.so.6
cp_lib libgcc_s.so.1
cp_lib libz.so.1
cp_lib libuv.so.1
cp_lib libbrotlidec.so.1
cp_lib libbrotlienc.so.1
cp_lib libbrotlicommon.so.1
cp_lib libcares.so.2
cp_lib libnghttp2.so.14
cp_lib libcrypto.so.3
cp_lib libssl.so.3
cp_lib libicui18n.so.76
cp_lib libicuuc.so.76
cp_lib libicudata.so.76
cp_lib libzstd.so.1
cp "$O/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" "$L/ld-linux-x86-64.so.2"
ln -sfn ../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 "$R/usr/lib64/ld-linux-x86-64.so.2"
ln -sfn usr/bin "$R/bin"
ln -sfn usr/lib "$R/lib"
ln -sfn usr/lib64 "$R/lib64"

# Node externalizes these builtins from libnode; without them Node aborts
# before loading the harness. Copying the whole Debian nodejs share directory
# keeps this bootstrap valid for the Node build used by the guest.
cp -a "$O/usr/share/nodejs" "$R/usr/share/nodejs"
cp -a "$O/etc/os-release" "$R/etc/os-release"
printf '// fixture npm\n' > "$R/usr/lib/node_modules/npm/index.js"

cp "$R/usr/bin/node" "$F/fixture/node/bin/node"
chmod 755 "$F/fixture/node/bin/node"
printf '// fixture npm\n' > "$F/fixture/node/lib/node_modules/npm/index.js"

chown -R "$BN_APP_UID:$BN_APP_UID" "$F"
echo "fixture-ready=$F rootfs=$R"
