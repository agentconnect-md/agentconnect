# Session executors: spreading one agent's sessions across a daemon group

**Status:** Design, decided 2026-09-16 and revised 2026-09-20, before implementation
started. The revision replaced the hand-rolled holder–executor link with a `prepare`
the Control Plane relays and a TLS-PSK byte pipe (§6), fixed an admission grant that
would have ended running sessions during a Control Plane outage, and cut what v1
does not need (§14, §15). A second revision on 2026-09-21 took the group's shared
data-plane store out of the design entirely: the executor allocates each launch's
generation (§6), a relayed `release` retires an environment (§7), and the backstop
reconcile asks only the Control Plane and this machine's own retention (§7). The
feature-independent groundwork has landed — #2154, #2155, #2157, #2158, #2160,
#2161 and #2165 — and so have F1, F2a and F2b (§12). A third revision on
2026-09-24 brought in what the first had deferred: an agent names the strategy it
runs in and every machine offers a table of them (§5), runtime credentials are the
executor's alone (§8), `srt` becomes a strategy by wrapping the shim (§5), and the
local microsandbox path converges on the executor's (§11). Motivated by
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

| #   | Decision                | Outcome                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Unit of ownership       | Unchanged: the whole agent, held by one daemon through the duty ledger. No session-level duty.                                                                                                                                                                                                                 |
| D2  | Where a session runs    | On the holder itself, or on the **executor facet** of another daemon in the agent's group; the holder chooses, and the candidate least full for its capacity wins. Only `session`-isolated sessions spread; `shared` ones stay with the primary checkout.                                                      |
| D3  | What the user sees      | One concept: the daemon. The executor facet is a seam inside it, switched by one key, `sandbox.share`, default off. No separate executor component, install or role.                                                                                                                                           |
| D4  | The contract            | The shim protocol, exactly as the pool uses it against a session pod. ACP, exec, fs, skills and the credential and MCP tunnels all ride it. The backend behind the shim is private.                                                                                                                            |
| D5  | Direction               | The executor facet listens; the holder dials. Same rule as the pool: the shim never dials.                                                                                                                                                                                                                     |
| D6  | Control plane role      | Orchestration only: facts a holder pulls at session birth, a `prepare` and a `release` it relays after checking the ledger, a hint at where a session last ran, upgrades. Never on the data path. Placement is the holder's.                                                                                   |
| D7  | Execution strategies    | `host` (Linux) and `microsandbox` in v1, in that order; `srt` next, as an SRT boundary around the shim; `docker` and non-Linux `host` later. A machine offers a table of them, on by default and made available by its probes; an agent names one; placement is a match (§5).                                  |
| D8  | State location          | Clones and HOME live in an executor-local directory mounted into the environment, the local confined layout; a replaced VM keeps them. No mounts across machines, no shared filesystem.                                                                                                                        |
| D9  | Credentials             | Runtime credentials — sign-in, provider API keys — are the executor's own and never travel; one it lacks is a runtime `authRequired` error. The agent's environment and secrets travel from the holder over the encrypted link (§8).                                                                           |
| D10 | Upgrades                | The facet upgrades with the daemon through the existing CLI store and the CP-tracked `daemon/upgrade`. Hosted sessions join the daemon's existing shutdown drain; no phase is added. Environments survive as disks and directories; running processes do not.                                                  |
| D11 | Local convergence       | For sandboxing strategies: a local session runs through an in-process executor — no Control Plane, no pipe — so local and remote are one path per strategy. `microsandbox` first, then `srt`; the unconfined direct path stays (§11).                                                                          |
| D12 | Network assumption (v1) | Group members share a LAN. No NAT traversal, no relay. The link is TLS-PSK regardless: the assumption buys reachability and latency headroom, never a plaintext link.                                                                                                                                          |
| D13 | The link                | Two machines share one thing: a TLS-PSK byte pipe per session, under the unchanged shim protocol. Its key is minted by the executor, relayed by the CP with the `prepare` reply, outlives dials, and is replaced only by a newer launch's `prepare`.                                                           |
| D14 | No shared store         | Spreading depends on no shared data-plane store. The executor allocates its environment's generation, a relayed `release` retires it, and the backstop asks the CP for its agent and this machine for its retention (§6, §7). A shared store is optional and buys failover that carries session history (§13). |

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
  carries the shim itself and no runtime.
- **Git and workspace files.** Daemon-run Git crosses the shim's `exec` channel
  with the pool's `ShimGitRunner`, and workspace mutations cross its file channel,
  so a rename is the guest's own.
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
the shim path pays: daemon-run Git, local or remote, rides the shim's exec channel
inside the one WebSocket, as on the pool, and the executor holds one agentd stream
per pipe.

## 5. Execution strategies and capabilities

The executor facet implements the contract with a **strategy**, named after the
sandbox backends:

| Strategy         | Boundary                     | Needs                                                         | Status                                                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `host`           | none                         | a Linux machine that runs Node                                | v1, first                                                                         |
| `microsandbox`   | VM                           | Linux, KVM, msb + libkrunfw, the runtime image                | v1, second                                                                        |
| `srt`            | process (bubblewrap)         | Linux, bwrap, socat, rg on PATH, unprivileged user namespaces | next: an SRT boundary around the shim (below)                                     |
| `docker`         | container, optionally gVisor | docker or podman, the runtime image (already OCI)             | later                                                                             |
| `host` off Linux | none                         | macOS or Windows                                              | later: a non-Linux read path and a second look at the socket's protection (below) |

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
table. The console shows it only through the agent's strategy picker (below), with
each unavailable entry's reason. The table is a process-level fact, so it rides
registration beside `sandboxUnavailable`, not the heartbeat (§6).

### The machine's table and the agent's choice

**A machine offers every strategy by default; its probes decide which are available.**
The single-valued `sandbox.backend` becomes a table:

```json
"sandbox": {
  "host": true,
  "srt": true,
  "microsandbox": { "cpus": 2, "memoryMiB": 2048, "diskGiB": 10 }
}
```

Each value is `false | true | {…}`; a strategy with parameters takes an object, and
`true` means its defaults. The default is all three on. Configuring a strategy offers
it; its startup probe makes it available or records why not, and placement reads only
the effective table. On-by-default is safe only because every probe is cheap and has
no side effects: the microsandbox probe checks a usable `/dev/kvm`, and msb and
libkrunfw where the daemon's store already holds them, and installs and pulls
nothing — msb and the image are prepared by the first session that uses the strategy,
and the runtime table that preparation reads is recorded against the image's identity,
so a restart on the same image boots no preparation VM — and the backend's state
collection runs whenever the strategy is enabled, not only when it was the selected
backend. A mount layout a strategy cannot honor makes that strategy unavailable with
the validation error rather than refusing startup. `sandbox.env` and `sandbox.mounts`
stay where they are and apply to every sandboxing strategy.

