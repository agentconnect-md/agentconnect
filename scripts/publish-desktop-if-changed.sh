#!/bin/sh
# publish-npm.mjs passes the last published npm tag, the next version or dist-tag, and prepare|publish.
# Unknown baseline tags rebuild; Git errors fail the job.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/desktop/package.json
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
DESKTOP_PATHS="packages/desktop packages/protocol packages/connection tsconfig.base.json pnpm-lock.yaml"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # Word-splitting DESKTOP_PATHS is deliberate: it is a list of pathspecs.
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $DESKTOP_PATHS)
  if [ -z "$CHANGED" ]; then
    echo "desktop bundle inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL} (checked: ${DESKTOP_PATHS})"
    exit 0
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/desktop"
  # Build with the release version and dependencies intact, scan what ships, then strip the self-contained package's dependencies.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  AGENTCONNECT_RELEASE_VERSION="$VALUE" pnpm run build
  pnpm run license-scan dist
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

# Skip prepack: rebuilding after prepare stripped dependencies would break the bundle.
cd "$REPO_ROOT/packages/desktop"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
