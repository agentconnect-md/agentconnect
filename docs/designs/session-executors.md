# Session executors: spreading one agent's sessions across a daemon group

**Status:** Design, decided 2026-09-16 and revised 2026-09-20, before implementation
started. The revision replaced the hand-rolled holder–executor link with a `prepare`
the Control Plane relays and a TLS-PSK byte pipe (§6), fixed an admission grant that
would have ended running sessions during a Control Plane outage, and cut what v1
does not need (§14, §15). The feature-independent groundwork has landed — #2154,
#2155, #2157, #2158, #2160, #2161 and #2165 (§12); the feature itself is not
implemented. Motivated by
[#2111](https://github.com/agentconnect-md/agentconnect/issues/2111): a self-hosted
team with a handful of Linux machines and no Kubernetes wants an agent's
concurrent sessions to use the spare compute of the other machines in its daemon
group, while the agent stays one identity on one holder.

This document generalizes what the managed pool already does with session pods
([k8s-daemon-pool.md](k8s-daemon-pool.md) §4, [git-workspace-model.md](git-workspace-model.md)
§11) to machines that are not a cluster. Almost everything here is "reuse X". The
genuinely new things are a second facet on every daemon (§3), a TLS-PSK listener for
session traffic on every daemon whose executor facet is on, and two Control Plane
requests through which a holder finds and prepares an executor (§6); the rest is the
pool's shape with the Kubernetes-specific parts removed.

## 0. Decision summary

| #   | Decision                | Outcome                                                                                                                                                                                                                                                       |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Unit of ownership       | Unchanged: the whole agent, held by one daemon through the duty ledger. No session-level duty.                                                                                                                                                                |
| D2  | Where a session runs    | On the holder itself, or on the **executor facet** of another daemon in the agent's group; the holder chooses, and the candidate hosting the fewest sessions wins. Only `session`-isolated sessions spread; `shared` ones stay with the primary checkout.     |
| D3  | What the user sees      | One concept: the daemon. The executor facet is a seam inside it, switched by one key, `sandbox.share`, default off. No separate executor component, install or role.                                                                                          |
| D4  | The contract            | The shim protocol, exactly as the pool uses it against a session pod. ACP, exec, fs, skills and the credential and MCP tunnels all ride it. The backend behind the shim is private.                                                                           |
| D5  | Direction               | The executor facet listens; the holder dials. Same rule as the pool: the shim never dials.                                                                                                                                                                    |
| D6  | Control plane role      | Orchestration only: facts a holder pulls at session birth, a `prepare` it relays after checking the ledger, the session's executor id, upgrades. Never on the data path. Placement is the holder's.                                                           |
| D7  | Execution strategies    | `host` (Linux) and `microsandbox` in v1, in that order; `srt`, `docker` and non-Linux `host` later. Named after `sandbox.backend`. Capabilities are an effective strategy table; placement is a match against it.                                             |
| D8  | State location          | Clones and HOME live in an executor-local directory mounted into the environment, the local confined layout; a replaced VM keeps them. No mounts across machines, no shared filesystem.                                                                       |
| D9  | Credentials             | Each machine carries its own runtime sign-in or API-key configuration; the executor seeds a session's HOME from its own. Provider credentials and agent secrets travel from the holder over the encrypted link.                                               |
| D10 | Upgrades                | The facet upgrades with the daemon through the existing CLI store and the CP-tracked `daemon/upgrade`. Hosted sessions join the daemon's existing shutdown drain; no phase is added. Environments survive as disks and directories; running processes do not. |
| D11 | Local convergence       | Later, behind a flag: the holder's own machine becomes a loopback executor, and the direct local path retires. Not in this project.                                                                                                                           |
| D12 | Network assumption (v1) | Group members share a LAN. No NAT traversal, no relay. The link is TLS-PSK regardless: the assumption buys reachability and latency headroom, never a plaintext link.                                                                                         |
| D13 | The link                | Two machines share one thing: a TLS-PSK byte pipe per session, under the unchanged shim protocol. Its key is minted by the executor, relayed by the CP with the `prepare` reply, outlives dials, and is replaced only by a newer launch's `prepare`.          |

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
  between holder and executor do not pass through it; what does is control metadata,
  the two requests of §6.
- **Isolation tiers.** `shared` sessions keep running in the primary checkout on the
  holder. Only `session`-isolated sessions can be placed elsewhere, and a session
  placed elsewhere is always the clone tier ([git-workspace-model.md](git-workspace-model.md)
  §11), because the primary checkout is not on that machine.
- **The execution trust model** ([architecture.md](architecture.md) §9.1). Running
  without a sandbox is an operator choice, not a defect. A remote session without a
  sandbox is trusted exactly as a local one is.

## 3. One daemon, two facets

The user-facing model has one concept: the daemon. Internally every daemon carries
two facets:

- The **holder facet** is today's daemon: it claims duties, owns platform
  connections, runs schedules, drives turns.
- The **executor facet** hosts session execution for holders in its group. It
  exposes one thing to a holder — an authenticated byte pipe to a hosted session's
  shim — and the shim contract rides above that. It holds no duty, owns no agent and
  cannot become a holder — it does carry the session-to-holder metadata it needs,
  the labels of §7 — and it is the self-hosted counterpart of a session pod.

The two facets are a seam inside one process, not two processes, and one
configuration key switches the second: `sandbox.share`, **default off** (§10). A
machine that leaves it off is exactly today's daemon: it holds agents and runs their
sessions itself. A machine that turns it on also lends its compute to the other
members of its group. The switch introduces no second binary, service unit or
install path.

There is no switch for the holder facet in v1. An earlier draft had
`role: "executor"` for a machine that contributes compute and never holds. Nothing
in #2111 needs it — the requester's machines are ordinary group members — and the
existing controls do not express it either: `limits.maxAgents` bounds how many
agents a member accepts, but `0` is the ledger's unbounded sentinel, not a ceiling
of zero. A member that must hold nothing is a later, separate change (§14); the
facet seam is what keeps it a small one.

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
§6 makes it one request.

The holder side was groundwork, and it has landed (§12). `RemoteShimDriver`
(`packages/daemon/src/remote/shim-driver.ts`) is the generic "dial a shim, bind at a
generation, run a runtime through it" layer, lifted out of `K8sDriver`. What differs
per backend is a `ShimEndpointProvider` (`remote/shim-endpoint.ts`), whose `resolve`
answers exactly that sentence; the pool's resumes a Sandbox and waits for its pod
(`k8s/endpoint-provider.ts`). The executor path is a second provider under the same
driver, and its `resolve` is the `prepare` of §6. Above it the path is
indistinguishable from the pool's: ACP is spawned through the shim, Git and
workspace reads cross the shim's exec and fs channels, skills are published through
it, and the credential and MCP tunnels ride the same channel in the direction §6 of
[cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) already fixes. Where a
session's workspace operations land is an `ExecutionPlane`
(`packages/daemon/src/execution/plane.ts`), resolved per scope rather than per
process: a spread session resolves to an executor plane and its siblings to the
holder's own disk, in one daemon at once.

The local microsandbox path already has this shape, so there is one microsandbox
mode rather than a local one and a remote one
([daemon-sandbox-backends.md](daemon-sandbox-backends.md) §3):

- **ACP.** The driver starts the runtime **through the VM's shim**, with the same
  `createRemoteRuntime` a pool member uses against a pod. agentd's exec channel
  carries the shim itself and daemon-run Git, and no runtime.
- **The tunnels.** The VM's `gitcred` and `mcp` endpoints are served by the shim's
  `TunnelHost` under the `tunnel` grant and proxied to the driving daemon's own
  sockets, and the guest helper endpoints — the git-credential socket variable and
  the bridge's `mcpServers` spec — name the shim's paths, exactly as the pool image
  does. The AF_VSOCK bridges that once served them are gone: on an executor they
  would have terminated at a daemon that owns no agent.

That is what keeps the contract backend-neutral: a holder never learns whether the
far side is a VM, a container or a bare process.

The executor side is the same shim the pool image carries and the microsandbox
backend already stages into a VM's `/run` at startup — and it is the **executor's
own** bundle, the `dist/shim` artifact set `microsandbox/shim.ts` stages today; the
holder pushes nothing (§15). A holder and a shim from different releases negotiate
features in the handshake — `supportedFeatures` in `shim/hello`, `features` in
`shim/identity` (`ShimFeatureSchema`) — which is the skew a pool image's shim
already has against the daemon that dials it.

### Evidence

The pinned microsandbox SDK has no self-hostable server: its two backends are
`local` and a hosted control plane in private beta, and the hosted one lacks host
mounts, disk volumes, published ports and force-kill. But the daemon's data path
never goes through that backend abstraction. `microsandbox/exec.ts` and `tcp.ts`
talk to agentd through its relay unix socket via `AgentClient`, and
`AgentClient.connect(path)` accepts any path. A probe forwarded a VM's relay
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
is for. And a guest's shim WebSocket survives a byte-forwarding hop unmodified,
which is all the executor's pipe (§6) is. The per-exec cost in the table is not one
the remote path pays: the daemon opens a fresh `AgentClient` per exec for the Git it
runs through agentd, but a holder's Git rides the shim's exec channel inside the one
WebSocket, as on the pool, and the executor holds one agentd stream per pipe.

## 5. Execution strategies and capabilities

The executor facet implements the contract with a **strategy**, named after the
values `sandbox.backend` already uses:

| Strategy         | Boundary                     | Needs                                                         | Status                                                                                 |
| ---------------- | ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `host`           | none                         | a Linux machine that runs Node                                | v1, first                                                                              |
| `microsandbox`   | VM                           | Linux, KVM, msb + libkrunfw, the runtime image                | v1, second                                                                             |
| `srt`            | process (bubblewrap)         | Linux, bwrap, socat, rg on PATH, unprivileged user namespaces | follow-up: the wrapping moves from the daemon's launch path into the shim's spawn path |
| `docker`         | container, optionally gVisor | docker or podman, the runtime image (already OCI)             | later                                                                                  |
| `host` off Linux | none                         | macOS or Windows                                              | later: a non-Linux read path and a second look at the socket's protection (below)      |

**`host` is a legitimate strategy.** §9.1 of the architecture already says an
unsandboxed agent is operator-trusted code; spreading such sessions across the
operator's own machines changes nothing about that trust. And the shim is an
ordinary Node process, so "shim as a host process" is not a new mode, only a new
place to start it.

**`host` ships first**, though since #2161 it is no longer the smaller half on the
executor. A VM is the pool's layout by construction — fixed in-guest paths, a shim
`microsandbox/shim.ts` already stages and starts, no per-session root — so its
strategy is mostly "prepare an environment without spawning a runtime". `host` needs
the launcher and the path derivation below. It goes first because it needs no KVM,
no image and no msb: it runs on any Linux machine a group has, which is what the
requester of #2111 has, and it exercises everything that is actually new — the
facet, `prepare`, the pipe, the reconcile — without a VM's lifecycle underneath.

**`host` is Linux-only in v1.** The shim's console read path is fd-bound
(`shim/safe-descent.ts` refuses with `ENOTSUP` off Linux, as
cluster-spawn-and-shim.md §5 documents), so a macOS or Windows executor would accept
sessions and then fail every console file view for them. And the `host` shim's only
listener is a unix socket in a directory protected by POSIX permissions (§6), a
protection that has to be re-argued for another platform's socket model. A
non-Linux `host` needs a read fallback and that second look; both are deferred.

The shim also assumes one thing about its surroundings that `host` must supply
explicitly: that it owns its filesystem namespace. Its tunnel endpoints default to
the fixed in-sandbox paths `/run/agentconnect/{gitcred,mcp}.sock`, and `TunnelHost`
removes a stale socket before binding, because inside a pod or a VM the only
previous owner of that path is an earlier incarnation of the same shim. Two `host`
sessions on one machine would replace each other's endpoints — a request could
reach the wrong holder, and one session's shutdown would unlink another's socket.
So the `host` strategy gives each session a **private runtime root**: a short,
owner-only directory the executor creates per session. The mechanism landed with
#2155 — every path the shim authors is one derivation,
`shimPaths(runtimeRoot, helperRoot)` in `shim/sandbox-paths.ts`, and the shim
entrypoint reads `AC_SHIM_RUNTIME_ROOT` and threads the result to the tunnel
listeners, skill staging, the MCP bridge probe and the merge watcher. The AF_UNIX
path-length budget applies here as it does to the session's `TMPDIR`, so the root
is kept short rather than nested under the session's HOME.

Some paths are authored on the **daemon** side and travel over the wire: the Git
config directory, the git-credential socket variable and the MCP endpoint under the
runtime root, and the credential helper under the helper root
(`workspace/git-injection.ts`, `mcp/inject.ts`). Today they are the image's
constants. The executor chose the root, so the root travels in the `prepare` reply
(§6), and the holder derives those paths from it with the same `shimPaths`. The
function's second root locates the helper entries an image bakes under
`/opt/agentconnect`; a `host` executor has no image, so its launcher points that
root at its own bundle — the entrypoint takes only the runtime root from its
environment today, so passing the second is the launcher's to add — and the reply
names it beside the runtime root. For `microsandbox` both roots are the image's
defaults and the reply says nothing new. The shim's hello does not change (§15).
The wire contract is unchanged; only the paths move.

**Configured is what a machine offers; reported is what is effective.** A strategy
whose probe fails at startup is reported unavailable with its reason, the way the
daemon already reports `sandboxUnavailable`; placement reads only the effective
table. The console keeps showing the reason exactly as it does for a daemon whose
sandbox is down. The table is a process-level fact, so it rides registration beside
`sandboxUnavailable`, not the heartbeat (§6).

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

- **Process-level facts ride registration.** Whether the executor facet is on, the
  effective strategy table, the **executor endpoint** (address and port — no daemon
  frame carries one today, because no daemon listens for its peers) and the session
  capacity are decided when the process starts and change only when it says so. They
  belong to `register`, re-announced through the existing `capabilities/update` when
  they change, not to a frame sent every fifteen seconds.
- **The heartbeat gains one field, `hostedSessions`**: the number of session
  environments live on the machine, whoever holds the session. It sits beside the
  existing `activeSessions`, which is the holder facet's own in-flight turn count
  and must not silently acquire that meaning.
- **Which runtimes a machine can authenticate is already reported**: `authRequired`
  per runtime in the `facts/daemon-runtimes` snapshot
  (`packages/protocol/src/frames/telemetry.ts`). Nothing is added for it.
- **Holders pull; nothing is pushed.** At session birth the holder asks
  `executor/candidates` (below). The earlier text had holders "read" these facts,
  "plus fan-out", and named no mechanism — and none exists: the heartbeat is
  daemon→CP only (§15).
- The CP **relays `executor/prepare`** (below) after checking the duty ledger.
- The session row records `executorDaemonId` — in the shared data-plane store, so a
  successor holder can find a session's environment after failover, and on the CP's
  own session row, so the console can show it (§10).
- Upgrades and restarts reuse `daemon/upgrade` and `daemon/lifecycle/progress`
  unchanged (§9).

**What the Control Plane does not do.** It does not choose the executor: the holder
does, from the facts it pulled, because placement authority on the CP was rejected
in the pool design and nothing here reopens it. And it does not carry the data
path: the ACP stream and the shim WebSocket are a direct connection from holder to
executor. Routing that stream through the CP's WebSocket would put the CP on the
hot path, make a CP outage end every running remote session, and show the CP the
`session/update` stream it must never see. A relayed `prepare` changes none of
that: it is a control request with a bounded reply — which machine, which strategy,
a key — and it carries no repository, no credential and no byte of any session (§7
is why it needs none).

**Finding, preparing and dialing an executor.** The pool binds a shim connection
with the pod's own rotating Kubernetes credential and a TokenReview, and there is
deliberately no CP-signed shim grant or key set ([k8s-daemon-pool.md](k8s-daemon-pool.md)
§7). A self-hosted executor has no such identity source, so the authority for the
link is the one both ends already authenticate to: the CP, reached over the two
control connections that already exist. It is used for exactly two requests, and
then the machines talk to each other.

1. **`executor/candidates {agentId}`** — holder → CP, at session birth. The CP
   answers the connected members of the agent's set whose executor facet is on, each
   with its effective strategy table, endpoint, capacity, `hostedSessions` and the
   runtimes it can authenticate. An empty answer carries its reason: the group's
   switch is off (§10), or no member shares. These are **facts, never a choice**:
   the CP ranks nothing and recommends nothing, and placement stays the holder's.
2. **`executor/prepare {agentId, sessionKey, executorDaemonId, generation, strategy, resources, image}`**
   — holder → CP. The CP checks the ledger: the requester holds the agent's duty
   (`DutyLeaseService.holdsAgent`, the read that already authorizes `duty/fetch`),
   and the target is a member of the agent's set with its facet on. It then relays
   the request to the executor over the executor's own control connection — the CP
   already carries scoped request/reply frames to daemons
   (`packages/control-plane/src/orchestrator/outbound.ts`). The executor reserves
   capacity atomically, creates the environment, seeds its HOME from the executor's
   own runtime sign-in (§8), starts the shim, mints a per-session pre-shared key,
   and replies `{endpoint, psk, runtimeRoot, liveCount}` — `host` adds its helper
   root (§5) — or `full`, or a refusal with its reason. The CP returns that reply to
   the holder. `generation` is the launch's binding generation (below); `resources`
   and `image` matter to the `microsandbox` strategy only.
3. **The holder dials the executor's listener with TLS, using that key**, with the
   session leaf as the PSK identity. TLS-PSK authenticates both ends and encrypts
   the link with no certificates (the evidence closes this section): a dialer that
   does not hold the key fails the handshake, and so does a listener that does not.
   After the handshake the executor **pipes bytes** to that session's shim and
   parses nothing. Above the pipe runs the existing shim protocol, exactly as
   `packages/daemon/src/microsandbox/shim.ts` already runs it over an injected
   socket (`createConnection`): the dialer is handed a connected socket instead of
   opening one.
4. **Binding is unchanged where it matters.** The session's binding credential is
   still minted locally by the holder's `ShimBindingRegistry`, scoped to a
   generation and a grant list — step 6 of cluster-spawn-and-shim.md §3. What
   replaces steps 1–5 of that proof, the pod's TokenReview, is one fact: _this pipe
   was authenticated for this session by a key its executor minted._ The dialer's
   identity check is an injected interface (`PodIdentityVerifier`), which
   TokenReview implements for a pod and a constant-time token compare for a local
   VM; for an executor it answers from the pipe. The key and the binding credential
   are two things: the first opens the pipe and is the executor's, the second scopes
   a session and is the holder's.

**`prepare` is idempotent per launch, which is what makes it one request.** Every
launch the generic layer records already carries a binding generation, allocated per
subject from the group's shared store before its endpoint is resolved
(`LaunchRegistry.recordLaunch` in `remote/launch-registry.ts`), and `prepare` carries
it. The executor applies generations monotonically per environment, and keeps the
highest it has applied on disk beside the environment, so a restart does not forget
it:

- _A generation it has already applied_ is the same logical request: a
  retransmission — both control connections' correlators resend an unanswered frame
  — or `resolve` asked again for the same launch. It joins the preparation in flight
  or returns the reply it already gave: the same key, no rotation, no pipe closed.
  Without this a preparation slower than one acknowledgement timeout would run
  twice, and the second run would rotate away the key the first had just returned.
  The reply lives only as long as the launch does on the executor. Once the
  executor has stopped the environment for idleness, or has restarted, there is no
  reply to return, and it **refuses retryably** rather than minting a second key at
  a generation it has already applied — which would hand a working key to whoever
  replayed that generation, a deposed holder included. The holder discards the
  launch and allocates a higher generation, so every wake and every recovery
  advances the fence.
- _A higher generation_ is a new launch. For an environment that already exists it
  attaches: it starts the shim if the environment was stopped, and mints a fresh
  key. So the same frame is session birth, the wake of an idle environment, recovery
  after an executor restart, and holder failover — the successor sends it, and the
  ledger check now names the successor.
- _A lower generation_ is refused as stale. The ledger check runs at the CP, before
  the relayed effect, so a deposed holder's `prepare` can pass it and still arrive
  after its successor's. It carries a generation allocated before the successor's —
  the successor allocates only once it is granted, from the same counter — so it can
  never rotate the successor out.

Dial and prepare are one request: literally §4's sentence, and on the holder
literally `ShimEndpointProvider.resolve`. The fence is the binding generation and
not the duty term, for the reason the pool gives at its own edge (k8s-daemon-pool.md
§2, §7): the term is monotonic per duty _group_ and starts again with a new group,
so a recompute that splits an agent's component would hand its rightful holder a
lower term and have it refused. The generation is a different monotonic counter
over the same ordering, and it belongs to the subject.

**The ordering comes free.** The holder learns the endpoint only from the
executor's reply, so there is no window in which a holder dials an executor that has
not yet been told to expect it. The earlier rendezvous had that race by
construction: the CP told the executor to expect a dial and handed the holder its
secret in the same step.

**The key outlives dials; only a newer launch's `prepare` replaces it.** `ShimDialer`
(`packages/daemon/src/shim/dialer.ts`) does not dial once. The shim closes the
channel as `rebinding` at half the binding credential's lifetime and the dialer
re-dials at once; a dropped socket re-dials on the `reconnect` backoff. The earlier
text made the admission grant one-shot — "consumed by one dial" — which would have
sent every spread session back through the Control Plane at every renewal, every
five minutes on the pool's default credential lifetime, and after every network
blip. A CP outage would then have ended each running spread session at its next
renewal, which contradicts the invariant this architecture is built on: established
sessions keep running while the CP is down. So the key is not consumed. It admits
dials for as long as the environment it was minted for keeps running, a re-dial by
the same holder costs no CP round trip, and exactly one thing replaces it: a
`prepare` at a higher generation, which the ledger check lets only the current
holder send and the generation rule lets only a newer launch win.

Rotation is therefore also the executor-side fence. The executor closes the pipe
admitted under the old key, and a deposed holder can neither keep its connection nor
open another. The executor keeps one pipe per environment — a newly admitted dial
closes the one before it — so neither a half-dead socket of the same holder nor a
deposed holder's can sit in the shim's single connection slot. That is the takeover
delay the pool accepts (k8s-daemon-pool.md §7), and this topology does not have to.
The executor path also takes the local VM's day-long binding credential (#2165)
rather than a pod's ten minutes, for the reason that change gave: a renewal proves
nothing new on a pipe that is already authenticated, and it ends any helper stream
with a frame in flight.

**What still needs the CP, and what no longer does.** A re-dial does not, and
neither does a second bind of the same launch, whose reply the provider keeps with
the launch. A new launch does: birth, the wake of an environment the executor
stopped (§7), a successor's attach, recovery after an executor restart. A CP outage
therefore leaves every running spread session running and makes one that needs a
new launch wait: its turn fails retryably and nothing is lost, because the
environment is one `prepare` away once the CP answers. The pool has the same shape
with the Kubernetes API in the CP's place — a bound pod serves through an API
outage, and a suspended one cannot be woken until it ends. When the CP cannot be
reached at **birth**, the session simply does not spread: the holder is always its
own candidate (below), and the reason is recorded (§7).

**What the CP sees.** The key, and control metadata: agent, session key, machines,
strategy. It issued the secret itself in the earlier text, so the trust placed in it
is unchanged — a CP that wanted to impersonate a holder already could. It never
sees ACP, tunnel bytes, secrets or file content, which cross the pipe and nothing
else.

**What did not change about the shim, verified.** The shim proves itself to the
daemon; it does **not** authenticate whoever dials it (cluster-spawn-and-shim.md
§3). `ShimServer` accepts any WebSocket with the right path and subprotocol, and the
shim answers that dialer's hello with its identity and accepts the binding that
follows. In a pod that is safe because a NetworkPolicy decides who can reach the
port, and in a VM because the port is guest loopback, which nothing outside the VM
reaches except the daemon that owns it. On a shared host nothing plays that part:
another local user, or a sandboxed agent on that machine, can reach a loopback
port. So a `host`-strategy shim listens **only on a unix socket inside its session's
private runtime root** (§5), never on TCP — `ShimServer.start` binds TCP only today,
so the socket listener is part of the `host` launcher — and the only way to it from
another machine is the executor's authenticated pipe. §15's rejection of dialing a
shim port directly stands for the same reason.

**Direction.** The executor facet listens; the holder dials. This is the pool's rule
— the shim listens, the daemon dials the ready pod — applied to a machine instead of
a pod. It is a new listener for session traffic, not a daemon's first: the readiness
HTTP server (`readiness.ts`, bound on `AC_READINESS_PORT`) is prior art for binding
and lifecycle, though its health-only endpoint sets no authentication rule, and the
shim listener the daemon owned before the direction was reversed
(cluster-spawn-and-shim.md §2) is prior art for the hardening. The port is off
unless the executor facet is on (§10), and nothing is served on it before a TLS-PSK
handshake succeeds under a key minted for a session the machine hosts. The reverse
direction (executor dials the holder) would make the holder listen instead and was
not chosen; it buys NAT traversal, which v1 does not need.

**Placement: two consents, one predicate, one rule.**

1. **Two consents enable spreading** (§10): the group's switch, and each machine's
   `sandbox.share`. Off at the group means no session of any agent in it spreads,
   whatever the daemons say; off at a machine means that machine is nobody's
   candidate.
2. **The birth predicate decides eligibility** (§7): the session is
   `session`-isolated, the agent's memory does not pin it to the holder, and some
   candidate's effective table matches the agent's ask and can authenticate the
   session's runtime.
3. **One rule selects.** The holder is itself a candidate, and the session goes to
   the candidate hosting the fewest sessions; a tie goes to the holder, which costs
   no link. There is no placement policy key. An earlier draft had a `spread` and a
   `local-first` policy; one rule has no configuration to get wrong, and the rule
   already keeps the first session of an idle group at home.

`hostedSessions` counts a machine's own isolated sessions as well as the ones it
hosts for others, so the number means the same thing for every candidate, the
holder included; counting only what a machine hosts for others would make every
holder read its own load as zero and keep everything. The counts are **advisory**
all the same. They are as fresh as the last heartbeat, and a burst of births — a
webhook storm — can still aim several holders at one machine. Admission is
therefore the executor's, and atomic: at `prepare` it reserves a slot against its
limit, counting preparations still in flight, releases the reservation if
preparation fails, and answers `full` when it cannot reserve; the holder moves to
the next candidate instead of queueing behind the serialized starts of §7. The
limit is `limits.maxConcurrentSessions`, a key the daemon has carried without an
enforcer, and it refuses only a `prepare`: a machine's own births are not newly
limited. What it counts is live shims and VMs, never directories, so an idle
environment holds no slot (§7). The holder keeps no provisional count of its own
(§15): facts are pulled per birth, the CP refreshes a member's `hostedSessions`
from the `liveCount` of each reply it relays, and `full` is the backstop either
way.

**What the LAN assumption buys**, so nobody over-credits it: reachability — no NAT
traversal and no relay, both already out of scope — and enough latency headroom that
a round trip per shim request, which is what every Git operation a holder drives
costs, goes unnoticed. It does not buy a plaintext link, and the earlier text was
wrong to say it might: sandboxed agents share the LAN, and only microsandbox denies
private networks by default. It does not enable discovery either, which
registration already provides. Two things it seems to enable are rejected in §15: a
shared filesystem, and dialing a guest's published shim port directly.

### Evidence for the link

A loopback probe on Node 24.16, both ends on one machine; cross-machine latency and
throughput are not yet measured:

| Check                                                                                                                    | Result                                |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| certificate-less TLS-PSK on TLS 1.3 with `TLS_AES_128_GCM_SHA256`                                                        | works                                 |
| TLS 1.2 with `ECDHE-PSK-CHACHA20-POLY1305`                                                                               | works                                 |
| TLS 1.2 with `PSK-AES256-GCM-SHA384`                                                                                     | works                                 |
| a dial with the wrong key                                                                                                | refused at the handshake              |
| TLS 1.3 with `TLS_AES_256_GCM_SHA384` and a callback-supplied PSK                                                        | fails: such keys are bound to SHA-256 |
| an ordinary `ws` client given the TLS socket through `createConnection`, a plain loopback WebSocket server behind a pipe | completes the WebSocket handshake     |

Two things fall out. The suite is pinned rather than negotiated from Node's
defaults: a callback-supplied key works only with a SHA-256 suite, so a peer that
prefers the SHA-384 one fails instead of falling back. The proposed pin is TLS 1.3
with `TLS_AES_128_GCM_SHA256`. And the last row is the whole executor data path in
miniature: TLS terminates at the listener, bytes are piped to a server that knows
nothing about TLS, and the unmodified WebSocket client on the far end cannot tell.

## 7. Session lifecycle

**Birth: who does what.** The holder decides, at session creation, that this session
spreads (§6's controls), pulls candidates, picks one and sends `prepare`.

- _The executor_ reserves a slot, creates
  `<executorRoot>/sessions/<leaf>/{workspace,repos,home}`, seeds `home` from its own
  host sign-in (D9), starts the environment with its own driver — a plain process
  for `host`, the existing microsandbox manager for a VM — starts the shim, mints
  the key and replies.
- _The holder_ records the executor on the session row, dials, binds at the launch's
  generation, and then drives everything else **over the shim**: the per-session
  blobless clone, the branch checkout and the rest of §11 of the workspace model,
  through the execution plane's Git runner. That is exactly the pool's path —
  `WorkspaceManager` (`packages/daemon/src/workspace/workspace-manager.ts`) clones
  through a swappable `GitRunner`, and on the pool that runner is the shim's exec
  channel plus the gitcred tunnel.

The split follows what each side knows. The executor knows neither the remote nor
the credentials — the retention rule below already depended on that — so an earlier
draft that had it perform the clone would have had to ship it both, through the CP.
HOME has two halves for the same reason: the sign-in seed is the executor's, from
its own disk; provider credentials and agent secrets are the holder's, and arrive
over the link (§8).

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

**Execution.** The holder's driver dials the pipe and binds at the launch's
generation. Everything above the shim is the pool path. Console reads of the
session's paths are routed to the executor, as they are routed to a session pod
today; reads of the agent's primary checkout stay with the holder, where that
checkout is.

**Agent-scoped state.** A session pod on the pool binds and holds the agent's
companion pod for three agent-scoped things; a remote session has no companion, so
each needs a named source:

- _Managed memory._ Locally the runtime's memory root is a mount of the holder's
  scope directory, which cannot cross machines. So the birth predicate refuses
  exactly one case: an agent whose memory is **managed and daemon-homed**
  (`provider: managed` with `home: daemon`). An agent whose managed memory lives in
  the Control Plane (`home: control-plane`, the rule the pool already mandates)
  spreads, read and written by the holder over its control connection. An agent
  with no managed memory has nothing on the holder's disk to be cut off from, and
  spreads too; the earlier text required `control-plane` of every agent, which
  would have refused agents that have no managed tree at all. Because `home`
  defaults to `daemon`, the refusal is the common case for a managed-memory agent,
  so it must not be silent (below). Runtime-native state stays in the per-session
  HOME on the executor, as it does for every confined session.
- _Merge-when-ready._ On a self-hosted daemon the watcher runs in the holder process
  for local sessions; it does the same for a spread session, holding nothing on the
  executor.
- _The primary checkout._ Stays on the holder; it is not part of a clone-tier
  session's environment.

**A session that stays home says why.** The birth predicate's verdict is recorded
on the session and reported with its metadata: the executor it went to, or the
reason it did not spread — the agent is not placed on a group, the group's switch is
off, the session is `shared`, the agent's memory is daemon-homed, no candidate offers
the strategy or can authenticate the runtime, every candidate was full, the Control
Plane could not be asked. The console shows it (§10). Without it, "why is everything
still running on one machine" has no answer an operator can find.

**Stickiness.** A session runs where it was born for its whole life. There is no
turn-level migration.

**Idle, retention, retirement.** The judge is the holder, as it is on the pool: its
idle sweep decides when a session's environment may stop, and its workspace manager
applies the dirty and unique-commit rules over the shim, because those rules need
the agent's remote, default branch and retention policy, which the executor does
not know.

Neither decision needs a message. _Idle:_ the holder closes the session's pipe, and
in the same step drops the session and forgets the launch — the coupling the pool's
suspend path already has (`K8sDriver.suspendIfIdle`), and with the launch goes the
`prepare` reply the provider kept for it. An environment with no admitted pipe for
longer than a linger — longer than the dialer's reconnect backoff, so a blip is not
an idle signal — has its shim, and its VM, stopped by the executor. That frees its
slot, since capacity counts live shims and VMs; the directory stays. The next turn
finds no launch, records one at a higher generation, and its `prepare` starts the
environment again; a holder that kept the old launch would reuse a reply whose key
no longer opens anything, and no `prepare` would ever be sent. A dead holder's
pipes close by themselves, so nothing keeps running for lack of a judge.
_Retirement:_ the holder deletes the session's row in the shared store, and the
executor's reconcile (below) removes the environment. There is no `release` message
(§15), so the reconcile is part of the executor facet itself (§12), not a
follow-up.

**When there is no holder.** An executor cannot judge, and an agent may lose its
holder for a long time or be removed outright. So the executor keeps an inventory
of its environments labelled by agent id and session leaf — the pool's claim labels
— and reconciles it on a schedule against the same two authorities the pool's
reconciler uses (`cli/reconcile.ts`): the **shared data-plane store** for session
existence, read directly through `sessionKeysForAgent`, and the **CP** for agent
existence, through the `agent/exists` request that reconciler already sends, which
answers an org-scoped connection for its own organization's agents. The CP is
deliberately not asked about sessions: its `SessionMeta` row is created
asynchronously from daemon reports and is kept after the data-plane session is
purged, so a missing CP row can describe a retained session and a present one an
already-purged session. The executor discards an environment whose agent the CP no
longer knows, whose session key the store no longer lists, or whose row names
another executor (the loss rule below can move a session while its old machine is
away) — under the pool's orphan-reconciliation rules (a grace period, and a
same-name replacement check so a session recreated after the query is never the one
deleted) — and **retains** everything when either lookup cannot answer. Agent
removal and session retirement delete the store's rows; the next reconcile removes
the environments. Nothing is kept forever for lack of a judge.

The store is authoritative the other way too. An environment whose session the
store still lists on this executor is kept however long its agent goes without a
holder: retaining a live agent's work is intentional, and unassignment is not an
orphan signal. The executor discards only what the authorities no longer know
**and** no admitted holder connection is using, and it never judges dirtiness — the
deletion, produced by the holder's retirement or by agent removal, is the only
evidence it acts on. That gives deletion an owner that survives the holder without
giving the executor a duty.

This has a configuration consequence. The reconcile reads the group's data-plane
store directly, so a machine that only lends compute still needs the group's
data-plane connection: the shared store of [daemon-groups.md](daemon-groups.md) §5 is
a prerequisite of sharing, not only of holding. A sharing member without it could
answer neither question and would retain every environment forever — the safe
failure, and a full disk.

**Holder failover.** The successor member claims the agent through the ledger as
today, reads the session's executor from its row, and sends the same `prepare` for
its own launch, whose generation is higher than any its predecessor allocated. The
ledger now names it, so the CP relays; the executor attaches, rotates the key and
closes the deposed holder's pipe, and refuses any `prepare` of the predecessor's
that arrives late (§6). The environment is still there — nothing on the executor
depended on which holder was driving it — so failover costs one relayed request and
a dial, not a re-preparation.

**Executor loss.** Decided lazily, at the next launch, from the answer to the
`prepare` that launch already sends. There is no timer and no new state on the
holder (§15).

- _The executor answers, and the dial then fails._ The machine is up — it just
  replied — so what failed is the link between the two machines. The turn fails
  retryably and the session is **not** moved: its environment and any uncommitted
  work in it still exist.
- _The CP cannot relay, because the executor's control connection is down._ The CP
  answers with its own record of that daemon: when it last heard from it
  (`lastSeenAt`, the heartbeat stamp the ledger's liveness already reads). Inside a
  grace the turn fails retryably, because a machine that is rebooting comes back
  with its directories. Past it the holder prepares the session on another
  candidate, records the new executor on the row, and tells the user in the
  conversation that the previous environment was lost, as it is when a pinned
  daemon dies. If the old machine returns, its reconcile collects the orphan.
- _The executor refuses_ — it is full, or draining, or the launch it was asked about
  is one it has retired (§6), which the holder answers with a new launch. A refusal
  is not a loss: the environment is intact, so the turn fails retryably and nothing
  moves.

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
operator's own machine, no platform-held tokens — is unchanged, and it has a
consequence worth saying plainly: **a spread session runs under the sign-in of the
machine it lands on**, which is why lending a machine is its owner's decision (§10).
Which runtimes a machine can authenticate is already in its `facts/daemon-runtimes`
snapshot (`authRequired`), the way the console already shows "Login required" per
runtime; `executor/candidates` answers from it, and a holder does not place a
session whose runtime the executor cannot authenticate.

**Provider credentials and agent secrets are two mechanisms**, and both cross the
link — encrypted. The earlier text authenticated the dial and left the link itself
optionally plaintext, while its own §6 noted that sandboxed agents share the LAN: a
provider key or an agent secret crossing in the clear is readable by anything that
can see the segment. TLS-PSK covers every byte above the handshake, which is every
byte these two mechanisms send.

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

No phase is added (§15). The daemon's existing shutdown drain — the gate a
`daemon/upgrade` or `daemon/restart` with `drainFirst` closes, bounded by
`limits.shutdownDrainMs` — covers the facet: once it closes, `prepare` is refused
so holders place elsewhere, and hosted environments get the same budget the
daemon's own turns get before it stops them. The executor cannot tell a busy pipe
from an idle one, because it parses nothing, so a machine hosting sessions spends
the whole budget and a machine hosting none spends nothing.

What a restart costs is stated honestly, because neither v1 strategy keeps a
running process across it. The microsandbox backend's rule is that a daemon restart
stops recorded owned VMs and retains their disks; it does not adopt running guests,
so the guest, its shim and its ACP process end. A `host` session's process
tree is a child of the daemon and ends with it; ACP over stdio ends regardless.
Environments therefore survive **as disks and directories** (§7), and a session
resumes from them on its next turn — a VM is started from its retained disk, a
`host` environment is re-entered — while any turn still running at the instant of
restart is lost, which is what a daemon restart already costs. Adopting live VMs or
detached shims across a restart would change the backend's fencing rule and is not
in scope. The keys die with the process too: a holder that lost its pipe re-dials,
the handshake is refused, the launch is given up as lost, and the next one sends a
`prepare` at a new binding generation, which starts the shim again and returns a
fresh key. The highest generation each environment has applied is on disk (§6), so
the restart does not reopen the door to a stale `prepare`, and a `prepare` replayed
at the generation the restart interrupted is refused rather than given a second
key.

Nothing version-sensitive is pushed from the holder. The executor runs its own shim
bundle (§4), and the link has no protocol of its own to version: below the shim
protocol there is TLS and a byte pipe. The only skew left between a holder at N+1
and an executor at N is between the holder's dialer and the executor's shim, and
that is the shim protocol's existing feature negotiation — the same skew a pool
image's shim already has against its daemon. Members roll in either order. The two
CP requests follow the control protocol's own rule: a holder answered
`UNKNOWN_FRAME` by an older CP does not spread, and says so. The one
version-sensitive value that does travel is a name, not code: the `microsandbox`
image reference in `prepare`, so the runtimes a session sees do not depend on which
machine it landed on.

## 10. Configuration and console

Daemon configuration grows **one** key, daemon-owned, inside `sandbox`:

```json
"sandbox": {
  "backend": "microsandbox",
  "share": true
}
```

`share` is the executor facet switch and **defaults to off**: the listener opens
only when `share` is true and the effective strategy table is non-empty — never
merely because `sandbox.backend` has a value, since it always does (`srt` by
default). A machine whose table is empty and whose `share` is true starts with the
facet dark and says why. Executor addresses and keys are not configured anywhere:
registration publishes the endpoint, and each session's key is minted at `prepare`.
There is no `role` key and no `placement` key (§3, §6), and capacity is the existing
`limits.maxConcurrentSessions`.

**Two consents, two owners.** Spreading needs both, and they are not redundant,
because they belong to different people. `sandbox.share` is the **machine owner's**:
it lends that machine's CPU and disk and — the part that is easy to miss — its
runtime sign-in, since a spread session authenticates as whoever signed in on the
machine it lands on (§8). Only the person who runs that machine can agree to that,
so the key lives in its local config file and is deliberately not among the keys
`config/push` may set. The group's switch is the **group admin's**: it lets the
group's agents run their sessions — their repositories, provider credentials and
agent secrets — on machines other than their holder. Only whoever administers the
group can agree to that, so it is Control Plane metadata on the member set, default
off, enforced where the facts are served: with the switch off,
`executor/candidates` answers nobody and `executor/prepare` creates nothing (§13
has the question of sessions already placed). Either consent alone would let one
party volunteer the other.

The console adds no new kind of row. On the Infra page each daemon shows the
sessions it hosts and its capacity beside the strategies it offers. A group has one
switch, "spread sessions across the group", default off. A session's detail shows
which daemon executes it, or why it stayed on its holder (§7). The existing "Run in
sandbox" state and its unavailable reason keep their meaning per strategy.

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
shim process and a local socket it did not have.

The end state of "a thinner daemon" is a pool member — a holder that executes
nothing itself — not a daemon folded into the Control Plane. Thin or not, the
daemon is the process that carries message bodies and ACP streams, and those never
enter the CP.

## 12. Rollout

**The groundwork has landed.** Seven pull requests, none of which depends on this
feature shipping:

| PR    | What it landed                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2154 | The Kubernetes-free shim dial layer moved out of `k8s/` into `packages/daemon/src/remote/`.                                                                               |
| #2155 | `shimPaths(runtimeRoot, helperRoot)` in `shim/sandbox-paths.ts`: every path the shim authors as one derivation, and `AC_SHIM_RUNTIME_ROOT` read by its entrypoint (§5).   |
| #2157 | `ShimEndpointProvider` (`remote/shim-endpoint.ts`): obtaining a shim endpoint separated from dialing and driving it, with `RemoteShimDriver` as the generic rest (§4).    |
| #2158 | `ExecutionPlane` (`packages/daemon/src/execution/plane.ts`): one interface for where runtimes execute and workspaces live, resolved per host key.                         |
| #2160 | The per-scope `PlaneResolver`: workspaces placed per scope instead of by a process-wide mode, which is what lets one daemon hold local and spread sessions at once.       |
| #2161 | The local microsandbox backend runs ACP and both helper tunnels through the VM's shim (§4); the AF_VSOCK bridges are gone.                                                |
| #2165 | A local VM's binding credential lives a day rather than a pod's ten minutes, so the channel renewal — the re-dial §6's key has to survive — is rare rather than constant. |

**The feature is six pull requests.** The earlier estimate of three weeks of focused
work predates both the groundwork and the cuts, and each shortens it; the week of
validation on a real multi-machine deployment, which the requester of #2111 offered
to run, stands.

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Protocol and CP: the executor facet, effective strategy table, endpoint and session capacity at registration and in `capabilities/update`; `hostedSessions` in the heartbeat; `executor/candidates`; the relayed `executor/prepare` with its ledger check; the group's switch on the member set; `executorDaemonId` on the CP session row and on the shared-store session row. |
| F2a | The `host`-strategy shim launcher — the executor's own bundle as a host process with a private runtime root, a helper root and a unix-socket listener — and the daemon-side path derivation: the Git config directory, git-credential socket variable, MCP endpoint and credential helper derived from the reply's roots instead of constants (§5).                            |
| F2b | The executor facet: `sandbox.share`, the TLS-PSK listener and the byte pipe, `prepare` handling (reservation, environment, HOME seed, key, and the generation rule: join, attach and rotate, or refuse), the idle stop, the orphan reconcile, and joining the shutdown drain.                                                                                                  |
| F3  | The holder: `ExecutorPlane` and its `ShimEndpointProvider`, per-session plane resolution, the birth predicate with its recorded reason, launch retirement at idle and on a retired-launch refusal, failover, the lazy loss rule; and a two-daemon, one-CP integration fixture covering holder failover, executor loss and executor restart.                                    |
| F4  | The `microsandbox` strategy: "prepare an environment" split from "spawn the runtime" in the microsandbox driver, the pipe into the guest over agentd's TCP stream, the session's state in an executor-local mount.                                                                                                                                                             |
| F5  | Console: the group switch, per-daemon hosting and capacity, a session's executor or the reason it stayed home.                                                                                                                                                                                                                                                                 |

Documents travel with the code that changes them: the pointers in the group and
backend designs already exist, and the workspace model's tier rule gains its
executor arm with F3.

Calibration: the pool's remote path — `k8s/` plus the generic layer now in
`remote/` — is about three thousand three hundred lines and took five weeks of
commits, including claim, sleep and orphan machinery this design does not need.
About nine hundred of those lines are the generic layer, already extracted and
reused as is. The shim, at twice the size of that whole path, is reused unchanged.

## 13. Open questions

- **Width of the exec surface.** The shim exec handler admits a closed list of Git
  subcommands, and the same list (`workspace/git-command-policy.ts`) already gates
  the local microsandbox path, so the list is not a pool-only control and this is
  not a pool-versus-self-hosted split. The question is narrower: whether the `host`
  strategy on a trusted machine gets the same list. Proposed: yes, one list
  everywhere, widened where an operation needs it, so nothing loosens an existing
  local control.
- **The grace in the loss rule** (§7): how long the CP must have gone without
  hearing from an executor before a session is prepared elsewhere. Too short
  abandons uncommitted work on a machine that was only rebooting; too long leaves a
  session unusable. Proposed: ten minutes, a constant until someone needs a key.
- **How an executor learns its own address.** Proposed: the local address of the
  socket its control connection leaves from, since on a LAN that is the interface
  its peers reach it on. A multi-homed machine where that is wrong needs an
  override key, deferred until one exists.
- **Withdrawn consent.** What happens to sessions a machine already hosts when its
  owner switches `sandbox.share` off, or the group's switch goes off. Proposed: both
  switches gate `candidates` and the creation of environments, not attachment to
  one that exists, so nothing new is placed and existing sessions run until they
  retire.
- **Default for the group switch** (proposed: off, explicit opt-in).

## 14. Non-goals

- Cross-organization executors. An executor serves the group it belongs to;
  `executor/prepare` is checked against one organization's ledger, and a machine
  serving two organizations would need that check to span both.
- Turn-level migration or live movement of a running session.
- Durable environment storage across executor loss. Uncommitted work on a lost
  machine is lost; there is no PVC equivalent and none is designed.
- Adopting running VMs or detached shims across an executor restart (§9).
- NAT traversal, relays, or an executor behind a firewall the holder cannot reach.
- Changing `sandbox.backend`, `security.requireSandbox` or `runInSandbox`. §5 records
  the intended successors; they are separate changes.
- A member that lends compute and holds nothing — the `role: executor` of an earlier
  draft (§3). Later, if a group ever has such a machine.
- A placement policy key. v1 has one rule (§6); a `local-first` policy can return
  when someone shows the rule is wrong for them.
- Waking a stopped environment without the Control Plane. An admitted dial could
  start the shim itself, which would take the CP off the wake path as §6 took it off
  the re-dial path; v1 keeps one path, `prepare`.

## 15. Rejected

Shapes and mechanisms considered for the design:

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
  a signed token needs a key set to distribute and verify, and §6 gets the same
  guarantee from the two control connections that already exist — a per-session key
  the CP relays, not a signature it issues.
- **Routing the data path through the CP's WebSocket.** Puts the CP on the hot path.
  A relayed `prepare` is not that: it is one control request per launch, carrying
  which machine, which strategy and a key — control metadata of the kind the CP
  already stores — and no ACP frame, tunnel byte, secret or file ever follows it
  through the CP.
- **The duty term as the executor's fence** against a deposed holder's late
  `prepare`. The term is monotonic per duty group and a new group starts again, so a
  recompute that splits an agent's component would hand its rightful holder a lower
  term and have it refused. The pool fences its edge with the binding generation for
  the same reason, and the generation also names the launch, which is what makes a
  retransmitted `prepare` the same request (§6).
- **Symmetric daemon↔daemon links** where either side may hold the agent. The
  asymmetry (holder dials, executor listens) is what keeps one holder per agent.
- **A shared filesystem between members.** The daemon's local store is SQLite, Git
  on NFS is slow and lock-prone, microsandbox mounts are virtiofs, and it contradicts
  D8. Not worth the environment it would create.
- **Dialing a guest's published shim port directly** to skip the executor's pipe.
  Saves a small component and exposes every sandbox's shim on the LAN, where the shim
  authenticates nobody who dials it (§6): whoever reaches the port binds it.
- **The earlier dynamic-placement draft** (relay-level per-session machine choice,
  an agent materialized on every machine, CP-fired cron). Its goals are met by set
  placement, the ledger and this design; its cron half was rejected in the pool
  design's §9.
- **`sandbox.backend: none`** as an explicit "this machine runs unconfined on
  purpose" value. It would let a Linux machine that merely forgot to install bwrap
  look intentional and lose today's warning. The strategy table of §5 expresses the
  intent without a new value: a machine that does not list `srt` does not offer it.

Removed by the 2026-09-20 revision, each with the reason it went:

- **A hand-rolled holder↔executor protocol** — version negotiation, a mutual
  challenge–response over a link that might be plaintext, then `prepare`, `full` and
  `release` frames, then proxying. It authenticated the handshake and nothing after
  it, so provider credentials and agent secrets would have crossed in the clear a
  LAN that sandboxed agents share. It was a second protocol to version, fuzz and
  keep in step between members. And every frame it defined is either a control
  request the CP can relay or unnecessary. TLS-PSK is the challenge–response, done
  by a library, with encryption included.
- **A one-shot admission grant**, consumed by one dial. `ShimDialer` re-dials at
  half the binding credential's lifetime and after every dropped socket, so each of
  those would have gone back through the CP, and a CP outage would have ended every
  running spread session at its next renewal (§6).
- **Pushing the holder's shim bundle** with each preparation. It paired the two
  halves by construction, at the price of a code push on every session birth, to
  avoid a skew the shim's feature negotiation already handles (§4).
- **A CP fan-out of peer facts** to every member. The earlier text implied one and
  named no mechanism, and none exists. Building it would mean a broadcast path kept
  warm for a question a holder asks once per session birth, so the holder asks (§6).
- **Process-level facts in the heartbeat.** The strategy table and the endpoint
  change when a process restarts, not every fifteen seconds; registration and
  `capabilities/update` already carry facts of that kind (§6).
- **A provisional placement count on the holder**, for what it had placed since the
  last heartbeat. It patched over facts as stale as a heartbeat; facts pulled per
  birth are fresher than the patch, and the executor's atomic `full` is the backstop
  either way (§6).
- **A `draining` lifecycle phase** with a count of sessions still running: a
  protocol change and a console surface for a number the executor, which parses
  nothing, cannot compute. The existing shutdown drain already has the right shape
  (§9).
- **A timer-driven executor-loss state machine on the holder**, with a per-session
  "environment unreachable" state. It would be run by the one party that cannot tell
  a dead machine from a dead link, to reach a conclusion the CP's own heartbeat
  record already supports; asking at the next launch needs no state (§7).
- **Reporting the shim's paths in its hello.** The executor chose the root and
  already replies to `prepare`, so the answer travels there and the handshake does
  not have to change (§5).
- **A `release` message.** A second way to say what deleting the session's row
  already says, with a failure mode of its own when the message is lost; the
  reconcile acts on the row (§7).

## 16. Relationship to other documents

- [daemon-groups.md](daemon-groups.md) defines the member set this design places
  into; §5's operational prerequisites (shared store, re-cloneable workspaces) apply
  unchanged, and the shared store binds a member that only lends compute too,
  because its reconcile reads it (§7).
- [k8s-daemon-pool.md](k8s-daemon-pool.md) §4 and [git-workspace-model.md](git-workspace-model.md)
  §11 define the session-pod shape and the clone tier this design reuses; the
  workspace model's "tier a session is born in" gains an executor arm that always
  answers "clone". The pool's edge fence, the binding generation, is the fence on
  `prepare` too, and its §7 takeover trade-off does not carry over: rotating the key
  closes a deposed holder's pipe (§6).
- [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) defines the seam, the shim,
  the dial direction and the tunnel direction, which apply verbatim, and the binding
  proof, whose identity steps (1–5) §6 replaces with a TLS-PSK pipe keyed by the
  executor while keeping its locally minted session credential (step 6).
- [daemon-sandbox-backends.md](daemon-sandbox-backends.md) describes the backends a
  strategy wraps; the executor facet's `microsandbox` strategy is that backend with
  the session's state in an executor-local mount rather than on the VM's disks.
- [architecture.md](architecture.md) §9.1 is the trust model `host` relies on, and
  the hot-path goal of its §2 is the reason the data path never touches the CP.