`sandbox.backend` and `security.requireSandbox` retire together. A file that still
sets them is mapped once at startup, with a warning: either backend value gives the
default table, and `requireSandbox: true` is `host: false`. A machine that offers no
`host` refuses unsandboxed sessions, and a machine whose table has no available entry
refuses to start, which keeps today's fail-closed behavior. For that rule and for the
machine's own sessions, `host` is the direct local child and available on every
platform; the reading an executor reports to other members keeps `host` Linux-only
(above). An explicit `sandbox.backend: none` stays rejected (§15).

**An agent names one strategy.** `runInSandbox` gives way to `execution`, a strategy
slug. The user picks what sessions actually run in, instead of a boolean whose meaning
depended on the machine. The console offers the strategies available where the agent
is placed — a daemon's table, or for a group those at least one serving member offers —
each labeled with its boundary (none, process, VM, container), and shows an
unavailable one disabled with its probe's reason. It reads each machine's own table
from the daemon read model and, for the agent's saved placement, the table the agent
carries; a daemon that predates the table keeps a "Sandbox" choice sent as the legacy
boolean. A `shared` session runs on its holder, so for it the holder's table decides.
A pool agent's boundary is its pod, and the pool shows no picker. The Control Plane
validates `execution` against the same tables, which replaces today's two conflicts
("required by this daemon", "unavailable on this daemon").

Existing agents migrate once: `runInSandbox: false` becomes `host`; `true` becomes
the backend the agent's daemon last reported at registration, `srt` unless it runs
`microsandbox`; an agent with no daemon becomes `srt`. Registration reports the legacy
backend for exactly this purpose while a daemon still reads one (`sandboxBackend`,
beside the machine's own table in `strategies`). A daemon that predates the report
names no backend, so a placed, sandboxed agent keeps no strategy until that daemon's
first registration with a report. Until then the spec carries none and the daemon reads
`runInSandbox`. Every write of `execution` advances the agent's `configRevision`, since
the field rides the spec.

**No silent downgrade.** A session whose strategy is unavailable where it would run is
refused with the probe's reason; it never falls back to a weaker boundary. A session
keeps the strategy it was born with, as the workspace model's tier rule already
works: changing an agent's `execution` reaches only sessions created afterwards.

**The birth strategy is durable, on both sides.** Nothing reconstructs it from the
agent's current setting, which may have changed since:

- _The holder_ records the strategy in the session's birth verdict
  (`setSessionExecutor`), beside the executor it chose or the reason it stayed home,
  so a local session records one too. Every later launch — a restart, a re-dial —
  sends the recorded strategy and never asks the agent. A successor holder has no
  such row without a shared store, so the Control Plane keeps the strategy beside the
  executor in its hint of where the session last ran (§6), written from the same
  relayed `ready` prepare, and `executor/candidates` returns both; a successor with
  neither is launching a new session, not resuming one. A row written before this
  revision carries none and is filled once at upgrade with the agent's migrated
  `execution`, which is correct because no one can have changed it in between.
- _The executor_ already writes the strategy into its environment record
  (`<daemonRoot>/sessions/<leaf>.json`). A `prepare` for an existing environment that
  names a different strategy is refused as `strategy_mismatch`: it neither attaches
  nor rewrites the record, because the directory's state belongs to one boundary — a
  host tree is not a VM's mount. The holder surfaces the refusal as a startup error
  and does not recreate the environment, which would discard the session's work.

**Placement is a match.** The holder places a session on an executor whose effective
table offers the named strategy — its own machine included, which after §11 is the
same path. The executor's report has used the table since the first version, so the
change is only the ask: a slug where the boolean was.

**A Decision picks the runtime, never the strategy.** An agent's model selection
([decisions.md](decisions.md) §10.6) resolves the session's runtime, model and run
settings before placement, and placement then looks for a machine that can run and
authenticate that runtime with that model in the agent's strategy. The strategy stays
the agent's: it is a security boundary, and a model's judgment of the opening message
does not choose one; a target only another strategy runs falls back. Two reads keep
that order across machines:

- **Whether a rule's target is usable** is judged against the machines the session
  could land on, not the holder alone. For a birth that could be placed elsewhere —
  session-isolated, on a group, in a strategy that spreads — the holder asks
  `executor/candidates` before it evaluates, since placement needs the answer anyway,
  and the same answer serves both, so a birth still costs one round trip. A target is
  usable when the holder, or a candidate whose table offers the strategy and which
  authenticates the runtime, runs it. A runtime only another member offers is
  therefore not mistaken for unavailable. And a model the landing machine lacks is not
  accepted because the holder has it: placement lands a session only on a member
  whose catalog runs its runtime and model, and a holder whose own catalog does not
  keeps the session only when no member does.
- **The target's catalog is the strategy's.** A microsandbox environment runs the
  runtimes its image declares, not the ones installed on the host, so a rule naming a
  runtime the image lacks falls back instead of failing at startup.

Both need a catalog the candidates reply does not carry today: its runtime entries
hold an id and `authRequired`, no models. And the member's `facts/daemon-runtimes`
snapshot, the natural source, has one `models` list per runtime, taken from probing
the host install even when the machine runs microsandbox. With strategies side by
side that is not enough: the host store and the image can hold different versions of
a runtime, as the snapshot's separate `version` and `hostVersion` already admit, and
so advertise different models. A catalog of host model A and image model B would
accept A for a microsandbox session.

So the catalog is **per strategy**. Each runtime profile in the snapshot carries one
entry per strategy the machine offers — available or unavailable with a reason, the
advertised `models`, and their `modelsSource` — and each entry comes from the install
that strategy starts: the host store's probe for `host` and `srt`, and for
`microsandbox` a probe of the image's runtime, since the on-by-default probe boots no
VM. That probe is the first session an environment of the image opens for the
runtime: the model selector the runtime advertises there, in the guest and with the
session's own credentials, is what a separate probe session would read. The list is
recorded against the image's identity beside its runtime table
(`microsandbox/image-models.json`), so another build behind the same tag starts
without one. A recorded list reads as `cached` after a restart until that run's first
such session confirms it. Only this machine's own VM sessions contribute: an
environment it hosts for another member carries the holder's ACP stream, which the
executor never reads. An entry with no probe yet has no model list and stays
permissive, as a `cached` one already does in the activation check; so does an empty
list, which a runtime without a model selector advertises, and a member that reports
no entries at all. `authRequired` stays per runtime, because the
sign-in is the machine's whichever install reads it. The Control Plane copies, for
each candidate, the entries of the strategies its effective table offers, from the
same snapshot it already reads for `authRequired`; the holder's own entries come from
its local facts. The target check reads the entry for the session's strategy and
nothing else.

### The `srt` strategy: SRT around the shim

`srt` becomes a strategy by putting the whole shim inside an SRT boundary, the way a
pod or a VM contains it. Its launcher is the `host` launcher with `sandboxWrap` around
the shim's process, and every runtime, bridge and helper the shim starts inherits the
boundary. The policy is the executor's, computed from its own paths when the
environment starts; the holder sends none, and the `prepare` reply is `host`'s. The
alternative, a host shim that wraps each runtime it spawns, is recorded in §15.

A probe on Linux (bubblewrap 0.8, an unprivileged user, the real shim and holder
dialer) established that it works: a dial from outside the network namespace reaches
the shim's unix socket; reads of the daemon root and of other sessions, and writes
outside the session, are refused; two environments run side by side; the marked
sweep finds and ends sandboxed processes from the host. It also found what wrapping
the shim requires:

- **No parent-death descriptor.** The SRT provider hands bubblewrap stdio only, so
  fd 3 inside is not the daemon's pipe and the shim exits at once, believing its
  daemon gone. The launcher sets no `AC_SHIM_PARENT_FD`; the provider's own owner
  watch ends the sandbox when the daemon dies — measured within half a second of a
  SIGKILL.
- **SRT's proxy environment reaches the runtimes.** SRT isolates the network
  namespace and injects `HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY` and
  `NODE_USE_ENV_PROXY` for its bridge. The shim's base-environment allowlist drops
  them and the runtime has no network; forwarded, egress works.
- **The VM's rule for `.git`, not the local path's.** The outer deny on `.git/config`
  and `.git/hooks` also blocks the holder's own Git, which now runs through the shim
  inside the boundary: `git config` and `git remote add` fail with `EBUSY`. The deny
  exists because daemon-side Git runs outside the sandbox
  ([git-workspace-model.md](git-workspace-model.md) §11); here it runs inside, so a
  planted hook executes within the boundary, as in a VM. The runtime's inner profile
  keeps its own deny.
- **The shim's socket is inside what the runtime can write.** A host shim
  authenticates nobody who dials it, so a runtime can reach and replace the socket,
  and at worst take its own session's channel during a re-dial. That is the exposure
  a pod's loopback port and a VM's guest listener already have. Impersonating the
  shim to the holder needs the identity token, which exists only in the shim's memory.

Costs, from the same probe on built bundles with an echo runtime — relative, not
absolute:

| Path                                        | First echo                                    | Round trip p50 / p99 | Throughput   | Extra memory (PSS) |
| ------------------------------------------- | --------------------------------------------- | -------------------- | ------------ | ------------------ |
| Direct child, today's local `host`          | 11 ms                                         | 0.02 / 0.3 ms        | ~1,100 MiB/s | —                  |
| SRT around the runtime, today's local `srt` | 170–290 ms                                    | 0.02 / 0.1–0.24 ms   | ~1,100 MiB/s | 57 MiB             |
| Host shim                                   | 90 ms                                         | 0.18 / 1.2–1.9 ms    | ~85 MiB/s    | 61 MiB             |
| SRT around the shim                         | 240 ms; a later runtime in the same one 12 ms | 0.15 / 1.0–1.5 ms    | ~90 MiB/s    | 116 MiB            |

Start-up matches today's `srt`, and later runtimes in a live environment start
faster. The added round trip is negligible beside a model turn. Throughput falls to
the shim channel's, which a multi-megabyte tool output notices and ordinary ACP
traffic does not. Memory is the real cost: one shim process, about 60 MiB per session.

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
- The CP **relays `executor/prepare` and `executor/release`** (below) after checking
  the duty ledger.
- The CP's own session row records `executorDaemonId`, so the console can show it
  (§10). The CP also keeps a **hint** of where each (agent, session key) last ran,
  written when it relays a `ready` `prepare` as well as from the session report, so
  `executor/candidates` can answer a successor (below). The holder also records it
  locally, for its own sessions; nothing reads that column across machines.
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
control connections that already exist. It is used for three requests, and then
the machines talk to each other.

1. **`executor/candidates {agentId, sessionKey?}`** — holder → CP, at session birth
   or when a successor picks the session up. The CP answers the connected members of
   the agent's set whose executor facet is on, each with its effective strategy
   table, endpoint, capacity, `hostedSessions` and the runtimes it can authenticate,
   each with its entries for the strategies that table offers (§5).
   An empty answer carries its reason: the group's switch is off (§10), or no member
   shares. When `sessionKey` is named and the CP's hint for that (agent, session
   key) names an executor, the answer also carries `currentExecutorDaemonId` and, as
   `birthStrategy`, the strategy the session was born with (§5) — a **hint**, not an
   instruction (§7).
   These are **facts, never a choice**: the CP ranks nothing and recommends nothing, and
   placement stays the holder's.
