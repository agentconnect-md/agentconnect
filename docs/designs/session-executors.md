# Session executors: spreading one agent's sessions across a daemon group

**Status:** Design, decided 2026-09-16. Not implemented. Motivated by
[#2111](https://github.com/agentconnect-md/agentconnect/issues/2111): a self-hosted
team with a handful of Linux machines and no Kubernetes wants an agent's
concurrent sessions to use the spare compute of the other machines in its daemon
group, while the agent stays one identity on one holder.

This document generalizes what the managed pool already does with session pods
([k8s-daemon-pool.md](k8s-daemon-pool.md) §4, [git-workspace-model.md](git-workspace-model.md)
§11) to machines that are not a cluster. Almost everything here is "reuse X". The
two genuinely new things are a second facet on every daemon (§3) and a listener
for session traffic on every daemon whose executor facet is on (§6); the rest is the
pool's shape with the Kubernetes-specific parts removed.

## 0. Decision summary

| #   | Decision                | Outcome                                                                                                                                                                                                                |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Unit of ownership       | Unchanged: the whole agent, held by one daemon through the duty ledger. No session-level duty.                                                                                                                         |
| D2  | Where a session runs    | On the **executor facet** of any daemon in the agent's group, chosen by the holder. Only `session`-isolated sessions spread; `shared` sessions stay with the primary checkout.                                         |
| D3  | What the user sees      | One concept: the daemon. Every daemon has a holder facet and an executor facet; each can be switched off. No separate executor component or install.                                                                   |
| D4  | The contract            | The shim protocol, exactly as the pool uses it against a session pod. ACP, exec, fs, skills and the credential and MCP tunnels all ride it. The backend behind the shim is private.                                    |
| D5  | Direction               | The executor facet listens; the holder dials. Same rule as the pool: the shim never dials.                                                                                                                             |
| D6  | Control plane role      | Orchestration only: capability facts and the executor endpoint in the heartbeat, a dial rendezvous checked against the ledger, the session's executor id, upgrades. Never on the data path. Placement is the holder's. |
| D7  | Execution strategies    | `host` (Linux) and `microsandbox` in v1; `srt`, `docker` and non-Linux `host` later. Named after `sandbox.backend`. Capabilities are an effective strategy table; placement is a match against it.                     |
| D8  | State location          | Clones and HOME live in an executor-local directory mounted into the environment, the local confined layout; a replaced VM keeps them. No mounts across machines, no shared filesystem.                                |
| D9  | Credentials             | Each machine carries its own runtime sign-in or API-key configuration; the executor facet seeds from its own host HOME. Provider credentials and agent secrets travel from the holder over the authenticated link.     |
| D10 | Upgrades                | The facet upgrades with the daemon through the existing CLI store and the CP-tracked `daemon/upgrade`, with one new `draining` phase. Environments survive as disks and directories; running processes do not.         |
| D11 | Local convergence       | Later, behind a flag: the holder's own machine becomes a loopback executor, and the direct local path retires. Not in this project.                                                                                    |
| D12 | Network assumption (v1) | Group members share a LAN. No NAT traversal, no relay, TLS optional. This buys little structurally and is stated as scope, not as a simplifier.                                                                        |

## 1. Problem

A daemon group ([daemon-groups.md](daemon-groups.md)) makes a set of machines
interchangeable **holders**: when one dies, another claims its agents. It says
nothing about where an agent's sessions execute, because a self-hosted daemon
executes them itself. So today an agent with three concurrent sessions — a coding
task, an issue, a review — runs all three on its holder while the other members of
the group sit idle:

```text
daemon-a: holder of agent X — coding task, issue, review   (busy)
daemon-b: member, idle
daemon-c: member, idle
```

The pool does not have this problem. A pool member is a thin holder; every isolated
session gets a pod of its own, scheduled wherever the cluster has room, and the
member dials each pod's shim. Compute spreads by construction while the agent stays
one identity. The request in #2111 is for the same property without Kubernetes.

## 2. What does not change

Stated so nobody rebuilds it:

- **Ownership.** The duty group is still the whole agent. The ledger, the self-fence,
  install-on-grant, holder-following delivery and the activation rendezvous are
  untouched. `mayAct`, `servingDaemon` and every other authorization read still asks
  the holder. There is no session-level duty and no second holder.
- **The holder's job.** Platform connections, routing, cron, identity and the turn
  loop stay on the holder. A remote session's turn is driven from the holder exactly
  as a pod session's is.
- **The hot-path invariant.** The Control Plane never carries message bodies, ACP
  `session/update` streams or attachment bytes. The ACP stream and the shim WebSocket
  between holder and executor do not pass through it.
- **Isolation tiers.** `shared` sessions keep running in the primary checkout on the
  holder. Only `session`-isolated sessions can be placed elsewhere, and a session
  placed elsewhere is always the clone tier ([git-workspace-model.md](git-workspace-model.md)
  §11), because the primary checkout is not on that machine.
- **The execution trust model** ([architecture.md](architecture.md) §9.1). Running
  without a sandbox is an operator choice, not a defect. A remote session without a
  sandbox is trusted exactly as a local one is.

## 3. One daemon, two facets

The user-facing model has one concept: the daemon. Internally every daemon carries
two facets, declared at registration:

- The **holder facet** is today's daemon: it claims duties, owns platform
  connections, runs schedules, drives turns.
- The **executor facet** hosts session execution for holders in its group. It
  exposes the shim contract and nothing else. It holds no duty, owns no agent and
  cannot become a holder — it does carry the session-to-holder metadata it needs,
  the labels of §7 — and it is the self-hosted counterpart of a session pod.

The two facets are a seam inside one process, not two processes. Two configuration
keys switch them (§10): `role: "executor"` — `--role executor` on the command line
is the same key — switches the holder facet off, for a machine that only
contributes compute; `sandbox.share: false` switches the executor facet off, for a
laptop that should hold agents but never run other machines' sessions. Both off is
refused at startup. Neither switch introduces a second binary, service unit or
install path.

This also settles what a group is. A group used to be one half of the pool's shape —
a set of interchangeable holders — with the other half missing because the holder
executed locally. With the executor facet the group is the whole shape: **a set of
control units plus the compute they share**, symmetric with the pool's org-less
member set plus its sandbox namespace.

Three shapes were considered and are recorded in §15: a bare executor driven over
SSH, a full peer daemon that hosts another member's session, and a standalone
executor component. The facet is the third shape's structure in the second shape's
packaging: the role boundary of a separate component, with nothing new for the
operator to learn or install.

## 4. The contract is the shim protocol

Between holder and executor there is one sentence: _give session S a shim endpoint._

The holder side is a third `SpawnDriver` ([cluster-spawn-and-shim.md](cluster-spawn-and-shim.md)
§1) beside the local driver and `K8sDriver`. It dials a shim and, above that, is
indistinguishable from the pool path: ACP is spawned through the shim, Git and
workspace reads cross the shim's exec and fs channels, skills are published through
it, and the credential and MCP tunnels ride the same channel in the direction §6 of
that document already fixes. The common "dial a shim, bind at a term, run a runtime
through it" layer is extracted from `K8sDriver` when the second remote implementer
arrives, per the repository's rule of extracting on the second implementer rather
than guessing an interface from one.

Two things the local microsandbox path does differently today move onto the shim,
and both are in PR 2's scope (§12):

- **ACP.** Locally, ACP is spawned through agentd's exec channel and the shim serves
  only filesystem and skills. A remote session spawns ACP **through the shim**, as a
  pod does.
- **The tunnels.** Locally, the VM's `gitcred` and `mcp` endpoints are AF_VSOCK bridges
  (`microsandbox/socket-bridge.ts`) that the driver wires to the local daemon's host
  sockets, and the VM shim is granted `read` and `skills*` but never `tunnel`. On an
  executor those bridges would terminate at a daemon that owns no agent, so the
  `microsandbox` strategy serves both tunnels through the shim's `TunnelHost`,
  grants `tunnel`, and repoints the guest helper endpoints — the git-credential
  socket variable and the bridge's `mcpServers` spec — at the shim's paths, exactly
  as the pool image does. The local vsock wiring is not retained for remote
  sessions.

That is what keeps the contract backend-neutral: a holder never learns whether the
far side is a VM, a container or a bare process.

The executor side is the same shim the pool image carries and the microsandbox
backend already stages into a VM's `/run` at startup. The holder pushes its own shim
bundle to the executor at session preparation, so the shim a session runs is paired
with the daemon that drives it, by construction, regardless of the executor's
version or image.

### Evidence

The pinned microsandbox SDK has no self-hostable server: its two backends are
`local` and a hosted control plane in private beta, and the hosted one lacks host
mounts, disk volumes, published ports and force-kill. But the daemon's data path
never goes through that backend abstraction. `microsandbox/exec.ts`, `tcp.ts` and
the socket bridges talk to agentd through its relay unix socket via `AgentClient`,
and `AgentClient.connect(path)` accepts any path. A probe forwarded a VM's relay
socket from a Linux test host to a developer machine over SSH and drove it with the
unmodified SDK:

| Channel                                              | Result                          |
| ---------------------------------------------------- | ------------------------------- |
| exec with streamed stdin and stdout, 4 MiB output    | works                           |
| ten concurrent exec streams on one connection        | works                           |
| `core.tcp.connect` to a guest listener (the shim WS) | works                           |
| `core.fs.request`                                    | works                           |
| per-exec cost, on the host                           | 2–3 ms                          |
| per-exec cost, over a high-latency link              | one RTT shared, two RTTs fresh  |
| throughput                                           | bounded by the link, not agentd |

Two things fall out. Lifecycle — create, start, stop, destroy, image pull — is a
local-backend call and must run on the executor, which is what the executor facet
is for. And the daemon opens a fresh `AgentClient` per exec today; a remote executor
keeps one connection per sandbox, or every operation pays an extra round trip.

## 5. Execution strategies and capabilities

The executor facet implements the contract with a **strategy**, named after the
values `sandbox.backend` already uses:

| Strategy         | Boundary                     | Needs                                                         | Status                                                                                 |
| ---------------- | ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `host`           | none                         | a Linux machine that runs Node                                | v1                                                                                     |
| `microsandbox`   | VM                           | Linux, KVM, msb + libkrunfw, the runtime image                | v1                                                                                     |
| `srt`            | process (bubblewrap)         | Linux, bwrap, socat, rg on PATH, unprivileged user namespaces | follow-up: the wrapping moves from the daemon's launch path into the shim's spawn path |
| `docker`         | container, optionally gVisor | docker or podman, the runtime image (already OCI)             | later                                                                                  |
| `host` off Linux | none                         | macOS or Windows                                              | later: a non-Linux read path and path relocation (below)                               |

**`host` is a legitimate strategy.** §9.1 of the architecture already says an
unsandboxed agent is operator-trusted code; spreading such sessions across the
operator's own machines changes nothing about that trust. And the shim is an
ordinary Node process, so "shim as a host process" is not a new mode, only a new
place to start it.

**`host` is Linux-only in v1**, for two reasons the shim carries. Its console read
path is fd-bound (`shim/safe-descent.ts` refuses with `ENOTSUP` off Linux, as
cluster-spawn-and-shim.md §5 documents), so a macOS or Windows executor would accept
sessions and then fail every console file view for them. And its helper locations
are image-fixed (`shim/sandbox-paths.ts`: the git-credential helper and bridge
entries under `/opt/agentconnect`, the Git config and skill-staging directories
under `/run/agentconnect`), which Windows cannot bind as AF_UNIX paths at all. A
non-Linux `host` needs a read fallback and a relocation of those paths under the
daemon's own root; both are deferred.

The shim also assumes one thing about its surroundings that `host` must supply
explicitly: that it owns its filesystem namespace. Its tunnel endpoints are the
fixed in-sandbox paths `/run/agentconnect/{gitcred,mcp}.sock`, and `TunnelHost`
removes a stale socket before binding, because inside a pod or a VM the only
previous owner of that path is an earlier incarnation of the same shim. Two `host`
sessions on one machine would replace each other's endpoints — a request could
reach the wrong holder, and one session's shutdown would unlink another's socket.
So the `host` strategy runs each session's shim with **per-session tunnel paths**
under the session's private runtime directory, through the `socketPathFor` seam
`TunnelHost` already exposes, and points the helper configuration at those paths:
the git-credential socket variable and the `mcpServers` spec the shim reports are
per session too. The wire contract is unchanged; only the paths move. The AF_UNIX
path-length budget applies here as it does to the session's `TMPDIR`, so the
directory is kept short rather than nested under the session's HOME.

**Configured is what a machine offers; reported is what is effective.** A strategy
whose probe fails at startup is reported unavailable with its reason, the way the
daemon already reports `sandboxUnavailable`; placement reads only the effective
table. The console keeps showing the reason exactly as it does for a daemon whose
sandbox is down.

**Placement is a match.** An agent asks for a strategy; the holder places the session
on an executor whose effective table offers it. In v1 the ask is the existing
`runInSandbox` boolean: `true` means any sandboxing strategy, `false` means `host`.
The intended end state replaces the boolean with an enum naming a strategy, which is
a backward-compatible widening; the executor's capability report uses the strategy
table from the first version so that later change touches no wire field.

**The configuration to grow into**, not part of this project:

```json
"sandbox": {
  "host": true,
  "srt": true,
  "microsandbox": { "image": "…", "cpus": 2, "memoryMiB": 4096 }
}
```

Each value is `false | true | {…}`; strategies with parameters take an object.
Defaults are `host: true`, `srt: true`, `microsandbox: false`, which is today's
behavior for an unconfigured machine. When this lands, the single-valued
`sandbox.backend` and `security.requireSandbox` retire together: `backend: srt` maps
to the default table, `backend: microsandbox` enables that entry, and
`requireSandbox: true` is `host: false` — a machine that offers no `host` strategy
refuses unsandboxed sessions, and a machine whose table has no effective entry at
all refuses to start, which preserves today's fail-closed behavior. An explicit
`sandbox.backend: none` was considered and rejected (§15).

## 6. Control plane and data plane

**What the Control Plane does.** Facts flow down and claims flow up, as the pool
design put it, and this design adds no exception:

- The heartbeat carries each member's effective strategy table, its **executor
  endpoint** (address and port — today's `Heartbeat` has none, because no daemon
  listens), its capacity, and a `hostedSessions` count. That count is a new field
  beside the existing `activeSessions`: the first counts environments this executor
  facet hosts for any holder, the second is the holder facet's own pending count
  and must not silently acquire that meaning. Holders read all of it; nobody
  configures executor lists by hand.
- The CP brokers a **dial rendezvous** (below) and checks the duty ledger before
  doing so.
- The session row records `executorDaemonId`, in the shared data-plane store, so a
  successor holder can find a session's environment after failover.
- Upgrades, restarts and progress reporting reuse `daemon/upgrade` and
  `daemon/lifecycle/progress` (§9).

**What the Control Plane does not do.** It does not choose the executor: the holder
does, from the facts it has, because placement authority on the CP was rejected in
the pool design and nothing here reopens it. And it does not carry the data path:
the ACP stream and the shim WebSocket are a direct connection from holder to
executor. Routing that stream through the CP's WebSocket would put the CP on the
hot path, make a CP outage end every running remote session, and show the CP the
`session/update` stream it must never see.

**Authenticating the dial.** The pool binds a shim connection with the pod's own
rotating Kubernetes credential and a TokenReview, and there is deliberately no
CP-signed shim grant or key set ([k8s-daemon-pool.md](k8s-daemon-pool.md) §7). A
self-hosted executor has no such identity source, so the identity authority for the
dial is the one both ends already authenticate to: the CP, through a rendezvous
rather than a signed token.

1. The holder asks the CP for a dial to executor E for session S of agent A.
2. The CP checks the ledger — the requester holds A's duty, E is a member of A's set
   with its executor facet on — and refuses otherwise.
3. The CP issues an **admission grant**: it sends E, over E's own control
   connection, an _expected dial_ — holder id, session id, a one-time shared
   secret, an expiry — and returns the same secret to the holder. The grant is
   bound to that session and that pair of daemons and is consumed by one dial.
4. The holder dials E's endpoint. Both sides prove possession of the secret by
   answering the other's challenge with a keyed hash over it, so the secret never
   crosses the link in the clear (the link may be plaintext in v1) and the proof is
   mutual: E admits only a dial it was told to expect, once, before expiry, and the
   holder learns that the endpoint it reached is the executor the CP intended. The
   preparation request (§7) is the first message after admission.
5. Once admitted, the holder mints the session's binding credential locally, exactly
   as `ShimBindingRegistry` does today — step 6 of cluster-spawn-and-shim.md §3 is
   unchanged; steps 1–5 of that proof are what the admission grant replaces. The
   grant and the binding credential are two things: the first opens the port and
   is the CP's, the second scopes a session and is the holder's.

There is one issuer of anything that opens the port — the CP, through step 3 — and
nothing signed to distribute. A successor holder after failover runs the same steps
and needs a fresh grant; step 2 is what makes it authorized, since the ledger now
names it. A re-dial therefore costs one CP round trip plus one dial, and the
executor never has to judge duty itself.

**Direction.** The executor facet listens; the holder dials. This is the pool's rule
— the shim listens, the daemon dials the ready pod — applied to a machine instead of
a pod. It is a new listener for session traffic, not a daemon's first: the readiness
HTTP server (`readiness.ts`, bound on `AC_READINESS_PORT`) is prior art for binding
and lifecycle, though its health-only endpoint sets no authentication rule, and the
shim listener the daemon owned before the direction was reversed
(cluster-spawn-and-shim.md §2) is prior art for the hardening. The port is off
unless the executor facet is on (§10), and gated by the admission of the
rendezvous. In v1, with
the LAN assumption, it may be plain WebSocket; TLS is a v1.5 item. The reverse
direction (executor dials the holder) would make the holder listen instead and was
not chosen; it buys NAT traversal, which v1 does not need.

**Placement policy, and which control wins.** Three things decide whether and where
a session spreads, in this order:

1. The group's switch (§10) **enables** spreading. Off means no session of any agent
   in the group spreads, whatever the daemons say.
2. The birth predicate (§7) decides **eligibility**: the session is
   `session`-isolated, the agent's memory home allows it, and some member's
   effective table matches the agent's ask.
3. The holder's own `placement` policy **selects** among the eligible executors for
   sessions it creates: `spread` picks the member with the fewest hosted sessions;
   `local-first` keeps sessions on the holder while it has room.

The counts in the heartbeat are **advisory**. They are stale by up to one heartbeat
interval plus fan-out, which is long enough for a burst of sessions — a webhook
storm — to land on one executor, and a live count returned after the fact would
not stop several holders admitting work at once. Admission is therefore the
executor's, and atomic: at preparation it reserves capacity against its own limit,
counting preparations still in flight, releases the reservation if preparation
fails, and answers `full` when it cannot reserve. The holder keeps a provisional
count for what it has placed since the last heartbeat and, on `full`, moves to the
next candidate instead of queueing behind the serialized starts of §7.

**What the LAN assumption buys**, so nobody over-credits it: no NAT traversal and no
relay (already out of scope), optional TLS, and enough latency headroom that the
per-exec connection cost of §4 is not urgent. It does not replace authentication —
sandboxed agents share the LAN, and only microsandbox denies private networks by
default — and it does not enable discovery, which the heartbeat already provides.
Two things it seems to enable are rejected in §15: a shared filesystem, and dialing
a guest's published shim port directly.

## 7. Session lifecycle

**Birth.** The holder decides, at session creation, that this session spreads (§6's
order of controls). It completes the rendezvous, dials, and sends the executor a
preparation request — strategy, image tag, resource spec, the shim bundle, the
workspace to clone, the HOME to seed — and receives a shim endpoint and the
executor's live count. The executor creates the environment with its own driver
(the existing microsandbox manager, or a plain process for `host`), stages the
shim, and performs the per-session blobless clone and HOME preparation of §11 of
the workspace model. The session row records the executor.

**Where the state lives.** The environment's durable state — clone, secondary roots,
HOME — is an executor-local directory, `<executorRoot>/sessions/<leaf>/{workspace,repos,home}`,
the layout the local confined tier already uses, mounted into the environment.
This is what makes it survive the backend's own lifecycle: the microsandbox
driver's `replace()` retires and destroys a VM whenever its spec or image identity
changes, with no dirty check, and its disks are disposable across replacement by
the backend's stated rule. A session's work must therefore not live on those
disks. Session storage therefore has the session row's lifetime and a VM has the
backend's; the two are decoupled on purpose, so replacement never touches the mount
and only the holder's retirement judgement (below) removes it. The mount is local
to the executor; "no mounts across machines" (D8) is about the holder never
mounting anything of the executor's, and stands.

**Execution.** The holder's driver dials the shim and binds at the session's term.
Everything above the shim is the pool path. Console reads of the session's paths
are routed to the executor, as they are routed to a session pod today; reads of the
agent's primary checkout stay with the holder, where that checkout is.

**Agent-scoped state.** A session pod on the pool binds and holds the agent's
companion pod for three agent-scoped things; a remote session has no companion, so
each needs a named source:

- _Managed memory._ Locally the runtime's memory root is a mount of the holder's
  scope directory, which cannot cross machines. A spread session therefore requires
  the agent's memory home to be the Control Plane (`memory.home: control-plane`),
  the rule the pool already mandates, read and written by the holder over its
  control connection; the birth predicate refuses to spread an agent whose memory is
  daemon-homed. Runtime-native state stays in the per-session HOME on the executor,
  as it does for every confined session.
- _Merge-when-ready._ On a self-hosted daemon the watcher runs in the holder process
  for local sessions; it does the same for a spread session, holding nothing on the
  executor.
- _The primary checkout._ Stays on the holder; it is not part of a clone-tier
  session's environment.

**Stickiness.** A session runs where it was born for its whole life. There is no
turn-level migration.

**Idle, retention, retirement.** The judge is the holder, as it is on the pool: the
holder's workspace manager drives suspension, the dirty and unique-commit rules and
directory removal over the shim, because those rules need the agent's remote,
default branch and retention policy, which the executor does not know.

**When there is no holder.** An executor cannot judge, and an agent may lose its
holder for a long time or be removed outright. So the executor keeps an inventory
of its environments labelled by agent id and session leaf — the pool's claim labels
— and reconciles it on a schedule against the same two authorities the pool's
reconciler uses (`cli/reconcile.ts`): the **shared data-plane store** for session
existence, read directly through `sessionKeysForAgent`, and the **CP** for agent
existence, over its control connection. The CP is deliberately not asked about
sessions: its `SessionMeta` row is created asynchronously from daemon reports and
is kept after the data-plane session is purged, so a missing CP row can describe a
retained session and a present one an already-purged session. The executor
discards an environment whose agent the CP no longer knows, or whose session key
the store no longer lists, under the pool's orphan-reconciliation rules (a grace
period, and a same-name replacement check so a session recreated after the query
is never the one deleted) — and **retains** everything when either lookup cannot
answer. Agent removal and session retirement delete the store's rows; the next
reconcile removes the environments. Nothing is kept forever for lack of a judge.

