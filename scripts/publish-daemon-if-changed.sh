#!/bin/sh
# Publish only when the daemon bundle or its default runtime image inputs change on this channel.
#
# Called by release.config.js's prepareCmd/publishCmd (cwd = repo root) with:
#   $1 = previous release git tag on this channel ('' on a channel's first
#        release; rc releases diff against the previous rc, stable against
#        the previous stable — matching what each npm dist-tag's consumers
#        last got)
#   $2 = next version (prepare) or npm dist-tag (publish)
#   $3 = prepare | publish (defaults to publish for backwards compatibility)
#
# A skip must never mask a failure: set -eu aborts the release on any git
# error (a failing command substitution in a plain assignment trips -e), and
# an unknown/unfetchable tag falls through to publishing.
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
    # prepare temporarily bumps the daemon version and strips its dependencies.
    # Restore the manifest before later release steps use the workspace.
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
  # Set the version by editing package.json directly rather than `pnpm version`.
  # The prepare steps run in sequence, and pnpm's workspace-aware `version`
  # command aborts if any earlier prepare already dirtied the working tree
  # (ERR_PNPM_UNCLEAN_WORKING_TREE). A plain manifest edit has no such check and
  # is equivalent here — the bundle is already built by tsdown and deps are
  # stripped below.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  AGENTCONNECT_RELEASE_VERSION="$VALUE" pnpm run build
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

# dist/ was already built by prepareCmd; --ignore-scripts skips prepack so it
# is NOT rebuilt with dependencies now stripped (which would re-break the
# bundle).
cd "$REPO_ROOT/packages/daemon"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
