# The K8s Daemon Pool: Multi-Org Daemons and the Duty Ledger

**Status:** The ownership mechanism is implemented (control plane, daemon,
relay, protocol) and enforcement is unconditional: an install-wide (frame-scope)
member is duty-governed, an org-scoped daemon is not, and there is no switch
between them. The remaining build order is the tracking issue
"K8s daemon pool — implementation plan and tracking". This document states the
design and marks what is not yet built; file references are given so every
claim can be checked against the code.

## 1. Problem

The model this replaces provisioned **one daemon Deployment plus one
ReadWriteOncePod PVC per org**: an operator reconciled an `AgentConnectOrg` CR
into a roughly fifteen-object envelope per org — namespace, service accounts,
RBAC, NetworkPolicies, quota, warm pools, the state PVC, the `replicas: 1,
strategy: Recreate` Deployment, and the shim Service — and per-tier warm pools
added more. That machinery has since been removed
([agentconnect-org-operator.md](agentconnect-org-operator.md)); the costs below
are why.

Four costs grow with org count:

1. **Idle burn.** An org with zero traffic still runs a full daemon pod 24×7.
   Agents already sleep (idle sweep + sandbox suspension, `sweepIdle` in
   `packages/daemon/src/daemon.ts`), but the daemon itself cannot.
2. **Object sprawl.** Kubernetes object count, PVC count, and watch/reconcile
   load scale linearly with orgs, most idle at any moment. The per-org **warm
   pool** is the sharpest case: a warm pool scoped to one org can only ever
   pre-warm for that org, so at scale each org either burns idle warm pods or
   sets `warmReplicas: 0` and gets no warm benefit at all.
3. **Upgrade blast radius.** A daemon image bump is a `Recreate` rollout of
   _every_ org's singleton pod — every org's platform connections drop, every
   org's in-flight turns die, simultaneously.
4. **The daemon can never stop.** It holds the org's platform ingress (Slack
   Socket Mode, Telegram long-poll, Discord gateway). Stopping it means going
   deaf; this is why daemon scale-to-zero was never viable (R1).

The fix is not to make per-org daemons cheaper. It is to remove the per-org
daemon as a unit of deployment: a fixed-size pool of multi-tenant daemon
**members**, where **agents sleep and daemons do not**, and where everything
that must be held by exactly one member is a claimable **duty** in one ledger.

## 2. Core principles

**P1 — Ownership follows ingress.** An agent runs where its ingress duty is
held. The duty holder **dials** the agent's sandbox (daemon → shim). Ingress
and execution are therefore co-located _by construction_: there is no
cross-member forwarding path for platform messages, and none is needed. This
single principle deletes the entire family of forward-hop, presence-sync, and
MOVED-redirect mechanisms rejected in R4.

**P2 — One ownership mechanism.** Every exactly-one responsibility — a
Telegram polling loop, a Slack socket, an agent's home — is a claimable
**duty** in a single ledger. Members _volunteer_ (claim); nothing ever
assigns. The control plane hosts the ledger and arbitrates claims
transactionally, but never chooses holders. This preserves the house rule that
already rejected CP placement authority (R3): facts flow down, claims flow up,
arbitration sits in the middle.

**P3 — Plane split.** Facts and the duty ledger live in the **control plane**
(the CP and its own Postgres, where `Bot`/`Integration` rows already live).
Message content and session state live in the **data plane** (shared tables
carrying an `org` column, with the org injected at the store-handle layer —
[cloud-data-plane-postgres.md](cloud-data-plane-postgres.md)). The CP never
connects to the data plane; members bridge the two. This is the pool-scale
restatement of the existing invariant that the CP stores only control-plane
metadata, never message bodies.

**P4 — Fencing by term at the edges, by ownership at the store.** Every claim
carries a CP-minted monotonic **term**: the shim accepts the highest-term dialer
and drops older connections, and the ledger arbitrates every claim on
`(holder, term)`. The database arm is spelled differently — a data-plane write
carries no term (§11). A stale ex-holder is stopped there by the duty gate before
it reaches the statement, by row ownership wherever it holds a claim, and by a
race-safe statement wherever two members may both legitimately write. So it is
still fenced everywhere it could do harm — at the sandbox, at the database, at
the ledger — with the term generalizing the existing `sessionEpoch`/`launchId`
discipline to pool membership.

### Decision summary

