#!/usr/bin/env bash
set -euo pipefail

base=${1:?base rootfs required}
archive=${2:?output archive required}
snapshot=${3:?verified Debian snapshot URL required}
suite=${4:?Debian suite required}
keyring=${5:?Debian archive keyring required}
epoch=${6:?source date required}
cross=${7:?cross architecture flag required}

workspace=$(sudo mktemp -d "${base}-workspace.XXXXXXXX")
cleanup() {
  if mountpoint -q "$workspace/proc"; then sudo umount "$workspace/proc" || return; fi
  if mountpoint -q "$workspace/dev"; then sudo umount "$workspace/dev" || return; fi
  sudo rm -rf -- "$workspace"
}
trap cleanup EXIT

sudo cp -a "$base/." "$workspace/"
sudo install -m 644 /etc/resolv.conf "$workspace/etc/resolv.conf"
sudo install -m 644 "$keyring" "$workspace/usr/share/keyrings/dsh-workspace-build.gpg"
source_file=/etc/apt/sources.list.d/dsh-workspace-build.list
printf 'deb [signed-by=/usr/share/keyrings/dsh-workspace-build.gpg] %s %s main\n' "$snapshot" "$suite" |
  sudo tee "$workspace$source_file" >/dev/null
if [[ "$cross" == true ]]; then
  sudo install -m 755 /usr/bin/qemu-aarch64-static "$workspace/usr/bin/qemu-aarch64-static"
fi
sudo mkdir -p "$workspace/dev" "$workspace/proc"
sudo mount --bind /dev "$workspace/dev"
sudo mount -t proc proc "$workspace/proc"

guest() { sudo timeout --signal=TERM --kill-after=15s 600s chroot "$workspace" "$@"; }
apt_options=(
  -o "Dir::Etc::sourcelist=$source_file"
  -o Dir::Etc::sourceparts=-
  -o Acquire::Languages=none
  -o Acquire::Retries=2
  -o Acquire::https::Timeout=30
  -o APT::Update::Error-Mode=any
)
libc_version=$(guest dpkg-query -W -f='${Version}' libc6)
guest apt-get "${apt_options[@]}" update
guest env DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" -y --no-install-recommends install git openssh-client
test "$(guest dpkg-query -W -f='${Version}' libc6)" = "$libc_version"
test -z "$(guest dpkg --audit)"
guest apt-get check
guest git --version
guest ssh -V

sudo umount "$workspace/proc"
sudo umount "$workspace/dev"
sudo rm -f "$workspace$source_file" "$workspace/usr/share/keyrings/dsh-workspace-build.gpg" \
  "$workspace/etc/resolv.conf" "$workspace/etc/machine-id" "$workspace/var/lib/dbus/machine-id" \
  "$workspace/usr/bin/qemu-aarch64-static" "$workspace/var/cache/apt/pkgcache.bin" \
  "$workspace/var/cache/apt/srcpkgcache.bin"
sudo find "$workspace/var/lib/apt/lists" "$workspace/var/cache/apt/archives" \
  -mindepth 1 -delete
sudo find "$workspace/usr/share/doc" -type f ! -name copyright -delete
sudo sh scripts/prepare-rootfs.sh --rootfs "$workspace" --relative-links
sudo sh scripts/prepare-rootfs.sh --rootfs "$workspace" --relative-links --verify

# Keep package copyrights and working software metadata. Manuals and info pages are optional here.
sudo tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  --hard-dereference --exclude='./dev/*' --exclude='./usr/share/man/*' --exclude='./usr/share/info/*' \
  --exclude='./usr/share/locale/*' \
  --xattrs --xattrs-include='*' --acls -cJf "$archive" -C "$workspace" .
sudo chmod 644 "$archive"
xz --test "$archive"
