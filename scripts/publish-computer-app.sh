#!/bin/sh
# publish-npm.mjs passes the arch, the release version or dist-tag, and prepare|publish; the build job built the package.
set -eu

ARCH="$1"
VALUE="$2"
MODE="${3:-publish}"
REPO_ROOT=$(git rev-parse --show-toplevel)
PACKAGE="$REPO_ROOT/packages/computer/bundle/computer-darwin-$ARCH"

case "$MODE" in
  prepare)
    # The app's Info.plist and manifest must carry this release's version, or the computer package pins a missing app.
    BUILT=$(node -p "require('$PACKAGE/package.json').version")
    if [ "$BUILT" != "$VALUE" ]; then
      echo "computer-darwin-$ARCH was built as $BUILT, not $VALUE" >&2
      exit 1
    fi
    cd "$REPO_ROOT/packages/computer"
    pnpm run license-scan --binaries-only "$PACKAGE"
    ;;
  publish)
    # The package lives outside the workspace; npm publishes it with the job's trusted-publisher identity.
    npm publish "$PACKAGE" --tag "$VALUE" --access public
    ;;
  *)
    echo "usage: $0 <arm64|x64> <version-or-dist-tag> [prepare|publish]" >&2
    exit 2
    ;;
esac
