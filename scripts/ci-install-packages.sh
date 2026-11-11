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
    if grep -Eiq 'NO_PUBKEY|BADSIG|EXPKEYSIG|signature|not signed|Hash Sum mismatch|Certificate verification failed|does not have a Release file|Malformed|Conflicting values' "$work/normal-update.log" ||
       ! grep -Eiq 'Could not resolve|Temporary failure resolving|Could not connect|Failed to connect|Connection timed out|Connection failed|Connection refused|Network is unreachable|Connection reset' "$work/normal-update.log"; then
        exit "$status"
    fi
    # The mirror below is Ubuntu amd64, not ubuntu-ports. Keep ARM64 legacy
    # runners and every other distribution on their normal required failure.
    . /etc/os-release
    if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 || "$(dpkg --print-architecture)" != amd64 ]]; then
        exit "$status"
    fi
    keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
    if [[ ! -r "$keyring" ]]; then echo 'Ubuntu archive keyring missing' >&2; exit 1; fi
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
    if apt_update >"$work/fallback-update.log" 2>&1; then
        cat "$work/fallback-update.log"
    else
        status=$?; cat "$work/fallback-update.log" >&2; exit "$status"
    fi
fi
# Both normal and fallback paths retain APT Release signatures and package hashes.
# Logs/source overrides stay under target; no global file rewrite or cleanup.
sudo timeout --signal=TERM --kill-after=15s 600s apt-get     "${common[@]}" "${sources[@]}" install --no-install-recommends -y "$@"
