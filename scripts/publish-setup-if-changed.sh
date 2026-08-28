#!/bin/sh
# Publish @agentconnect.md/setup only when its self-contained bundle inputs
# changed on the current release channel.
set -eu

LAST_TAG="${1:-}"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)

restore_manifest() {
  git -C "$REPO_ROOT" restore --source=HEAD -- packages/setup/package.json
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

# Keep this identical to the Control Plane image input set in
# component-versions.sh. The image embeds this package, so whenever those bits
# rebuild, npm receives the same version that the image reports.
COMMON="docker/Dockerfile docker-bake.hcl .dockerignore .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"
SETUP_PATHS="packages/control-plane packages/setup packages/protocol packages/observability packages/k8s-client packages/connection $COMMON"
SETUP_IMPORTERS="packages/setup packages/control-plane packages/protocol packages/observability packages/k8s-client packages/connection"

if [ -n "$LAST_TAG" ] && git rev-parse -q --verify "${LAST_TAG}^{commit}" > /dev/null; then
  # shellcheck disable=SC2086
  CHANGED=$(git diff --name-only "$LAST_TAG" HEAD -- $SETUP_PATHS)
  if [ -z "$CHANGED" ]; then
    # shellcheck disable=SC2086
    LOCK_VERDICT=$(node "$REPO_ROOT/scripts/lockfile-closure-changed.mjs" "$LAST_TAG" HEAD $SETUP_IMPORTERS)
    if [ "$LOCK_VERDICT" = "unchanged" ]; then
      echo "setup bundle inputs unchanged since ${LAST_TAG} — skipping ${SKIP_LABEL}"
      exit 0
    fi
  fi
fi

if [ "$MODE" = prepare ]; then
  cd "$REPO_ROOT"
  # `<pkg>...` is the control plane AND its workspace dependencies, built in topological
  # order. It replaced a hand-written list of those dependencies, which is a list that
  # silently rots: tsc resolves a workspace import through the dependency's BUILT types,
  # so the first release after the cluster provisioner started importing `k8s-client`
  # failed the whole run with TS2307 — the dependency was real, it just never got built
  # here. Nothing to keep in sync now; pnpm reads the dependency graph itself.
  pnpm --filter "@agentconnect.md/control-plane..." build
  cd "$REPO_ROOT/packages/setup"
  pnpm exec json -I -f package.json -e "this.version='$VALUE'"
  pnpm run build
  pnpm exec json -I -f package.json -e 'this.dependencies={}'
  exit 0
fi

cd "$REPO_ROOT/packages/setup"
sh "$REPO_ROOT/scripts/npm-publish-with-retry.sh" "$VALUE"
