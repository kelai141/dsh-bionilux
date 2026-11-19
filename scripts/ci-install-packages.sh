#!/usr/bin/env bash
# Bounded CI dependencies. Never change host sources, resolvers, TLS or APT trust.
set -euo pipefail
export LC_ALL=C
if [ "$#" -eq 0 ]; then echo 'usage: ci-install-packages.sh PACKAGE...' >&2; exit 2; fi
for package in "$@"; do
    if [[ ! "$package" =~ ^[a-z0-9][a-z0-9+.:=~-]*$ ]]; then
        echo "invalid package argument: $package" >&2; exit 2
    fi
done
mkdir -p target/independent-linux/ci-apt
work="$(mktemp -d "$PWD/target/independent-linux/ci-apt/run.XXXXXX")"
chmod 755 "$work"
common=(-o Acquire::ForceIPv4=true -o Acquire::Retries=2
        -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15
        -o DPkg::Lock::Timeout=60 -o Acquire::AllowInsecureRepositories=false
        -o Acquire::AllowDowngradeToInsecureRepositories=false
        -o APT::Get::AllowUnauthenticated=false)
sources=()
apt_update() {
    sudo timeout --signal=TERM --kill-after=15s 180s apt-get         "${common[@]}" "${sources[@]}" -o APT::Update::Error-Mode=any update
}
apt_install() {
    local limit=$1
    shift
    sudo timeout --signal=TERM --kill-after=15s "$limit" apt-get \
        "${common[@]}" "${sources[@]}" install --no-install-recommends -y "$@"
}
integrity_pattern='NO_PUBKEY|BADSIG|EXPKEYSIG|signature|not signed|Hash Sum mismatch|Certificate verification failed|does not have a Release file|Malformed|Conflicting values'
network_pattern='Could not resolve|Temporary failure resolving|Could not connect|Failed to connect|Connection timed out|Connection failed|Connection refused|Network is unreachable|Connection reset'

use_signed_mirror() {
    # The mirror below is Ubuntu amd64, not ubuntu-ports.
    . /etc/os-release
    if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 || "$(dpkg --print-architecture)" != amd64 ]]; then
        return 1
    fi
    local keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
    if [[ ! -r "$keyring" ]]; then echo 'Ubuntu archive keyring missing' >&2; return 1; fi
    cat >"$work/fallback.sources" <<'SOURCES'
Types: deb
URIs: https://mirrors.edge.kernel.org/ubuntu
Suites: noble noble-updates noble-backports noble-security
Components: main universe restricted multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
    mkdir -p "$work/lists/partial"
    chmod 755 "$work/lists" "$work/lists/partial"
    chmod 644 "$work/fallback.sources"
    sources=(-o "Dir::Etc::sourcelist=$work/fallback.sources"
             -o Dir::Etc::sourceparts=- -o "Dir::State::lists=$work/lists"
             -o APT::Get::List-Cleanup=0)
    echo '::warning::Normal Ubuntu repositories failed over the network; retrying a signed per-command mirror.'
    apt_update >"$work/fallback-update.log" 2>&1 || {
        local status=$?
        cat "$work/fallback-update.log" >&2
        return "$status"
    }
    cat "$work/fallback-update.log"
}

if apt_update >"$work/normal-update.log" 2>&1; then
    cat "$work/normal-update.log"
else
    status=$?
    # A timeout alone is not network evidence; both bounded DNS probes must fail.
    if [[ "$status" == 124 ]]; then
        dns_failed=0
        for host in archive.ubuntu.com security.ubuntu.com; do
            if ! timeout --signal=TERM --kill-after=2s 5s getent ahostsv4 "$host" >>"$work/normal-update.log" 2>&1; then
                dns_failed=$((dns_failed + 1))
            fi
        done
        if [[ "$dns_failed" == 2 ]]; then
            echo "Temporary failure resolving both required Ubuntu archive hosts" >>"$work/normal-update.log"
        fi
    fi
    cat "$work/normal-update.log" >&2
    # A different mirror must not conceal integrity, authentication or config
    # errors. Require positive network evidence, never just a nonzero exit.
    if grep -Eiq "$integrity_pattern" "$work/normal-update.log" ||
       ! grep -Eiq "$network_pattern" "$work/normal-update.log"; then
        exit "$status"
    fi
    use_signed_mirror || exit "$status"
fi

if (( ${#sources[@]} == 0 )); then
    # Give artifact downloads a separate deadline so a slow mirror cannot
    # interrupt dpkg or exhaust the job before we reach the signed fallback.
    if apt_install 240s --download-only "$@" >"$work/normal-download.log" 2>&1; then
        cat "$work/normal-download.log"
    else
        status=$?
        cat "$work/normal-download.log" >&2
        if grep -Eiq "$integrity_pattern" "$work/normal-download.log"; then exit "$status"; fi
        if ! grep -Eiq "$network_pattern" "$work/normal-download.log" &&
           ! { [[ "$status" == 124 ]] && grep -Eq '^(Get|Ign):[0-9]+ .*https?://' "$work/normal-download.log"; }; then
            exit "$status"
        fi
        use_signed_mirror || exit "$status"
    fi
fi

# Both paths retain APT Release signatures and package hashes.
apt_install 420s "$@"
