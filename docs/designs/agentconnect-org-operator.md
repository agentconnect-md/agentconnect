# AgentConnectOrg CRD + Operator

**Status:** Envelope, status, deletion, and rollout reconcile logic implemented — including the
drain handshake with the daemon and its timeout — plus the control-plane CR provisioner (§6);
gateway policy rendering waits on the gateway spike, and the credential key authority is still TODO.

The managed execution plane provisions one _org envelope_ per organization on a
Kubernetes cluster: a namespace, RBAC, network policies, sandbox templates and
warm pools, and the org's daemon supervisor. This document describes the
declarative interface (`AgentConnectOrg`) and the operator that reconciles it.
The daemon-side half of the cluster story (spawn driver, shim, TokenReview
binding) is in [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md); the
agent-sandbox stack it builds on is documented in `deploy/k8s/README.md`.

## 1. Shape of the system

- **`AgentConnectOrg`** (`agentconnect.md/v1alpha1`, namespaced, short name
  `acorg`) — one CR per org, living in the install's _control namespace_ (the
  Helm release namespace). `spec.targetNamespace` names the org's envelope
  namespace. The CR is the sole desired-state carrier for the envelope; who
  writes it is deployment policy (an administrator or GitOps statically, a
  control plane programmatically), and the operator does not care.
- **Operator** (`@agentconnect.md/operator`, container bin
  `agentconnect-operator`) — two replicas, Lease leader election, the leader
  watches CRs _only in its own namespace_ and reconciles envelopes. It holds
  no control-plane credentials and has **zero Secret API access** anywhere.
- **Install-time constants** — each install is fully parameterized by its
  control namespace and an org-namespace prefix (`AC_ORG_NAMESPACE_PREFIX`).
  Several installs (environments) share one cluster by choosing disjoint
  constants; all isolation checks are static string comparisons rendered into
  each install's RBAC and admission policies at chart-install time.

## 2. CRD

Authoritative schema: `charts/operator/templates/crd.yaml` (full
openAPIV3Schema with per-field descriptions and CEL transition rules). The
zod schemas in `packages/operator/src/crd/types.ts` are the operator's runtime
guard; a parity unit test asserts the two field trees stay identical.

