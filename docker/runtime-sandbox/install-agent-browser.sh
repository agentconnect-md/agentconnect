#!/bin/sh
# Install the CLI against the Chrome already supplied by the system base.
set -eu

npm install --global --no-fund --no-audit "agent-browser@${AGENT_BROWSER_VERSION}"
keep="$(readlink -f /usr/local/bin/agent-browser)"
case "$keep" in
  */agent-browser-*) ;;
  *)
    echo "agent-browser bin link resolved to $keep" >&2
    exit 1
    ;;
esac
find /usr/local/lib/node_modules/agent-browser/bin -type f -name 'agent-browser-*' ! -path "$keep" -delete
npm cache clean --force
agent-browser --version

printf '%s\n' \
  '#!/bin/sh' \
  '# agentconnect: this sandbox bakes Chrome, so a bare `install` has nothing to fetch. See runtime-sandbox.Dockerfile.' \
  '# Defaulted here too, not only in ENV: an ACP child is spawned from an allowlist, so the image env may not reach it.' \
  ': "${AGENT_BROWSER_EXECUTABLE_PATH:=/opt/agentconnect/browser/chrome}"' \
  'export AGENT_BROWSER_EXECUTABLE_PATH' \
  'if [ "$1" = install ]; then' \
  '  shift' \
  '  case "$*" in' \
  '  ""|-d|--with-deps)' \
  '    echo "agent-browser install: Chrome is already installed in this sandbox at $AGENT_BROWSER_EXECUTABLE_PATH"' \
  '    exit 0' \
  '    ;;' \
  '  esac' \
  '  exec /usr/local/bin/agent-browser install "$@"' \
  'fi' \
  'exec /usr/local/bin/agent-browser "$@"' \
  > /opt/agentconnect/pathbin/agent-browser
chown root:root /opt/agentconnect/pathbin/agent-browser
chmod 0555 /opt/agentconnect/pathbin/agent-browser
