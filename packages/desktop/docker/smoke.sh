#!/usr/bin/env bash
# Smoke test of a built desktop image: size, health, doctor, a maximized browser and a clean stop (computer-use.md §3.8).
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
name="agentconnect-desktop-smoke-$$"
max_bytes=$((1024 * 1024 * 1024))

size=$(docker image inspect --format '{{.Size}}' "$image")
echo "image size: $((size / 1024 / 1024)) MiB"
[ "$size" -le "$max_bytes" ] || {
  echo "the image is larger than 1 GiB" >&2
  exit 1
}

net="$name-net"
cleanup() {
  docker rm -f "$name" "$name-reg" "$name-stub" > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$name" --shm-size=1g "$image" > /dev/null

health=starting
for _ in $(seq 1 60); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$name")
  [ "$health" = starting ] || break
  sleep 3
done
if [ "$health" != healthy ]; then
  docker logs "$name" >&2
  docker inspect --format '{{json .State.Health}}' "$name" >&2
  echo "health: $health" >&2
  exit 1
fi
echo "health: healthy"

# ffmpeg is not in the image: the daemon downloads it on first start, so its checks turn ok once that finishes.
for _ in $(seq 1 40); do
  doctor=$(docker exec "$name" agentconnect-desktop doctor --json --daemon --port 7681)
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

# The browser starts beside the daemon, so give it a moment to map and maximize its window.
maximized=
for _ in $(seq 1 30); do
  if docker exec -e DISPLAY=:1 "$name" sh -c \
    'w=$(wmctrl -l | awk "/Mozilla Firefox/ { print \$1; exit }"); [ -n "$w" ] && xprop -id "$w" _NET_WM_STATE' \
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
echo "browser: maximized"

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
    docker exec "$name-reg" pgrep -x firefox-esr > /dev/null && return 0
    sleep 1
  done
}
wait_log 'registered as computer 00000000-0000-4000-8000-000000000001' || {
  echo "the container did not register from its environment" >&2
  exit 1
}
docker exec "$name-reg" test -f /home/desktop/.agentconnect/desktop/computer-key.json
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
    case "$comm" in tini | entrypoint.sh | "AgentConnect De") continue ;; esac
    echo "== ${dir#/proc/} $comm"
    tr "\0" "\n" < "$dir/environ" 2> /dev/null || true
  done')
grep -q '^== .* firefox-esr$' <<< "$environs" && grep -q '^== .* xfce4-session$' <<< "$environs" \
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

started=$(date +%s)
docker stop -t 20 "$name" > /dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
echo "stop: exit $code in $(($(date +%s) - started))s"
[ "$code" = 0 ]
