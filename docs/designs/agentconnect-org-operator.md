# AgentConnectOrg CRD + Operator

**Status:** Envelope, status, deletion, and rollout reconcile logic implemented — including the
drain handshake with the daemon and its timeout — plus the control-plane CR provisioner (§6);
gateway policy rendering waits on the gateway spike.

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
  Helm release namespace). The org's envelope namespace is **derived by default**
  — `<AC_ORG_NAMESPACE_PREFIX><CR name>` — and published on `status.namespace`.
  The CR is the sole desired-state carrier for the envelope; who
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

Authoritative schema: `charts/operator/crd/agentconnectorg.yaml` (full
openAPIV3Schema with per-field descriptions and CEL transition rules). The
zod schemas in `packages/operator/src/crd/types.ts` are the operator's runtime
guard; a parity unit test asserts the two field trees stay identical.

**The namespace is configurable at two levels** (`reconcile/namespace.ts` resolves
both, and every reader takes the resolved value):

1. _Install_ — `AC_ORG_NAMESPACE_PREFIX` fences every org namespace, always.
2. _Per org_ — `spec.targetNamespace` is an optional override. **Unset** (the
   normal path, and what the control plane always writes) derives
   `<prefix><CR name>`: the name is unique within the control namespace, so two
   CRs cannot collide on a namespace and none can name one outside its install —
   by construction rather than by validation. **Set** still has to start with the
   install's prefix, or the org lands `Degraded/NamespaceOutsidePrefix` with
   nothing written.

Either way the resolved name must be a DNS label: a CR name legal for a
Kubernetes object (a DNS _subdomain_) can still derive an illegal namespace, and
that lands `Degraded/InvalidNamespaceName` and writes no envelope objects. Two
orgs aimed at one namespace are caught by the claim label
(`Degraded/NamespaceClaimConflict`) — the operator degrades, never adopts.

