#!/usr/bin/env bash
# Effective version of a runtime image at a release, decided by the previous same-channel image's fingerprint labels
# rather than by changed paths: when its shim payload and recipe digests equal this release's, the image is unchanged
# and its effective version is the build the previous tag points at; otherwise this release builds it.
#
# Usage: runtime-image-effective.sh <image ref without tag> <version> <previous same-channel tag or ''> <shim digest> <recipe digest>
# Stdout (GITHUB_OUTPUT-ready): effective=<tag> and unchanged=true|false. Stderr: the reason.
set -euo pipefail

IMAGE="${1:?usage: runtime-image-effective.sh <image> <version> <previous-tag> <shim-digest> <recipe-digest>}"
VERSION="${2:?missing version}"
PREVIOUS="${3-}"
SHIM="${4:?missing shim digest}"
RECIPE="${5:?missing recipe digest}"

SHIM_LABEL=io.agentconnect.shim.digest
RECIPE_LABEL=io.agentconnect.recipe.digest
VERSION_LABEL=io.agentconnect.image.version

emit() {
  printf 'effective=%s\nunchanged=%s\n' "$1" "$2"
  echo "$3" >&2
}
build() {
  emit "$VERSION" false "$1 — building ${IMAGE##*/}:${VERSION}"
  exit 0
}

[ -n "$PREVIOUS" ] || build "no previous release on this channel"

errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
if ! labels="$(docker buildx imagetools inspect "${IMAGE}:${PREVIOUS}" --format '{{json .Image.Config.Labels}}' 2> "$errors")"; then
  build "${IMAGE}:${PREVIOUS} is unavailable ($(tr '\n' ' ' < "$errors"))"
fi
label() {
  jq -r --arg key "$1" 'if type == "object" then .[$key] // empty else empty end' <<< "$labels"
}
previous_shim="$(label "$SHIM_LABEL")"
previous_recipe="$(label "$RECIPE_LABEL")"
if [ -z "$previous_shim" ] || [ -z "$previous_recipe" ]; then
  build "${IMAGE}:${PREVIOUS} carries no fingerprint labels"
fi
[ "$previous_shim" = "$SHIM" ] || build "the shim payload changed since ${PREVIOUS} (${previous_shim} → ${SHIM})"
[ "$previous_recipe" = "$RECIPE" ] || build "the image recipe changed since ${PREVIOUS} (${previous_recipe} → ${RECIPE})"

# An alias shares its source's config, so the previous tag's version label names the build it points at.
effective="$(label "$VERSION_LABEL")"
if [ -z "$effective" ]; then
  effective="$PREVIOUS"
elif [ "$effective" != "$PREVIOUS" ] && ! docker buildx imagetools inspect "${IMAGE}:${effective}" > /dev/null 2>&1; then
  echo "::warning::${IMAGE}:${effective} is unavailable; ${IMAGE}:${PREVIOUS} stands in as the effective version" >&2
  effective="$PREVIOUS"
fi
emit "$effective" true "${IMAGE##*/} unchanged since ${effective}"