| spec field                    | Notes                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targetNamespace`             | DNS label, **immutable** (CEL). Shape-only at CRD level; install ownership (prefix) is enforced by the operator and admission.                                                       |
| `suspend`                     | Quiesce the org: daemon to zero, sandboxes drained, gateway denies LLM calls.                                                                                                        |
| `daemon.image`, `daemon.tier` | Supervisor image (change ⇒ Recreate rollout) and resource tier name.                                                                                                                 |
| `daemon.credentialSecretName` | **Immutable**, default `ac-daemon-token`. A reference only — the Secret is written by the key authority, mounted required so the kubelet gates startup; the operator never reads it. |
| `daemon.credentialRevision`   | Opaque; bumped after Secret rotation, projected into a pod-template annotation to force a Recreate.                                                                                  |
| `runtime.image`               | Sandbox image; change starts the drain-based rollout.                                                                                                                                |
| `runtime.tiers[]`             | `{name, warmReplicas}` referencing cluster master template/pool pairs; 0 keeps a cold pool.                                                                                          |
| `quota`                       | `maxAgents`/`cpu`/`memory`/`storage`; zero values mean unlimited.                                                                                                                    |
| `llmLimits`                   | Per-session and per-org token/request rate bounds, rendered into egress-gateway policies.                                                                                            |
| `egressPolicy`                | `locked \| curated \| open` sandbox egress tier.                                                                                                                                     |
| `llmDeny`                     | Emergency LLM shutoff (`all` or per-agent).                                                                                                                                          |
| `deletionPolicy`              | `Delete` only in v1alpha1; `Archive` joins when its semantics exist.                                                                                                                 |

Status is operator-owned: `observedGeneration`, `namespace` (published
atomically with `NamespaceReady`, only after create-or-adopt plus label
validation), conditions (`Ready`, `NamespaceReady`, `CredentialReady`,
`LimitsApplied`, `Progressing`, `Degraded`), daemon/sandboxes/pools summaries,
`appliedLimits` (an _observation record_ of the gateway policy API — possibly
`Unknown`, never an enforcement proof), and `rollout` progress.

Schema evolution: v1alpha1 with pruning; adding fields is free, changing
semantics requires a new version. The TypeScript choice should be revisited
only if CRD conversion webhooks become necessary.

## 3. Operator modules (`packages/operator/src/`)

| Module                        | Role                                                                                                                                                                                                                     | State         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `index.ts`                    | Bin entry: config → in-cluster client → elector → controller; SIGTERM drains.                                                                                                                                            | done          |
| `config.ts`                   | zod env, fail-fast: prefix + tokenreview ClusterRole (required), master template prefix, resync interval, lease name, watch timeout.                                                                                     | done          |
| `crd/types.ts`                | Group/kind/finalizer/annotation/condition constants + zod spec/status schemas.                                                                                                                                           | done          |
| `crd/api.ts`                  | Typed verbs over the thin client: get/list/own-namespace watch, merge-patch meta (finalizers), `/status` patch.                                                                                                          | done          |
| `workqueue.ts`                | Per-key serialized, coalescing queue with per-key failure backoff, plus the delayed follow-up a pass asks for when its own reading was provisional.                                                                      | done          |
| `controller.ts`               | Leader-gated term: CR watch + secondary Deployment/Pod watches (label `agentconnect.md/org`, mapped to the owning CR, filtered to known CRs) + bounded resync ticker.                                                    | done          |
| `reconcile/reconcile.ts`      | Dispatch: deletion path vs ensure-finalizer → envelope → rollout → gateway policies → status.                                                                                                                            | done          |
| `reconcile/resources.ts`      | Server-side-apply/get/delete primitives, path builders, and the envelope's fixed object names.                                                                                                                           | done          |
| `reconcile/envelope.ts`       | The ordered inventory implemented over SSA (see §4).                                                                                                                                                                     | done          |
| `reconcile/status.ts`         | `setCondition`, live workload observation, and the full condition/summary builder.                                                                                                                                       | done          |
| `reconcile/finalizer.ts`      | Deletion order implemented; only claimed, prefix-owned namespaces are touched.                                                                                                                                           | done          |
| `reconcile/rollout.ts`        | The runtime-image rollout: conditioned image patch for Suspended instances, drain-requested handshake for Running ones, stale-request sweep, and the drain deadline that moves a stuck instance to `failed` (see below). | done          |
| `reconcile/gateway-limits.ts` | llmLimits/llmDeny → gateway policy kinds (pinned by the gateway spike).                                                                                                                                                  | **TODO stub** |

**Runtime-image rollout.** Changing `spec.runtime.image` rolls every bound Sandbox
onto it without ever killing a live turn, through a two-party handshake:

- A **Suspended** instance has no pod, so the operator patches its image directly.
  The patch is conditioned (`test` on `spec.operatingMode`) so a wake-up racing the
  swap rejects it and the next pass re-decides.
- A **Running** instance is _asked_ to drain: the operator writes
  `agentconnect.md/drain-requested: <rolloutId>/<image>` plus
  `agentconnect.md/drain-requested-at`. The owning daemon watches its namespace's
  Sandboxes ([`cluster-spawn-and-shim.md`](cluster-spawn-and-shim.md)), keeps new
  launches off a drained instance, and suspends it as soon as the work already on it
  ends — immediately when it is idle. The next pass then patches the image as above,
  and the pass after that sweeps both annotations once the instance runs the target.
  The operator never suspends a Running instance itself.
- An instance still Running `DRAIN_TIMEOUT_MS` after its request is reported in
  `status.rollout.failed`. It stays listed and nothing is re-requested for that
  target: a drain that has not landed by then will not land by being asked again. A
  new target image is a new `rolloutId`, which starts the handshake over. The bound
  is 30 minutes — an exported constant rather than a knob, set comfortably past the
  daemon's 15-minute idle host reclaim, which is what makes a quiet instance drain
  in the first place.

The request time lives on the object rather than in operator memory, so a leader
change does not restart every drain's clock.

Shared plumbing lives in `@agentconnect.md/k8s-client` (also used by the
daemon's K8sDriver): in-cluster config with per-request token re-read, bare
`node:http(s)` verbs, list-then-watch with resourceVersion resume and 410
re-list, and the Lease elector. No client-go-style dependency; reconciles read
live state (no informer cache, hence no cache-consistency window), and drift
in envelope objects converges via the bounded full resync (default 10 min)
plus the Deployment/Pod secondary watches that keep status conditions prompt.

## 4. Envelope inventory

Everything is stamped by server-side apply (field manager
`agentconnect-operator`, force) — one PATCH per object per pass, no read-back
diffing. Object names are fixed per-namespace constants (`ac-daemon`,
`ac-daemon-shim`, `ac-daemon-state`, `ac-runtime-<tier>`, `ac-quota`,
`ac-limits`); the namespace is per-org, so they never collide. Master
SandboxTemplates live in the control namespace as
`<AC_MASTER_TEMPLATE_PREFIX><tier>` (default `ac-runtime-<tier>`); daemon
resource tiers are a built-in small/medium/large table, unknown names falling
back to `small` with a warning. Order is policy-before-workload within one
reconcile pass:

1. `ensureNamespace` — create-or-adopt `targetNamespace` via claim label;
   label mismatch ⇒ `Degraded`, never adopt.
2. `ensureServiceAccounts` — daemon SA; runtime SA with
   `automountServiceAccountToken: false` and zero bindings.
3. `ensureRoleAndBinding` — daemon SA: SandboxClaim CRUD + `Sandbox`
   get/watch/patch (admission restricts the patch to `spec.operatingMode`);
   no Secret verbs.
4. `ensureTokenReviewClusterRoleBinding` — per-org CRB to the install's
   release-prefixed tokenreview ClusterRole (TokenReview is cluster-scoped;
   a namespaced Role cannot grant it). No namespace ownerReference — the
   finalizer deletes it explicitly.
5. `ensureNetworkPolicies` — sandbox egress (gateway + git only) and daemon
   egress (control plane/relay/platform APIs + kube-apiserver + DNS).
6. `ensureQuotaAndLimitRange` — from `spec.quota`; omit when unlimited.
7. `ensureSandboxTemplates` — stamp per-org SandboxTemplate + one
   SandboxWarmPool per tier from the cluster master templates.
8. `ensureDaemonPvc` — ReadWriteOncePod (the Recreate strategy assumes
   single-attach).
9. `ensureDaemonDeployment` — strategy Recreate; required credential Secret
   volume (kubelet gates startup); `credentialRevision` annotation forces
   rotation rollouts. `CredentialReady` derives from pod state plus the pod's
   `FailedMount` events, which is where the kubelet — and only the kubelet —
   names a Secret it could not mount: a blocked mount reads
   `False/CredentialSecretMissing`, an unplaced pod
   `Unknown/DaemonPodUnschedulable`, any other stall `False/DaemonPodNotReady`.
   An Event is only believed while it is still being re-emitted and the pod is
   still awaiting container creation, so one retained past its fix cannot
   describe a mount that now works. Reading Events keeps the no-Secret-verbs
   boundary intact, and a forbidden events read only costs the nuance, never
   the status pass. An Event can also be written after the pod's last update,
   which no watch would wake the operator for, so the provisional verdict asks
   the queue for one follow-up pass a minute later rather than waiting for the
   full resync.
10. `ensureDaemonService` — ClusterIP for relay ingress and shim dial-in.

Deletion (finalizer `agentconnect.md/org-envelope`): quiesce → delete
workloads → (future: archive) → delete namespace + cluster-scoped bindings →
remove finalizer. Steps must be idempotent.

## 5. Chart (`charts/operator`, name `agentconnect-operator`)

One chart, one release per environment. `installCRD` gates the cluster-shared
pieces — the CRD plus the vendored agent-sandbox stack (`vendor/agent-sandbox.yaml`,
pinned to an upstream release manifest because upstream publishes no chart to a
registry). Every CRD is a _templated_ resource (conditional + upgradable)
carrying `helm.sh/resource-policy: keep` so no release uninstall can
cascade-delete every org or every live Sandbox. The one thing the chart adds to
the vendored stack is the controller's label-domain allowlist, which replaces
rather than extends its default and without which every SandboxClaim is
rejected. Everything else is per-install: operator Deployment (2 replicas) +
SA/RBAC, the release-prefixed tokenreview ClusterRole, two
ValidatingAdmissionPolicies, and a pre-delete hook that refuses uninstall while
CRs remain — removing the operator would strand every finalizer. That hook is a
Job running the operator image's hidden `preflight-uninstall` subcommand under
the operator's own SA: it lists the CRs in the release namespace and exits
non-zero naming them, so the check runs the same client the controller does
instead of a second, drifting copy in shell. Publishing to the OCI registry
rides the release pipeline (not yet wired).

The policies are the static half of the isolation story RBAC cannot express —
RBAC grants verbs, admission bounds where they may be used — and each install
renders its own release-prefixed copies from its own constants (Kubernetes
≥ 1.30, both `failurePolicy: Fail`):

- **envelope fence** — every write by the install's operator SA must target a
  namespace carrying its prefix, its own control-namespace CRs and Lease being
  the only exceptions; namespaces it stamps must carry the org/claim labels and
  a `baseline`-or-stricter Pod Security level; the per-org TokenReview binding
  is the only other cluster-scoped object it may write. A control namespace
  marked `agentconnect.md/control-namespace` is never a write target, and the
  marked namespace object itself can be neither deleted nor unmarked — that pair
  is what protects a _neighbouring_ install from a prefix misconfigured to
  overlap it. The Namespace object needs its own check because it is
  cluster-scoped: no `namespaceObject`, and an empty `request.namespace`.
- **sandbox baseline** — pods in an org namespace (claim label, narrowed to the
  install's prefix) may not be privileged, share host namespaces, or mount
  `hostPath`; every pod but the daemon supervisor must set
  `automountServiceAccountToken: false`, and the audience-scoped projected token
  the shim handshake needs is the only service-account token it may carry.
  Pods are the enforcement point, so a sandbox created from an operator-copied
  template is covered without teaching the policy about its controller.

## 6. Control-plane provisioner

The CR writer is control-plane code (`packages/control-plane/src/cluster/`),
opt-in through `CLUSTER_EXECUTION_MODE` (`off` | `in-cluster` | `kubeconfig`);
off is the default and mounts nothing. It is deliberately the SAME path for a
self-hosted cluster install and a hosted deployment — only the policy inputs
differ (`CLUSTER_ORG_NAMESPACE_PREFIX`, which must equal the operator install's
`AC_ORG_NAMESPACE_PREFIX`, plus the default images and tier).

- `org_cluster_execution` (one row per org) holds only the spec fields the
  control plane owns. Status is never mirrored there: the console reads it live
  off the CR, so a row can never disagree with the cluster.
- `targetNamespace` is derived once as `<prefix><org id folded to a DNS label>`
  and stored, because the CRD marks the field immutable.
- Writes are server-side apply under field manager
  `agentconnect-control-plane`, so the operator's own manager is untouched;
  the control plane never writes `/status`, finalizers, or envelope objects.
- `PUT /orgs/:orgId/cluster-execution` (owner-only) persists then applies;
  `enabled: false` deletes the CR and hands the envelope to the finalizer, while
  `suspend` quiesces without tearing down. `GET …/cluster-execution/status`
  projects the operator's conditions and summaries.

The credential Secret named by `spec.daemon.credentialSecretName` — and the
`credentialRevision` bump that rolls the daemon after a rotation — belong to
this same module as the key authority, and are still TODO; the operator keeps
zero Secret access either way.

## 7. Verification

Unit tests run against an in-process fake API server
(`@agentconnect.md/k8s-client/testing`) — no cluster needed. The CRD parity
test fails when the YAML and zod field trees drift. `helm lint
charts/operator` is part of the check ritual until charts get their own CI.
