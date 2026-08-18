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
PKG="@agentconnect.md/billing-contract"

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

# Bootstrap guard, and it clears itself. npm will not let a trusted publisher be
# configured for a package that does not exist yet, so the FIRST publish of this
# name has to be a manual one; until it happens, OIDC authentication here fails.
# That failure would land badly: this lane runs after the daemon / cli / setup
# lanes, so the tag would be pushed and those three published before the run died
# — half a release. Skipping until the name exists keeps the shared pipeline
# green, and the moment someone publishes 0.1.0 by hand the guard stops firing
# with nothing to remember to remove.
#
# A registry error that is NOT a 404 must never be swallowed: an unreachable
# registry has to fail the release rather than quietly not publish.
if ! NPM_VIEW=$(npm view "$PKG" version 2>&1); then
  case "$NPM_VIEW" in
    *E404*)
      echo "${PKG} is not on npm yet — skipping ${SKIP_LABEL}."
      echo "  npm requires the package to exist before a trusted publisher can be configured:"
      echo "  publish the first version by hand, then set release.yaml as its trusted publisher."
      exit 0
      ;;
    *)
      echo "npm view ${PKG} failed for a reason other than 404 — refusing to guess:" >&2
      echo "$NPM_VIEW" >&2
      exit 1
      ;;
  esac
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/billing-contract"
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  pnpm run build
  exit 0
fi

cd "$REPO_ROOT/packages/billing-contract"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
