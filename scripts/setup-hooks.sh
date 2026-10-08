#!/bin/sh
# CI runs its checks explicitly; publishing tags must not run the developer hooks again.
[ "${CI:-}" != "true" ] || exit 0
# Package installs and linked worktrees do not own a .git directory.
[ -d .git ] || exit 0
git config --local include.path ../.github/.gitconfig
git config core.hooksPath .github/.githooks
