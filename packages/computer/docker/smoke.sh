#!/usr/bin/env bash
# Smoke test of a built computer image: size, health, doctor, a maximized Chrome and a clean stop (computer-use.md §3.8).
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
name="agentconnect-computer-smoke-$$"
max_bytes=$((5 * 1024 * 1024 * 1024 / 2))

size=$(docker image inspect --format '{{.Size}}' "$image")
echo "image size: $((size / 1024 / 1024)) MiB"
[ "$size" -le "$max_bytes" ] || {
  echo "the image is larger than 2.5 GiB" >&2
  exit 1
}

net="$name-net"
# What a failed run leaves to read: the container's log, the Xfce session's log, its processes and window manager.
diagnose() {
  docker inspect "$1" > /dev/null 2>&1 || return 0
  echo "== $1: container log"
  docker logs "$1" 2>&1 | tail -n 200
  echo "== $1: /tmp/xfce4-session.log"
  docker exec "$1" tail -n 200 /tmp/xfce4-session.log 2>&1 || true
  echo "== $1: processes"
  docker exec "$1" ps -eo pid,ppid,etimes,stat,comm 2>&1 || true
  echo "== $1: window manager"
  docker exec -e DISPLAY=:1 "$1" wmctrl -m 2>&1 || true
}
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    diagnose "$name" >&2
    diagnose "$name-reg" >&2
    diagnose "$name-sys" >&2
  fi
  docker rm -f "$name" "$name-reg" "$name-stub" "$name-sys" > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
  docker volume rm "$name-sys" > /dev/null 2>&1 || true
}
trap cleanup EXIT
wait_healthy() {
  local health=starting
  for _ in $(seq 1 60); do
    health=$(docker inspect --format '{{.State.Health.Status}}' "$1")
    [ "$health" = starting ] || break
    sleep 3
  done
  if [ "$health" != healthy ]; then
    docker logs "$1" >&2
    docker inspect --format '{{json .State.Health}}' "$1" >&2
    echo "health: $health" >&2
    exit 1
  fi
  echo "health: healthy"
}
# An inherited CHROME_EXTRA_FLAGS would win over argv, so the launcher drops it: the profile stays browser/main.
docker run -d --name "$name" --shm-size=1g -e CHROME_EXTRA_FLAGS=--user-data-dir=/tmp/elsewhere "$image" > /dev/null
wait_healthy "$name"

# ffmpeg is not in the image: the daemon downloads it on first start, so its checks turn ok once that finishes.
for _ in $(seq 1 40); do
  doctor=$(docker exec "$name" agentconnect-computer doctor --json --daemon --port 7681)
  failed=$(printf '%s' "$doctor" | docker exec -i "$name" node -e 'const c = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(c.filter((x) => !["ok", "info"].includes(x.status)).map((x) => x.name).join(" "))')
  [ -z "$failed" ] && break
  sleep 3
done
echo "$doctor"
[ -z "$failed" ] || {
  echo "doctor checks not ok: $failed" >&2
  exit 1
}

# Without a terminal, an unregistered daemon writes its first client token to a file rather than the log.
logs=$(docker logs "$name" 2>&1)
grep -q 'token written to' <<< "$logs" || {
  echo "the first start did not write the client token to its file" >&2
  exit 1
}

# The desktop has a window manager: without one nothing is maximized, decorated or focused.
wm=$(docker exec -e DISPLAY=:1 "$name" wmctrl -m 2> /dev/null | sed -n 's/^Name: //p')
[ "$wm" = Xfwm4 ] || {
  echo "no window manager on the desktop: ${wm:-none}" >&2
  exit 1
}
echo "window manager: $wm"

# The browser starts beside the daemon, so give it a moment to map and maximize its window.
maximized=
for _ in $(seq 1 30); do
  if docker exec -e DISPLAY=:1 "$name" sh -c \
    'w=$(wmctrl -l | awk "/Google Chrome\$/ { print \$1; exit }"); [ -n "$w" ] && xprop -id "$w" _NET_WM_STATE' \
    | grep -q MAXIMIZED_HORZ; then
    maximized=1
    break
  fi
  sleep 1