The store is authoritative the other way too. An environment whose session the
store still lists is kept however long its agent goes without a holder: retaining a
live agent's work is intentional, and unassignment is not an orphan signal. The
executor discards only what the authorities no longer know **and** no admitted
holder connection is using, and it never judges dirtiness — the deletion, produced
by the holder's retirement or by agent removal, is the only evidence it acts on.
That gives deletion an owner that survives the holder without giving the executor
a duty.

**Holder failover.** The successor member claims the agent through the ledger as
today, reads the session's executor from its row, completes a rendezvous, and
re-dials. The environment is still there — nothing on the executor depended on
which holder was driving it — so failover costs a rendezvous and a dial, not a
re-preparation.

**Executor loss.** The environment and any uncommitted work in it are gone, as they
are when a pinned daemon dies. The holder marks the session's executor unreachable
after a bounded grace, and the next turn re-prepares the session elsewhere with a
visible notice that the previous environment was lost. This state machine is new;
nothing today records a session whose environment is unreachable but whose row is
live.

**Concurrency on one executor.** The executor facet is the only writer of its own
sandbox state, so several holders placing sessions on one machine at once are
serialized by it. This matters for microsandbox specifically: concurrent starts from
independent processes can leak disk-lock descriptors across supervisors, which a
single starting process avoids.

