#!/bin/sh
# Installs apt packages on a hosted runner: its own mirror list first, upstream alone if that fails or stalls.
set -eu

MIRRORS=/etc/apt/apt-mirrors.txt
UPSTREAM=https://archive.ubuntu.com/ubuntu/
APT_OPTS='-o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 -o Acquire::Retries=2'
# Two attempts fit the calling step's five-minute cap; a healthy one takes about fifteen seconds.
ATTEMPT_SECONDS=100

# Only the network half runs under the cap, so a stalled fetch is killed without interrupting dpkg.
fetch() {
  # shellcheck disable=SC2016 # $0 and $@ belong to the inner shell.
  sudo timeout "$ATTEMPT_SECONDS" sh -c \
    'apt-get $0 update && apt-get $0 install -y --no-install-recommends --download-only "$@"' \
    "$APT_OPTS" "$@"
}

if ! fetch "$@"; then
  echo "apt: the runner's mirror list failed or stalled; retrying against upstream alone" >&2
  if [ -f "$MIRRORS" ]; then
    echo "$UPSTREAM" | sudo tee "$MIRRORS" > /dev/null
  fi
  fetch "$@"
fi

sudo apt-get install -y --no-install-recommends --no-download "$@"
