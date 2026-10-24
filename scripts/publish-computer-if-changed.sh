#!/bin/sh
# publish-npm.mjs passes the last published npm tag, the next version or dist-tag, prepare|publish, and the app pins to prepare.
# Unknown baseline tags rebuild; Git errors fail the job.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
# The exact macOS app versions this computer version runs in, as JSON optionalDependencies.
APP_PINS="${4:-}"
[ -n "$APP_PINS" ] || APP_PINS='{}'
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/computer/package.json
}

case "$MODE" in
  prepare)
    SKIP_LABEL="version bump and build"
    ;;
  publish)
    SKIP_LABEL="npm publish"
    # Restore the manifest before the next package uses the workspace.
    trap restore_manifest EXIT
    ;;
  *)
    echo "usage: $0 <last-tag> <version-or-dist-tag> [prepare|publish]" >&2
    exit 2
    ;;
esac

# Everything esbuild inlines into the computer daemon bundle; the whole lockfile stands in for its resolved closure.
COMPUTER_PATHS="packages/computer packages/protocol packages/connection tsconfig.base.json pnpm-lock.yaml"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # Word-splitting COMPUTER_PATHS is deliberate: it is a list of pathspecs.
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $COMPUTER_PATHS)
  if [ -z "$CHANGED" ]; then
    echo "computer daemon bundle inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL} (checked: ${COMPUTER_PATHS})"
    exit 0
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/computer"
  # Build with the release version and dependencies intact, scan what ships, then strip the self-contained package's dependencies.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  AGENTCONNECT_RELEASE_VERSION="$VALUE" pnpm run build
  pnpm run license-scan dist
  # One edit: pnpm checks a workspace's dependencies before each exec, and one after the strip would try to reinstall them (frozen in CI).
  pnpm exec json -I -f package.json -e "this.dependencies={}; this.optionalDependencies=$APP_PINS"
  exit 0
fi

# Skip prepack: rebuilding after prepare stripped dependencies would break the bundle.
cd "$REPO_ROOT/packages/computer"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