| #   | Decision                | One line                                                                                                                                                                                                      |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pool shape              | Fixed-size plain Deployment of multi-tenant members; manual scaling; members never sleep                                                                                                                      |
| D2  | Sleep                   | Agents sleep (existing sandbox suspension); wake = existing `SandboxClaim` flow; no new machinery                                                                                                             |
| D3  | Connection direction    | The duty holder dials the sandbox; the shim is a hardened listener; one NetworkPolicy ingress-rule amendment                                                                                                  |
| D4  | Member anatomy          | Singleton machinery + per-agent rooms + thin refcounted org contexts; the session stays the atomic unit                                                                                                       |
| D5  | Duty group              | The claim unit is the connected component of the agent↔daemon-held-bot graph — every agent is a node, so an edgeless one is its own singleton — claimed atomically under one term                             |
| D6  | Lease service           | CP-hosted `duty_group` ledger over the fleet WS, with a derived membership projection; vacancy grant = the claim call                                                                                         |
| D7  | Lease timing            | Batched renewals; T_fence self-fence < T_reassign; startup recovery grace                                                                                                                                     |
| D8  | Cross-member paths      | `rd/agentmsg` stays A2A-only; the rendezvous adds a `not_holder` NAK on the inbound `rd/msg` path; no redirects, no presence streams; the ledger is the directory                                             |
| D9  | Org context on the wire | Install-wide connection with per-frame `orgId`; reconnect state is a combined multi-org snapshot / revision-fenced stream — no per-org subscription, room, or socket                                          |
| D10 | Crons                   | A time-based trigger against a group that is already proactively claimable (D5), so a schedule always has a home; the holder fires it locally with today's daemon machinery                                   |
| D11 | State                   | Separate data-plane PG, shared tables with an `org` column (org injected by the store handle, never by call sites); one daemon-owned store surface over SQLite and PG drivers — synchronous, not async (#958) |
| D12 | Upgrades                | maxSurge 100%, maxUnavailable = 0; drain = draining bit + acknowledged per-group duty release + sleep-as-migration                                                                                            |
| D13 | Failure model           | Explicit matrix; two accepted loss windows                                                                                                                                                                    |
| D14 | Capacity                | Member self-gating at claim time; CP alarms on vacant-duty age; no scheduler                                                                                                                                  |
| D15 | One binary              | Composition-root profiles differ by capability knobs, never a mode flag                                                                                                                                       |
| D16 | Isolation               | The shared pool is the default; an oversized or noisy workload moves to a dedicated daemon                                                                                                                    |
| D17 | Kubernetes footprint    | No per-org Kubernetes objects for pooled orgs: one shared sandbox namespace, tier-shared warm pools, label-scoped policies — so the operator, the org CR, and the CP's cluster credentials all retire         |
| D18 | Migration               | Orgs move one at a time with rehearsed rollback (tracking issue, M5)                                                                                                                                          |

## 3. Pool anatomy (D1, D4)

The pool is a plain Kubernetes **Deployment** — explicitly not a StatefulSet
(R11) — of N identical daemon members, manually scaled. Occupancy alarms fire
when the ledger shows aged vacant duties or members near their duty budget; a
human adds or removes members. Members never sleep; they are the always-on
substrate that lets everything else sleep.

Each member is composed of three layers:

- **Singleton machinery** — relay and CP links, heartbeat, the claim/renew
  loop, and the sandbox dialer: today's `Daemon.start()` connective tissue
  minus the assumption of one org.
- **Rooms** — one per _agent_, not per org (R14): the agent host, its sandbox
  connection, ACP sessions, turn queues, and streaming state. The room is
  where the existing session machinery lives unchanged. A session remains the
  atomic unit: single home, serial turns, fenced by the existing
  `sessionEpoch`/`seq`/`launchId` discipline.
- **Org contexts** — thin, refcounted: a config snapshot and an org-scoped
  store handle. Created when the first room or duty for that org appears;
  dropped when the last user releases it. The org is deliberately reduced to
  shared context, because ingress and execution granularity is per-agent or
  per-bot, never per-org.

**Identity is per Pod, not per org.** Each Deployment Pod authenticates with
an audience-scoped, Pod-bound Kubernetes ServiceAccount token; TokenReview
establishes the subject and Pod UID, and each Pod gets its own org-less daemon
row and a stable `daemonId` for that Pod lifetime
(`packages/control-plane/src/cluster/daemon-identity.ts`). The daemon↔CP
WebSocket is install-wide with `orgId` carried per frame (`organizationMode:
'frame'`); there is no org room, org-specific connection, or per-org
subscription (D9).

**The pool and sandboxes occupy two explicit namespaces.** The daemon Pod's
ServiceAccount namespace identifies the member pool only; `AC_K8S_SANDBOX_NAMESPACE`
names the shared namespace where the runtime plane reads and writes SandboxClaims
and Sandboxes. Each member also receives its Pod UID through the Downward API as
`AC_K8S_MEMBER_ID`; the runtime probe hashes it into
`agent-ac-runtime-probe-<member-hash>`, so simultaneous member startup never races
on one probe claim. Probe claims carry a dedicated label and a 15-minute expiry;
the orphan reconciler (§4) collects an expired one, so a missed teardown cannot
retain a Sandbox and volume forever.

**The control plane carries one bit, not a namespace.** `DAEMON_POOL_ENABLED=true`
says "this deployment runs a daemon pool": the control plane loads its in-cluster
config from its own pod's ServiceAccount (fail-loud outside a pod) and accepts pool
member identities — TokenReview of the projected token, ServiceAccount name plus
namespace — from **its own namespace**, read off the credential that proves it.
Unset means no cluster module and API-key daemon auth only. Naming the namespace
separately was a false degree of freedom: a member is a pod this install places
beside itself, so the key invited an answer that was either the only correct one or a
misconfiguration that failed late, as "identity refused" at registration rather than
at boot. Two earlier spellings — a separate execution-enabled flag, then a namespace
key — were deleted outright rather than aliased, on the same reasoning.

**Org-threading is the end state; instantiation is scaffolding.** The wire
carries the org, the data plane carries the org, and the process interior
converges on the same axis: subsystems take the org as an explicit parameter,
with per-org instantiation of today's single-org classes as the zero-rewrite
transition for whatever is not yet threaded. Locally the parameter is a
constant, so the one-binary story (D15) is unchanged.

## 4. Agents sleep, daemons do not (D2)

**What "asleep" means, precisely.** Sleep is _suspension_, not deletion:
`sweepIdle` → `suspendIfIdle` sets the sandbox operating mode to `Suspended`
(`packages/daemon/src/k8s/driver.ts`), and **the `SandboxClaim`, the
`Sandbox`, and the workspace volume all survive**. Claim deletion is a
separate path that destroys the volume with it. So a sleeping agent has
released its compute — no running container, no connection, no in-memory room
on any member — while keeping its durable identity and workspace in the
cluster. Anything that would "recreate" a sandbox must go through
suspend/resume, never delete-and-claim-again, or it silently deletes the
agent's work.

**Sleep is the holder's decision, and the holder is the only member that
knows the launch.** A member's launch record (`K8sDriver.launches`) is scoped
to the duties it holds: gaining an agent re-derives the launch from the cluster
(claim → bound Sandbox → mode, recording only a Running pod), losing it — a
revoke, a self-fence, a drain release — forgets the launch, its shim channel,
its tunnel proxy and any loss watch without touching the claim. The idle sweep
suspends only agents this member holds, and floors idleness at the time it
took the launch when the shared store records no activity. So a Running pod
has exactly one member that owns its idleness, an ex-holder can never suspend
a successor's pod, and a rollout leaves no pod without a candidate to suspend it.

A sleeping agent still belongs to a duty group (§6), and if that group
contains a daemon-held bot the group stays claimed while the agent sleeps —
that held duty is precisely what lets the wake message arrive. A singleton
group with no daemon-held bot carries no connection to keep alive, so it may
sit vacant until a trigger arrives — but the group itself exists either way.

Wake is the existing spawn flow: whichever member needs the agent creates the
`SandboxClaim` idempotently (`SandboxApi.ensureClaim`, deterministic name
`agent-<agentId>`); the out-of-band agent-sandbox controller materializes the
pod, adopting from the runtime tier's shared warm pool when one is available;
`bindChannel` patches the operating mode to Running and publishes the launch
record at pod-name time — and the holder then dials the shim and binds at its
term (§7). Cold, warm, and resume paths are already distinguished and metered
(`LaunchTimer.observedPath`). **No new wake machinery exists here.**

### Orphan reconciliation

Teardown is best-effort and a member can die mid-way — a rollout, an OOM, a
node loss — leaving a `SandboxClaim`, a `Sandbox`, or a probe claim that no
process still intends to remove. Rather than one durable obligation per
failure mode, a single **orphan reconciler**
(`packages/daemon/src/k8s/orphan-reconciler.ts`) sweeps the sandbox namespace.

**It is a CronJob, not a timer.** The deployment runs
`agentconnect-daemon reconcile --once` on a schedule (every 10 minutes) with
`concurrencyPolicy: Forbid`: one shot per run, and the cluster — not the daemon
— owns the cadence, the mutual exclusion a lease used to provide, and the
failure reporting a non-zero exit already gives an operator. The Job uses the
daemon image, the pool members' ServiceAccount, and the same namespace and
warm-pool environment they read; the members themselves run no sweep and hold
no scheduler state for one. The job connects to the control plane as an
**observer** (`register.observer`): the same projected identity a member
presents, admitted on the same TokenReview path, but enrolled in no member set
— so the duty ledger can never grant work to a process whose only job is to
sweep — and marked so the pool-member reaper retires its row promptly.

**What it collects.** It lists the claims and Sandboxes that carry the
install's agent label (`agentconnect.md/agent` on the pod metadata), asks the
control plane in **one batched read per run** which of those agent ids still
exist (`agent/exists` → `agent/exists/ok`, install-wide, advertised as the
`agent-exists-v1` server feature), and deletes only what is provably orphaned:

- a claim whose agent the control plane no longer knows, on an object at least
  the grace period old (default 10 minutes);
- a probe claim past the window the probe stamped on it;
- a Sandbox no claim binds, whose agent the control plane no longer knows,
  under the same grace.

**Safety rules.** An object of a live agent is never touched, a claimless
Sandbox included — deleting a claim deletes the workspace volume and is
irreversible, so a stray of a live agent is reported, not collected. An id the
control plane cannot be asked about and an object without a readable age skip;
a run whose control-plane read fails collects nothing and exits non-zero. The
grace is the OBJECT'S OWN AGE, which is the clock that matters — no in-flight
creation can still be racing the control plane's write — and the only one a
one-shot job has, since it keeps no memory of an earlier run. Every delete
carries the UID and resourceVersion from the LIST snapshot, so a same-name
replacement created after the list is never the object deleted. Each run logs
one summary line (candidates, orphaned, deleted, skipped-live, skipped-grace,
failed).

**Dry run by default.** The reconciler ships reporting only; deletion is
enabled per deployment with `AC_K8S_ORPHAN_DELETE=true` after an observation
window in which the summary lines show it collecting exactly what an operator
would (`AC_K8S_ORPHAN_GRACE_MS` tunes the grace). It replaced the dedicated
probe-claim GC, and agent removal's sandbox teardown is best-effort because of
it: `discardAgent` deletes the claim once and logs a failure, and the
reconciler collects the leftovers.

## 5. The duty ledger and lease service (D6, D7)

**The CP is the ledger.** Members claim, renew, and release duties over the
existing fleet WebSocket; the CP transacts against its own Postgres, alongside
the `Bot` and `Integration` rows it already owns.

**The ledger is a `duty_group` table, not columns on existing rows.** Per-row
leases cannot express the claim unit of §6: they are exactly the independent
claims that would give one agent two homes, a botless agent has no
`Integration` row to carry a lease at all, and two already-held groups merging
have no row on which to record the single surviving holder. The shape
(`packages/control-plane/prisma/schema.prisma`, repo in
`persistence/repositories/duty-group.repo.ts`):

- `duty_group` — `(orgId, holder, term, expiresAt)`, one row per connected
  component, the only thing ever claimed.
- `duty_group_member` — the derived `(agentId|botId → group)` projection,
  recomputed from the org's `Agent` and `Integration` rows whenever an agent or
  an edge changes; its composite primary key makes "one home per agent / per
  bot" a database invariant.

**`term` is the fencing token**: monotonic per group, bumped on _every_ grant
and never on renewal. **Vacancy is temporal**, not referential: a group is
grantable when `expiresAt` has lapsed (or it was never claimed / explicitly
released); a dead member simply stops renewing, and `holder` deliberately
carries no foreign key — a row-level `SetNull` would vacate without a term
bump while fencing always reads `(holder, term)` together.

**Vacancy discovery and claiming collapse into one call.** A member's
heartbeat asks "grant me up to K vacant duties", capacity-gated by the member
itself (D14). `claimVacant` is one CAS statement (`FOR UPDATE SKIP LOCKED`):
racing claimants take disjoint vacancies, first valid claim wins, and the
grant's row locks hold until the returned `(term, members)` snapshot is
assembled so a concurrent recompute can never pair an old term with rewritten
membership.

**Composition changes are re-grants, not evictions.** The recompute
(`orchestrator/dutyGroup.ts` + `dutyRecompute.ts`) is plan-then-apply in one
transaction under a per-org advisory lock plus row locks. The pure planner
assigns group identity deterministically — existing groups are consumed in
(held, larger, lower-id) order and take the component holding most of their
former members — which makes "the holder of the larger group keeps the merged
group, ties broken by the lower groupId" a corollary, lets splits follow the
largest fragment without eviction, and names every superseded holder in the
plan. The sweep walks orgs on a keyset rotation; a coalescing `kick(orgId)`
runs the same recompute promptly from the mutation seams (agent create/delete,
integration create/delete, cron upsert/remove, placement moves), with the
rotation as the backstop.

**The lease protocol rides the existing heartbeat.** Not a new connection,
timer, or tick (`orchestrator/dutyLease.ts`):

- **Renewal is the heartbeat** — one batched, term-preserving expiry refresh
  per frame. A lapsed-but-unclaimed lease still renews, so a CP outage shorter
  than the reassign window is a non-event.
- **The digest diff is the reconnect crossing point**: confirm the terms or
  supersede, never both. A held group missing from the member's digest
  (restart, lost EVT) or present at a stale term is re-issued as a
  `duty/grant` entry — an entry _replaces_ its group daemon-side, so both
  cases converge through one path. A digest entry the ledger no longer grants
  is revoked (`superseded` | `gone`), classified after the vacancy claim so
  the grant and revoke sets are disjoint by construction.
- **Grant emission is chunked** (entries per frame plus a member-ref budget).
  A component larger than `DUTY_GRANT_MEMBERS_MAX` is not deliverable on this
  wire at all: it is never claimed (a size gate inside the vacancy predicate),
  an unserved oversized lease vacates rather than renewing forever, and a held
  one that grows past the cap is superseded — the honest signal that the group
  belongs on a dedicated daemon (D16).
- **One per-daemon lane serializes every ledger touch**, reserved
  synchronously at dispatch so lane order is the daemon's frame order:
  overlapping beats cannot double-spend headroom, and a `duty/release` queued
  behind a running exchange guarantees every grant that exchange emitted
  reaches the daemon before the release ack.

**Timing (D7).** Three constants govern liveness:

- **T_fence** — a holder that cannot renew for T_fence **self-fences**: it
  tears down the affected duties, including their platform connections. Sized
  to cover a routine CP deploy. Implemented daemon-side: the client tracks a
  per-group deadline and calls `Daemon.fenceDuties`, without which a partitioned
  ex-holder could still serve a group a successor has claimed.
- **T_reassign > T_fence** — the CP treats a duty as vacant only after
  T_reassign without renewal, guaranteeing the old holder has self-fenced
  before a successor can claim.
- **Recovery grace** — a freshly booted CP suppresses vacancy grants for one
  full T_reassign, so a CP restart cannot misread quiet members as dead;
  renewals are unaffected. (Implemented.)

**The duty term and `sessionEpoch` are independent fencing domains.**
`sessionEpoch` is minted per daemon at auth and fences control frames from a
stale connection generation; the term fences actions by a member that is no
longer the holder. Every reconnect bumps `sessionEpoch` — so a term derived
from it would churn every duty in the install on each CP deploy, which is R7
through a side door. The acceptance property: restart the CP, watch every
`sessionEpoch` bump, and no duty term moves and no platform connection drops.

**Two consciously accepted trades:** (1) a sustained CP outage longer than
T_fence tears down daemon-held ingress pool-wide — members cannot distinguish
"CP down" from "I am partitioned and a successor is being appointed", and the
loss is bounded by the platforms' own buffering; (2) duty failover after
member death is ~T_reassign, not the ~30s a data-plane-anchored lease would
give — the price of R6's mechanism deletion. Failover latency is a tunable;
mechanism count is forever.

## 6. The duty group: what is actually claimed (D5)

| Group shape                                           | Members                         | Why                                                                                                            |
| ----------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Agent with agent-bound bots (Telegram, Discord)       | `{agent, bot…}`                 | Ingress and execution co-located by construction                                                               |
| Shared daemon-held bot (Slack Socket Mode, Feishu WS) | `{bot, …every agent it serves}` | One socket per bot token — its agents cluster at the socket's owner                                            |
| Agent with an enabled cron                            | `{agent}`                       | A cron needs a home like any other trigger; the singleton below already is one, so the schedule always has one |
| Relay-ingress-only / webchat / A2A agent              | `{agent}`                       | A singleton, derived by the recompute — every agent is ownable, so it is proactively claimable                 |

**Every agent is a node.** The component set is seeded from the org's `agent`
rows and then merged by edges; an edge only forces **co-location**, it is not
what makes an agent ownable. Edges come from active `Integration` rows whose
bot has `transport: 'socket'`; relay-ingress (`http`) integrations create no
edge because the relay, not the daemon, owns that socket. Crons need no input
of their own — a cron's agent is an agent. An oversized group is the mechanical
signal for a dedicated daemon (D16).

Deriving the singleton rather than minting it on first contact is what keeps
the ledger self-consistent: an edgeless agent used to appear in **no** computed
component, so the recompute's final "delete every group no component claimed"
pass reaped the singleton the activation rendezvous had just minted, and the
next trigger minted it again — a grant/revoke loop that interrupted the agent's
in-flight turn on every sweep. The cost is one `duty_group` row per agent per
org, most of them permanently vacant in a deployment whose agents live on
org-scoped daemons; vacancy is cheap by construction (§5) and the eligibility
gate filters those rows out inside `claimVacant` — a machine-placed agent has
exactly one eligible holder and it is never a pool member — so they consume no
grant budget.

### The activation rendezvous

A trigger for an _unheld_ group has nowhere to go — the ledger names no holder
for a group nobody has claimed. The resolution keeps members volunteering and
adds no component: the relay routes the trigger to **any connected member**,
and that member claims the group on receipt. The claim normally lands on a
group the recompute already derived; minting one is the fallback for the window
between an agent's creation and its first sweep.

- The daemon's `rd/msg` handler checks its duty registry (one gate covers all
  four message sources). On a miss it sends `duty/claim`; a win returns a
  grant installed exactly like a `duty/grant` EVT and the message re-enters
  normal dispatch; a loss answers the relay with a typed **`not_holder` NAK
  carrying `holderDaemonId`** — the incumbent it lost to, as the CP named it.
