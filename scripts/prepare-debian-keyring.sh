#!/usr/bin/env bash
# Ubuntu 24.04's Debian keyring can predate trixie. Add pinned official
# Debian 13 keys; never bypass gpgv or debootstrap signature verification.
set -euo pipefail
output=${1:?usage: prepare-debian-keyring.sh OUTPUT}
mkdir -p "$(dirname "$output")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for key in archive-key-13 release-13; do
  curl --fail --location --retry 4 --retry-all-errors \
    "https://ftp-master.debian.org/keys/$key.asc" -o "$work/$key.asc"
done
cat > "$work/SHA256SUMS" <<'SUMS'
6f1d277429dd7ffedcc6f8688a7ad9a458859b1139ffa026d1eeaadcbffb0da7  archive-key-13.asc
4d097bb93f83d731f475c5b92a0c2fcf108cfce1d4932792fca72d00b48d198b  release-13.asc
SUMS
(cd "$work" && sha256sum --check --strict SHA256SUMS)
for key in archive-key-13 release-13; do
  gpg --homedir "$work" --no-options --batch --dearmor \
    --output "$work/$key.gpg" "$work/$key.asc"
done
cat /usr/share/keyrings/debian-archive-keyring.gpg \
  "$work/archive-key-13.gpg" "$work/release-13.gpg" > "$output"