2. **`executor/prepare {agentId, sessionKey, executorDaemonId, launchId, strategy, runtime, resources, image}`**
   — holder → CP. The CP checks the ledger: the requester holds the agent's duty
   (`DutyLeaseService.holdsAgent`, the read that already authorizes `duty/fetch`),
   and the target is a member of the agent's set with its facet on. It then relays
   the request to the executor over the executor's own control connection — the CP
   already carries scoped request/reply frames to daemons
   (`packages/control-plane/src/orchestrator/outbound.ts`). The executor reserves
   capacity atomically, creates the environment, seeds its HOME from the executor's
   own runtime sign-in (§8), starts the shim, allocates the launch's binding
   generation, mints a per-session pre-shared key, and replies
   `{generation, endpoint, psk, runtimeRoot, liveCount}` — `host` adds its helper
   root (§5), and `runtimeLaunch` when the request named a `runtime` (§8) — or `full`,
   or a refusal with its reason. The CP returns that reply to the holder. `launchId` is
   a uuid the holder mints per launch (below); `resources` and `image` matter to the
   `microsandbox` strategy only.
3. **`executor/release {agentId, sessionKey, executorDaemonId, launchId}`** — holder
   → CP, when the holder retires the session (§7). The same ledger checks as
   `prepare` **except the two consents**: neither the group's switch nor the
   executor's facet being on may block it, because withdrawn consent must still let a
   holder clean up what it placed. The executor stops the shim, removes the
   environment and its inventory record, and answers `released`, `unknown` or a
   refusal. An executor whose control connection is down answers `offline` from the
   CP's own record, and its backstop collects the environment later.

   `launchId` names the launch being retired, and it is a fence, not a label. A
   session key is derived from the conversation and outlives every launch under it,
   so without one a release that was retransmitted, or that the CP relayed after a
   `prepare` from the same holder, would delete an environment a **newer** launch had
   just created — prepares are ordered against each other (below), but a release and a
   prepare are two independent handler runs. An environment that has moved on to
   another launch answers `unknown`, which is also the answer for one that is not
   there at all: both mean "the launch you are retiring is gone", and both make a
   resend free. The holder therefore records the launch it last prepared for a session
   beside that session's executor — in the process that prepared it, since a restart ends
   every launch it could have named; what it cannot name, the backstop owns.

4. **The holder dials the executor's listener with TLS, using that key**, with the
   session leaf as the PSK identity. TLS-PSK authenticates both ends and encrypts
   the link with no certificates (the evidence closes this section): a dialer that
   does not hold the key fails the handshake, and so does a listener that does not.
   After the handshake the executor **pipes bytes** to that session's shim and
   parses nothing. Above the pipe runs the existing shim protocol, exactly as
   `packages/daemon/src/microsandbox/shim.ts` already runs it over an injected
   socket (`createConnection`): the dialer is handed a connected socket instead of
   opening one. How the executor reaches that shim is its strategy's, so the
   admission supplies a **connector** rather than a path: `host` connects the unix
   socket in the session's runtime root, and a VM opens agentd's TCP stream to the
   guest's loopback port (`microsandbox/tcp.ts`), which is the same stream the
   local backend already binds its own shim over.
