#!/bin/sh
# Run the daemon's vitest inside a Linux container: the descriptor-bound shim executors need
# /proc/self/fd, so their tests skip on macOS. The repo is copied into a named volume (node_modules
# holds platform binaries) and installed there once; pass `--fresh` to redo the install.
set -e
cd "$(dirname "$0")/../../.."
volume=agentconnect-linux-test
if [ "$1" = "--fresh" ]; then
  shift
  docker volume rm -f "$volume" > /dev/null 2>&1 || true
fi
docker run --rm -v "$PWD":/src:ro -v "$volume":/work -w /work node:24 sh -c '
  set -e
  if [ ! -f /work/.installed ]; then
    corepack enable >/dev/null 2>&1
    (cd /src && tar --exclude=node_modules --exclude=.git -cf - .) | tar -xf - -C /work
    corepack pnpm install --frozen-lockfile --prefer-offline >/dev/null
    touch /work/.installed
  else
    (cd /src && tar --exclude=node_modules --exclude=.git -cf - packages) | tar -xf - -C /work
  fi
  cd /work/packages/daemon && node ../../node_modules/vitest/vitest.mjs run "$@"
' sh "$@"
