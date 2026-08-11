# agentconnect-operator

Installs the AgentConnect cluster operator, which reconciles `AgentConnectOrg`
resources in the release namespace (the environment's _control namespace_)
into per-org execution envelopes: namespace, RBAC, network policies, sandbox
templates and warm pools, and the org's daemon supervisor.

## Layout

One release per environment. Several environments can share a cluster: each
release carries its own operator, election Lease, admission policies, and a
release-prefixed tokenreview ClusterRole, all parameterized by two install-time
constants — the release namespace and `orgNamespacePrefix`. Prefixes must not
overlap between installs (in either direction), and must not be a prefix of any
control namespace.

`installCRD` gates the cluster-shared pieces (the `AgentConnectOrg` CRD today;
vendored agent-sandbox CRDs/controllers later):

- **Single-environment clusters** keep the default `installCRD: true`.
- **Multi-environment clusters** set `installCRD: false` on every release and
  manage the CRD out-of-band, so no environment's lifecycle owns it.

The CRD template carries `helm.sh/resource-policy: keep`: uninstalling the
release that installed it leaves the CRD (and every org) in place.

## Dependencies

The agent-sandbox CRDs and controllers (`agents.x-k8s.io`) must be installed
separately for now — see `deploy/k8s/README.md` in the repository. Vendoring
them behind `installCRD` is planned.

## Install

```bash
helm install ENV_NAME oci://ghcr.io/agentconnect-md/charts/agentconnect-operator \
  --namespace CONTROL_NAMESPACE --create-namespace \
  --set orgNamespacePrefix=ENV_PREFIX-org-
```

(Chart publishing to the OCI registry lands with the release-pipeline wiring;
until then install from this directory.)

## Uninstall

Delete every `AgentConnectOrg` first and wait for finalizers to complete — the
pre-delete hook refuses to uninstall while CRs remain, because removing the
operator strands their finalizers.
