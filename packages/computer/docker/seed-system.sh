#!/bin/bash
# Gives a desktop a system of its own on its volume so `sudo apt install` survives the pod (computer-use.md §3.8); runs as root before the desktop starts.
set -euo pipefail

volume="${1:?usage: seed-system.sh <volume>}"
system="$volume/system"
home="$volume/home"

if [ ! -e "$system/.seeded" ]; then
  # A copy an earlier start did not finish is started over.
  rm -rf "$system"
  mkdir -p "$system"
  started=$(date +%s)
  for dir in usr etc var; do
    cp -a "/$dir" "$system/$dir"
  done
  # The excludes kept the image small; packages a person installs get all their files.
  rm -f "$system/etc/dpkg/dpkg.cfg.d/agentconnect-computer"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$system/.seeded"
  echo "seed-system: copied the image's system in $(($(date +%s) - started))s"
else
  # What the image owns follows the image; everything else is the desktop's own from here on.
  while IFS= read -r path; do
    [ -e "$path" ] || continue
    mkdir -p "$system$(dirname "$path")"
    cp -a "$path" "$system$path"
  done < /opt/agentconnect/image-owned
  image=$(dpkg-query -W -f '${Version}' chromium)
  desktop=$(dpkg-query --admindir="$system/var/lib/dpkg" -W -f '${Version}' chromium 2> /dev/null || true)
  if [ -n "$desktop" ] && dpkg --compare-versions "$desktop" lt "$image"; then
    echo "seed-system: this desktop's chromium $desktop is older than the image's $image; run 'sudo apt update && sudo apt upgrade' or reset the desktop"
  fi
fi

# The home is the user's from its first start; a later start leaves its owner and mode alone.
[ -d "$home" ] || install -d -o computer -g computer -m 0700 "$home"
printf 'computer ALL=(ALL:ALL) NOPASSWD: ALL\n' > "$system/etc/sudoers.d/computer"
chmod 0440 "$system/etc/sudoers.d/computer"
