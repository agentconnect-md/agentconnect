#!/bin/sh
# Install the shared ACP runtimes and derive the preset from the pinned DeepSeek package.
set -eu

DSH_RUNTIME_DIR=/opt/agentconnect/dsh-runtime

npm install --global --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
  "@agentconnect.md/codex-acp@${CODEX_ACP_VERSION}" \
  "@openma/deepseek-harness-acp@${DEEPSEEK_HARNESS_ACP_VERSION}"
npm cache clean --force
# Unpack the vendored DeepSeek runtime once into the image, before session pods start.
DSH_ACP_CACHE_DIR="$DSH_RUNTIME_DIR" timeout 300 dsh-acp < /dev/null > /dev/null
# An ACP child's environment is an allowlist, so PATH is the only way to point the adapter at what it unpacked.
ln -s $DSH_RUNTIME_DIR/*/node_modules/.bin/dsh /usr/local/bin/dsh
DSH_ACP_CACHE_DIR="$DSH_RUNTIME_DIR" node /tmp/bake-dsh-preset.mjs /opt/agentconnect/dsh/agent-presets/standard-no-search
# Shipping the archive as well would be the same tree twice, and a fallback that silently restores the unpack.
rm "$(npm root -g)/@openma/deepseek-harness-acp/vendor/dsh-runtime.tgz"
# The unpack ran as root, which leaves its directory 0700 — unreadable to the uid the runtime launches under.
chown -R root:root /opt/agentconnect/dsh "$DSH_RUNTIME_DIR"
chmod -R a+rX,a-w /opt/agentconnect/dsh "$DSH_RUNTIME_DIR"
