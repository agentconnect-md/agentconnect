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
# be appended to them.
#
# `--ignore-not-found` rather than `|| true`, deliberately. `|| true` swallows EVERY read failure —
# an API timeout, a denied RBAC check — as "absent", and the write that follows would then replace a
# shared allowlist with just these two domains, revoking every other tenant's. Only a genuine
# NotFound may be quiet here; anything else must abort before any write, which `set -e` now does.
EXISTS=$(kubectl -n "$NS" get cm agent-sandbox-config --ignore-not-found -o name)
CURRENT=""
if [ -n "$EXISTS" ]; then
  CURRENT="$(kubectl -n "$NS" get cm agent-sandbox-config -o jsonpath='{.data.allowed-label-domains}')"
fi
[ -n "$CURRENT" ] || CURRENT="$FALLBACK"
case ",${CURRENT}," in
  *",${DOMAIN},"*)
    echo "$DOMAIN already allowed in $NS: $CURRENT"
    exit 0
    ;;
esac
MERGED="${CURRENT},${DOMAIN}"

if [ -n "$EXISTS" ]; then
  # A merge patch on the ONE key. Applying a whole generated ConfigMap would take the rest of its
  # data with it — this ConfigMap is the controller's, and it may hold keys that are none of our
  # business. Still last-writer-wins against a concurrent edit of this same key; the read above is
  # seconds old, and the alternative is a resourceVersion CAS loop for a step run by hand.
  kubectl -n "$NS" patch cm agent-sandbox-config --type merge \
    -p "{\"data\":{\"allowed-label-domains\":\"${MERGED}\"}}"
else
  kubectl -n "$NS" create configmap agent-sandbox-config \
    --from-literal=allowed-label-domains="$MERGED"
fi

# The controller reads this file once at startup. It is shared infrastructure: a restart interrupts
# reconciliation for every tenant, so check first.
echo
echo "allowlist in $NS is now: $MERGED"
echo "running sandboxes (restarting the controller affects reconciliation for these):"
kubectl get sandboxes -A --no-headers 2> /dev/null || echo "  (none)"
echo
echo "restart the controller to pick it up:"
echo "  kubectl -n $NS rollout restart deploy/agent-sandbox-controller"
