#!/bin/sh
# Declared inputs of the runtime image, for the daemon package that pins it as its default (publish-daemon-if-changed.sh).
# build.yaml does not read them: it decides whether the image itself changed by the content of its shim payload.
RUNTIME_SANDBOX_PATHS="docker/runtime-sandbox.Dockerfile docker/runtime-sandbox packages/daemon/src/shim packages/daemon/tsdown.shim.config.ts packages/daemon/package.json packages/protocol packages/connection docker-bake.hcl .dockerignore .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"
