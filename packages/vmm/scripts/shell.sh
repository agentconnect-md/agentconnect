#!/usr/bin/env bash
# Opens a shell in a running VM over the forwarded ssh port.
#
# The image regenerates its ssh host keys on first boot, so a persistent
# known_hosts entry would trip the "identification has changed" check every time
# the image is rebuilt.
set -euo pipefail

PORT="${VIRT_SSH_PORT:-2222}"
LOGIN="${VIRT_SSH_USER:-root}"

nc -z 127.0.0.1 "$PORT" 2> /dev/null || {
  cat >&2 << HELPTEXT
shell.sh: nothing is listening on 127.0.0.1:${PORT}

Start the VM with the ssh port forwarded first:
  virt run image --forward ${PORT}:22

To keep it running in the background and shell in from elsewhere:
  virt run image --forward ${PORT}:22 </dev/null >vm.log 2>&1 &
HELPTEXT
  exit 1
}

exec ssh -p "$PORT" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  "${LOGIN}@127.0.0.1" "$@"
