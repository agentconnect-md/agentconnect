# agentconnect-operator

Installs the AgentConnect cluster operator, which reconciles `AgentConnectOrg`
resources in the release namespace (the environment's _control namespace_)
into per-org execution envelopes: namespace, RBAC, network policies, sandbox
templates and warm pools, and the org's daemon supervisor.

An envelope's namespace is **derived by default**: `orgNamespacePrefix` plus the
`AgentConnectOrg`'s own name, which is unique in the control namespace — so two
CRs cannot collide on one namespace. A deployment that needs a specific namespace
sets `spec.targetNamespace`, which is immutable and must still start with the
install's prefix. Either way the operator publishes the result on
`status.namespace`, which is where every consumer — including the credential
writer — reads it.

## Layout

One release per environment. Several environments can share a cluster: each
release carries its own operator, election Lease, admission policies, and a
release-prefixed tokenreview ClusterRole, all parameterized by two install-time
constants — the release namespace and `orgNamespacePrefix`. Prefixes must not
overlap between installs (in either direction), and must not be a prefix of any
control namespace.

Kubernetes 1.30 or newer is required (`kubeVersion` in `Chart.yaml`): the
isolation fences below are `ValidatingAdmissionPolicy` objects, GA since 1.30.

`installCRD` gates the cluster-shared pieces: the `AgentConnectOrg` CRD and the
vendored agent-sandbox stack.

- **Single-environment clusters** keep the default `installCRD: true` — a fresh
  cluster needs nothing installed by hand.
- **Multi-environment clusters** set `installCRD: false` on every release and
  manage the shared pieces out-of-band, so no environment's lifecycle owns
  them. Same setting for a cluster that already runs agent-sandbox: Helm
  refuses to adopt objects it did not create.

Every CRD carries `helm.sh/resource-policy: keep`: uninstalling the release that
installed them leaves them — and every org and Sandbox — in place.

## Admission policies

Each release renders its own release-prefixed pair of `ValidatingAdmissionPolicy`
objects from its two install-time constants. Both deny on failure — an
expression that cannot be evaluated rejects the request.

- **`<release>-ac-envelope-fence`** bounds this install's operator ServiceAccount.
  Every write it makes must land in a namespace carrying `orgNamespacePrefix`;
  the only exceptions are its own `AgentConnectOrg` resources and election Lease
  in the release namespace. A namespace marked as a control namespace is neither
  a write target nor an object it may delete or strip the marker from. Namespaces it creates must carry the envelope org
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

## The vendored agent-sandbox stack

Envelopes are built on [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
(`agents.x-k8s.io`, `extensions.agents.x-k8s.io`). Under `installCRD: true` the
chart installs it: **v0.5.4**, vendored at `vendor/agent-sandbox.yaml` — the
namespace `agent-sandbox-system`, the four CRDs, the controller with its RBAC
and Services, plus one ConfigMap of ours.

Vendored rather than depended on: upstream publishes release manifests but no
chart to any registry ([issue #483](https://github.com/kubernetes-sigs/agent-sandbox/issues/483)),
so there is nothing for `Chart.yaml` to point at. The vendored file is the
release asset `sandbox-with-extensions.yaml` with exactly one edit —
`helm.sh/resource-policy: keep` on each CRD — and its header records the source
URL and the upstream digest.

The ConfigMap (`agent-sandbox-config`) sets the controller's label allowlist to
`sandbox.users.io,agentconnect.md`. That key _replaces_ the controller's default
rather than extending it, which is why both are named; without ours the
controller rejects every SandboxClaim the daemon makes with `InvalidMetadata`.

### Upgrading the pin

```bash
node scripts/vendor-agent-sandbox.mjs vX.Y.Z # rewrites vendor/agent-sandbox.yaml
```

Read the diff before committing — CRD schema changes are upstream API changes —
then update the version named above. The script is deterministic, so re-running
it on the same tag produces no diff.

The CRDs are templated, not in a `crds/` directory, so `helm upgrade` does roll
them forward (`keep` only holds them back from an uninstall). A release that
moves the stored API version is the exception: upstream ships a storage
migration for it, and skipping that is how CRs become unreadable.

## Daemon state volume

Every org envelope carries one `ReadWriteOncePod` PVC for its daemon's
transcripts and local state, provisioned from `daemonStorage`:

```yaml
daemonStorage:
  className: '' # empty = the cluster default StorageClass
  size: 10Gi
```

Leave `className` empty only when the cluster default is a cluster-wide
(network-attached) class. A node-local default provisioner binds a volume to
whichever node has a path for it, so the claim fails wherever the scheduler
places the daemon — the pod then never starts, with the PVC stuck `Pending`.

Both settings apply when the claim is created. Kubernetes rejects a class change
on an existing PVC, so changing them moves new orgs only; an org already
provisioned keeps its volume until that volume is deleted.

## Install

```bash
helm install ENV_NAME oci://ghcr.io/agentconnect-md/charts/agentconnect-operator \
  --namespace CONTROL_NAMESPACE --create-namespace \
  --set orgNamespacePrefix=ENV_PREFIX-org-
```

(Chart publishing to the OCI registry lands with the release-pipeline wiring;
until then install from this directory.)

## Telemetry

The operator ships the same OpenTelemetry bootstrap as the other services and
starts nothing unless the standard `OTEL_*` environment is present, so an
install that wants traces points it at a collector through
`operator.extraEnv` (raw container env entries, empty by default):

```yaml
operator:
  extraEnv:
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      value: http://<collector-service>.<collector-namespace>:4318
```

## Uninstall

Delete every `AgentConnectOrg` first and wait for finalizers to complete — the
pre-delete hook refuses to uninstall while CRs remain, because removing the
operator strands their finalizers.

The hook is a Job running the operator image's `preflight-uninstall` subcommand
under the operator's own ServiceAccount: it lists the CRs in the release
namespace and exits non-zero, naming them, if any are left. A failed hook Job is
kept, so its log is the diagnosis:

```bash
kubectl -n CONTROL_NAMESPACE logs job/RELEASE_NAME-operator-pre-delete
```
