#!/bin/sh
# Shared inputs for the runtime image and the daemon package that pins it as its default.
RUNTIME_SANDBOX_PATHS="docker/runtime-sandbox.Dockerfile docker/runtime-sandbox packages/daemon/src/shim packages/daemon/tsdown.shim.config.ts packages/daemon/package.json packages/protocol packages/connection docker-bake.hcl .dockerignore .npmrc .pnpmfile.mjs pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json scripts"
