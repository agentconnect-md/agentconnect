#!/usr/bin/env bash

set -u

mode="${1:-no-auth}"
checkout="${2:-.}"
errors=0
warnings=0

ok() { printf 'ok: %s\n' "$1"; }
warn() {
  printf 'warning: %s\n' "$1"
  warnings=$((warnings + 1))
}
fail() {
  printf 'error: %s\n' "$1"
  errors=$((errors + 1))
}

case "$mode" in
  no-auth | local-logto | cloud-logto) ;;
  *)
    printf 'usage: %s <no-auth|local-logto|cloud-logto> [agentconnect-checkout]\n' "$0" >&2
    exit 2
    ;;
esac

if [ ! -d "$checkout" ]; then
  printf 'error: checkout directory does not exist: %s\n' "$checkout" >&2
  exit 2
fi

cd "$checkout" || exit 2

if command -v docker > /dev/null 2>&1; then
  ok 'docker command is available'
else
  fail 'docker is not installed or not on PATH'
fi

if command -v git > /dev/null 2>&1; then
  ok 'git command is available'
else
  warn 'git is not installed or not on PATH'
fi

if [ -f compose.yaml ]; then
  ok 'compose.yaml exists'
else
  fail 'compose.yaml is missing; run this from an AgentConnect checkout'
fi

compose=(docker compose)
case "$mode" in
  local-logto)
    if [ -f compose.logto.yaml ]; then
      ok 'compose.logto.yaml exists'
      compose+=(-f compose.yaml -f compose.logto.yaml)
    else
      fail 'compose.logto.yaml is missing'
    fi
    ;;
  cloud-logto)
    if [ -f compose.env ]; then
      ok 'compose.env exists'
      compose+=(--env-file compose.env)
      for name in LOGTO_ENDPOINT LOGTO_ADMIN_ENDPOINT OIDC_ISSUER LOGTO_MGMT_ENDPOINT; do
        if grep -Eq "^[[:space:]]*${name}=.+$" compose.env; then
          ok "$name is configured"
        else
          fail "$name is missing or empty in compose.env"
        fi
      done
    else
      fail 'compose.env is missing for cloud-logto mode'
    fi
    ;;
  no-auth)
    if [ -f compose.env ] && grep -Eq '^[[:space:]]*AGENTCONNECT_BIND_ADDRESS=' compose.env \
      && ! grep -Eq '^[[:space:]]*AGENTCONNECT_BIND_ADDRESS=(127\.0\.0\.1|localhost)[[:space:]]*$' compose.env; then
      fail 'no-auth mode has a non-loopback AGENTCONNECT_BIND_ADDRESS'
    else
      ok 'no-auth mode has no detected non-loopback bind override'
    fi
    ;;
esac

arch="$(uname -m 2> /dev/null || printf unknown)"
case "$arch" in
  x86_64 | amd64) ok 'host architecture is amd64-compatible' ;;
  arm64 | aarch64) warn 'published images target linux/amd64; enable container emulation' ;;
  *) warn "unrecognized host architecture: $arch" ;;
esac

if command -v docker > /dev/null 2>&1; then
  if docker compose version > /dev/null 2>&1; then
    ok 'Docker Compose v2 is available'
  else
    fail 'docker compose v2 is unavailable'
  fi

  if docker info > /dev/null 2>&1; then
    ok 'Docker engine is reachable'
    if [ -f compose.yaml ] && "${compose[@]}" config --services > /dev/null 2>&1; then
      ok 'Compose configuration is valid'
      printf '\nCurrent Compose status (read-only):\n'
      "${compose[@]}" ps --all 2> /dev/null || true
    else
      fail 'Compose configuration does not validate for the selected mode'
    fi
  else
    fail 'Docker engine is not reachable'
  fi
fi

printf '\nSummary: %d error(s), %d warning(s).\n' "$errors" "$warnings"
[ "$errors" -eq 0 ]