- A claim is refused locally, without asking the CP, while draining or at zero
  headroom — a full or draining member must not volunteer.
- The relay re-sends the **same `msgId`** to the named holder **once**: the
  holder's own dedup protects against double delivery, and a second refusal
  terminates rather than chasing a stale ledger.
- A refusal the relay cannot resolve — no holder named, the holder not
  connected here, the redirect target refusing in turn — is a **counted
  drop**, deliberately not a claimed retry: HTTP ingress has already
  acknowledged and deduplicated the provider callback by then, so nothing
  upstream will present the message again. Bounding that window is the
  ledger's job (vacancy plus the recompute), not the router's.
- The NAK verdict is not cached in the daemon's ack-dedup map, so a later
  grant never replays a stale refusal.
- **A platform interaction takes the same road as a message.** A status-modal
  button or a card action carries the member the routing projection last
  recorded, which after a rollout or a rebalance is either gone or no longer the
  holder — and nothing retries, because HTTP ingress acknowledged the provider
  callback long before the ack came back. So the relay forwards interactions
  through the rendezvous too, and the ack it answers the platform with is the
  true holder's, `response` body included, which is what a Slack modal and a
  Feishu toast need. A refusal it cannot place is a counted drop like any other.
  Webhook hook dispatch deliberately stays off this path: it has its own
  connection-retry loop and reports a rejection upstream as a delivery status.

