#!/usr/bin/env bash
# Effective per-component image versions for a release tag, on either channel.
#
# A component's effective version is the most recent tag ON THE SAME CHANNEL —
# walking back from the given one (stable vX.Y.Z tags for a stable, prerelease
# vX.Y.Z-rc.N tags for an rc) — whose release actually changed that component's
# build inputs. An unchanged component's inputs are identical between the two
# tags. build.yaml uses this to skip rebuilding unchanged images and reports the
# resulting artifact-version map to configured downstream workflow automation.
#
# The walk never crosses release channels. Stable and RC tag sequences are each
# monotonic in main's history, so consecutive same-channel tags compare one
# release with the previous release seen by that channel.
#
# Usage: component-versions.sh <release-tag vX.Y.Z | vX.Y.Z-rc.N>
# Stdout (GITHUB_OUTPUT-ready):
#   controlPlane=vA
#   web=vB
#   relay=vC
#   mem0=vD
#   mem0Backend=vE
#   setup=vF
# Requires the full tag list and history (CI: actions/checkout fetch-depth: 0);
# an unknown tag fails loudly rather than guessing.
set -euo pipefail

TAG="${1:?usage: component-versions.sh <release-tag>}"
case "$TAG" in
  v[0-9]*) ;;
  *)
    echo "::error::${TAG} is not a vX.Y.Z(-rc.N) release tag" >&2
    exit 1
    ;;
esac
case "$TAG" in
  *-*) CHANNEL=rc ;;
  *) CHANNEL=stable ;;
esac

# Input path sets. A component's set must cover EVERYTHING that can change its
# built image: its package dir, its workspace deps (keep in sync with
# packages/*/package.json), and the shared build inputs below. Over-including
# only costs a needless rebuild; under-including silently ships a stale image
# under a new version, so err on the side of more.
#
# COMMON: the Dockerfile itself, the pnpm install inputs it COPYs (lockfile,
# workspace manifest, root package.json whose `prepare` pulls in scripts/,
# .npmrc), the build-context filter (.dockerignore), and the shared tsconfig
# every package build extends.
COMMON="docker/Dockerfile docker-bake.hcl .dockerignore .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"
CP_PATHS="packages/control-plane packages/setup packages/protocol packages/observability packages/k8s-client packages/connection $COMMON"
SETUP_PATHS="$CP_PATHS"
WEB_PATHS="packages/web packages/protocol $COMMON"
RELAY_PATHS="packages/relay packages/message packages/protocol packages/connection packages/observability $COMMON"
MEM0_PATHS="packages/memory-plugin-mem0 packages/protocol $COMMON"
DAEMON_PATHS="packages/daemon packages/message packages/protocol packages/connection packages/observability packages/k8s-client $COMMON"
OPERATOR_PATHS="packages/operator packages/k8s-client packages/connection packages/protocol packages/observability $COMMON"
# The backend's application source is the immutable external context declared in
# docker-bake.hcl. Changes to that pin, its owned Dockerfile, or this resolver
# rebuild the image; unrelated app/package changes leave it on its effective tag.
MEM0_BACKEND_PATHS="docker/mem0-backend.Dockerfile docker-bake.hcl scripts/component-versions.sh"
# The runtime sandbox has its OWN Dockerfile, so it deliberately does not share COMMON's
# docker/Dockerfile. Its inputs are the shim's source graph — the shim ships inside it and the two
# halves of that channel must not drift apart — plus the pinned runtime versions and table
# generator that the published runtime table describes.
RUNTIME_SANDBOX_PATHS="docker/runtime-sandbox.Dockerfile docker/runtime-sandbox packages/daemon/src/shim packages/daemon/tsdown.shim.config.ts packages/daemon/package.json packages/protocol packages/connection docker-bake.hcl .dockerignore .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"

# The channel's tags (prerelease tags carry a `-`), oldest → newest. Within one
# channel `sort -V` compares version fields numerically (rc.9 < rc.10), so the
# sorted order is the release order.
TAGS=()
if [ "$CHANNEL" = "stable" ]; then
  FILTER=(grep -v -- -)
else
  FILTER=(grep -- -)
fi
while IFS= read -r t; do
  TAGS+=("$t")
done < <(git tag -l 'v[0-9]*' | "${FILTER[@]}" | sort -V || true)

IDX=-1
for i in "${!TAGS[@]}"; do
  if [ "${TAGS[$i]}" = "$TAG" ]; then
    IDX=$i
  fi
done
if [ "$IDX" -lt 0 ]; then
  echo "::error::${TAG} not found among ${CHANNEL} tags — not a released tag, or tags/history missing (needs fetch-depth: 0)" >&2
  exit 1
fi

# Walk the channel's tags newest → oldest from TAG; the first hop whose release
# changed the component's inputs is its effective version. The channel's very
# first release built everything, so it is the floor.
effective() {
  local paths="$1" i
  for ((i = IDX; i > 0; i--)); do
    # shellcheck disable=SC2086 -- $paths is a deliberate pathspec list
    if [ -n "$(git diff --name-only "${TAGS[$((i - 1))]}" "${TAGS[$i]}" -- $paths)" ]; then
      echo "${TAGS[$i]}"
      return
    fi
  done
  echo "${TAGS[0]}"
}

printf 'controlPlane=%s\n' "$(effective "$CP_PATHS")"
printf 'web=%s\n' "$(effective "$WEB_PATHS")"
printf 'relay=%s\n' "$(effective "$RELAY_PATHS")"
printf 'mem0=%s\n' "$(effective "$MEM0_PATHS")"
printf 'mem0Backend=%s\n' "$(effective "$MEM0_BACKEND_PATHS")"
printf 'setup=%s\n' "$(effective "$SETUP_PATHS")"
printf 'runtimeSandbox=%s\n' "$(effective "$RUNTIME_SANDBOX_PATHS")"
printf 'daemon=%s\n' "$(effective "$DAEMON_PATHS")"
printf 'operator=%s\n' "$(effective "$OPERATOR_PATHS")"
