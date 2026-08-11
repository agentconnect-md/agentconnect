#!/usr/bin/env bash
# Adds our label domain to the agent-sandbox controller's allowlist, wherever it lives.
#
# A YAML manifest cannot do this job. The key REPLACES the allowlist, so an apply would revoke
# whatever is already there — including the controller's built-in `sandbox.users.io` fallback — and
# a manifest that names its own namespace cannot be relocated to the controller's with `-n`.
# Upstream installs into `agent-sandbox-system`; some clusters run it elsewhere.
#
# Without this the controller rejects our claims with `InvalidMetadata` and never creates a Sandbox.
set -euo pipefail

DOMAIN="${1:-agentconnect.md}"
FALLBACK=sandbox.users.io

NS="$(kubectl get deploy -A \
  -o jsonpath='{range .items[?(@.metadata.name=="agent-sandbox-controller")]}{.metadata.namespace}{end}')"
if [ -z "$NS" ]; then
  echo "agent-sandbox-controller not found in any namespace" >&2
  exit 1
fi

# Read-modify-write, not a presence check: if the ConfigMap exists with other domains, ours has to
# be appended to them. `|| true` because a missing ConfigMap is the ordinary first-run case.
CURRENT="$(kubectl -n "$NS" get cm agent-sandbox-config -o jsonpath='{.data.allowed-label-domains}' 2> /dev/null || true)"
[ -n "$CURRENT" ] || CURRENT="$FALLBACK"
case ",${CURRENT}," in
  *",${DOMAIN},"*)
    echo "$DOMAIN already allowed in $NS: $CURRENT"
    exit 0
    ;;
esac
MERGED="${CURRENT},${DOMAIN}"

kubectl -n "$NS" create configmap agent-sandbox-config \
  --from-literal=allowed-label-domains="$MERGED" \
  --dry-run=client -o yaml | kubectl -n "$NS" apply -f -

# The controller reads this file once at startup. It is shared infrastructure: a restart interrupts
# reconciliation for every tenant, so check first.
echo
echo "allowlist in $NS is now: $MERGED"
echo "running sandboxes (restarting the controller affects reconciliation for these):"
kubectl get sandboxes -A --no-headers 2> /dev/null || echo "  (none)"
echo
echo "restart the controller to pick it up:"
echo "  kubectl -n $NS rollout restart deploy/agent-sandbox-controller"