When the ledger still names a holder that has died but not yet gone vacant,
a re-route lands on a dead connection and fails the same way — a counted drop,
part of accepted window 2 (§13), bounded by T_reassign plus the recompute. No
internal retry exists behind that drop; if the window ever needs to be
narrower than the platforms' own buffering makes it, the close is a
relay-owned durable retry, which is deliberately future work rather than an
implied property. Crons never reach this rendezvous: a cron-bearing group is
proactively claimable, so it always has a holder by the time a fire is due.

**A cross-daemon peer wake (`rd/agentmsg`) does not take the rendezvous; it
waits it out.** Its sender is a daemon, not a provider callback, so it can be
told "not yet". The peer directory carries a pool agent nobody may be addressed
at yet — a grant its member has not confirmed in a digest, a lapsed lease a live
member is about to claim — as a **pending** entry (policy intact, no daemon), the
relay answers the retryable **`not_ready`** for it (as does a target daemon
handed an agent it does not run), no hop caches that verdict against the
`deliveryId`, and the source daemon re-sends the same `deliveryId` with backoff
for a few lease horizons before recording it as terminal. Exactly-once holds
because the id never changes: an attempt that landed is replayed from the
target's dedup on every later attempt.

## 7. Ownership and dial-in binding (D3)

Historically the shim dialed out to its org's daemon (`AC_SHIM_ENDPOINT` — the
address was knowable because the topology was per-org). In the pool, the
daemon that should own an agent is whoever holds the duty, unknowable from
inside the sandbox. So **the direction flips: the duty holder dials the
sandbox** (`packages/daemon/src/shim/dialer.ts` dials; `shim/server.ts`
listens in the sandbox). See [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md)
for the spawn machinery this re-choreographs.

The shim is a hardened listener: accept exactly one active connection; on
accept, present its audience-restricted projected ServiceAccount token (the
same `/var/run/ac-identity/token`, audience `ac-daemon-callback` as before);
let the daemon TokenReview it; enforce highest-term-wins — a dial carrying a
higher term supersedes and closes the current connection, a lower term is
refused, and the same term is accepted only from the same holder, which is
what makes an ordinary transport break recoverable without a term advance.

**Authentication is direct Kubernetes identity in both directions.**
TokenReview proves the pod's identity to the daemon; the pre-disclosure
boundary toward the shim is the sandbox-namespace NetworkPolicy (one ingress
rule: pool namespace → shim port) plus member pod identity, with audience
separation preventing a token for one hop from authenticating at another.
**There is no CP-signed shim grant, public key, JWKS document, or key set** —
an earlier revision specified one and it was removed outright: the Kubernetes
identity the pods already carry answers the same question without a CP-owned
key-distribution mechanism.

The binding invariants of the spawn design survive re-choreographed: mutual
authentication; the connection binds to (sandbox UID, pod UID, org, agent,
generation), checked by the dialer against its own launch record; per-operation
capability grants unchanged; the replay fence gains the term alongside the
generation; no long-lived credential in the sandbox. The single-predicate
enforcement style of `ShimBindingRegistry.authorize()` is retained, extended
with the term check.

**Unreachable sandbox:** after N failed dials with backoff, the holder
releases the agent's duty so another member can claim it and dial from its own
network position. Reachability failure is treated as a placement problem, and
the ledger is the placement mechanism.

## 8. The wake path, end to end

A new Telegram message for a sleeping agent — no CP call on the first-message
path, because the held bot duty _is_ the agent's home:

```mermaid
sequenceDiagram
    participant U as Telegram user
    participant TG as Telegram API
    participant M as Member
    participant CP as CP ledger
    participant K as kube API / agent-sandbox controller
    participant S as Shim
    Note over CP: install creates the Integration row → duty group exists, vacant
    M->>CP: heartbeat: grant me up to K vacant duties
    CP-->>M: grant tg-bot group (term=1)
    M->>TG: bot.start() — long-poll opens
    U->>TG: @agent hello
    TG-->>M: update
    M->>M: home check (local, no CP call):<br/>the held bot duty IS the agent's home
    M->>K: SandboxClaim ensure (agent-<id>, idempotent)
    K-->>M: claim bound (warm pool)
    M->>K: watch Sandbox CR
    K-->>M: pod name + ready observed
    M->>M: publish launch record at pod-name time
    M->>S: dial + bind (Kubernetes-identity + term handshake, §7)
    S-->>M: channel ready
    M->>M: create ACP session, run turn
    M-->>TG: streamed reply
```

Nothing here is new mechanism: the polling connection is today's
`TelegramConnection`, the sandbox flow is today's
`K8sDriver.ensureSandbox`/`bindChannel` with the dial direction flipped, and
the session machinery is untouched.

## 9. Crons are a time-based trigger, not an input (D10)

An enabled `CronDef` is a standing reason for its agent's duty group to be
held — exactly as a bot connection is. It needs no input of its own: every
agent already seeds a component (§6), so a cron-bearing group is **proactively
claimable** like any other, appearing in the vacancy pool even while its agent
sleeps. The holder loads the schedule with the ordinary daemon-side
machinery (`croner` in `packages/daemon/src/scheduler/scheduler.ts`, its
roster filter following group holdership) and fires it locally; at fire time
the holder is already the agent's home, so the wake is §8 with no routing step
at all. `CronDef.lastRunAt` keeps its advisory, daemon-authoritative
semantics; the dream scheduler is scoped identically.

**The handover window is compensated, not ignored.** A schedule is armed only
while its holder holds the duty, and a freshly constructed `croner` job knows
nothing of a moment that has already passed — so a fire landing between the old
holder unregistering and the new one arming used to run nowhere, silently, on
every rollout. On GAINING an agent, a member now replays the one occurrence its
stamp says ran nowhere: the newest missed moment only (never a backlog), inside
a grace window of one interval capped at an hour, and taken by a CAS on the
stamp row so two members racing the same handoff fire it once. `cron_runs` is
what that stamp was declared for; `dream_runs` is its dream twin.