## 8. Credentials and secrets

**Two prerequisites per machine, not one.** Daemon onboarding — `agentconnect login`,
which every member already has — connects the daemon to the Control Plane and
populates no runtime authentication. Runtime credentials are the second, separate
prerequisite, and they are required on the **executor**, where the runtime runs: the
host HOME an executor seeds a session from is populated by the runtime's own sign-in
(`claude` or `codex` login under the daemon's OS account) or by configured API-key
or provider credentials; interactive sign-in is not universally required. A holder
that only delegates a session needs none of that for it. Nothing copies a sign-in
across machines, so the compliance shape — the operator's own subscription, on the
operator's own machine, no platform-held tokens — is unchanged. The executor facet
reports which runtimes it can authenticate, the way the daemon already reports
"Login required" per runtime, and a holder does not place a session whose runtime
the executor cannot authenticate.

**Provider credentials and agent secrets are two mechanisms**, and both cross the
link:

- _Recognized provider credentials_ — what `CREDENTIAL_PREPARERS` handles per
  runtime, for known provider endpoints — are seeded as files into the session HOME,
  and on a microsandbox executor are additionally protected by hostname-scoped
  placeholder substitution on that executor's host, exactly as locally. The
  distinction is the credential's handling, not where it was configured: a
  recognized provider credential supplied as an agent secret still takes this path.
- _Everything else_ configured as an agent secret (`runtimeOverrides.secrets`)
  enters the runtime's environment as a plain value on every backend today, with
  output masking as its only protection, and does so on an executor the same way.
  A `host` executor exposes such values to the process tree; a microsandbox
  executor exposes them to the VM. Neither is a change from the local exposure.

## 9. Upgrades

The executor facet is part of the daemon, so it upgrades the way a daemon does: the
stable `agentconnect` CLI, the versioned store, `prepare-upgrade.js` staging the
microsandbox SDK and image artifacts before the switch, the process-level health
check and rollback ([cli-daemon-split.md](cli-daemon-split.md) §3), and the
CP-tracked `daemon/upgrade` with `daemon/lifecycle/progress` for the console.

One phase is added. The sequence becomes `preparing` → **`draining`** →
`restarting` → READY at the target version. Draining stops accepting new sessions
and waits, with a cap, for the turns in flight on that executor to finish; the
console shows the remaining count.

What a restart costs is stated honestly, because neither v1 strategy keeps a
running process across it. The microsandbox backend's rule is that a daemon restart
stops recorded owned VMs and retains their disks; it does not adopt running guests,
so the guest, its ACP process and its socket bridge end. A `host` session's process
tree is a child of the daemon and ends with it; ACP over stdio ends regardless.
Environments therefore survive **as disks and directories** (§7), and a session
resumes from them on its next turn — a VM is started from its retained disk, a
`host` environment is re-entered — while any turn still running at the instant of
restart is lost, which is what a daemon restart already costs. Adopting live VMs or
detached shims across a restart would change the backend's fencing rule and is not
in scope. Holders that lose the shim connection re-dial and take a new binding
generation.

Version-sensitive pieces are pushed from the holder rather than installed on the
executor: the shim bundle comes with each preparation request, and the image tag is
chosen per session. The executor's own contract is negotiated in the dial
handshake: each side advertises the versions it speaks — its own and the previous
one — and the connection uses the highest both share, so a holder at N+1 still
talks to an executor at N and members can roll in either order. A pair with no
common version refuses the dial, and the holder moves on.

## 10. Configuration and console

Daemon configuration grows three keys, all daemon-owned: `role` at the top level,
and `share` and `placement` inside `sandbox`:

```json
"role": "daemon",
"sandbox": {
  "backend": "microsandbox",
  "share": true,
  "placement": "spread"
}
```

`role` is `daemon` (both facets, the default) or `executor` (holder facet off);
`--role executor` on the command line is the same key. `share` is the executor
facet switch and **defaults to off**: the listener opens only when `share` is true
and the effective strategy table is non-empty — never merely because
`sandbox.backend` has a value, since it always does (`srt` by default). A machine
whose table is empty and whose `share` is true starts with the facet dark and says
why. `role: executor` with `share: false` is refused at startup. `placement` is
`spread` or `local-first`. Executor addresses and dial credentials are not
configured anywhere: the heartbeat publishes the endpoint, the CP brokers the dial.

The console adds no new kind of row. On the Infra page each daemon shows the
sessions it hosts and its capacity beside the strategies it offers. A group has one
switch, "spread sessions across the group", default off. A session's detail shows
which daemon executes it. The existing "Run in sandbox" state and its unavailable
reason keep their meaning per strategy.

## 11. Converging the local path

With `host` a real strategy, the holder's own machine is just another executor
reachable over loopback. That makes full convergence possible: the direct local
spawn path, the microsandbox host-mount layout and the worktree tier can retire, and
the "which tier was this session born in" logic of the workspace model disappears
because every executed session is a clone in an environment the shim owns.

This is not part of this project. The order is: land the driver against remote
executors; add a switch that routes local sessions through a loopback executor;
run with it as the default for a while; then delete the direct path. One point to
keep honest when that happens: the simplest install (one laptop, no sandbox) gains a
shim process and a loopback WebSocket it did not have.

The end state of "a thinner daemon" is a pool member — a holder that executes
nothing itself — not a daemon folded into the Control Plane. Thin or not, the
daemon is the process that carries message bodies and ACP streams, and those never
enter the CP.

## 12. Rollout

Five to six pull requests, roughly three weeks of focused work plus a week of
validation on a real multi-machine deployment, which the requester of #2111 offered
to run.

| PR  | Scope                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Protocol and CP: facet declaration at registration; strategy table, executor endpoint and `hostedSessions` in the heartbeat; the dial rendezvous with its ledger check; `executorDaemonId` on the session row; the agent-existence answer the reconcile asks the CP for.                                                   |
| 2   | Executor facet: split "prepare an environment" from "spawn the runtime" in the microsandbox driver; ACP and both tunnels onto the shim with the `tunnel` grant; the listener and expected-dial check; `host` strategy (Linux) with per-session tunnel paths and helper configuration (§5); the orphan reconcile; draining. |
| 3   | Holder: the executor `SpawnDriver`, extracting the shared dial-and-bind layer from `K8sDriver`; placement with the optimistic count and the `full` reply; the memory-home gate in the birth predicate; the unreachable-executor state.                                                                                     |
| 4   | Console: group switch, per-daemon hosting and capacity, session's executor.                                                                                                                                                                                                                                                |
| 5   | Tests: a two-daemon, one-CP integration fixture covering holder failover, executor loss and executor restart; the loopback shim smoke test extended to `host`.                                                                                                                                                             |
| 6   | Documents beside the code: this design, the pointers in the group and backend designs, and the workspace model's tier rule gaining the executor arm.                                                                                                                                                                       |

Calibration: `K8sDriver` is about three thousand lines and took five weeks of
commits, including claim, sleep and orphan machinery this design does not need. The
shim, at twice that size, is reused unchanged.

## 13. Open questions

- **Width of the exec surface.** The shim exec handler admits a closed list of Git
  subcommands, and the same list (`workspace/git-command-policy.ts`) already gates
  the local microsandbox path, so the list is not a pool-only control and this is
  not a pool-versus-self-hosted split. The question is narrower: whether the `host`
  strategy on a trusted machine gets the same list. Proposed: yes, one list
  everywhere, widened where an operation needs it, so nothing loosens an existing
  local control.
- **Executor-loss semantics** (§7): the grace before a session is declared
  unreachable, and whether re-preparation is automatic on the next turn (proposed)
  or requires an operator.
- **TLS in v1** or plain WebSocket under the LAN assumption (proposed: plain, TLS in
  v1.5).
- **Default for the group switch** (proposed: off, explicit opt-in).

## 14. Non-goals

- Cross-organization executors. An executor serves the group it belongs to; the
  rendezvous of §6 is checked against one organization's ledger, and a machine
  serving two organizations would need that check to span both.
- Turn-level migration or live movement of a running session.
- Durable environment storage across executor loss. Uncommitted work on a lost
  machine is lost; there is no PVC equivalent and none is designed.
- Adopting running VMs or detached shims across an executor restart (§9).
- NAT traversal, relays, or an executor behind a firewall the holder cannot reach.
- Changing `sandbox.backend`, `security.requireSandbox` or `runInSandbox`. §5 records
  the intended successors; they are separate changes.

## 15. Rejected

- **A bare executor driven over SSH** — sshd plus msb on the machine, the holder
  running lifecycle through the CLI and forwarding the relay socket. It works (that is
  what the probe did), but it rewrites lifecycle, seeding and retention as remote
  CLI invocations, keeps trust in out-of-band SSH keys, and gives the CP nothing to
  show or upgrade.
- **A peer daemon hosting another member's session** as a full holder-shaped member.
  It reuses the most code but blurs the ledger's distinction between a member that
  holds and compute that executes: authorization reads would need a per-session
  answer, placement would move to the CP, and one process's drain would drain both
  its held agents and its hosted sessions. The facet keeps the packaging and drops
  the blur.
- **A standalone executor component** the operator installs beside the daemon. The
  right structure — a role that cannot hold — but a second concept, a second service
  unit and a second thing to keep in step. The facet is that structure inside the
  daemon.
- **Session-level duty.** It would cost the ledger's co-location edges, install-on-
  grant, holder-following delivery and every per-agent authorization read, and the
  socket-mode ingress would still land on one holder and forward.
- **CP-assigned placement.** Rejected in the pool design; nothing here reopens it.
- **A CP-signed dial token.** The pool removed its CP-signed shim grant outright;
  a signed token needs a key set to distribute and verify, and the rendezvous of §6
  gets the same guarantee from the two control connections that already exist.
- **Routing the data path through the CP's WebSocket.** Puts the CP on the hot path.
- **Symmetric daemon↔daemon links** where either side may hold the agent. The
  asymmetry (holder dials, executor listens) is what keeps one holder per agent.
- **A shared filesystem between members.** The daemon's local store is SQLite, Git
  on NFS is slow and lock-prone, microsandbox mounts are virtiofs, and it contradicts
  D8. Not worth the environment it would create.
- **Dialing a guest's published shim port directly** to skip the executor's proxy.
  Saves a small component and exposes every sandbox's shim on the LAN behind its
  binding token alone.
- **The earlier dynamic-placement draft** (relay-level per-session machine choice,
  an agent materialized on every machine, CP-fired cron). Its goals are met by set
  placement, the ledger and this design; its cron half was rejected in the pool
  design's §9.
- **`sandbox.backend: none`** as an explicit "this machine runs unconfined on
  purpose" value. It would let a Linux machine that merely forgot to install bwrap
  look intentional and lose today's warning. The strategy table of §5 expresses the
  intent without a new value: a machine that does not list `srt` does not offer it.

## 16. Relationship to other documents

- [daemon-groups.md](daemon-groups.md) defines the member set this design places
  into; §5's operational prerequisites (shared store, re-cloneable workspaces) apply
  unchanged.
- [k8s-daemon-pool.md](k8s-daemon-pool.md) §4 and [git-workspace-model.md](git-workspace-model.md)
  §11 define the session-pod shape and the clone tier this design reuses; the
  workspace model's "tier a session is born in" gains an executor arm that always
  answers "clone".
- [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) defines the seam, the shim,
  the dial direction and the tunnel direction, which apply verbatim, and the binding
  proof, whose identity steps §6 replaces with the rendezvous while keeping its
  locally minted session credential.
- [daemon-sandbox-backends.md](daemon-sandbox-backends.md) describes the backends a
  strategy wraps; the executor facet's `microsandbox` strategy is that backend with
  the session's state in an executor-local mount rather than on the VM's disks.
- [architecture.md](architecture.md) §9.1 is the trust model `host` relies on, and
  the hot-path goal of its §2 is the reason the data path never touches the CP.