done
[ -n "$maximized" ] || {
  echo "no maximized browser window" >&2
  exit 1
}
# Chrome runs through the launcher: on browser/main, marked as past its first run, with the container's flags.
main=/home/computer/.agentconnect/computer/browser/main
# Chrome rewrites its own process title, so its switches are read as one string, padded to match whole words.
browser=$(docker exec "$name" sh -c "test -f '$main/First Run' && lock=\$(readlink '$main/SingletonLock') && pid=\${lock##*-} \
  && readlink /proc/\$pid/exe && echo \" \$(tr '\\0' ' ' < /proc/\$pid/cmdline) \" && tr '\\0' '\\n' < /proc/\$pid/environ") || {
  echo "no browser holds browser/main, or it has no First Run file" >&2
  exit 1
}
# /opt/google leads to /usr/lib/google, so a system volume holds the browser with /usr (§3.8).
[ "$(head -n 1 <<< "$browser")" = /usr/lib/google/chrome/chrome ] || {
  echo "the main browser is not Google Chrome: $(head -n 1 <<< "$browser")" >&2
  exit 1
}
for flag in "--user-data-dir=$main" --no-sandbox --no-first-run --hide-crash-restore-bubble --password-store=basic; do
  sed -n 2p <<< "$browser" | grep -qF -- " $flag " || {
    echo "the main browser lacks $flag" >&2
    exit 1
  }
done
if grep -q '^CHROME_EXTRA_FLAGS=' <<< "$browser"; then
  echo "the main browser inherited CHROME_EXTRA_FLAGS" >&2
  exit 1
fi
echo "browser: Google Chrome maximized on browser/main"

# The browser tier's Chrome DevTools MCP is the pinned one beside the daemon, and starts with no update check (§5.8).
cdm=$(docker exec "$name" sh -c 'home=$(mktemp -d) && CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 HOME="$home" \
  node /opt/agentconnect/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js --version \
  && ! test -e "$home/.cache"; status=$?; rm -rf "$home"; exit $status') || {
  echo "Chrome DevTools MCP is missing, or checked for updates" >&2
  exit 1
}
[ "$cdm" = 1.13.0 ] || {
  echo "expected Chrome DevTools MCP 1.13.0, found $cdm" >&2
  exit 1
}
echo "chrome devtools mcp: $cdm, no update check"

# Registration from the environment against a stub Control Plane: one exchange, the key kept on restart, the token never shown.
token="acr_smoke_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
stub='
  let count = 0
  require("http").createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/count") return res.end(String(count))
      if (req.method !== "POST" || req.url !== "/v1/computers/register") return res.writeHead(404).end()
      if (JSON.parse(body).token !== process.env.TOKEN || count > 0) return res.writeHead(401).end()
      count++
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ computerId: "00000000-0000-4000-8000-000000000001", orgId: "org_smoke",
        apiKeyId: "key_smoke", apiKey: "ack_smoke", channelUrl: "ws://127.0.0.1:9/v1/computers/ws" }))
    })
  }).listen(8080)'
docker network create "$net" > /dev/null
docker run -d --name "$name-stub" --network "$net" -e TOKEN="$token" --entrypoint node "$image" -e "$stub" > /dev/null
docker run -d --name "$name-reg" --network "$net" --shm-size=1g \
  -e AGENTCONNECT_CP_URL="http://$name-stub:8080" -e AGENTCONNECT_REGISTER_TOKEN="$token" "$image" > /dev/null
wait_log() {
  for _ in $(seq 1 60); do
    docker logs "$name-reg" 2>&1 | grep -q "$1" && return 0
    sleep 2
  done
  docker logs "$name-reg" >&2
  return 1
}
wait_browser() {
  for _ in $(seq 1 30); do
    docker exec "$name-reg" pgrep -x chrome > /dev/null && return 0
    sleep 1
  done
}
wait_log 'registered as computer 00000000-0000-4000-8000-000000000001' || {
  echo "the container did not register from its environment" >&2
  exit 1
}
docker exec "$name-reg" test -f /home/computer/.agentconnect/computer/computer-key.json
wait_browser
docker restart -t 20 "$name-reg" > /dev/null
wait_log 'registration token is not used again' || {
  echo "a restart did not keep the stored key" >&2
  exit 1
}
exchanges=$(docker exec "$name-stub" node -e 'fetch("http://127.0.0.1:8080/count").then((r) => r.text()).then(console.log)')
[ "$exchanges" = 1 ] || {
  echo "expected one token exchange, got $exchanges" >&2
  exit 1
}
wait_browser
# Only tini, the entrypoint and the daemon start with the token; the session, the browser and the driver never see it.
# `docker exec` itself inherits the container's environment, so the probe drops the token from its own first.
environs=$(docker exec "$name-reg" env -u AGENTCONNECT_REGISTER_TOKEN sh -c '
  for dir in /proc/[0-9]*; do
    comm=$(cat "$dir/comm" 2> /dev/null) || continue
    case "$comm" in tini | entrypoint.sh | "AgentConnect Co") continue ;; esac
    echo "== ${dir#/proc/} $comm"
    tr "\0" "\n" < "$dir/environ" 2> /dev/null || true
  done')
