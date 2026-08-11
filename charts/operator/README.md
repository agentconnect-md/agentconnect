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

Kubernetes 1.30 or newer is required (`kubeVersion` in `Chart.yaml`): the
isolation fences below are `ValidatingAdmissionPolicy` objects, GA since 1.30.

`installCRD` gates the cluster-shared pieces (the `AgentConnectOrg` CRD today;
vendored agent-sandbox CRDs/controllers later):

- **Single-environment clusters** keep the default `installCRD: true`.
- **Multi-environment clusters** set `installCRD: false` on every release and
  manage the CRD out-of-band, so no environment's lifecycle owns it.

The CRD template carries `helm.sh/resource-policy: keep`: uninstalling the
release that installed it leaves the CRD (and every org) in place.

## Admission policies

Each release renders its own release-prefixed pair of `ValidatingAdmissionPolicy`
objects from its two install-time constants. Both deny on failure — an
expression that cannot be evaluated rejects the request.

- **`<release>-ac-envelope-fence`** bounds this install's operator ServiceAccount.
  Every write it makes must land in a namespace carrying `orgNamespacePrefix`;
  the only exceptions are its own `AgentConnectOrg` resources and election Lease
  in the release namespace. Namespaces it creates must carry the envelope org
  labels and a `baseline`-or-stricter Pod Security level, and the only other
  cluster-scoped objects it may write are the per-org TokenReview bindings.
  RBAC already scopes the verbs; this scopes _where_ they may be used.
- **`<release>-ac-sandbox-baseline`** applies to every pod in an org namespace
  (selected by the `agentconnect.md/org-namespace` claim label, narrowed to this
  install's prefix): no privileged containers, no host namespaces, no `hostPath`
  volumes, and — for every pod except the daemon supervisor —
  `automountServiceAccountToken: false`, with a projected token restricted to the
  daemon callback audience as the only service-account token it may carry.

**Marking control namespaces.** On a cluster shared by several installs, label
each control namespace so no install's operator can write into another's, even
if a prefix is later misconfigured to overlap it:

```bash
kubectl label namespace CONTROL_NAMESPACE agentconnect.md/control-namespace=''
```

The fence only tests for the key, so the value is free. Prefixes must still not
overlap a control namespace name — the label is the second line of defense, not
the first.

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
