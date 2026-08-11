# AgentConnectOrg CRD + Operator

**Status:** Skeleton merged; reconcile bodies are TODO stubs for the implementation milestone.

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

| Module                        | Role                                                                                                                                                                  | State          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `index.ts`                    | Bin entry: config → in-cluster client → elector → controller; SIGTERM drains.                                                                                         | done           |
| `config.ts`                   | zod env, fail-fast: prefix (required), resync interval, lease name, watch timeout.                                                                                    | done           |
| `crd/types.ts`                | Group/kind/finalizer/annotation/condition constants + zod spec/status schemas.                                                                                        | done           |
| `crd/api.ts`                  | Typed verbs over the thin client: get/list/own-namespace watch, merge-patch meta (finalizers), `/status` patch.                                                       | done           |
| `workqueue.ts`                | Per-key serialized, coalescing queue with per-key failure backoff.                                                                                                    | done           |
| `controller.ts`               | Leader-gated term: CR watch + secondary Deployment/Pod watches (label `agentconnect.md/org`, mapped to the owning CR, filtered to known CRs) + bounded resync ticker. | done           |
| `reconcile/reconcile.ts`      | Dispatch: deletion path vs ensure-finalizer → envelope → rollout → gateway policies → status.                                                                         | done           |
| `reconcile/envelope.ts`       | The ordered inventory as named stubs (see §4).                                                                                                                        | **TODO stubs** |
| `reconcile/status.ts`         | `setCondition` (transition-time handling) done; `buildStatus` stub.                                                                                                   | mixed          |
| `reconcile/finalizer.ts`      | Deletion order stubs; `removeFinalizer` done.                                                                                                                         | mixed          |
| `reconcile/rollout.ts`        | Drain-annotation state machine.                                                                                                                                       | **TODO stub**  |
| `reconcile/gateway-limits.ts` | llmLimits/llmDeny → gateway policy kinds (pinned by the gateway spike).                                                                                               | **TODO stub**  |

Shared plumbing lives in `@agentconnect.md/k8s-client` (also used by the
daemon's K8sDriver): in-cluster config with per-request token re-read, bare
`node:http(s)` verbs, list-then-watch with resourceVersion resume and 410
re-list, and the Lease elector. No client-go-style dependency; reconciles read
live state (no informer cache, hence no cache-consistency window), and drift
in envelope objects converges via the bounded full resync (default 10 min)
plus the Deployment/Pod secondary watches that keep status conditions prompt.

## 4. Envelope inventory (what each stub owes its implementer)

Order is policy-before-workload within one reconcile pass:

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
   volume (kubelet gates startup; `CredentialReady` derives from pod state);
   `credentialRevision` annotation forces rotation rollouts.
10. `ensureDaemonService` — ClusterIP for relay ingress and shim dial-in.

Deletion (finalizer `agentconnect.md/org-envelope`): quiesce → delete
workloads → (future: archive) → delete namespace + cluster-scoped bindings →
remove finalizer. Steps must be idempotent.

## 5. Chart (`charts/operator`, name `agentconnect-operator`)

One chart, one release per environment. `installCRD` gates the cluster-shared
pieces (the CRD today, vendored agent-sandbox CRDs/controllers later); the CRD
is a _templated_ resource (conditional + upgradable) carrying
`helm.sh/resource-policy: keep` so no release uninstall can cascade-delete
every org. Everything else is per-install: operator Deployment (2 replicas) +
SA/RBAC, the release-prefixed tokenreview ClusterRole, admission policies
(TODO), and a pre-delete hook that refuses uninstall while CRs remain —
removing the operator would strand every finalizer. Publishing to the OCI
registry rides the release pipeline (not yet wired).

## 6. Verification

Unit tests run against an in-process fake API server
(`@agentconnect.md/k8s-client/testing`) — no cluster needed. The CRD parity
test fails when the YAML and zod field trees drift. `helm lint
charts/operator` is part of the check ritual until charts get their own CI.
