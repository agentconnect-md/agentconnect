#!/bin/sh
# Installs the AgentConnect desktop daemon prototype for the current macOS user; run it in Terminal on the Mac itself.
set -e
here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node || true)
[ -z "$node_bin" ] && [ -x "$HOME/.local/node/bin/node" ] && node_bin="$HOME/.local/node/bin/node"
if [ -z "$node_bin" ]; then
  echo 'Node.js >= 24.12 is required: https://nodejs.org/ (the macOS .pkg, or the tarball unpacked to ~/.local/node)' >&2
  exit 1
fi
"$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=12)?0:1)' \
  || {
    echo "Node.js >= 24.12 is required, found $("$node_bin" -v)" >&2
    exit 1
  }

app="$HOME/.agentconnect/desktop/app"
mkdir -p "$app"
cp "$here/agentconnect-desktop.mjs" "$app/"
cp "$here/README.md" "$app/" 2> /dev/null || true
# A double-clickable launcher: macOS ties the permissions to Terminal, so the daemon must start from it.
cat > "$app/AgentConnect Desktop.command" << LAUNCH
#!/bin/sh
exec "$node_bin" "$app/agentconnect-desktop.mjs" run
LAUNCH
chmod +x "$app/AgentConnect Desktop.command"

# setup downloads Cua Driver and ffmpeg, raises the macOS permission dialogs, waits for them and runs doctor.
status=0
"$node_bin" "$app/agentconnect-desktop.mjs" setup "$@" || status=$?
echo ""
echo "Start the daemon: open \"$app/AgentConnect Desktop.command\"   (or: node \"$app/agentconnect-desktop.mjs\" run)"
exit $status
