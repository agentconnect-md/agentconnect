#!/bin/sh
# Install the shared ACP runtimes and derive the preset from the pinned DeepSeek package.
set -eu

npm install --global --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
  "@agentconnect.md/codex-acp@${CODEX_ACP_VERSION}" \
  "@openma/deepseek-harness-acp@${DEEPSEEK_HARNESS_ACP_VERSION}"
npm cache clean --force
node /tmp/bake-dsh-preset.mjs /opt/agentconnect/dsh/agent-presets/standard-no-search
chown -R root:root /opt/agentconnect/dsh
chmod -R a-w /opt/agentconnect/dsh
