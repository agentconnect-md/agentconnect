#!/bin/sh
# Installs the AgentConnect desktop daemon prototype for the current macOS user; run it in Terminal on the Mac itself.
set -e
here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node || true)
[ -z "$node_bin" ] && [ -x "$HOME/.local/node/bin/node" ] && node_bin="$HOME/.local/node/bin/node"
if [ -z "$node_bin" ]; then
  echo 'Node.js >= 26.0 is required: https://nodejs.org/ (the macOS .pkg, or the tarball unpacked to ~/.local/node)' >&2
  exit 1
fi
"$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0])>=26?0:1)' \
  || {
    echo "Node.js >= 26.0 is required, found $("$node_bin" -v)" >&2
    exit 1
  }

app="$HOME/.agentconnect/computer/app"
mkdir -p "$app"
cp "$here/agentconnect-computer.mjs" "$app/"
cp "$here/README.md" "$app/" 2> /dev/null || true
# A double-clickable launcher: macOS ties the permissions to Terminal, so the daemon must start from it.
cat > "$app/AgentConnect Computer.command" << LAUNCH
#!/bin/sh
exec "$node_bin" "$app/agentconnect-computer.mjs" run
LAUNCH
chmod +x "$app/AgentConnect Computer.command"

# setup downloads Cua Driver and ffmpeg, raises the macOS permission dialogs, waits for them and runs doctor.
status=0
"$node_bin" "$app/agentconnect-computer.mjs" setup "$@" || status=$?
echo ""
echo "Start the daemon: open \"$app/AgentConnect Computer.command\"   (or: node \"$app/agentconnect-computer.mjs\" run)"
exit $status
