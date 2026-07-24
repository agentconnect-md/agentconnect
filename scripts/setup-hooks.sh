#!/bin/sh
# Registers the repo git hooks. No-op outside a git checkout
# (e.g. when this package is installed as a dependency or in CI).
[ -d .git ] || exit 0
git config --local include.path ../.github/.gitconfig
git config core.hooksPath .github/.githooks
