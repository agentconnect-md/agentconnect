# AgentConnectOrg CRD + Operator (retired)

**Status:** Removed. The `AgentConnectOrg` CRD, the operator that reconciled it,
and the control plane's per-org envelope provisioner have all been deleted.

The per-org execution envelope — one CR, one namespace, one daemon supervisor
per organization — is superseded by the shared multi-org daemon pool
([k8s-daemon-pool.md](k8s-daemon-pool.md), decision D17: no per-org Kubernetes
objects, one shared sandbox namespace, tier-shared warm pools, label-scoped
policies). The model was retired outright rather than migrated because no
production or staging envelope ever depended on it: the only consumers were
disposable test organizations, so there was nothing to carry across and a
migration path would have been machinery written for an empty set. The pieces
the pool still needs — TokenReview-based daemon identity, the in-cluster
Kubernetes client, the daemon's `--k8s` spawn driver — survive and are described
in [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) and
[k8s-daemon-pool.md](k8s-daemon-pool.md). This page stays as a tombstone so the
links that point here still resolve.