5. **Binding is unchanged where it matters.** The session's binding credential is
   still minted locally by the holder's `ShimBindingRegistry`, scoped to a
   generation and a grant list — step 6 of cluster-spawn-and-shim.md §3. What
   replaces steps 1–5 of that proof, the pod's TokenReview, is one fact: _this pipe
   was authenticated for this session by a key its executor minted._ The dialer's
   identity check is an injected interface (`PodIdentityVerifier`), which
   TokenReview implements for a pod and a constant-time token compare for a local
   VM; for an executor it answers from the pipe. The key and the binding credential
   are two things: the first opens the pipe and is the executor's, the second scopes
   a session and is the holder's.

**The executor allocates the generation, and `launchId` names the launch.** The
binding generation belongs to the environment, and the executor is the single writer
of its own environments — it already persists the applied generation beside each one,
so a restart does not forget it. Nothing else has a counter that is both monotonic per
environment and reachable without a shared store, so the executor allocates: a new
launch gets **one past the last it applied**, and the `ready` reply names it so the
holder binds the shim there (`RemoteShimDriver` binds at whatever generation its
endpoint provider resolved). A holder mints instead a `launchId`, a uuid per launch,
which is the only thing `prepare` carries about identity:

- _The same `launchId`_ is the same logical request: a retransmission — both control
  connections' correlators resend an unanswered frame — or `resolve` asked again for
  the same launch. It joins the preparation in flight or returns the reply it already
  gave: the same generation, the same key, no rotation, no pipe closed. Without this a
  preparation slower than one acknowledgement timeout would run twice, and the second
  run would rotate away the key the first had just returned. The reply lives only as
  long as the launch does on the executor. Once the executor has stopped the
  environment for idleness, or has restarted, there is no reply to return, and it
  **refuses retryably** (`launch_retired`) rather than minting a second key for a
  launch it has already finished — which would hand a working key to whoever replayed
  that launch, a deposed holder included. The holder discards the launch and mints a
  new one, so every wake and every recovery advances the fence.
- _A new `launchId`_ is a new launch: generation = last applied + 1. For an
  environment that already exists it attaches — it starts the shim if the environment
  was stopped, mints a fresh key, and closes the pipe admitted under the old one. So
  the same frame is session birth, the wake of an idle environment, recovery after an
  executor restart, and holder failover; the ledger check names whoever sends it.
- _There is no stale generation to refuse._ A holder never proposes a number, so it
  cannot propose one that is behind. What replaces that refusal is an ordering
  argument, below.

**A deposed holder's late `prepare` must not win, and the CP makes that true.** Every
relay to one executor leaves over that executor's **one** control connection, so
arrival order at the executor is send order. The CP's handler therefore puts its
**last** duty read immediately before the send, with no await between the two
(`ws/handlers/executor.ts`): if holder A's final check passed before the duty moved
and holder B's passed after, A's relay is on the wire ahead of B's, and a holder that
was deposed while it was still looking membership up never reaches the wire at all.
The executor completes the picture by applying prepares in arrival order — nothing is
awaited between entering `prepare()` and recording the launch, and an environment a
`release` is removing retires the launch rather than making it wait, because a wait is
exactly what would let a later holder's prepare overtake it. An await inserted
anywhere in that chain is the bug; the tests on both sides pin it.

Dial and prepare are one request: literally §4's sentence, and on the holder
literally `ShimEndpointProvider.resolve`. The fence is the binding generation and
not the duty term, for the reason the pool gives at its own edge (k8s-daemon-pool.md
§2, §7): the term is monotonic per duty _group_ and starts again with a new group,
so a recompute that splits an agent's component would hand its rightful holder a
lower term and have it refused. The generation is a different monotonic counter
over the same ordering, and it belongs to the environment.

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
`prepare` naming a new launch, which the ledger check lets only the current holder
send and the ordering argument lets only the current holder reach.

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
   `session`-isolated, and some candidate's effective table matches the agent's ask
   and can authenticate the session's runtime. Memory is not part of it: a group's
   agents keep managed memory in the Control Plane by the placement rule.
3. **One rule selects.** The holder is itself a candidate, and the session goes to
   the candidate that would be least full with it: the lowest
   `(hostedSessions + 1) / capacity`, where capacity is the machine's own
   `limits.maxConcurrentSessions`. A candidate already at its capacity is skipped,
   and a tie goes to the holder, which costs no link. With equal capacities the
   ratio orders exactly as the raw count does, so a group nobody sized behaves as
   "fewest sessions wins" and still keeps the first session of an idle group at
   home; sized unequally — say 8, 2 and 1 for a large workstation and two small
   machines — the larger machine takes the larger share. There is no placement
   policy key and no separate weight. An earlier draft had a `spread` and a
   `local-first` policy; one rule has no configuration to get wrong.

`hostedSessions` counts a machine's own isolated sessions as well as the ones it
hosts for others, so the number means the same thing for every candidate, the
holder included; counting only what a machine hosts for others would make every
holder read its own load as zero and keep everything. An own session counts while
its runtime lives here, as the executor counts its shims: its own host, or its
agent's shared host with the session loaded, since worktree sessions share one.
An open row with nothing running (a reclaimed runtime, a stuck turn) holds
nothing, and a placed session's host on its holder is only a pipe, counted by
its executor. The counts are **advisory**
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

**Agent-scoped state.** A remote session holds nothing of the agent's beside its
own environment, as a session pod on the pool now holds only its own pod, so three
agent-scoped things each need a named source:

- _Managed memory._ Locally the runtime's memory root is a mount of the holder's
  scope directory, which cannot cross machines, so a managed tree on the holder's
  disk could not follow a spread session. That is settled at placement, not at
  birth: every agent placed on a group keeps its managed memory in the Control
  Plane (`home: control-plane`, [memory-evolution.md](memory-evolution.md) §3.2.1 —
  refused otherwise on create, edit and move, and existing agents are flipped at
  Control Plane boot), read and written by the holder over its control connection.
  The birth predicate therefore has no memory condition: an agent with no managed
  memory has nothing on the holder's disk to be cut off from, and a managed one is
  never daemon-homed on a group. The only remnant is a binding the boot-time flip has
  not reached yet, which is why the wire keeps a stay-home reason for it.
  Runtime-native state stays in the per-session HOME on the executor, as it does for
  every confined session.
- _Merge-when-ready._ On a self-hosted daemon the watcher runs in the holder process
  for local sessions; it does the same for a spread session, holding nothing on the
  executor.
- _The primary checkout._ Stays on the holder; it is not part of a clone-tier
  session's environment.

