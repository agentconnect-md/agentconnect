#!/bin/bash
# Starts Xvfb, a session D-Bus and Xfce, then the daemon in the foreground; SIGTERM stops the daemon first, then the session.
set -euo pipefail

export DISPLAY=:1 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=XFCE
unset WAYLAND_DISPLAY
export XDG_RUNTIME_DIR="/tmp/runtime-$(id -u)"
mkdir -p -m 700 "$XDG_RUNTIME_DIR"

data="${AGENTCONNECT_DESKTOP_HOME:-$HOME/.agentconnect/desktop}"
mkdir -p -m 700 "$data"
for tool in cua-driver ffmpeg; do [ -e "$data/$tool" ] || ln -s "/opt/agentconnect/tools/$tool" "$data/$tool"; done

# The container filesystem survives `docker restart`, and so would a stale X lock.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 "${RESOLUTION:-1600x900x24}" -nolisten tcp -dpi 96 &
xvfb=$!
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X1 ] && break
  sleep 0.1
done
[ -S /tmp/.X11-unix/X1 ] || {
  echo "Xvfb did not start" >&2
  exit 1
}

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
xfce4-session > /tmp/xfce4-session.log 2>&1 &
session=$!

args=(run --port "${PORT:-7681}")
[ -n "${RTC_ADDRESS:-}" ] && args+=(--rtc-address "$RTC_ADDRESS")
[ -n "${RTC_PORTS:-}" ] && args+=(--rtc-ports "$RTC_PORTS")
node /opt/agentconnect/agentconnect-desktop.mjs "${args[@]}" < /dev/null &
daemon=$!

stop() { kill -TERM "$daemon" 2> /dev/null || true; }
trap stop TERM INT
# `wait` returns early (143) when the trap fires, so keep the status of the final wait only.
status=0
while kill -0 "$daemon" 2> /dev/null; do
  status=0
  wait "$daemon" || status=$?
done

# Apps the agent launched outlive the daemon; close them gracefully so the Firefox profile is not left locked.
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
