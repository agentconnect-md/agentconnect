#!/bin/sh
# Installs apt packages on a hosted runner: pinned .debs from CI_APT_DEBS_URL first, then its mirror list, then upstream alone.
set -eu

MIRRORS=/etc/apt/apt-mirrors.txt
UPSTREAM=https://archive.ubuntu.com/ubuntu/
APT_OPTS='-o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 -o Acquire::Retries=2'
# The pinned download plus two apt attempts leave a minute of the calling step's five for installing; healthy ones take seconds.
PINNED_SECONDS=40
ATTEMPT_SECONDS=100

# CI_APT_DEBS names a sha256sum manifest of .debs that, with what the runner image ships, provide every requested package.
pinned() {
  [ -n "${CI_APT_DEBS_URL:-}" ] && [ -n "${CI_APT_DEBS:-}" ] || return 1
  manifest=$(realpath "$CI_APT_DEBS")
  dir=$(mktemp -d)
  # One cap over every download, so a stalled host leaves the apt attempts their whole budget; keys' literal `+` is escaped.
  # shellcheck disable=SC2016 # $1 and $2 belong to the inner shell.
  awk '{ print $2 }' "$manifest" | timeout "$PINNED_SECONDS" sh -c '
    while read -r deb; do
      curl -fsSL --connect-timeout 10 --retry 2 -o "$1/$deb" "$2/$(printf %s "$deb" | sed "s/+/%2B/g")" || exit 1
    done' sh "$dir" "$CI_APT_DEBS_URL" || return 1
  (cd "$dir" && sha256sum --check --quiet "$manifest") || return 1
  # No sources: apt resolves against the given files and the installed set only, and refuses rather than fetch.
  mkdir "$dir/sources.list.d" && touch "$dir/sources.list"
  sudo apt-get install -y --no-install-recommends \
    -o Dir::Etc::SourceList="$dir/sources.list" -o Dir::Etc::SourceParts="$dir/sources.list.d" \
    "$dir"/*.deb || return 1
  dpkg -s "$@" > /dev/null
}

# Only the network half runs under the cap, so a stalled fetch is killed without interrupting dpkg.
fetch() {
  # shellcheck disable=SC2016 # $0 and $@ belong to the inner shell.
  sudo timeout "$ATTEMPT_SECONDS" sh -c \
    'apt-get $0 update && apt-get $0 install -y --no-install-recommends --download-only "$@"' \
    "$APT_OPTS" "$@"
}

if pinned "$@"; then
  exit 0
fi
echo "apt: the pinned .debs were unavailable or incomplete; installing from apt" >&2

if ! fetch "$@"; then
  echo "apt: the runner's mirror list failed or stalled; retrying against upstream alone" >&2
  if [ -f "$MIRRORS" ]; then
    echo "$UPSTREAM" | sudo tee "$MIRRORS" > /dev/null
  fi
  fetch "$@"
fi

sudo apt-get install -y --no-install-recommends --no-download "$@"