**A session that stays home says why.** The birth predicate's verdict is recorded
on the session and reported with its metadata: the executor it went to, or the
reason it did not spread — the agent is not placed on a group, the group's switch is
off, the session is `shared`, no candidate offers
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
an idle signal — has its shim, and its VM, stopped by the executor. That linger is
the only idle judge a hosted environment has: the machine's own sandbox idle sweep
skips it, because nothing local holds it and its holder is elsewhere. That frees its
slot, since capacity counts live shims and VMs; the directory stays. The next turn
finds no launch, mints a new one, and its `prepare` starts the environment again at
the next generation; a holder that kept the old launch would reuse a reply whose key
no longer opens anything, and no `prepare` would ever be sent. A dead holder's
pipes close by themselves, so nothing keeps running for lack of a judge.
_Retirement:_ the holder sends `executor/release` naming the launch it is retiring
(§6), and the executor stops the shim — waiting first for a launch still inside its
launcher, so no shim outlives the record that could have stopped it — removes the
environment and drops its inventory record. That is the whole of it when the executor
is reachable; when it is not, the holder is told `offline` and the backstop below
collects the environment later.

**When there is no holder.** A release can be lost, a holder can die between
deciding and sending, and an agent can be removed outright. So the executor keeps an
inventory of its environments labelled by agent id and session leaf — the pool's
claim labels — plus the generation it applied and when the environment was last
used, and reconciles it on a schedule as a **backstop**. It reads no store. Two
rules, both under the pool's orphan-reconciliation conditions (a grace period, and a
same-name replacement check so an environment a `prepare` or a dial touched after the
lookup is never the one deleted), and never while an admitted pipe is using the
environment:

- _The agent is gone._ The **CP** answers `agent/exists`, the request the pool's
  reconciler (`cli/reconcile.ts`) already sends, which an org-scoped connection
  answers for its own organization's agents. An agent the CP no longer knows has no
  sessions to retain.
- _Nothing has used it within this machine's session retention._ Neither a `prepare`
  nor an admitted dial for longer than the daemon's existing `sessions.retention`
  window, measured from a last-use stamp kept in the inventory record so a restart
  does not reset the clock. `retention: never` never discards.

The CP is deliberately not asked about sessions: its `SessionMeta` row is created
asynchronously from daemon reports and is kept after the session's content is
purged, so a missing row can describe a retained session and a present one an
already-purged session. And the executor **retains** everything when the CP cannot
answer: a lookup that cannot be made is not an absence.

Retention is the rule that replaces the store's session list, and it is a weaker
statement on purpose. It does not know that a session retired; it knows that this
machine has not been asked about this environment for as long as it keeps sessions
at all, which is the operator's own answer to "how long is work worth keeping". An
environment in use is kept however long its agent goes without a holder: retaining a
live agent's work is intentional, and unassignment is not an orphan signal. The
executor never judges dirtiness — a holder's `release`, a removed agent or an expired
retention is the only evidence it acts on.

There is no configuration consequence any more. An earlier draft had this reconcile
read the group's shared data-plane store, which would have made that store a
prerequisite of **sharing** and not only of holding — and, because a daemon has one
store for all its agents, would have put every ordinary agent on a lending machine
onto PostgreSQL (§15). Neither rule above reads a store, so a machine can lend
compute with nothing but its control connection.

**Holder failover.** The successor member claims the agent through the ledger as
today. It asks `executor/candidates` with the session's key; if the CP's hint names an
executor the answer carries it as `currentExecutorDaemonId` with the session's birth
strategy, and the successor sends its own launch's `prepare` there, naming that
strategy rather than the agent's current one (§5). The ledger now names the
successor, so the CP relays; the executor attaches, allocates the next generation,
rotates the key and
closes the deposed holder's pipe, and a predecessor's `prepare` that was authorized
before the duty moved is already on the wire ahead of it, while one authorized after
never reaches the wire (§6). The environment is still there — nothing on the executor
depended on which holder was driving it — so failover costs one relayed request and
a dial, not a re-preparation.

**Where the hint comes from.** The session report alone would leave a gap: it is
sent asynchronously, so a holder that dies after its `prepare` came back `ready` but
before its report lands would leave the successor with no hint, and placement would
then rank by load and could start the session somewhere else, away from its
uncommitted work. The CP relays that `prepare` itself, so it records the executor
when it relays a `ready` answer to the current duty holder, before the holder
receives the key. The hint is a small CP table keyed by (agent, session key)
that holds the executor's id and the time of the observation; nothing else is
stored in it. It is kept separate from the session row for three reasons. At
`prepare` time the CP knows the session key but not the session id the row is
keyed by. A row invented by the CP would appear in session listings before any
report. And it would fix visibility, which is first-wins, before the report that
classifies the session arrives.

Every observation carries a time: the CP's clock when the `ready` answer arrived,
or the report's own `ts`. An observation replaces the recorded one only if it is
newer, and a report also wins a tie. A report is therefore authoritative for
everything after the `prepare` it describes. A `prepare` answered before a newer
report cannot take the hint back. A re-emit written before the `prepare` and
delivered after it cannot either. A stayed-home verdict clears the hint but never
creates one, so a key that never ran remotely has no row. A key that has no hint
yet, because it last ran before the table existed, falls back to the newest
session row that names an executor. The two clocks are compared only where one
holder reports shortly after its own `prepare`, or where a later move follows a loss
grace. In the first case both observations name the same executor. In the second,
the gap is far larger than any plausible skew.

The hint is only a hint. Stale is harmless: a `prepare` at a machine that no longer
has the environment simply creates one, and an executor that is offline follows the
lazy loss rule below. Session keys are derived from the conversation's identity, so
a successor preparing the same session on the hinted executor lands on the same
environment leaf and attaches to the work already in it, uncommitted changes
included. What the successor does **not** get, without a shared store, is the
session's transcript or its ACP resume state: those live in the predecessor's own
store. That is what a daemon group already costs today when a duty moves without a
shared store, not a regression this design introduces — and it is the thing a shared
store buys (§13).

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
session whose runtime the executor cannot authenticate. The holder is held to the same
rule: it keeps a session home only if it authenticates the runtime itself, and
otherwise places it on a member that does. Only when no machine does is the session
kept home, where the runtime's `authRequired` is the error.

**The holder composes the launch in the executor's coordinates.** A placed session's
HOME, XDG directories and runtime state roots (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …)
are the session HOME on the root its shim reported — `ExecutorPlane.homeFor`, the
same derivation as the mount and the runtime root of §5 — which is the directory the
executor seeded. None of the holder's own environment travels with the spawn
request, nothing is seeded or linked on the holder's disk, and no boundary of the
holder's own is composed around it, neither an SRT policy nor its own microsandbox VM:
the executor's strategy is the session's boundary, whatever the holder's backend is.
The runtime's own tool sandbox is still the holder's to compose. A Codex session gets
the private-HOME profile under that HOME, and the exact write grants on its clones'
`.git` directories that a confined local session gets. The holder lists those clones
over the pipe before the launch and refuses a `.git` that is a link, as
[git-workspace-model.md](git-workspace-model.md) §11 does on its own disk. A pool
session's pod gets the same grants.
What only the executor can name comes from the executor: the HOME seed also answers
where that machine keeps a sign-in the HOME only points at — Claude's credential
directory, which the seed leaves out of the HOME — and the executor's shim fills that
in beneath whatever the holder sent. Those places, and the shared files the seeded HOME
links to (Codex's and Qoder's), are paths on the executor's host: a `host` shim already
sees them, and a VM strategy mounts them into the guest at the same paths, writable
for a token refresh, as the local VM already mounts them for its own sessions.

