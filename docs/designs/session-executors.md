# Session executors: spreading one agent's sessions across a daemon group

**Status:** Design, decided 2026-09-16. Not implemented. Motivated by
[#2111](https://github.com/agentconnect-md/agentconnect/issues/2111): a self-hosted
team with a handful of Linux machines and no Kubernetes wants an agent's
concurrent sessions to use the spare compute of the other machines in its daemon
group, while the agent stays one identity on one holder.

This document generalizes what the managed pool already does with session pods
([k8s-daemon-pool.md](k8s-daemon-pool.md) §4, [git-workspace-model.md](git-workspace-model.md)
§11) to machines that are not a cluster. Almost everything here is "reuse X". The
two genuinely new things are a second facet on every daemon (§3) and the first
listener a daemon has ever opened (§6); the rest is the pool's shape with the
Kubernetes-specific parts removed.

## 0. Decision summary

| #   | Decision                | Outcome                                                                                                                                                                             |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Unit of ownership       | Unchanged: the whole agent, held by one daemon through the duty ledger. No session-level duty.                                                                                      |
| D2  | Where a session runs    | On the **executor facet** of any daemon in the agent's group, chosen by the holder. Only `session`-isolated sessions spread; `shared` sessions stay with the primary checkout.      |
| D3  | What the user sees      | One concept: the daemon. Every daemon has a holder facet and an executor facet; each can be switched off. No separate executor component or install.                                |
| D4  | The contract            | The shim protocol, exactly as the pool uses it against a session pod. ACP, exec, fs, skills and the credential and MCP tunnels all ride it. The backend behind the shim is private. |
| D5  | Direction               | The executor facet listens; the holder dials. Same rule as the pool: the shim never dials.                                                                                          |
| D6  | Control plane role      | Orchestration only: capability facts, a short-lived binding token, the session's executor id, upgrades. Never on the data path. Placement is the holder's decision.                 |
| D7  | Execution strategies    | `host`, `microsandbox` in v1; `srt` and `docker` later. Named after `sandbox.backend`. Capabilities are reported as an effective strategy table; placement is a match against it.   |
| D8  | State location          | Clones and HOME live on the executor's own disk in the pool's layout. No host mounts across machines, no shared filesystem.                                                         |
| D9  | Credentials             | Each machine signs in for itself; the executor facet seeds from its own host HOME. Agent secrets travel from the holder over the authenticated link.                                |
| D10 | Upgrades                | The facet upgrades with the daemon through the existing CLI store and the CP-tracked `daemon/upgrade`, with one new `draining` phase. Sandboxes survive the restart.                |
| D11 | Local convergence       | Later, behind a flag: the holder's own machine becomes a loopback executor, and the direct local path retires. Not in this project.                                                 |
| D12 | Network assumption (v1) | Group members share a LAN. No NAT traversal, no relay, TLS optional. This buys little structurally and is stated as scope, not as a simplifier.                                     |

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
  exposes the shim contract and nothing else. It holds no duty, knows no agent,
  and cannot become a holder; it is the self-hosted counterpart of a session pod.

The two facets are a seam inside one process, not two processes. `--role executor`
switches the holder facet off, for a machine that only contributes compute.
`sandbox.share: false` switches the executor facet off, for a laptop that should
hold agents but never run other machines' sessions. Neither switch introduces a
second binary, service unit or install path.

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

One consequence is deliberate: the local microsandbox path today spawns ACP through
agentd's exec channel and uses the shim only for filesystem and skills. A remote
session spawns ACP **through the shim**, as a pod does. That is what keeps the
contract backend-neutral; a holder never learns whether the far side is a VM, a
container or a bare process.

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

| Strategy       | Boundary                     | Needs                                                         | Status                                                                                 |
| -------------- | ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `host`         | none                         | a machine that runs Node, including macOS and Windows         | v1                                                                                     |
| `microsandbox` | VM                           | Linux, KVM, msb + libkrunfw, the runtime image                | v1                                                                                     |
| `srt`          | process (bubblewrap)         | Linux, bwrap, socat, rg on PATH, unprivileged user namespaces | follow-up: the wrapping moves from the daemon's launch path into the shim's spawn path |
| `docker`       | container, optionally gVisor | docker or podman, the runtime image (already OCI)             | later                                                                                  |

**`host` is a legitimate strategy.** §9.1 of the architecture already says an
unsandboxed agent is operator-trusted code; spreading such sessions across the
operator's own machines changes nothing about that trust. And the shim is an
ordinary Node process with no dependency on the boundary around it, so "shim as a
host process" is not a new mode, only a new place to start it. `host`
is what makes a Mac build machine or a Windows box a usable executor.

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

- The heartbeat carries each member's effective strategy table, capacity and current
  session count, beside the load it already reports. Holders read it; nobody
  configures executor lists by hand.
- The CP mints the short-lived token a holder presents when it dials an executor,
  bound to the session and the pair of daemons, in the shape of the pool's shim
  binding. Both ends are already-authenticated members of one organization.
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

**Direction.** The executor facet listens; the holder dials. This is the pool's rule
— the shim listens, the daemon dials the ready pod — applied to a machine instead of
a pod. It is also the first listener a daemon has ever opened toward the network;
every other connection a daemon has is outbound. The port is off by default, opened
only when the executor facet is on, and gated by the CP-minted token. In v1, with the
LAN assumption, it may be plain WebSocket; TLS is a v1.5 item. The reverse direction
(executor dials the holder) would make the holder listen instead and was not chosen;
it buys NAT traversal, which v1 does not need.

**Placement policy.** `spread` places on the member with the matching strategy and
the fewest sessions; `local-first` keeps sessions on the holder while it has room.
The count comes from the executor's own heartbeat, so several holders sharing one
executor see the same number without coordinating.

**What the LAN assumption buys**, so nobody over-credits it: no NAT traversal and no
relay (already out of scope), optional TLS, and enough latency headroom that the
per-exec connection cost of §4 is not urgent. It does not replace authentication —
sandboxed agents share the LAN, and only microsandbox denies private networks by
default — and it does not enable discovery, which the heartbeat already provides.
Two things it seems to enable are rejected in §15: a shared filesystem, and dialing
a guest's published shim port directly.

## 7. Session lifecycle

**Birth.** The holder decides, at session creation, that this session spreads: it is
`session`-isolated, the agent's strategy ask matches some member's effective table,
and the group's spreading switch is on. It sends the executor a preparation request
over the direct link — strategy, image tag, resource spec, the shim bundle, the
workspace to clone, the HOME to seed — and receives a shim endpoint plus a binding
token. The executor creates the environment with its own driver (the existing
microsandbox manager, or a plain process for `host`), stages the shim, and performs
the per-session blobless clone and HOME preparation of §11 of the workspace model
inside that environment. The session row records the executor.

**Execution.** The holder's driver dials the shim and binds at the session's term.
Everything above the shim is the pool path. Console workspace reads for that session
are routed by path to the executor, as they are routed to a session pod today.

**Stickiness.** A session runs where it was born for its whole life. There is no
turn-level migration.

**Idle, retention, retirement.** Suspension, the dirty and unique-commit rules and
directory removal run on the executor, judged in the clone, keyed by the session
row. A `microsandbox` environment suspends and keeps its disk; a `host` environment
is a directory and a process tree.

**Holder failover.** The successor member claims the agent through the ledger as
today, reads the session's executor from its row, and re-dials. The environment is
still there — nothing on the executor depended on which holder was driving it — so
failover costs one dial, not a re-preparation.

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

**Runtime sign-in stays per machine.** Every machine that hosts execution runs
`agentconnect login` for itself, and the executor facet seeds a session's private
HOME from that host HOME exactly as the daemon seeds a local sandboxed agent today.
Nothing copies a sign-in across machines, so the compliance shape — the operator's
own subscription, on the operator's own machine, no platform-held tokens — is
unchanged. A group member already needs this to be a holder; the executor facet adds
no requirement.

**Agent secrets** are materialized by the holder from the Control Plane and travel to
the executor over the authenticated link, where they enter the environment as they
enter a local one. A microsandbox executor performs hostname-scoped placeholder
substitution on its own host, so the real values are held there for the session's
life. A `host` executor exposes them to the process tree, as a local unsandboxed run
does.

## 9. Upgrades

The executor facet is part of the daemon, so it upgrades the way a daemon does: the
stable `agentconnect` CLI, the versioned store, `prepare-upgrade.js` staging the
microsandbox SDK and image artifacts before the switch, the process-level health
check and rollback ([cli-daemon-split.md](cli-daemon-split.md) §3), and the
CP-tracked `daemon/upgrade` with `daemon/lifecycle/progress` for the console.

One phase is added. The sequence becomes `preparing` → **`draining`** →
`restarting` → READY at the target version. Draining stops accepting new sessions
and waits, with a cap, for open exec streams to close; the console shows the
remaining count. Sandboxes are not touched: a microsandbox VM is held by a detached
supervisor that outlives the daemon process, and a `host` session's process tree is
re-attached after restart. What a restart costs is the turns in flight at that
instant, which is what a daemon restart already costs. Holders that lose the shim
connection re-dial and take a new binding generation.

Version-sensitive pieces are pushed from the holder rather than installed on the
executor: the shim bundle comes with each preparation request, and the image tag is
chosen per session. The executor's own contract is versioned in the dial handshake;
version N serves holders at N and N−1, and a holder refuses an executor below its
minimum, so members and executors can roll in either order.

## 10. Configuration and console

Daemon configuration grows two keys beside `sandbox`, both daemon-owned:

```json
"sandbox": {
  "backend": "microsandbox",
  "share": true,
  "placement": "spread"
}
```

`share` is the executor facet switch, default on when a sandbox backend is
configured. `placement` is `spread` or `local-first`. Executor addresses and tokens
are not configured anywhere: the heartbeat publishes addresses, the CP mints tokens.

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
run with it as the default for a while; then delete the direct path. Two points to
keep honest when that happens: the simplest install (one laptop, no sandbox) gains a
shim process and a loopback WebSocket it did not have, and the pool's closed exec
inventory becomes a policy per strategy rather than a universal constraint (§14).

The end state of "a thinner daemon" is a pool member — a holder that executes
nothing itself — not a daemon folded into the Control Plane. Thin or not, the
daemon is the process that carries message bodies and ACP streams, and those never
enter the CP.

## 12. Rollout

Five to six pull requests, roughly three weeks of focused work plus a week of
validation on a real multi-machine deployment, which the requester of #2111 offered
to run.

| PR  | Scope                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Protocol and CP: facet declaration at registration, strategy table and session count in the heartbeat, binding token, `executorDaemonId` on the session row. |
| 2   | Executor facet: split "prepare an environment" from "spawn the runtime" in the microsandbox driver, the listener and token check, `host` strategy, draining. |
| 3   | Holder: the executor `SpawnDriver`, extracting the shared dial-and-bind layer from `K8sDriver`; placement; the unreachable-executor state.                   |
| 4   | Console: group switch, per-daemon hosting and capacity, session's executor.                                                                                  |
| 5   | Tests: a two-daemon, one-CP integration fixture covering holder failover and executor loss; the loopback shim smoke test extended to `host`.                 |
| 6   | Documents beside the code: this design, the pointers in the group and backend designs, and the workspace model's tier rule gaining the executor arm.         |

Calibration: `K8sDriver` is about three thousand lines and took five weeks of
commits, including claim, sleep and orphan machinery this design does not need. The
shim, at twice that size, is reused unchanged.

## 13. Open questions

- **Width of the exec surface.** The pool's shim exec handler admits a closed list of
  Git subcommands, chosen because the pod is the only place that check is a control.
  A self-hosted executor is in the operator's trust domain, where the list is only a
  tax. Proposed: one handler, one policy flag — closed on the pool, open on a
  self-hosted executor — decided before the driver is written, since the driver's
  Git phrasing depends on it.
- **Executor-loss semantics** (§7): the grace before a session is declared
  unreachable, and whether re-preparation is automatic on the next turn (proposed)
  or requires an operator.
- **TLS in v1** or plain WebSocket under the LAN assumption (proposed: plain, TLS in
  v1.5).
- **Default for the group switch** (proposed: off, explicit opt-in).

## 14. Non-goals

- Cross-organization executors. An executor serves the group it belongs to; a
  machine serving two organizations' sessions needs CP-verifiable proof of the
  holder's duty at re-dial, which v1 does not have.
- Turn-level migration or live movement of a running session.
- Durable environment storage across executor loss. Uncommitted work on a lost
  machine is lost; there is no PVC equivalent and none is designed.
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
  the dial direction, the binding proof and the tunnel direction, all of which apply
  verbatim.
- [daemon-sandbox-backends.md](daemon-sandbox-backends.md) describes the backends a
  strategy wraps; the executor facet's `microsandbox` strategy is that backend with
  the pool's disk layout instead of host mounts.
- [architecture.md](architecture.md) §9.1 is the trust model `host` relies on, and
  the hot-path goal of its §2 is the reason the data path never touches the CP.
