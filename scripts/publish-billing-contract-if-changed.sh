#!/bin/sh
# Publish @agentconnect.md/billing-contract only when the contract itself changed
# on the current release channel.
#
# Unlike the daemon / cli / setup lanes this is a REAL LIBRARY, not a
# self-contained tsdown bundle, so it differs from them in one load-bearing way:
# the manifest keeps its dependencies. Those lanes strip `dependencies` to `{}`
# because their bundles inline everything; here `zod` must stay declared or every
# consumer installs a package whose types cannot resolve.
#
# It is also the only lane published for a consumer OUTSIDE this repository (the
# closed-source billing service), which is the whole reason the contract is a
# package instead of a shared file.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/billing-contract/package.json
}

case "$MODE" in
  prepare)
    SKIP_LABEL="version bump and build"
    ;;
  publish)
    SKIP_LABEL="npm publish"
    trap restore_manifest EXIT
    ;;
  *)
    echo "usage: $0 <last-tag> <version-or-dist-tag> [prepare|publish]" >&2
    exit 2
    ;;
esac

# The contract has no workspace dependencies — its input set is itself plus the
# root files that decide how it builds and resolves.
CONTRACT_PATHS="packages/billing-contract .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $CONTRACT_PATHS)
  if [ -z "$CHANGED" ]; then
    LOCK_VERDICT=$(node "$REPO_ROOT/scripts/lockfile-closure-changed.mjs" "$LAST_TAG" HEAD packages/billing-contract)
    if [ "$LOCK_VERDICT" = "unchanged" ]; then
      echo "billing-contract inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL}"
      exit 0
    fi
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/billing-contract"
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  pnpm run build
  exit 0
fi

cd "$REPO_ROOT/packages/billing-contract"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