The runtime's adapter is the executor's too. A daemon launches a registry or managed
adapter from its own store (`node` and a bin path under its daemon root, resolved at
that daemon's start), so the holder's command names a tree only the holder has. The
holder names the session's `runtime` in `prepare`, and the executor answers
`runtimeLaunch`, the command and arguments that the environment it prepared starts it
with. For `host` that is what a local agent of that machine would start, installed in
its own store first if it has not been yet, the way it does for an agent assigned after
boot. For `microsandbox` it is the entry its image declares, which is what its own VM
sessions run. The holder launches with that command and keeps the rest of its own
definition. An executor that answers nothing, because it predates the field, has no
such runtime, or failed the install, leaves the holder's own definition in place,
which starts only where the executor's paths match. The runtime a session sees is
therefore the version that machine installed, as its sign-in is that machine's.

**Runtime credentials and the agent's secrets are two mechanisms**, and only the
second crosses the link — encrypted. The earlier text authenticated the dial and left
the link itself optionally plaintext, while its own §6 noted that sandboxed agents
share the LAN: an agent secret crossing in the clear is readable by anything that can
see the segment. TLS-PSK covers every byte above the handshake.

- _Runtime credentials_ — a runtime's sign-in, and the provider credentials
  `CREDENTIAL_PREPARERS` recognizes per runtime for known provider endpoints — are
  the executor's and never travel. The holder strips recognized provider credentials
  from a placed session's launch, including one configured as an agent secret, and the
  executor supplies its own, from the HOME it seeded and its own environment. An
  executor that has none fails the runtime's authentication, surfaced as the existing
  `authRequired`. A VM strategy protects them by hostname-scoped placeholder
  substitution on its own host, as the local VM does, and it can because the values
  are local: a VM's secrets are fixed when it is created or started, before any spawn
  request could carry one. The microsandbox launcher seeds a hosted HOME through the
  local VM's credential step for every runtime the machine admits: the VM starts with
  those secrets, the HOME holds placeholders where the raw files were, and the shim
  fills the placeholders and the proxy's CA in beneath the holder's environment. A
  runtime whose credentials cannot be protected gets no sign-in, never a plain copy.
  `host` still exposes the executor's credentials to its process tree. What a holder
  strips is each preparer's own list: the runtime's variable for the key it protects
  (`ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex, `DEEPSEEK_API_KEY` for
  DeepSeek) and the variables it binds a key to. The executor fills the same variables
  in from its own runtime definitions and environment, with a local launch's
  precedence, through the
  shim's seed beneath the holder's environment: `host` as values, and a VM behind the
  placeholders its preparers set, or as values where they set none, as a local VM
  receives an environment-only Claude or Codex key.
- _Everything else_ configured on the agent — its environment and its secrets
  (`runtimeOverrides.secrets`) — travels with the launch and enters the runtime's
  environment as a plain value on every backend today, with output masking as its
  only protection, and does so on an executor the same way. An executor can lack
  such a value but never hold a different one: it holds no agent (§3).
  A `host` executor exposes such values to the process tree; a microsandbox
  executor exposes them to the VM. Neither is a change from the local exposure.
  The one exception is a config-file secret (`KUBECONFIG_DATA`, `DOCKER_CONFIG_DATA`),
  whose value is a whole file and whose pointer names where that file is. The holder
  plans it as it plans a local one, but the files travel with the launch: its driver
  empties `<runtimeRoot>/config-files` on the executor and writes them there before the
  runtime starts, as it writes the session gitconfig, and the pointers name that path.
  Nothing lands on the holder's disk. A pool pod takes the same path under its image's
  runtime root.

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
`prepare` naming a new launch, which starts the shim again, allocates the next
generation and returns a fresh key. The generation each environment applied and the
launch it belonged to are both on disk (§6), so the restart neither loses the fence
nor reopens it: a `prepare` replayed for the launch the restart interrupted is
refused as retired rather than given a second key at the same generation, and the
next real launch is strictly above everything that environment ever handed out.

Nothing version-sensitive is pushed from the holder. The executor runs its own shim
bundle (§4), and the link has no protocol of its own to version: below the shim
protocol there is TLS and a byte pipe. The only skew left between a holder at N+1
and an executor at N is between the holder's dialer and the executor's shim, and
that is the shim protocol's existing feature negotiation — the same skew a pool
image's shim already has against its daemon. Members roll in either order. The two
CP requests follow the control protocol's own rule: a holder answered
`UNKNOWN_FRAME` by an older CP does not spread, and says so. The version-sensitive
values that do travel are names, not code. One is the `microsandbox` image reference
in `prepare`, so the runtimes a session sees in a VM do not depend on which machine it
landed on. The other is the `runtime` id, which the executor resolves to the install its
environment starts (§8). A CP or executor that predates that field drops it, and the
holder keeps its own definition.

## 10. Configuration and console

Daemon configuration grows **one** key, daemon-owned, inside `sandbox`:

```json
"sandbox": {
  "share": true
}
```

`share` is the executor facet switch and **defaults to off**: the listener opens
only when `share` is true and the effective strategy table has an available entry —
never merely because strategies are configured, since every one is by default (§5).
A machine that shares but has no available entry starts with the facet dark and says
why. Executor addresses and keys are not configured anywhere:
registration publishes the endpoint, and each session's key is minted at `prepare`.
There is no `role` key and no `placement` key (§3, §6), and capacity is the existing
`limits.maxConcurrentSessions`. Like `share`, it is the machine owner's: how much of
the machine its group may use, set in its local config file for a group of unequal
machines, and not among the keys `config/push` may set.

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

The console adds no new kind of row, and no per-daemon executor readout: the hosted
count, the capacity and the strategy table are reported for placement, not for
display (#2232 took them off the daemon card). A group has one switch, "spread
sessions across the group", default off. A session's detail shows
which daemon executes it, or why it stayed on its holder (§7). The agent's strategy
picker (§5) replaces "Run in sandbox". A group's runtime list names the members that
need a runtime login, since those are the machines whose sign-in a session would
lack (#2397).

## 11. Converging the local path

The holder's own machine is another executor, so for a sandboxing strategy a local
session and a spread one take the same path: the strategy's launcher prepares the
environment and `RemoteShimDriver` drives the shim in it. Today each strategy has two
— the local microsandbox VM is keyed, driven and reached for Git differently from a
hosted one, and a local `srt` session is a direct child with its own policy plumbing —
and a fix to one does not reach the other.

The local path reaches the launcher **in process**. It does not relay `prepare`
through the Control Plane, open a pipe or run the TLS-PSK handshake: a local session
must start and run while the Control Plane is down, as it does today. What is shared
is everything from the launcher down — environment keying, the shim channel for ACP,
Git, workspace files and tunnels, the credential preparers, lifecycle.

**`microsandbox` first.** The runtime already starts through the VM's shim both ways
(§4), and a VM already carries a shim, so converging costs no memory. What still
differs locally goes, in four steps that each land alone:

1. **Git and workspace files over the shim — landed.** Locally they ran over agentd
   exec, a shell wrapper around Git and a guest Python for renames. They now cross
   the shim's exec and fs channels, which the pool and executors use
   ([daemon-sandbox-backends.md](daemon-sandbox-backends.md) §3). The shim is in the
   guest, so its rename is the guest's, and the stale cached view that motivated the
   Python does not arise.
2. **The credential preparers in the launcher — landed.** One credential step
   (`microsandboxCredentialStep`) serves the local launch composition
   (`microsandbox/launch.ts`) and the hosted-VM launcher, so a hosted VM gets
   placeholder substitution for its executor's own credentials (§8) and a local one
   keeps it. The local launch still calls the step itself until step 4 routes it through
   the launcher.
3. **The launcher takes an environment, not a leaf — landed.** A `StrategyLauncher`
   derived everything from `(daemonRoot, sessionLeaf)`. It now starts an
   `EnvironmentDescriptor` — its id, workspace root, mounts, placeholder secrets and
   HOME seed, the shape `MicrosandboxEnvironment` had and is now an alias of — and
   `discard` finds one by its id. The facet builds the hosted descriptor from the leaf
   exactly as before (`hostedEnvironment`: `executor/<leaf>` over
   `<daemonRoot>/sessions/<leaf>`), after seeding the HOME through the launcher's own
   `seedHome` where it has one, so a VM's protected seed is in the descriptor before
   `start`. That seed readies the image first, as a start did, because a first use
   adopts the image's runtime table and the seed must cover its runtimes. The `host`
   launcher takes its roots from the descriptor. The local placement rule
   (`microsandbox/placement.ts`, behind `microsandboxPlacement` and
   `microsandboxContext`) yields the same type: `agent/session-…` for a
   session-isolated session, and `agent/agent` or `agent/<host key>` for a `shared` or
   retained legacy one, with the agent's own mounts. Local launches do not go through
   the launcher yet; step 4 passes that descriptor straight through. Identities do not
   change, so every existing VM, disk and binding is adopted as it is and **nothing is
   migrated**. The remote contract does not change either: a relayed `prepare` names
   only a session leaf, so an agent-scoped environment is unreachable from another
   machine by construction, and the two id spaces already cannot collide
   (`HOSTED_PREFIX`).
4. **An in-process executor entry.** `ExecutorPlane` gains a local provider that calls
   the launcher with the local descriptor, and `RemoteShimDriver` binds the shim as it
   binds any executor's, with this daemon's own generation allocator. The manager's two
   shim modes become one: a local VM starts its shim exposed, as a hosted one does
   (`startGuestShim`), and the bound mode (`startMicrosandboxShim` binding in place)
   retires with the rest of the local wiring — the manager-driven launch and the local
   Git runner selection. Every caller of the manager's `withShim` moves with it, not
   only Git: the workspace-file requester, the skill reads and the skill reconcile in
   `daemon.ts` need a bound channel when no runtime is running, and take it from the
   plane's `withEnvironment` (`ensureChannel` binds the shim without starting a
   runtime and holds the environment against the idle sweep), as a placed session's
   workspace already does. Lifecycle stays with the environment's owner: a local
   environment keeps the manager's session idle policy and the workspace model's
   retirement, and a hosted one keeps the facet's linger, `release` and backstop, which
   never look at `agent/` ids.

**`srt` second**, on §5's launcher from its first version, local and remote at once.
The local direct SRT launch retires with it — the provider around each runtime, the
per-host settings and temp directories, the host-socket injection for MCP and
credentials, the local Git runner for confined sessions — and one `srt` policy
remains. It needs steps 3 and 4 first: a `shared` confined agent runs in an
agent-scoped descriptor through the in-process entry, one SRT-wrapped shim per host
key as today's local path runs one ACP host per host key. It costs a shim per
environment (§5).

**The unconfined direct path stays.** Local `host` is a child process with no
boundary to share. Routing it through a shim would add a process and a socket to the
simplest install (§5's measurement) and remove nothing. The pool is unaffected.

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

**The feature is seven pull requests.** The earlier estimate of three weeks of
focused work predates both the groundwork and the cuts, and each shortens it; the
week of validation on a real multi-machine deployment, which the requester of #2111
offered to run, stands. All seven have landed; F1b is the revision that took the
shared store out.

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Protocol and CP: the executor facet, effective strategy table, endpoint and session capacity at registration and in `capabilities/update`; `hostedSessions` in the heartbeat; `executor/candidates`; the relayed `executor/prepare` with its ledger check; the group's switch on the member set; `executorDaemonId` on the CP session row and on the shared-store session row.                                                                                                                     |
| F2a | The `host`-strategy shim launcher — the executor's own bundle as a host process with a private runtime root, a helper root and a unix-socket listener — and the daemon-side path derivation: the Git config directory, git-credential socket variable, MCP endpoint and credential helper derived from the reply's roots instead of constants (§5).                                                                                                                                                |
| F2b | The executor facet: `sandbox.share`, the TLS-PSK listener and the byte pipe, `prepare` handling (reservation, environment, HOME seed, key, and the generation rule: join, attach and rotate, or refuse), the idle stop, the orphan reconcile, and joining the shutdown drain.                                                                                                                                                                                                                      |
| F1b | The shared store leaves the design: `launchId` on `prepare` and the executor-allocated `generation` on its reply, the CP's adjacency of the last duty read and the send, the relayed `executor/release`, the `sessionKey` hint on `executor/candidates`, and the backstop reconcile on `agent/exists` plus this machine's retention. The holder side that SENDS a release is F3.                                                                                                                   |
| F3  | The holder: `ExecutorPlane` and its `ShimEndpointProvider`, per-session plane resolution, the birth predicate with its recorded reason, minting a `launchId` per launch and binding at the generation the reply returns, launch retirement at idle and on a retired-launch refusal, sending `executor/release` at retirement, failover through the candidates hint, the lazy loss rule; and a two-daemon, one-CP integration fixture covering holder failover, executor loss and executor restart. |
| F4  | The `microsandbox` strategy: "prepare an environment" split from "spawn the runtime" in the microsandbox driver, the pipe into the guest over agentd's TCP stream, the session's state in an executor-local mount.                                                                                                                                                                                                                                                                                 |
| F5  | Console: the group switch, and a session's executor or the reason it stayed home. Per-daemon hosting and capacity landed with it and were removed in #2232.                                                                                                                                                                                                                                                                                                                                        |

Documents travel with the code that changes them: the pointers in the group and
backend designs already exist, and the workspace model's tier rule gains its
executor arm with F3.

Calibration: the pool's remote path — `k8s/` plus the generic layer now in
`remote/` — is about three thousand three hundred lines and took five weeks of
commits, including claim, sleep and orphan machinery this design does not need.
About nine hundred of those lines are the generic layer, already extracted and
reused as is. The shim, at twice the size of that whole path, is reused unchanged.

**The 2026-09-24 revision** adds the following. S1, S2a, S2c, S3, M1, M2 and M3 have
landed and the rest have not started. Each lands alone; S1–S3 are one feature, S2
lands in three parts, and M1–M4 precede R1.

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Protocol and CP: the agent's `execution` slug beside `runInSandbox`; the daemon's own effective strategy table at registration, in the executor report's shape, and its legacy backend for the migration; the one-time backfill; validation of `execution` against the placement's tables in place of the two sandbox conflicts; per-strategy runtime entries in `facts/daemon-runtimes` (availability, `models`, `modelsSource`) and those entries on each candidate runtime, the birth strategy in the CP's hint, and the `strategy_mismatch` refusal. |
| S2a | Daemon: the `sandbox` strategy table with the legacy mapping and on-by-default probes, reported at registration and by the facet in place of S1's reading of the single backend; launch dispatch on the agent's strategy instead of `sandbox.backend`, `srt` and `microsandbox` side by side in one process with a runtime catalog per strategy; refusal instead of downgrade; per-strategy entries in `facts/daemon-runtimes` from the host probe; the placement ask by strategy slug, `srt` staying on its holder until R1.                            |
| S2b | Daemon: the birth strategy in the session's verdict, its upgrade backfill, and the executor's `strategy_mismatch` refusal.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S2c | Daemon: the image runtime's model probe per image identity; model selection judging targets against the candidates and the strategy's catalog, and placement landing a session only where its runtime and model run (§5).                                                                                                                                                                                                                                                                                                                                |
| S3  | Console: the strategy picker per placement, boundary labels and unavailable reasons; the pool shows none.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M1  | Local microsandbox Git and workspace files over the shim's channels (§11 step 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M2  | The credential preparers in the microsandbox launcher (§11 step 2, §8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M3  | The launcher takes an environment descriptor instead of a session leaf: hosted and local descriptors, identities unchanged, nothing migrated (§11 step 3).                                                                                                                                                                                                                                                                                                                                                                                               |
| M4  | The in-process executor entry: local microsandbox launches through it, a local VM's shim starts exposed and `RemoteShimDriver` binds it, every `withShim` caller (Git, workspace files, skills) moves to the plane's `withEnvironment`, and the bound shim mode retires (§11 step 4).                                                                                                                                                                                                                                                                    |
| R1  | The `srt` strategy (§5): the launcher, the three changes the probe found, the executor's policy; local `srt` launches through it and the direct SRT launch retires.                                                                                                                                                                                                                                                                                                                                                                                      |

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
  retire. Settled for deletion: neither switch gates `executor/release` (§6), because
  a holder must be able to clean up what it placed while consent still stood.
- **Default for the group switch** (proposed: off, explicit opt-in).
- **What a shared data-plane store would still buy.** Nothing here needs one any
  more, and a group that has one gains one thing: a successor holder inherits the
  session's transcript, and for a session placed on an executor its ACP resume state
  too, instead of attaching to the environment with the work in it but no history
  (§7). A session that ran on its holder keeps its runtime state on that machine
  either way. That is a property of the group, not of spreading: a group without a
  shared store already loses a session's history when a duty moves, spread or not.
  The store backend became a daemon setting in
  [#2188](https://github.com/agentconnect-md/agentconnect/issues/2188)
  ([cloud-data-plane-postgres.md](cloud-data-plane-postgres.md)); a daemon still
  opens one store for all its agents, which is precisely why requiring it here would
  have put every ordinary agent on a lending machine onto PostgreSQL (§15).

## 14. Non-goals

- Cross-organization executors. An executor serves the group it belongs to;
  `executor/prepare` is checked against one organization's ledger, and a machine
  serving two organizations would need that check to span both.
- Turn-level migration or live movement of a running session.
- Durable environment storage across executor loss. Uncommitted work on a lost
  machine is lost; there is no PVC equivalent and none is designed.
- Carrying a session's transcript or ACP resume state across holder failover. That
  needs the group's shared data-plane store, which this design deliberately does not
  require (§13); without one a successor attaches to the environment and its work,
  and starts a fresh conversation over it. The store itself is a separate daemon
  setting ([#2188](https://github.com/agentconnect-md/agentconnect/issues/2188)).
- Adopting running VMs or detached shims across an executor restart (§9).
- NAT traversal, relays, or an executor behind a firewall the holder cannot reach.
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
- **SRT around each runtime, under a host shim**, for the `srt` strategy. The probe of
  §5 ran it too, and it works with no change to the shim: the provider is already in
  the shim's bundle, the runtime gets SRT's proxy environment directly, the shim's
  socket is outside the boundary, and the holder's Git keeps the local path's `.git`
  deny. But someone has to compose each launch's policy, and neither choice holds up.
  The holder cannot: the executor would have to apply grants a peer machine sent it.
  The executor can only by taking over the launch composition that depends on agent
  configuration, which is most of `launch/prepare.ts`, plus a spawn-request field and
  a sandbox branch in the shim's runner. It also pays SRT's start-up on every runtime
  rather than once per environment. Wrapping the shim keeps the policy the executor's
  alone, changes no wire, and matches the boundary pods and VMs already draw.
- **Carrying provider credentials from the holder** to an executor. It keeps a
  per-agent provider key in force wherever a session lands, but puts a runtime
  credential on the link, and a VM's placeholder secrets are fixed at start, before a
  spawn request could deliver one. The executor's own credentials, and an
  `authRequired` when it has none, are simpler and match what already happens for
  sign-in (§8).

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
  reconcile acts on the row (§7). _Reinstated on 2026-09-21_, because the row it was
  redundant with lived in a shared store this design no longer has; the failure mode
  is real and is what the backstop reconcile now covers (§7).

Removed by the 2026-09-21 revision:

- **Allocating the launch's binding generation from the group's shared store.** It
  was the natural place — `LaunchRegistry.recordLaunch` already allocates per subject
  there — but the daemon opens **one** store for all its agents, and at the time only
  under `--k8s` (#2188 has since made it a setting, still one store per daemon). Requiring it
  would have made a machine that merely lends compute run every one of its own
  agents on PostgreSQL, which is precisely the cost the requester of #2111 does not
  want and #2188 exists to remove. Allocating on the executor needs no store at all,
  and is better placed besides: the executor is the single writer of the environment
  the generation fences.
- **Reading a successor's executor from the shared store's session row.** Same store,
  same cost. The CP already relays every `prepare` and receives every report, so
  it keeps the hint itself and `executor/candidates` returns it. A hint is all it
  has to be, since a wrong one costs a `prepare` that creates rather than attaches
  (§7).
- **Reading session existence from the shared store in the reconcile.** Same store,
  same cost, and it made sharing depend on a connection the sharing machine has no
  other use for. `agent/exists` plus this machine's own session retention answer the
  same question conservatively, and both are already there (§7).

## 16. Relationship to other documents

- [daemon-groups.md](daemon-groups.md) defines the member set this design places
  into; §5's operational prerequisites apply unchanged to a member that **holds**,
  and a member that only lends compute needs none of them: its executor facet reads
  no store, so sharing costs nothing but the control connection it already has (§7).
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