A stamp is only evidence about the definition it was written under, so both rows
carry a `definition` fingerprint (expression + timezone + enabled) alongside the
timestamp. Schedules are edited in place: "daily, last fired 03:00" then
"switched to hourly at 12:30" would otherwise owe a 12:00 fire the hourly
definition never covered, and a disable/re-enable would owe every moment inside
the disabled window. A catch-up is eligible only when the stored fingerprint
equals the active one, and the reconcile that arms the schedules retires a stamp
whose definition has moved — re-stamping NOW, so the new definition starts clean.
A schedule that is GONE has its row dropped instead: ids are re-mintable, so a
recreated one must start from no evidence rather than inherit the deleted
schedule's last run. A row written before the fingerprint existed carries NULL
and is simply ineligible until its next real fire.

Only the holder writes those rows. They are shared by the whole pool, so a
member that arms nothing for an agent reconciles nothing for it either — a stale
non-holder re-stamping under its own view of the definitions would erase the very
gap the holder is there to compensate. The check is at the write, not only at its
caller.

**The lease is what fixes the offline-cron hole, not a new trigger path.** A
cron whose owning daemon is offline simply does not fire today, and nothing
notices; under the ledger, a dead holder's group goes vacant at T_reassign, a
survivor claims it, loads the schedule, and the next fire happens. An earlier
revision concluded the CP should fire crons and nudge holders; that bought a
CP-side scheduler loop and the retirement of a working daemon subsystem to
deliver what the vacancy sweep already delivers, and was deleted.

## 10. Cross-member paths (D8) and org context on the wire (D9)

The pool has **one delivery topology and one narrow cross-member path**. P1
co-location means a platform message is born at the member that runs the turn
— there is no member-to-member platform-message path because there is nothing
to forward. The single cross-member path is `rd/agentmsg`, serving A2A only;
it is not extended into a platform-message bus (R5). The rendezvous adds a
`not_holder` NAK on the inbound `rd/msg` path (and the same reason on
`rd/agentmsg` for A2A first triggers). There are no MOVED redirects, no dial
hints, no presence streams: **the ledger is the sole directory**.

Org context travels on the frame, not on a subscription. The install-wide
connection carries `orgId` on every org-scoped request, event, control frame
and correlated reply; auth, register, heartbeat, fleet facts, rosters, duty
lease frames and daemon lifecycle frames legitimately omit it — and must, on
that connection. Both peers enforce it with the shared classification in
`packages/protocol/src/frame-scope.ts`: an org-scoped frame without an org, an
install-wide frame with one, an org that does not own the targeted resource,
or a reply that does not carry its request's org is refused with
`SCOPE_DENIED` and never applied (the contract in detail:
[`org-scoped-data-layer.md`](org-scoped-data-layer.md) §4.1). Reconnect state is a combined multi-org snapshot or revision-fenced stream
on the same member connection — deliberately **not** `subscribe(org)`, an org
room, or an org-specific socket — reusing the watermark machinery that already
exists in production (`Agent.configRevision` with the daemon-side
`stale|conflict|idempotent|apply` compare, and `SessionMeta.visibilityRev` +
replay-on-register).

**Platform credentials are duty-scoped; agent secrets stay pointer-based.** An
agent's secrets are materialized at spawn through the shim, but a duty holder
must open a Telegram long-poll before any sandbox exists, so the bot token
cannot ride that path. Credential delivery follows holdership: a member
receives a platform credential only for duty groups it currently holds,
stamped with the term it holds them at, and drops the material with the
group's context on supersession or release. Exposure narrows from "every bot
in the org, forever" to "the bots in the groups I hold, while I hold them".

## 11. The state layer (D11)

The data plane is a Postgres owned by the execution layer, fully separate from
the CP database — the CP never stores message content and never connects to it
(P3). The design is [cloud-data-plane-postgres.md](cloud-data-plane-postgres.md);
the properties that matter to the pool:

- **Shared tables with an `org` column**, org-prefixed uniqueness and indexes,
  migrations once per cluster. The decisive property is **reversibility**:
  org-predicated SQL is forward-compatible with a later per-org split (the
  predicate becomes redundantly true), while the reverse migration does not
  exist. The SQLite driver gains the identical column so both drivers run the
  same SQL.
- **The org predicate is injected in exactly one layer** — the store handle
  captures the org once; call sites never pass or see one. Row-tenancy's
  classic leak (one forgotten `WHERE`) is confined to the repository layer,
  covered by a contract suite that runs against both drivers, with row-level
  security available as belt-and-braces.
- **Writes are fenced by ownership, not by a duty term.** P4's term fences the
  connection at the shim and the claim at the ledger; the shared store fences by
  _who owns the row_ (below). No data-plane write carries a duty term, and none
  needs one: a member that lost the duty is stopped by the gate before it reaches
  the statement, and the statements two members can still reach concurrently are
  written to be race-safe.
- Streaming transcript writes are batched/coalesced; the per-token pattern
  that is cheap against local SQLite would be pathological against networked
  PG.

