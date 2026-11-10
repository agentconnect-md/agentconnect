#!/usr/bin/env bash
# Checks `form-fill install` against a distribution's real browser package (computer-form-fill-and-vault.md §11 S6).
# Usage: form-fill-browser-check.sh <debian-chromium|debian-chrome|fedora-chromium|fedora-chrome> [bundle]
# In a fresh container it installs the browser, runs the install as root, starts the browser as a user under Xvfb
# and waits for the force-installed extension to say hello on 127.0.0.1:7682 with this bundle's build id.
set -euo pipefail
case_name=${1:?usage: $0 <case> [bundle]}
bundle=${2:-$(cd "$(dirname "$0")/.." && pwd)/bundle/agentconnect-computer.mjs}
[ -f "$bundle" ] || {
  echo "build the bundle first: $bundle" >&2
  exit 2
}
node_version=26.13.0

case "$case_name" in
  debian-chromium)
    image=debian:trixie
    prepare='apt-get update -q && apt-get install -yq --no-install-recommends chromium xvfb curl xz-utils ca-certificates procps'
    browser=chromium
    ;;
  debian-chrome)
    image=debian:trixie
    prepare='apt-get update -q && apt-get install -yq --no-install-recommends xvfb curl xz-utils ca-certificates procps && curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get install -yq /tmp/chrome.deb'
    browser=google-chrome
    ;;
  fedora-chromium)
    image=fedora:latest
    prepare='dnf install -yq chromium xorg-x11-server-Xvfb xz procps-ng libatomic'
    browser=chromium-browser
    ;;
  fedora-chrome)
    image=fedora:latest
    prepare='dnf install -yq xorg-x11-server-Xvfb xz procps-ng libatomic && rpm --import https://dl.google.com/linux/linux_signing_key.pub && dnf install -yq https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm'
    browser=google-chrome
    ;;
  *)
    echo "unknown case $case_name" >&2
    exit 2
    ;;
esac

# A bare WebSocket listener: completes the upgrade, then prints the Origin and the first text frame (the extension's hello).
listener='
const http = require("http"), crypto = require("crypto")
const server = http.createServer()
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\n\r\n`)
  socket.once("data", (frame) => {
    let len = frame[1] & 127, at = 2
    if (len === 126) { len = frame.readUInt16BE(2); at = 4 }
    const mask = frame.subarray(at, at + 4), data = frame.subarray(at + 4, at + 4 + len)
    const text = Buffer.from(data.map((b, i) => b ^ mask[i % 4])).toString()
    console.log(JSON.stringify({ origin: req.headers.origin, hello: JSON.parse(text) }))
    process.exit(0)
  })
})
server.listen(7682, "127.0.0.1")
setTimeout(() => { console.error("no hello within 120 s"); process.exit(1) }, 120000)
'

docker run --rm -i -v "$bundle:/opt/check/agentconnect-computer.mjs:ro" "$image" bash -s << EOF
set -euo pipefail
$prepare >/dev/null
arch=\$(uname -m); case "\$arch" in x86_64) node=x64;; aarch64) node=arm64;; esac
curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-\${node}.tar.xz" | tar -xJ -C /usr/local --strip-components=1
useradd -m tester
node /opt/check/agentconnect-computer.mjs form-fill install --yes
echo '--- status'
node /opt/check/agentconnect-computer.mjs form-fill status
cat > /tmp/listener.js <<'JS'
$listener
JS
su tester -c 'node /tmp/listener.js' > /tmp/hello.json &
listen=\$!
su tester -c "Xvfb :9 -screen 0 1280x800x24 >/dev/null 2>&1 &"
sleep 2
su tester -c "DISPLAY=:9 $browser --no-sandbox --no-first-run --disable-gpu about:blank >/tmp/browser.log 2>&1 &"
wait \$listen
echo '--- hello'
cat /tmp/hello.json
EOF
