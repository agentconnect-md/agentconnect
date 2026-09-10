#!/usr/bin/env bash
# Fingerprint of a runtime image's inputs for build.yaml: the shim payload digest its build exported (tree-digest.mjs
# over the helper stage's /out) plus a recipe digest over the Dockerfile and the build inputs the leg passes it. The
# recipe covers what the payload cannot — the bases' digest pins and the final stages' instructions — so any Dockerfile
# edit rebuilds, which is the safe side.
#
# Usage: runtime-image-fingerprint.sh <payload digest file> <dockerfile> <target> <platforms> <build args> <build contexts>
# Stdout (GITHUB_OUTPUT-ready): shim=<digest>, recipe=<digest>, and a multi-line `labels` carrying both as OCI labels.
set -euo pipefail

DIGEST_FILE="${1:?usage: runtime-image-fingerprint.sh <digest-file> <dockerfile> <target> <platforms> <build-args> <build-contexts>}"
DOCKERFILE="${2:?missing dockerfile}"
TARGET="${3-}"
PLATFORMS="${4-}"
BUILD_ARGS="${5-}"
BUILD_CONTEXTS="${6-}"

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

shim="$(tr -d '\n' < "$DIGEST_FILE")"
if ! [[ "$shim" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::${DIGEST_FILE} holds no payload digest: '${shim}'" >&2
  exit 1
fi
recipe="sha256:$({
  cat "$DOCKERFILE"
  printf '\n%s\n%s\n%s\n%s\n' "$TARGET" "$PLATFORMS" "$BUILD_ARGS" "$BUILD_CONTEXTS"
} | sha256)"

printf 'shim=%s\nrecipe=%s\n' "$shim" "$recipe"
printf 'labels<<EOF\nio.agentconnect.shim.digest=%s\nio.agentconnect.recipe.digest=%s\nEOF\n' "$shim" "$recipe"
