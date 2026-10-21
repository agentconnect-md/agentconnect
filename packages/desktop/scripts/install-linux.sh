#!/bin/sh
# Installs the AgentConnect desktop daemon for this Linux desktop user and registers it (computer-use.md §3.5, §3.6).
# The Control Plane serves this file with its own URL and the bundle's sha256 filled in:
#   wget -nv -O- <control plane>/v1/computers/install.sh | sh -s -- --register <token> [--name <name>]
set -eu

CP_URL='@CP_URL@'
BUNDLE_SHA256='@BUNDLE_SHA256@'
# The pinned official Node.js runtime the daemon runs on (the same pin as docker/Dockerfile).
NODE_VERSION='24.12.0'
NODE_SHA256_X64='6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0'
NODE_SHA256_ARM64='9b2a2eeb98a8eb37361224e2a1d060300ad2dd143af58dfdb16de785df0f1228'
BUNDLE='agentconnect-desktop.mjs'

say() { printf '%s\n' "$*"; }
die() {
  printf 'agentconnect-desktop install: %s\n' "$*" >&2
  exit 1
}

usage() {
  say 'Usage: install.sh [--register TOKEN] [--name NAME] [--cp-url URL] [--no-service]'
  say '  --register TOKEN  the one-time registration token from the console (Computers > Add Computer)'
  say '  --name NAME       the Computer name shown in the console (default: this host name)'
  say '  --cp-url URL      the Control Plane to register with (default: the one that served this script)'
  say '  --no-service      install and register without the systemd user service'
  say 'Without --register it upgrades an installed desktop daemon in place.'
}

# Downloads $1 to $2 with curl, or with wget, which a fresh Ubuntu desktop has instead; a stalled transfer retries.
fetch() {
  if command -v curl > /dev/null 2>&1; then
    curl -fL --progress-bar --retry 5 --retry-all-errors --connect-timeout 20 --speed-limit 1024 --speed-time 30 \
      -o "$2" "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -q --show-progress --tries=5 --timeout=30 -O "$2" "$1"
  else
    die 'curl or wget is required'
  fi
}

verify() {
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || die "checksum mismatch for $3 (expected $2, got $actual)"
}

main() {
  token=''
  name=''
  cp_url=$CP_URL
  service=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --register)
        [ $# -ge 2 ] || die '--register needs a token'
        token=$2
        shift 2
        ;;
      --name)
        [ $# -ge 2 ] || die '--name needs a value'
        name=$2
        shift 2
        ;;
      --cp-url)
        [ $# -ge 2 ] || die '--cp-url needs a URL'
        cp_url=$2
        shift 2
        ;;
      --no-service)
        service=0
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
  done

  [ "$(uname -s)" = Linux ] || die 'this installer is for Linux; the console shows the macOS and Windows commands'
  [ "$(id -u)" != 0 ] || die 'run it as the desktop user, not root: the service runs in your graphical session'
  case "$(uname -m)" in
    x86_64 | amd64)
      arch=x64
      node_sha=$NODE_SHA256_X64
      ;;
    aarch64 | arm64)
      arch=arm64
      node_sha=$NODE_SHA256_ARM64
      ;;
    *) die "unsupported CPU architecture $(uname -m) (x86_64 and aarch64 are supported)" ;;
  esac
  command -v sha256sum > /dev/null 2>&1 || die 'sha256sum is required (coreutils)'
  command -v systemctl > /dev/null 2>&1 || [ "$service" = 0 ] || die 'systemd is required for the service (or pass --no-service)'

  home_dir="$HOME/.agentconnect/desktop"
  runtime="$home_dir/runtime/node-v$NODE_VERSION-linux-$arch"
  node="$runtime/bin/node"
  app="$home_dir/app"
  mkdir -p "$home_dir/runtime" "$app"
  chmod 700 "$home_dir"
  tmp=$(mktemp -d "$home_dir/.install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  if [ -x "$node" ]; then
    say "Node.js $NODE_VERSION: $runtime"
  else
    say "Downloading Node.js $NODE_VERSION ($arch)..."
    tarball="node-v$NODE_VERSION-linux-$arch.tar.gz"
    fetch "https://nodejs.org/dist/v$NODE_VERSION/$tarball" "$tmp/$tarball"
    verify "$tmp/$tarball" "$node_sha" "$tarball"
    mkdir -p "$tmp/node"
    # Only the runtime and its license: npm, headers and docs are not needed.
    tar -xzf "$tmp/$tarball" -C "$tmp/node" --strip-components=1 \
      "node-v$NODE_VERSION-linux-$arch/bin/node" "node-v$NODE_VERSION-linux-$arch/LICENSE"
    rm -rf "$runtime"
    mv "$tmp/node" "$runtime"
  fi

  base=$(printf '%s' "$CP_URL" | sed 's:/*$::')
  say "Downloading the desktop daemon from $base..."
  fetch "$base/v1/computers/desktop/$BUNDLE" "$tmp/$BUNDLE"
  verify "$tmp/$BUNDLE" "$BUNDLE_SHA256" "$BUNDLE"
  mv -f "$tmp/$BUNDLE" "$app/$BUNDLE"
  if fetch "$base/v1/computers/desktop/$BUNDLE.LEGAL.txt" "$tmp/legal"; then mv -f "$tmp/legal" "$app/$BUNDLE.LEGAL.txt"; fi

  # A launcher on PATH (Ubuntu's ~/.profile adds ~/.local/bin at login) names the command the fix hints use.
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  cat > "$bin/agentconnect-desktop" << LAUNCHER
#!/bin/sh
exec "$node" "$app/$BUNDLE" "\$@"
LAUNCHER
  chmod 755 "$bin/agentconnect-desktop"

  set -- setup
  if [ -n "$token" ]; then
    set -- "$@" --register "$token" --cp-url "$cp_url"
    if [ -n "$name" ]; then set -- "$@" --name "$name"; fi
  fi
  if [ "$service" = 0 ]; then set -- "$@" --no-service; fi
  say ''
  # stdin is this script when piped into sh, so setup reads the terminal instead (or nothing).
  status=0
  if (: < /dev/tty) 2> /dev/null; then
    "$node" "$app/$BUNDLE" "$@" < /dev/tty || status=$?
  else
    "$node" "$app/$BUNDLE" "$@" < /dev/null || status=$?
  fi
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "The agentconnect-desktop command is in $bin, which your PATH gets at the next login." ;;
  esac
  return "$status"
}

# Everything runs from main, so a download cut short never executes half a script.
main "$@"
