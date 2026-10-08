#!/bin/sh
# publish-npm.mjs passes the last published npm tag, the next version or dist-tag, and prepare|publish.
# Unknown baseline tags rebuild; Git errors fail the job.
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
    # Restore the manifest before the next package uses the workspace.
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
  # Build with the release version and dependencies intact, then strip the self-contained package's dependencies.
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  pnpm run build
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

# Skip prepack: rebuilding after prepare stripped dependencies would break the bundle.
cd "$REPO_ROOT/packages/cli"
pnpm publish --no-git-checks --ignore-scripts --tag "$VALUE"
