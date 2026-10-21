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

cleanup() { docker rm -f "$name" > /dev/null 2>&1 || true; }
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

doctor=$(docker exec "$name" agentconnect-desktop doctor --json --daemon --port 7681)
echo "$doctor"
failed=$(printf '%s' "$doctor" | docker exec -i "$name" node -e 'const c = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(c.filter((x) => !["ok", "info"].includes(x.status)).map((x) => x.name).join(" "))')
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

started=$(date +%s)
docker stop -t 20 "$name" > /dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
echo "stop: exit $code in $(($(date +%s) - started))s"
[ "$code" = 0 ]