| spec field                    | Notes                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targetNamespace`             | Optional DNS-label override, **immutable** (CEL). Unset ⇒ derived `<prefix><CR name>`. Shape-only at CRD level; install ownership (prefix) is enforced by the operator and admission.                                                            |
| `suspend`                     | Quiesce the org: daemon to zero, sandboxes drained, gateway denies LLM calls.                                                                                                                                                                    |
| `daemon.image`, `daemon.tier` | Supervisor image (change ⇒ Recreate rollout) and resource tier name.                                                                                                                                                                             |
| `controlPlane.url`            | The control plane's own WebSocket URL, written by it when it creates the CR. Plain text — a URL is not a secret, and the control plane is authoritative for its own address, so the operator never derives it. Injected as daemon container env. |
| `runtime.image`               | Sandbox image; change starts the drain-based rollout.                                                                                                                                                                                            |
| `runtime.tiers[]`             | `{name, warmReplicas}` referencing cluster master template/pool pairs; 0 keeps a cold pool.                                                                                                                                                      |
| `quota`                       | `maxAgents`/`cpu`/`memory`/`storage`; zero values mean unlimited.                                                                                                                                                                                |
| `llmLimits`                   | Per-session and per-org token/request rate bounds, rendered into egress-gateway policies.                                                                                                                                                        |
| `egressPolicy`                | `locked \| curated \| open` sandbox egress tier.                                                                                                                                                                                                 |
| `llmDeny`                     | Emergency LLM shutoff (`all` or per-agent).                                                                                                                                                                                                      |
| `deletionPolicy`              | `Delete` only in v1alpha1; `Archive` joins when its semantics exist.                                                                                                                                                                             |

Status is operator-owned: `observedGeneration`, `namespace` (the resolved name,
published atomically with `NamespaceReady`, only after create-or-adopt plus label
validation — and the only place a consumer learns the namespace), conditions (`Ready`, `NamespaceReady`,
`LimitsApplied`, `Progressing`, `Degraded` — `CredentialReady` retired with the
key path, see "Daemon identity"), daemon/sandboxes/pools summaries,
`appliedLimits` (an _observation record_ of the gateway policy API — possibly
`Unknown`, never an enforcement proof), and `rollout` progress.

Schema evolution: v1alpha1 with pruning; adding fields is free, changing
semantics requires a new version. The TypeScript choice should be revisited
only if CRD conversion webhooks become necessary.

## 3. Operator modules (`packages/operator/src/`)

| Module                        | Role                                                                                                                                                                                                                     | State         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `index.ts`                    | Bin entry, telemetry only: starts the SDK, then imports `main.ts` — `node:http(s)` bind their exports at import time, so the client must load after the patch.                                                           | done          |
| `main.ts`                     | The run itself: config → in-cluster client → elector → controller; SIGTERM drains, then flushes spans.                                                                                                                   | done          |
| `observability.ts`            | The shared OTel bootstrap with the operator's own name and version; off unless the install sets `OTEL_*` (chart: `operator.extraEnv`).                                                                                   | done          |
| `config.ts`                   | zod env, fail-fast: prefix + tokenreview ClusterRole (required), master template prefix, resync interval, lease name, watch timeout.                                                                                     | done          |
| `crd/types.ts`                | Group/kind/finalizer/annotation/condition constants + zod spec/status schemas.                                                                                                                                           | done          |
| `crd/api.ts`                  | Typed verbs over the thin client: get/list/own-namespace watch, merge-patch meta (finalizers), `/status` patch.                                                                                                          | done          |
| `workqueue.ts`                | Per-key serialized, coalescing queue with per-key failure backoff, plus the delayed follow-up a pass asks for when its own reading was provisional.                                                                      | done          |
| `controller.ts`               | Leader-gated term: CR watch + secondary Deployment/Pod watches (label `agentconnect.md/org`, mapped to the owning CR, filtered to known CRs) + bounded resync ticker.                                                    | done          |
| `reconcile/reconcile.ts`      | Dispatch: deletion path vs ensure-finalizer → envelope → rollout → gateway policies → status.                                                                                                                            | done          |
| `reconcile/resources.ts`      | Server-side-apply/get/delete primitives, path builders, and the envelope's fixed object names.                                                                                                                           | done          |
| `reconcile/envelope.ts`       | The ordered inventory implemented over SSA (see §4).                                                                                                                                                                     | done          |
| `reconcile/status.ts`         | `setCondition`, live workload observation, and the full condition/summary builder.                                                                                                                                       | done          |
| `reconcile/finalizer.ts`      | Deletion order implemented; only the claimed, prefix-owned namespace is touched.                                                                                                                                         | done          |
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
`<AC_MASTER_TEMPLATE_PREFIX><tier>` (default `ac-runtime-<tier>`), rendered by
the chart from its `runtimeTiers` value; daemon
resource tiers are a built-in small/medium/large table, unknown names falling
back to `small` with a warning. Order is policy-before-workload within one
reconcile pass:

1. `ensureNamespace` — resolve the namespace (§2), then create-or-adopt it via
   claim label; an out-of-prefix override, a name that is no DNS label, or a
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
9. `ensureDaemonDeployment` — strategy Recreate; a projected `serviceAccountToken`
   volume carrying the control-plane audience, and the control plane's URL from
   `spec.controlPlane.url` as container env. No credential Secret volume, no
   `install-config` init container, no `--config` file: there is nothing to
   install, and the token is a file the kubelet keeps current. The pod therefore
   starts whether or not it can authenticate, which is the trade the key path's
   kubelet gate bought and this one gives back.
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
rejected. Everything else is per-install: the master SandboxTemplates rendered
from `runtimeTiers` (blueprints in the control namespace — the operator inherits
each one wholesale except the image, the shim endpoint and the network policy),
operator Deployment (2 replicas) +
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
opt-in through `CLUSTER_EXECUTION_ENABLED`; off is the default and mounts
nothing. It is deliberately the SAME path for a self-hosted cluster install and
a hosted deployment — only the policy inputs differ
(`CLUSTER_ORG_NAMESPACE_PREFIX`, which must equal the operator install's
`AC_ORG_NAMESPACE_PREFIX`, plus the default images and tier).

**One switch, and no credentials to configure.** The switch is explicit — a
control plane that merely happens to run on Kubernetes must not start claiming
an operator install — but nothing beyond it is a knob: turning it on _asserts_
that this control plane runs inside the cluster it provisions, so the credential
is the pod's projected ServiceAccount and the control namespace is the pod's own.
A process that is not in a pod fails at boot rather than at its first write.

There is deliberately no out-of-cluster mode. An API server plus a token, or a
kubeconfig, would each be a second deployment shape to keep correct — and since
the control plane and the operator are installed together, a control plane that
cannot reach its own ServiceAccount is misconfigured rather than differently
configured. It also removes the one way the two halves could disagree about
_where_ the CRs live.

- `org_cluster_execution` (one row per org) holds only the spec fields the
  control plane owns. Status is never mirrored there: the console reads it live
  off the CR, so a row can never disagree with the cluster.
- `resourceName` — the CR's name — is derived once as the org id folded to a DNS
  label, truncated so the operator's `<prefix><CR name>` still fits in 63
  characters, and stored: it is the handle every later call addresses the
  envelope by. The control plane never writes `spec.targetNamespace`, so the
  namespace is the operator's to derive; anything that needs it (the credential
  Secret write) reads `status.namespace` off the CR. Server-side apply only
  prunes fields this manager owns, so an override written by hand survives.
- Writes are server-side apply under field manager
  `agentconnect-control-plane`, so the operator's own manager is untouched;
  the control plane never writes `/status`, finalizers, or envelope objects.
- `PUT /orgs/:orgId/cluster-execution` (owner-only) persists then applies;
  `enabled: false` deletes the CR and hands the envelope to the finalizer, while
  `suspend` quiesces without tearing down. `GET …/cluster-execution/status`
  projects the operator's conditions and summaries.
- **An envelope is part of what an organization is**, so it is provisioned with
  the org rather than waiting for an owner to find a toggle: `POST /orgs` calls
  `ensureProvisioned` after the create commits, best-effort — an unreachable
  cluster must not fail a creation that already landed. That covers only the
  orgs born on that route, and a personal org minted by JIT signup or a waitlist
  redeem is created in repository code that has no business knowing about
  Kubernetes. So `POST …/cluster-execution/ensure` (owner-only, idempotent) is
  the same operation as a request, and the console's Daemons page fires it once
  per org per session. Between them, every org converges — including ones that
  predate the feature — without a reconciler sweeping the whole table.
  `ensureProvisioned` enables only an org with NO settings row: a row that reads
  disabled is an owner's decision, and re-applying would undo it. An org that is
  enabled gets its spec re-applied (which recreates a CR that went missing) and,
  once `status.namespace` is published, its first credential — the namespace not
  existing yet at org-create time is the ordinary state, not a failure, and the
  next visit finishes the job.
- Every write bumps `specRevision`, and a write applies the CURRENT row and
  then re-reads that revision: two concurrent writers would otherwise be able to
  leave the row at one spec and the CR at an older one forever, since the
  operator reconciles the CR and nothing here re-reads on a timer.
- Deleting an organization **retires its envelope first**. Org deletion is
  refused while any daemon row survives — a RESTRICT-FK barrier rechecked inside
  the delete transaction — and that guard exists to make someone detach the
  physical machines explicitly. The envelope's daemon is not one of those: the
  control plane provisioned it, no Daemons page could be asked to detach it, and
  since provisioning now happens with the org, leaving it in the count would make
  every organization undeletable. So the route excludes it from the guard,
  switches cluster execution off (revoking the key and handing the envelope to
  the finalizer), and removes it before the delete — through the same detach
  sequence `DELETE /daemons/:id` uses (`http/daemon-removal.ts`), because the
  delete can still answer 409 afterwards and what survives that must be an org
  whose agents are properly unplaced, not live-looking agents pointing at a
  daemon that no longer exists. A cluster that refuses the disable does not fail
  the deletion — the tombstone below is what teardown actually hangs on.
- Deleting an organization records its envelope in `pending_envelope_teardown`
  **inside the delete transaction**, because the cascade removes the only copy
  of its `resourceName` and after that nothing could name the resource, namespace
  and workloads the operator is still keeping alive. Reading the row
  there is also what serializes the boundary: an enable that committed first is
  visible, and one that has not is blocked by the org row's `FOR UPDATE` and
  then fails its foreign key. The delete route retires the CR immediately, and a
  five-minute drain covers an unreachable cluster or a process that had cluster
  execution switched off at delete time. The one window the tombstone cannot
  cover — a `PUT` whose apply is in flight while the delete commits — closes in
  the convergence loop: a settings row that vanished between apply and re-read
  means the org is gone, so the request deletes what it just created.

### Daemon identity

An in-cluster daemon carries no credential at all. It authenticates to the
control plane with the audience-scoped ServiceAccount token the kubelet already
projects into its pod, and the control plane verifies that token against the
cluster that issued it, mapping the returned
`system:serviceaccount:<org-namespace>:ac-daemon` back to the org through the
namespace the operator published in `status.namespace`.

This is the shim handshake run backwards. A sandbox pod already proves itself to
the daemon with an audience-scoped projected token the daemon verifies
(cluster-spawn-and-shim §3); here the daemon proves itself to the control plane
the same way. The audience differs so a token minted for one hop cannot
authenticate at the other.

What the control plane writes is therefore **one object**: the
`AgentConnectOrg`, carrying its own WebSocket URL in plain text because a URL is
not a secret. It needs no permission in any org namespace, and nothing has to
be delivered after the namespace exists — which is what removes the round trip
the earlier design required, where the provisioner had to wait for
`status.namespace` before it could publish anywhere.

Retired with it: minting and publishing a per-org daemon key, the
`credentialSecretName` and `credentialRevision` spec fields, the pod-template
annotation that forced a Recreate on rotation, and the fencing token, cluster
sequence, and staged-before-published machinery that existed because a publish
could half-fail. Rotation is now the kubelet's business and happens roughly
hourly with nobody informed.

**API keys do not go away.** A daemon on someone's laptop has no Kubernetes
identity, so the key path stays exactly as it is; the token path is what an
in-cluster daemon uses instead. The control plane accepts both and each is
simple on its own.

Two consequences worth stating plainly. The kubelet no longer gates startup on a
required Secret mount, so a misconfigured daemon **runs but does not register**
rather than refusing to start — the failure moved from the pod to the control
plane's view of it, and that is where it must now be surfaced. And
`CredentialReady` loses its subject: there is no credential for the operator to
find missing, and whether a daemon registered is a fact only the control plane
holds. The condition retires rather than being redefined into something the
operator cannot observe.

#### The bootstrap contract

Nothing is delivered to the pod, so the pod must be born able to dial. Three
pieces, all stamped by `ensureDaemonDeployment`:

- **Where to dial** — `spec.controlPlane.url`, written by the control plane when
  it creates the CR, injected as container env. The operator passes it through
  and never derives it; a URL is not a secret and the control plane is the
  authority on its own address.
- **What to present** — a projected `serviceAccountToken` volume with the
  control-plane audience, on the daemon pod only, mounted read-only at a fixed
  path. Shape and expiry mirror the sandbox template's shim-audience volume,
  which is the same mechanism one hop down.
- **Nothing else** — no credential Secret volume, no `install-config` init
  container, no `--config` file. The init container existed to copy a
  root-owned read-only Secret onto a writable volume at a mode the daemon would
  accept; with no Secret there is nothing to copy.

The daemon reads that file at every connect rather than once at startup: the
kubelet rewrites it roughly hourly, and a token cached for the process lifetime
is a token that expires mid-life and reconnects with a credential the control
plane refuses.

Network reachability is a separate question from the URL, and stays a
deployment configuration: a policy selects namespaces and CIDRs, and cannot
select the DNS name the CR carries.

#### Which daemon record

TokenReview proves an org. It does not, on its own, say _which daemon_ — and the
WebSocket fencing, placements and session history are keyed by `daemonId`, with
more than one daemon record possible per org (a laptop daemon and this one can
coexist). The retired key path answered this by minting the key **for a daemon
record** and remembering it as `credentialDaemonId`; something has to take that
job.

An envelope has exactly one daemon: one Deployment, one replica, Recreate. So the
verified identity — cluster, namespace, ServiceAccount — designates exactly one
daemon record, and the control plane provisions that record on the first
authenticated connect and binds it to that identity, resolving the same row on
every reconnect afterwards. This is the pattern the control plane already runs
for humans: an OIDC subject with no local user JIT-provisions one and is bound to
it thereafter.

Three properties this has to hold:

- **The binding is unique.** One daemon record per identity, enforced by the
  store, so nothing can end up with two records competing for one envelope's
  placements.
- **Re-provisioning keeps history.** The namespace is derived, so an envelope
  torn down and rebuilt presents the same identity and resolves to the same
  daemon record — placements and session history survive, which is what an
  operator would expect from re-provisioning rather than a rename.
- **The daemon stores nothing.** It no longer needs to persist the `daemonId` it
  adopts from `auth/ok`, because identity is re-derived from the token on every
  connect. The control plane may still report it for logs and telemetry.

#### The two names both sides must agree on

Verification rests on two strings: the audience the operator projects onto the
daemon pod, and the ServiceAccount name it gives that pod. The control plane
checks both — the audience is the real gate, since a sandbox's token carries the
shim audience instead and is refused here, and the ServiceAccount name is the
cheap second check that keeps a future change from authenticating some other pod
in the same namespace.

Both live in `@agentconnect.md/protocol`, imported by the operator that stamps
them and the control plane that checks them, rather than configured on each side.
A constant kept in two places eventually holds two values: a rename passes every
build and every test, because each side is self-consistent, and fails only at
runtime when a daemon's token is rejected. One definition turns that into a
compile error. It does not solve version skew between a deployed operator and
control plane, but the release train ships them together, which bounds it.

The shim audience is the precedent and the counter-example: it is a constant in
the daemon with a comment on the sandbox template asking that they be kept equal.
That works, and it is exactly the kind of agreement an import should be carrying.

#### Verifying the token

Two ways, and the choice is contained — both check the same token:

- **TokenReview against the issuing cluster.** One API call, immediate effect
  when a ServiceAccount is deleted. The control plane already holds each
  cluster's credentials because it writes CRs there.
- **Offline signature verification** against the cluster's OIDC JWKS. The
  control plane is already an OIDC resource server for human sign-in and can
  treat each cluster's ServiceAccount issuer as one more trusted issuer,
  keeping the authentication path free of any call to the cluster.

Start with TokenReview: it is smaller and revokes instantly. Offline
verification is the upgrade when either the per-connect call becomes a real cost
(a control-plane restart reconnects every daemon at once) or a second cluster
arrives.

Multi-cluster follows without new key material. The control plane places an org,
so it knows which cluster to verify against; adding a cluster registers one more
issuer rather than provisioning and rotating a shared secret in two places. A
customer-operated cluster the control plane cannot reach is the one case that
needs a trust bootstrap — register its issuer and JWKS at install — and where
that is not possible, that deployment falls back to the API key path it would
have used anyway.

#### Alternatives that were rejected

Each of these solves the same two problems — a provisioner that must interact
twice, and a provisioner holding Secret write across every org namespace — and
each was set aside for a reason worth keeping:

- **Publish into the org namespace (the previous design).** Two interactions,
  because the namespace name is not known until the operator publishes it, and
  a grant broad enough to write Secrets into every org namespace. Narrowing that
  grant by admission is possible and does not fix the round trip.
- **Deliver through a Secret in the control namespace, moved by the operator.**
  One interaction and no cross-namespace grant, but the source is consumed: if
  the org Secret is later lost the operator cannot restore it, and a crash
  between deleting the source and creating the target strands the credential. It
  also concentrates every org's key in one namespace while in flight.
- **Seal the credential into the CR with a key the operator holds.** The same
  properties as moving, plus durable desired state — a lost Secret can be
  rebuilt from the CR — at the cost of a key pair to generate, persist, publish
  and rotate, with the failure mode that losing the private key invalidates
  every sealed CR at once. Reasonable, and strictly more machinery than a
  mechanism that needs no key at all.
- **Bootstrap: present the token once, receive a long-lived key.** Keeps
  authentication local after enrollment, but keeps minting, storage and
  revocation, and leaves the control plane supporting token auth, key auth and
  an enrollment endpoint — more moving parts than accepting the token every
  time, for a hot-path saving that offline verification also delivers.

Credential revocation was the strongest objection to the chosen design, and it
does not survive contact with the deployment model: revoking a key leaves a
running daemon holding an established connection until it drops, while an
in-cluster daemon is a workload this system owns — `suspend` scales it to zero
and deletion removes its namespace, both immediate and total. Revocation is the
kill switch for a daemon nobody controls, which is exactly the case that keeps
its API key.

## 7. Verification

Unit tests run against an in-process fake API server
(`@agentconnect.md/k8s-client/testing`) — no cluster needed. The CRD parity
test fails when the YAML and zod field trees drift. `helm lint
charts/operator` is part of the check ritual until charts get their own CI.
