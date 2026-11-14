#!/bin/sh
# Installs apt packages on a hosted runner: pinned .debs from CI_APT_DEBS_URL first, then its mirror list, then upstream alone.
set -eu

MIRRORS=/etc/apt/apt-mirrors.txt
UPSTREAM=https://archive.ubuntu.com/ubuntu/
APT_OPTS='-o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 -o Acquire::Retries=2'
# Two attempts fit the calling step's five-minute cap; a healthy one takes about fifteen seconds.
ATTEMPT_SECONDS=100

# CI_APT_DEBS names a sha256sum manifest of .debs that, with what the runner image ships, provide every requested package.
pinned() {
  [ -n "${CI_APT_DEBS_URL:-}" ] && [ -n "${CI_APT_DEBS:-}" ] || return 1
  manifest=$(realpath "$CI_APT_DEBS")
  dir=$(mktemp -d)
  # Object keys keep the literal `+` of a Debian version, which a URL path must escape.
  awk '{ print $2 }' "$manifest" | while read -r deb; do
    curl -fsSL --retry 3 --max-time 60 -o "$dir/$deb" "$CI_APT_DEBS_URL/$(printf %s "$deb" | sed 's/+/%2B/g')" || exit 1
  done || return 1
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