grep -q '^== .* chrome$' <<< "$environs" && grep -q '^== .* xfce4-session$' <<< "$environs" \
  && grep -q '^== .* cua-driver$' <<< "$environs" || {
  grep '^==' <<< "$environs" >&2
  echo "the session, the browser or the driver is not running" >&2
  exit 1
}
if docker logs "$name-reg" 2>&1 | grep -qF "$token" || grep -qF "$token" <<< "$environs"; then
  echo "the registration token leaked into the log or a session process" >&2
  exit 1
fi
echo "registration: registered once, kept on restart, token not shown"

# The image alone grants no root: sudo has no rule until a system volume is seeded.
if docker exec "$name" sudo -n true 2> /dev/null; then
  echo "sudo works without a seeded system volume" >&2
  exit 1
fi

# A system volume (§3.8): seeded once, sudo and apt work as the desktop user, and a package outlives its container.
docker volume create "$name-sys" > /dev/null
seed() {
  docker run --rm --user 0 --entrypoint /opt/agentconnect/seed-system.sh -v "$name-sys:/volume" "$image" /volume
}
system=(--mount "type=volume,src=$name-sys,dst=/home/computer,volume-subpath=home")
for dir in usr etc var; do
  system+=(--mount "type=volume,src=$name-sys,dst=/$dir,volume-subpath=system/$dir")
done
seeded=$(seed)
grep -q "copied the image's system" <<< "$seeded" || {
  echo "the first seed did not copy the image's system" >&2
  exit 1
}
docker run -d --name "$name-sys" --shm-size=1g "${system[@]}" "$image" > /dev/null
wait_healthy "$name-sys"
# The browser that runs is the volume's: its binary sits on the /usr mount.
exe=
for _ in $(seq 1 30); do
  exe=$(docker exec "$name-sys" sh -c 'lock=$(readlink "$AGENTCONNECT_COMPUTER_HOME/browser/main/SingletonLock") \
    && exe=$(readlink "/proc/${lock##*-}/exe") && echo "$(stat -c %m "$exe") $exe"' 2> /dev/null) && break
  sleep 1
done
[ "$exe" = "/usr /usr/lib/google/chrome/chrome" ] || {
  echo "the browser on a system volume does not run from the volume's /usr: ${exe:-none}" >&2
  exit 1
}
[ "$(docker exec "$name-sys" sudo -n id -u)" = 0 ] || {
  echo "sudo does not reach root on a seeded system volume" >&2
  exit 1
}
installed=
for _ in 1 2 3; do
  if docker exec "$name-sys" sudo -n sh -c 'apt-get update -q && apt-get install -y -q --no-install-recommends sl' > /dev/null 2>&1; then
    installed=1
    break
  fi
  sleep 5
done
[ -n "$installed" ] || {
  echo "apt-get install failed on a seeded system volume" >&2
  exit 1
}
docker rm -f "$name-sys" > /dev/null
seeded=$(seed)
if grep -q "copied the image's system" <<< "$seeded"; then
  echo "a second seed copied the system again" >&2
  exit 1
fi
docker run --rm "${system[@]}" --entrypoint sh "$image" -c 'dpkg -s sl > /dev/null && test -x /usr/games/sl && sudo -n true && node --version > /dev/null' || {
  echo "the installed package, sudo or node did not survive a new container" >&2
  exit 1
}
echo "system volume: seeded once, sudo and apt work, the package survives"

started=$(date +%s)
docker stop -t 20 "$name" > /dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
echo "stop: exit $code in $(($(date +%s) - started))s"
[ "$code" = 0 ]
