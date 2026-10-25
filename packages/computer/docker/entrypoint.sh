#!/bin/bash
# Starts Xvfb, a session D-Bus, Xfce and the browser, then the daemon in the foreground; SIGTERM stops the daemon first.
set -euo pipefail

# The one-time registration token reaches the daemon only, never the session, the browser or the log.
register_token="${AGENTCONNECT_REGISTER_TOKEN:-}"
unset AGENTCONNECT_REGISTER_TOKEN

export DISPLAY=:1 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=XFCE
unset WAYLAND_DISPLAY
export XDG_RUNTIME_DIR="/tmp/runtime-$(id -u)"
mkdir -p -m 700 "$XDG_RUNTIME_DIR"

# A managed pod's browser and daemon share the egress forwarder's port, so its traffic follows the organization's egress.
if [ -n "${AGENTCONNECT_POOL_BOOTSTRAP_PORT:-}" ]; then
  export AGENTCONNECT_EGRESS_PORT="${AGENTCONNECT_EGRESS_PORT:-7691}"
fi

data="${AGENTCONNECT_COMPUTER_HOME:-$HOME/.agentconnect/computer}"
mkdir -p -m 700 "$data"
[ -e "$data/cua-driver" ] || ln -s /opt/agentconnect/tools/cua-driver "$data/cua-driver"
# An earlier image linked a preinstalled ffmpeg here; drop the dangling link so the daemon can download its own.
[ -L "$data/ffmpeg" ] && [ ! -e "$data/ffmpeg" ] && rm -f "$data/ffmpeg"

# The container filesystem survives `docker restart`, and so would a stale X lock.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
# dbus-launch connects and leaves first; a reset on that last disconnect would drop the session's connection mid-handshake.
Xvfb :1 -screen 0 "${RESOLUTION:-1600x900x24}" -nolisten tcp -noreset -dpi 96 > /tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X1 ] && break
  sleep 0.1
done
[ -S /tmp/.X11-unix/X1 ] || {
  cat /tmp/xvfb.log >&2
  echo "Xvfb did not start" >&2
  exit 1
}

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
xfce4-session > /tmp/xfce4-session.log 2>&1 &
session=$!

# Keeps one maximized browser window open: it is restarted when it exits or crashes, with a growing pause.
supervise_browser() {
  trap 'exit 0' TERM INT
  local pause=1 started pid window steady status
  while true; do
    # A second launch would only open another window in the instance holding the profile, so wait for that one to exit.
    if pgrep -u "$(id -u)" -x "$(basename "$BROWSER")" > /dev/null; then
      sleep 2 &
      wait $!
      continue
    fi
    started=$(date +%s)
    # shellcheck disable=SC2086 -- BROWSER_URL is optional and never contains spaces
    "$BROWSER" ${BROWSER_URL:-} > /tmp/browser.log 2>&1 &
    pid=$!
    # The window appears a moment after the process and may resize itself once mapped, so retry until it stays maximized.
    steady=0
    for _ in $(seq 1 150); do
      kill -0 "$pid" 2> /dev/null || break
      # wmctrl fails until the window manager is up.
      window=$(wmctrl -lp 2> /dev/null | awk -v pid="$pid" '$3 == pid { print $1; exit }') || window=
      if [ -n "$window" ]; then
        if xprop -id "$window" _NET_WM_STATE 2> /dev/null | grep -q _NET_WM_STATE_MAXIMIZED_HORZ; then
          steady=$((steady + 1))
          [ "$steady" -ge 10 ] && break
        else
          steady=0
          wmctrl -i -r "$window" -b add,maximized_vert,maximized_horz 2> /dev/null || true
        fi
      fi
      sleep 0.2
    done
    status=0
    wait "$pid" || status=$?
    # A browser that stayed up a minute starts the backoff over.
    if [ $(($(date +%s) - started)) -ge 60 ]; then pause=1; else pause=$((pause < 30 ? pause * 2 : 30)); fi
    echo "[entrypoint] $BROWSER exited ($status); restarting in ${pause}s" >&2
    # In the background, so the TERM trap runs at once rather than after the pause.
    sleep "$pause" &
    wait $!
  done
}
browser=
if [ -n "${BROWSER:-}" ] && [ "$BROWSER" != none ]; then
  supervise_browser &
  browser=$!
fi

# Published ports reach the container through its own interface, so the image asks for every interface explicitly.
args=(run --host "${LISTEN_HOST:-0.0.0.0}" --port "${PORT:-7681}")
[ -n "${PUBLIC_URL:-}" ] && args+=(--public-url "$PUBLIC_URL")
[ -n "${RTC_ADDRESS:-}" ] && args+=(--rtc-address "$RTC_ADDRESS")
[ -n "${RTC_PORTS:-}" ] && args+=(--rtc-ports "$RTC_PORTS")
if [ -n "$register_token" ]; then
  AGENTCONNECT_REGISTER_TOKEN="$register_token" node /opt/agentconnect/agentconnect-computer.mjs "${args[@]}" < /dev/null &
else
  node /opt/agentconnect/agentconnect-computer.mjs "${args[@]}" < /dev/null &
fi
daemon=$!
unset register_token

stop() { kill -TERM "$daemon" 2> /dev/null || true; }
trap stop TERM INT
# `wait` returns early (143) when the trap fires, so keep the status of the final wait only.
status=0
while kill -0 "$daemon" 2> /dev/null; do
  status=0
  wait "$daemon" || status=$?
done

# Stop restarting the browser, then close every app gracefully so the Firefox profile is not left locked.
[ -n "$browser" ] && kill -TERM "$browser" 2> /dev/null || true
pkill -TERM -u "$(id -u)" -x firefox-esr 2> /dev/null || true
for _ in $(seq 1 50); do
  pgrep -u "$(id -u)" -x firefox-esr > /dev/null || break
  sleep 0.1
done
kill -TERM "$session" 2> /dev/null || true
sleep 0.5
kill -TERM "$DBUS_SESSION_BUS_PID" "$xvfb" 2> /dev/null || true
wait 2> /dev/null || true
exit "$status"