Shipped: all of it, by a cheaper route than the plan named. #958 put the
**complete durable `LocalStore` surface** on Postgres behind a synchronous facade
over a worker thread, so the async-store refactor D11 anticipated never happened
and no call site became async; a `--k8s` daemon never opens SQLite. The
transcript fence landed last (#1075): the pool store's `transcript` /
`transcript_recipient` rows carry `orgId`, and the data plane's separate
transcript pair — declared but never read or written — is deleted, so exactly one
store carries the fence. The cross-driver contract suite is real rather than
aspirational (#1080): the store suites re-run against a real `postgres:16` on their
own CI job — which immediately found the activation rendezvous joining its keys with
NUL, a byte Postgres `TEXT` rejects outright, so paired activation could not settle on
the pool at all — beside a text check that fails on SQLite-only SQL the pool's rewrite
layer does not translate, for the statements no suite reaches.

### Shared state is per member, not per install

One shared store turns any table that _was_ per process under SQLite into an
install-wide one, silently: the code still reads and writes it as if it were the
only writer. The member-replacement audit worked that class out of the store; what
it converged on is four rules, and they are the shape any new table has to take.

- **A claimable row names its owner.** Outbox and receipt rows carry an
  `ownerId` and a claim lease: the hook-completion outbox (#1044), session purge
  receipts (#1065) and the session-metadata outbox (#1068) each offer a member
  its own rows, unowned rows, and a lapsed peer's rows for agents it currently
  serves, take a CAS claim before every emit, and fence the ACK to the claim
  holder — so a peer can never destroy a completion it merely happened to read.
  A row the reader cannot scope is **parked** for the member that can, never
  failure-counted (#1068). Per-member caches are keyed the same way
  (`runtime_catalog_meta` / `runtime_model_catalog`, #1058).
- **Background work is duty-gated.** `servesAgent(agentId)` — the predicate that
  already scoped `transportAgents()` — now also gates the sandbox idle sweep
  (#1045), orchestration deadlines (#1042), the session TTL and retention sweeps
  (#1065), the loop-guard trip's inbox purge (#1069) and cron/dream arming. A
  sweep on a non-holder is not merely wasted work: it suspends a pod, closes a
  session or deletes a queued row another member is serving.
- **Boot recovers only what this incarnation owned.** `ownerId` is a process
  incarnation, so a starting member owns nothing and rewrites nothing a peer is
  working on; a genuinely stranded row is reclaimed on `agentsGained` — the CP
  saying "you serve this agent now" — not on process start (#1046). The same
  hook replays the shared inbox backlog (#1049), re-derives the sandbox launch
  (#1045), compensates a swallowed schedule (#1053) and re-arms parked snapshots
  (#1068). A duty handoff is not a removal, so it keeps the agent's unrun inbox
  instead of purging it (#1064).
- **Two members that can reach one row use a CAS or a relative write.** Never a
  read-modify-write: the loop guard's counters and its trip latch are single
  statements with `RETURNING` (#1069), session usage accumulates through a
  compare-and-set (#1063), the memory-capture gate's revision test moved into the
  upsert's `ON CONFLICT … WHERE` (#1054), and the deadline fire is a CAS so two
  holders during a handoff wake the main once (#1042). The Postgres facade
  rewrites `BEGIN IMMEDIATE` to a plain `BEGIN`, so the writer lock a SQLite
  caller assumes does not exist here.

One further correction belongs to the same class rather than to concurrency: a
key that was runtime-local under SQLite becomes an install-wide collision domain
on the pool. `session_gates` was keyed by the ACP session id alone, which every
runtime mints from 1, so it is now keyed `(agentId, acpSessionId)` (#1054); the
CP routing map, one install-wide row rewritten from each member's memory, is
simply not persisted on a shared store (#1063).

**Managed agent memory is not store content and not member state either.** A
member's state root is an `emptyDir`, so anything the daemon wrote there for an
agent — `memory/`, `channels/`, dream staging — was lost with the next rollout
and invisible to the member that claimed the agent next (#1078). A pool agent's
managed memory therefore lives on its **sandbox volume**, at
`<workspace mount>/.agentconnect/memory`, beside the checkout on the same PVC:
it follows the agent across members exactly as the workspace does, is read and
written through the shim's file channel by whichever member holds the duty, and
is reachable only while the sandbox is bound — the console wakes the sandbox
before it reads (§8, #1077), and a post-turn distillation that arrives after
the pod was suspended waits in the shared-store capture outbox until the next
bind. Local daemons keep the tree under the agent dir; the two are one code path
over a file-system port ([memory-evolution.md](memory-evolution.md) §3.2.1).

## 12. Capacity (D14) and upgrades (D12)

Each member enforces its own duty budget **at claim time** — the "grant me up
to K" call is capacity-gated by the caller from `limits.maxAgents` minus
duty-covered agents, and the rendezvous refuses to claim at zero headroom. The
CP never load-balances, never schedules, never picks; it only refuses invalid
claims and **alarms on vacant-duty age**. A human scales the Deployment. No
scheduler exists anywhere — deliberate continuity with the current system,
where the session-placement scheduler was built but never armed.

Per-org resource quota is deliberately not implemented here: a shared sandbox
namespace keeps one namespace-wide `ResourceQuota`/`LimitRange` as the cluster
safety valve, per-member duty budgets bound each member, and finer-grained
enforcement belongs to whatever owns limits. A runaway workload's escape hatch
is a dedicated daemon (D16).

The pool Deployment rolls by **surging the whole pool, then draining the old
members slowly** — `maxSurge: 100%`, `maxUnavailable: 0`, a long
`terminationGracePeriodSeconds`. Kubernetes brings up a full second set, waits
for each replacement to report ready, then SIGTERMs the old members. Four
application-side properties make that a rollout with no capacity dip and at
most one move per agent (#1016):

- **Only the newest live generation claims.** `maxSurge: 100%` alone is not a
  full-pool barrier: the Deployment controller scales the old ReplicaSet down
  as soon as one replacement is Available for `minReadySeconds`, so one old
  member drains while its old peers still claim what it released. So the
  barrier lives in the ledger: a member reports its rollout generation (the
  pod-template hash, `AC_POD_TEMPLATE_HASH`) on register, and a claimant is
  offered vacant groups or a rendezvous home only if no live member of its
  set carries a different, newer generation — newest = the generation whose
  earliest live member arrived last (`newerGenerationLive`, one SQL predicate
  next to the `draining` gate). Older generations keep serving and renewing;
  null-generation members (local daemons, older pods) are never held back.
- **A draining member claims nothing.** On SIGTERM the member latches its
  claim gate (no `claimVacant` headroom, no activation-rendezvous claim, no
  grant admitted) and reports `draining: true` on its digest — sent at once,
  not at the next tick. The CP keeps that bit **sticky for the registration**
  (`DutyLeaseService.draining`): `claimVacant`, `claimAgentHome`, and the
  missing-regrant re-issue all skip a draining member until it registers
  afresh, so a vacated group can only land on a member that is staying —
  even if the scale-down is not simultaneous. Renewal continues meanwhile.
- **Ready means servable, not merely up.** A member under `--k8s` publishes one
  predicate (`packages/daemon/src/readiness.ts`, `readinessState`) on the two
  sinks a pod probe can read — HTTP `/readyz` on `AC_READINESS_PORT` and a file
  at `AC_READINESS_FILE` (default `/var/run/agentconnect/ready`) — true only once
  the CP registration is acknowledged **and** the install-wide sandbox runtime
  probe has returned, and false again the instant the SIGTERM latch closes, so
  the endpoints controller stops routing while the pod keeps running for the
  drain. That makes the rollout barrier the fact rather than a timed
  `minReadySeconds` (#1043). The gate is the FIRST thing `start()` does — a
  marker file on a mounted path outlives the container that wrote it, so it is
  cleared before startup blocks on the CP registry, and readiness reads
  `starting` until `start()` returns.
- **Drain is real, slow-safe, and acknowledged.** Per member
  (`Daemon.stop()` → `releaseDutiesForShutdown`): in-flight turns are never
  cut to speed the rollout up; each held group is withdrawn locally (the same
  teardown a revoke runs), its hosts are stopped and its platform connections
  converged **before** it is handed back with a `duty/release` that is
  **awaited and retried until acknowledged**, one group at a time, the moment
  that group is idle — idle groups immediately, a busy group when its last
  turn settles — all before the CP socket closes. A group whose teardown
  cannot be confirmed by the deadline is deliberately **not** released: it is
  left to lapse at T_reassign (the pre-#1016 takeover path), because an ack
  must mean "no longer served here" — a rejected host stop counts as
  unconfirmed. A grant that lands after the latch (an exchange that began
  before the SIGTERM) is never installed and never acknowledged early: it
  is recorded, and released acknowledged only once the loop is done with
  every held group — by then nothing is served here — and after one global
  wait for the platform convergence every duty change so far requested (a
  group revoked just before the SIGTERM never entered the loop; this is
  what closes its socket), unless it covers an agent of a group left to
  lapse (or one whose host stop is still recorded as pending or failed;
  host teardown is observable per agent), in which case it lapses too. The cost is deliberate: a group granted in that race
  window stays with the retiring member until its drain completes, a small
  delay bounded by the drain budget, chosen over per-case teardown proofs.
  A rebalance drain simply ignores late grants, as before. The whole drain is bounded by
  `limits.poolShutdownDrainMs` (5 min by default; the turn wait stops short of
  it by a release reserve so the last acks still land inside it), and ends
  with one log line: groups and agents released, acks, groups left to lapse.
  Deployment side: `terminationGracePeriodSeconds` ≥ that budget plus margin.

Sleeping agents still move by not moving: they wake wherever their duty is
next claimed. Successors claim on their next beat and re-dial sandboxes at a
fresh term; the shim's highest-term-wins handshake makes the cutover atomic per
sandbox. Releasing only after the group's own turns are done is load-bearing —
a successor binding at a higher term while the predecessor still owns admitted
work is the split this ordering prevents. A CP-commanded rebalance drain
(`runDrain`) keeps its own shape: it stops turn hosts, then `releaseAllDuties`,
and reopens — it never sets the sticky bit. Double moves are visible on the CP:
a group granted at a new term twice inside `doubleMoveWindowMs` logs a warning.
There are no reconnect storms in either direction: successors pace their own
dials, and sandboxes never dial anyone.

## 13. Failure model (D13)

| Failure                              | Behavior                                                                                                                                                                                                                                                                                                                        | Bound                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Member death**                     | Its duties stop renewing; successors claim after T_reassign and dial. Sleeping agents untouched. In-memory pending turns die. For relay-ingress agents the relay re-routes the bot within seconds, but that member waits out T_reassign before it can claim the dead member's agent homes — no connection-death fast path (R7). | Platform retry/buffering bounds message loss (accepted window 1); takeover gap ≈ T_reassign + platform reconnect (accepted window 2) |
| **Member ↔ CP partition**            | The member self-fences its duties at T_fence, including tearing down platform connections.                                                                                                                                                                                                                                      | Accepted false-positive teardown when the CP is up but unreachable from this member                                                  |
| **Member ↔ data-plane PG partition** | The member cannot serve state: fail turns after a bounded retry window, release duties, stop accepting work.                                                                                                                                                                                                                    | Data-plane PG availability is pool availability                                                                                      |
| **Member ↔ sandbox path break**      | Dial-retry with backoff; after N failures, release the agent's duty so another member claims and dials from its own network position.                                                                                                                                                                                           | N × backoff before relocation                                                                                                        |
| **Shim side**                        | On connection drop the shim just listens — it never dials. A half-dead old holder is fenced by term at the shim, and stopped at the store by the duty gate and row ownership (§11).                                                                                                                                             | Fencing is absolute, not probabilistic                                                                                               |
| **CP outage**                        | Existing holders keep serving until T_fence. No new claims, no wakes of new duties, no failovers until the CP returns — "CP down = activation pauses, established sessions continue."                                                                                                                                           | Outage > T_fence tears down daemon-held ingress pool-wide (accepted trade, §5)                                                       |

## 14. Local/pool parity (D15) and rollout

There is **one binary**. Profiles differ by capability knobs, never a mode
flag:

| Knob              | Local/self-hosted             | Pool member                                |
| ----------------- | ----------------------------- | ------------------------------------------ |
| Spawn driver      | `local` (child processes)     | `k8s` (SandboxClaim + shim dial-in)        |
| Store driver      | SQLite                        | data-plane PG                              |
| Org contexts      | exactly one, permanent        | refcounted, on demand                      |
| Org on the wire   | connection-scoped (API key)   | frame-scoped (`organizationMode: 'frame'`) |
| Ingress transport | per-integration, as today     | per-integration, duty-gated                |
| Duty ledger       | not consulted (single member) | CP lease service                           |

The local symmetry argument for dial-in: the local daemon already initiates
its runtimes — it spawns child processes and owns their stdio. Dial-in makes
pool and local symmetric: in both, the daemon reaches out to establish the
execution channel.

**Enforcement is not configurable.** Both the exchange and _enforcement_ (the
`transportAgents()` filter, schedule scoping, refusal of unheld triggers) follow
one predicate: `organizationScope() === 'frame'`. An install-wide member is
duty-governed and needs no configuration to be; an org-scoped daemon owns its
agents outright and is untouched. A pool member's state root is an `emptyDir`,
so its config.json is regenerated from defaults on every Pod start — which is
now simply irrelevant, since the file carries no part of the decision.

There was a `features.dutyEnforcement` soak flag, with an
`AGENTCONNECT_DUTY_ENFORCEMENT` override, and it is gone. It let a grant or
revoke move only bookkeeping so convergence could be watched before it gated a
connection, and it made sense only while placement pinned each agent to exactly
one member: "serve everything I was placed with" was then a well-defined
fallback. Once placement became a target, a `pool` agent is placed on no member,
so off meant those agents were served by nobody — a lever that breaks the
system rather than a safety valve.

**There is no grant policy any more.** The soak ran on an incumbent-only one —
a vacancy went only to the member the group's agents were already placed on —
and it could not survive its own premise: after a rollout the incumbent names a
Pod that no longer exists, so a vacated group was claimable in principle and
claimed by nobody in practice. What replaced it is not a wider policy but a
different question. Placement is a **target**: `daemon` names one machine
through `Agent.daemonId`, `set` names a **member set** through `Agent.setId` —
and the pool is one such set, the org-less row every frame-mode Pod is enrolled
in on auth (#1003; [daemon-groups.md](daemon-groups.md) §2). A member may claim a
group iff it may hold **every** agent in it — that machine for a `daemon`
placement, any member of the named set for a `set` one, which the ledger asks as
one join to `member_set_member`. One predicate, applied identically by the
heartbeat claim, the activation rendezvous, and the sweep's placement fence,
which now vacates a lease whose holder is no longer eligible rather than one that
lost its last incumbency. `{ kind: 'pool' }` survives as API sugar the route
resolves to the org-less set at the edge; nothing stores it.

Two consequences worth stating. A group mixing a `set` agent with a
machine-placed one is claimable by **neither** — serving it as a unit would mean
one side running what the other already runs — so the gate is FORALL, not
EXISTS. And an agent placed on a machine has exactly one eligible holder, which
an install-wide member never is: dropping the incumbent gate cannot reach the
agents a local daemon is already serving. A single-org daemon sends
byte-identical heartbeats to before and never observes any of this.

### Authority follows the holder, never a column

Once placement stopped naming a member, `Agent.daemonId` became NULL for every
pool agent — and every control-plane site still spelling authorization as
`agent.daemonId === conn.daemonId` silently answered "no". Not degraded across a
rollout: **permanently** false, for the whole class. The corrected seam is one
resolver, `PlacementResolver` (`domain/placement.ts` plus the duty ledger):
authority is **placement ∪ the duty leases this member currently holds**, asked
as `mayAct` / `servingDaemon` / `dispatchDaemon` / `routableDaemon` depending on
whether the caller is authorizing, addressing, or seeding ingress affinity. No
caller branches on the placement kind; the kind stays inside the resolver.

That converted the organization-knowledge reads (#1004), hook dispatch and PR
review (#1047) with the completion accepted from the member that now serves the
agent rather than the one it was dispatched to (#1061), multi-agent webchat and
the delegated webchat MCP entitlement (#1057, whose delegation row is keyed on the
agent so retiring a member no longer cascades it away), and the dozen write
routes, daemon reports and the visibility replay in #1055 — the last of which also
made the replay fire on duty admission and page the currently-private gates, so a
session marked private converges onto whichever member takes it next. A machine
placement is unchanged throughout, because there the placement _is_ the serving
daemon.

Two shapes of the same mistake are worth naming because they read as opposites: a
`null` column that fails **closed** refuses work that is legitimately placed, and
a `null` column read as "unplaced, therefore fine" fails **open** — which is how
the organization-environment gate skipped its precondition for pool agents until
#1063 pointed it at the resolver.

### Daemon groups: the pool is one member set

The k8s pool is the **degenerate case of a more general concept**: a _daemon
group_ — a named set of members within which an agent's duty may be claimed.
The first half has landed (#1003): the member set is no longer implicit, it is a
`member_set` row, and the pool is the org-less one — one per install, every
frame-mode Pod enrolled in it by `upsertOnAuth`. What remains is the org-scoped
half, so that self-hosted installs can form groups out of ordinary local daemons.
For local daemons this is the
cross-machine generalization of the singleton pid lock — two local daemons
configured with the same bot token fight over the platform API (R13); a group
makes multi-machine failover safe for the first time.

Its prerequisites — the shared data plane, the daemon self-fence, placement as a
target rather than a member id — have all landed for the pool, and the pool has
run enforced end to end. The design is now its own document,
[daemon-groups.md](daemon-groups.md); the one genuinely new piece is the tenancy
axis (org-scoped connections claiming only "this org's agents, in a group
containing the claimant"), and that document exists to state it precisely. The
two constraints this section used to carry — membership stays a predicate, the
tenancy gate widens and never disappears — are now that document's §3 and §4.

## 15. Rejected alternatives

**R1 — Daemon scale-to-zero / sleepy per-org daemons.** Optimizes the wrong
unit: a sleeping daemon loses platform ingress, so it needs a wake trigger,
which means someone else must hold ingress — this design with extra steps.

**R2 — Full relay-ingress-ization** (move every platform to relay-held
webhooks/gateways). Would concentrate all always-on duty in the relay — a
component deliberately kept content-stateless and thin — and still leaves the
agent-home problem unsolved, so the ledger would be needed anyway. Survives as
a future option that would shrink the ledger's scope, not conflict with it.

**R3 — CP placement/assignment authority.** The ledger arbitrates
member-initiated claims transactionally but never selects or pushes holders.
An arbiter can be simple and boring; a scheduler grows policy forever.

**R4 — Connection-defined ownership** (the shim dials a pool Service; MOVED
redirects, dial hints, presence streams steer it). Structurally requires
cross-member platform-message forwarding (R5) and carries recurring costs — a
forward hop on every first turn, presence sync as a standing subsystem,
reconnect storms on member death. Dial-in deletes the class.

**R5 — Extending `rd/agentmsg` into a platform-message bus.** Its documented
narrowness (per-hop dedup, small correlator timeout, retransmit scope-down) is
acceptable at A2A frequency; platform messages would demand real ordering and
retransmit semantics on the hottest path in the product.

**R6 — A member-written lease table in the data-plane PG** (CP directory
broadcast, scan SQL, holder-report stream). The integration rows already live
in the CP database; putting the ledger there deletes all four mechanisms.
Recorded honestly: the data-plane anchor gave ~30s failover; the trade was
latency for mechanism count.

**R7 — Connection-anchored duty liveness** (a duty dies when the WS drops).
Every routine CP deploy would flap every platform connection in the pool.
Liveness is "renewed within T_fence", never "socket is up".

**R8 — The inbox as the v1 delivery bus.** Deferred, not refuted: P1 means
ingress already lands at the home, so a delivery bus is speculative plumbing
today.

**R9 — A member-to-member forwarding fabric.** A second delivery path creates
merge, dedup, and ordering semantics between two buses.

**R10 — Prisma as the daemon store interface.** Static provider selection
breaks one-SQL-two-drivers, and its codegen/engine weight has no place in an
edge binary self-hosters install via npm. Prisma remains correct for the CP.

**R11 — StatefulSet pools.** No surge: replacement in place reduces capacity
exactly when duties need somewhere to go. Stable identity is the ledger's
job, not the pod name's.

**R12 — Schema-per-org / database-per-org.** Multiplies catalog objects by
org count, needs a per-schema migration runner, and is the irreversible order
(schema-shaped SQL has no org column to fall back on). Banked as a future
split with the org column as its pre-paid exit.

**R13 — Platform-native duty arbitration** (let two members fight over the
platform API). Telegram 409 offset-stealing loses messages; Discord duplicate
gateway sessions double-deliver; Slack Socket Mode load-balances events across
sockets, producing split-brain per event. Every platform's semantics are
different and all are wrong.

**R14 — A per-org room model** (a room per org containing its agents).
Nothing in the system is org-granular at runtime — duties are per-bot or
per-agent, sessions per-agent, sandboxes per-agent. An org room would recreate
a mini per-org daemon inside each member: the shape this design dissolves.

**R15 — Member-created per-org envelopes** (keep per-org namespaces but have
members create them lazily). Buys the operator's deletion by granting every
member cluster-wide namespace/RBAC/quota creation rights — the privilege moves
somewhere worse than the small, credential-free controller it replaced.
Removing the per-org objects entirely (D17) retires the same reconciler while
shrinking every actor's permissions.

## 16. Glossary

| Term                       | Meaning                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pool**                   | The shared daemon fleet: a fixed-size Deployment of multi-tenant members                                                                           |
| **Member**                 | One pool process; fungible; holds duties it has claimed                                                                                            |
| **Room**                   | Per-agent runtime state inside a member: sandbox connection, ACP sessions, turn queues, streaming state                                            |
| **Org context**            | Thin refcounted per-org context: config snapshot, org-scoped store handle                                                                          |
| **Duty**                   | An exactly-one responsibility recorded as a claimable ledger row: a daemon-held bot connection or an agent home                                    |
| **Duty group**             | The claim unit: a connected component of the agent↔daemon-held-bot graph (enabled crons are edges)                                                 |
| **Ledger**                 | The CP-hosted `duty_group` table; the single source of who-holds-what                                                                              |
| **Term**                   | CP-minted monotonic fencing token per grant; carried on the shim handshake and the ledger's claims, never on a data-plane write; highest term wins |
| **T_fence**                | Renewal-failure window after which a holder self-fences, anchored on a CP-confirmed renewal (#976)                                                 |
| **Member set**             | The set of daemons within which an agent's duty may be claimed; the pool is the org-less one, one per install                                      |
| **T_reassign** (> T_fence) | Silence window after which the CP treats a duty as vacant and grantable                                                                            |
| **Recovery grace**         | The CP's startup wait of one full T_reassign before granting vacancies, making CP restarts non-events                                              |
| **Vacancy grant**          | The single claim call, carried on the heartbeat: "grant me up to K vacant duties"                                                                  |
| **Rendezvous**             | Activation of an unheld group: any member receives the trigger, claims on receipt, and a loser NAKs with the winner                                |
| **Sleep-as-migration**     | Drain strategy: a sleeping agent moves by not moving — it wakes wherever its duty is next claimed                                                  |
| **Dial-in binding**        | The duty holder dials the sandbox's shim listener, TokenReviews its projected SA token, and binds at its term                                      |

## 17. Implementation map

| Piece                                                                  | Where                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frames + member cap                                                    | `packages/protocol/src/frames/duty.ts`, `relay-daemon.ts` (`RD_ACK_NOT_HOLDER`)                                                                    |
| Schema + repo (CAS claim, renew, release, reconcile, agent-home claim) | `packages/control-plane/prisma/schema.prisma`, `src/persistence/repositories/duty-group.repo.ts`                                                   |
| Pure group math + reconcile planner                                    | `packages/control-plane/src/orchestrator/dutyGroup.ts`                                                                                             |
| Lease exchange (digest diff, chunking, lanes, grace)                   | `packages/control-plane/src/orchestrator/dutyLease.ts`                                                                                             |
| Recompute sweep + mutation kicks + placement fence                     | `packages/control-plane/src/orchestrator/dutyRecompute.ts`                                                                                         |
| WS handlers                                                            | `packages/control-plane/src/ws/handlers/{heartbeat,duty-release,duty-claim,duty-fetch}.ts`                                                         |
| Member sets + placement/eligibility resolver                           | `packages/control-plane/src/domain/placement.ts`, `src/persistence/repositories/member-set.repo.ts`                                                |
| Frame-org fence on the daemon WS surface                               | `packages/control-plane/src/ws/handlers/frame-org.ts` (`frameOrgId`), the `*Unscoped` lint fence over `src/ws/**`                                  |
| Daemon registry + gate + rendezvous claim                              | `packages/daemon/src/cp/duty-registry.ts`, `src/daemon.ts` (`transportAgents`, `claimDutyForTrigger`)                                              |
| Relay re-route                                                         | `packages/relay/src/relay-ingress-manager.ts` (`sendWithRendezvous`), `relay-browser-connection.ts`                                                |
| Shim dial-in                                                           | `packages/daemon/src/shim/{dialer,server}.ts`                                                                                                      |
| Pod-bound member identity                                              | `packages/control-plane/src/cluster/daemon-identity.ts`                                                                                            |
| Member readiness (probe sinks)                                         | `packages/daemon/src/readiness.ts`, `src/daemon.ts` (`readinessState`)                                                                             |
| Rollout generation barrier                                             | `packages/protocol/src/frames/register.ts` (`generation`), `control-plane/src/persistence/repositories/duty-group.repo.ts` (`newerGenerationLive`) |
| Shared-store ownership (owner ids, outbox claims, holder gates)        | `packages/daemon/src/store/local-store.ts`, `src/store/postgres-sync-database.ts`, `src/daemon.ts` (`servesAgent`, `settleDutyChange`)             |
| Orphan reconciler + `reconcile --once` job + existence read            | `packages/daemon/src/k8s/orphan-reconciler.ts`, `packages/daemon/src/cli/reconcile.ts`, `packages/control-plane/src/ws/handlers/agent-exists.ts`   |
