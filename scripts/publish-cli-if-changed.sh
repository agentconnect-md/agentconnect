#!/bin/sh
# Publishes the CLI (@agentconnect.md/cli) to npm ONLY when something that lands
# in its bundle changed since the previous release on this channel. The CLI is
# the thin, stable bin — it changes far less often than the daemon — so most
# releases skip its publish, keeping npm versions meaningful.
#
# Called by release.config.js's prepareCmd/publishCmd (cwd = repo root) with:
#   $1 = previous release git tag on this channel ('' on a channel's first
#        release; rc releases diff against the previous rc, stable against
#        the previous stable)
#   $2 = next version (prepare) or npm dist-tag (publish)
#   $3 = prepare | publish (defaults to publish for backwards compatibility)
#
# A skip must never mask a failure: set -eu aborts the release on any git
# error, and an unknown/unfetchable tag falls through to publishing.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/cli/package.json
}

case "$MODE" in
  prepare)
    SKIP_LABEL="version bump and build"
    ;;
  publish)
    SKIP_LABEL="npm publish"
    # prepare temporarily bumps the CLI version and strips its dependencies.
    # Restore the manifest before later release steps use the workspace.
    trap restore_manifest EXIT
    ;;
  *)
    echo "usage: $0 <last-tag> <version-or-dist-tag> [prepare|publish]" >&2
    exit 2
    ;;
esac

# Everything tsdown inlines into the CLI bundle: the CLI itself, protocol,
# connection (the login auth probe uses connection's ClientTransport), and
# tsconfig.base.json (shapes the emitted JS). The lockfile is checked separately
# below, scoped to the CLI's importers.
CLI_PATHS="packages/cli packages/protocol packages/connection tsconfig.base.json"
CLI_IMPORTERS="packages/cli packages/protocol packages/connection"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # Word-splitting CLI_PATHS is deliberate: it is a list of pathspecs.
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $CLI_PATHS)
  if [ -z "$CHANGED" ]; then
    # Package dirs untouched — but a floating-range resolution bump can still
    # change the bundle without touching any package dir, so ask whether the
    # lockfile's resolved closure for the CLI's importers moved.
    # shellcheck disable=SC2086
    LOCK_VERDICT=$(node "$REPO_ROOT/scripts/lockfile-closure-changed.mjs" "$LAST_TAG" HEAD $CLI_IMPORTERS)
    if [ "$LOCK_VERDICT" = "unchanged" ]; then
      echo "cli bundle inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL} (checked: ${CLI_PATHS} + lockfile closure of ${CLI_IMPORTERS})"
      exit 0
    fi
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT/packages/cli"
  # Set the version by editing package.json directly rather than `pnpm version`.
  # The prepare steps run in sequence (daemon prepare runs first and dirties the
  # tree by bumping + stripping its own manifest), and pnpm's workspace-aware
  # `version` command aborts on an unclean working tree
  # (ERR_PNPM_UNCLEAN_WORKING_TREE). A plain manifest edit has no such check and
  # is equivalent here — the bundle is already built by tsdown and deps are
  # stripped below.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  pnpm run build
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

# dist/ was already built by prepareCmd; --ignore-scripts skips prepack so it
# is NOT rebuilt with dependencies now stripped (which would re-break the
# bundle).
cd "$REPO_ROOT/packages/cli"
sh "$REPO_ROOT/scripts/npm-publish-with-retry.sh" "$VALUE"
