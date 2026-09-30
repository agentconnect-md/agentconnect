#!/bin/sh
# publish-npm.mjs passes the last published npm tag, the next version or dist-tag, and prepare|publish.
# Unknown baseline tags rebuild; Git errors fail the job.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/daemon/package.json
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

. "$REPO_ROOT/scripts/runtime-sandbox-inputs.sh"
# The image consumes the full lockfile, so even unrelated dependency bumps now refresh its daemon default.
DAEMON_PATHS="packages/daemon packages/activation-policy packages/message packages/protocol packages/connection packages/k8s-client tsconfig.base.json $RUNTIME_SANDBOX_PATHS"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # Word-splitting DAEMON_PATHS is deliberate: it is a list of pathspecs.
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $DAEMON_PATHS)
  if [ -z "$CHANGED" ]; then
    echo "daemon bundle and runtime image inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL} (checked: ${DAEMON_PATHS})"
    exit 0
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/daemon"
  # Build with the release version and dependencies intact, then strip the self-contained package's dependencies.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  AGENTCONNECT_RELEASE_VERSION="$VALUE" pnpm run build
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

# Skip prepack: rebuilding after prepare stripped dependencies would break the bundle.
cd "$REPO_ROOT/packages/daemon"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
