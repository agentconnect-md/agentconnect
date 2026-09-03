# Cluster Spawn and the In-Sandbox Shim

How a daemon runs an agent's ACP runtime in a Kubernetes sandbox pod instead of as a
local child process, and how the two halves talk. Companion to
[cli-daemon-split.md](cli-daemon-split.md) §7 (trust boundaries) and
[daemon-detailed-design.md](daemon-detailed-design.md) §2.6 (`--k8s`).

Staged scope: this describes the mechanism. The hardened security model — an isolating
runtimeClass, admission policy, egress control, and a managed egress proxy so a provider
key never enters the sandbox — is a separate, later plan. Until it lands, the pod and the
shared Sandbox namespace are the only isolation boundaries, and a provider key is present inside
the sandbox, so this shape suits internal dogfooding and self-hosted
bring-your-own-key. A cloud daemon accepts the shared `MODEL_BASE_URL`/`MODEL_TOKEN` pair,
or a runtime-scoped one that replaces it whole (`ANTHROPIC_MODEL_*` for Claude,
`OPENAI_MODEL_*` for Codex, `DEEPSEEK_MODEL_*` for the DeepSeek Harness), and translates it for
that runtime at spawn; a configured key server replaces the static token with a session-scoped
pair. The runtime image still accepts the legacy deployment-owned `AC_CLAUDE_BASE_URL`/`AC_CLAUDE_API_KEY`,
`AC_CODEX_BASE_URL`/`AC_CODEX_API_KEY` and `AC_DEEPSEEK_BASE_URL`/`AC_DEEPSEEK_API_KEY` pod
variables as fill-ins, but a daemon-sent value wins — including for DeepSeek Harness, whose
`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` the daemon now writes itself; the pod variables remain
its floor, since a sandbox seeds no `$DSH_HOME` credential store. See
[key-server.md](key-server.md) for precedence and lifecycle. A sandbox also seeds no `$DSH_HOME` PRESET, which the shim
supplies before that runtime launches: the image bakes a copy of the harness's shipped `standard`
preset with `web_search` deregistered, and the shim copies it into `$DSH_HOME/.agent-presets` and
names it the default — a floor rather than a lock, since a client can still switch a blank session to
a shipped preset through the ACP `agent` option. The tool cannot work in a pod — the harness's search provider ignores
`DEEPSEEK_BASE_URL` and takes `DEEPSEEK_API_KEY` to api.deepseek.com itself, so a gateway key fails
every search as an invalid key — and dropping the row is only possible as a whole preset file, since
the host-plane patch layer cannot reach into a preset subtree. A deployment whose sandbox key reaches
the real API sets `AC_DEEPSEEK_WEB_SEARCH=on` (chart: `daemonPool.runtime.deepseekWebSearch`) and
keeps the shipped preset. The pod may also carry
`AC_CODEX_CONFIG`, a JSON object of codex session config the deployment asserts about its
endpoint (for example, disabling a feature whose request shape the endpoint's gateway
rejects); the shim merges it under any daemon-sent `CODEX_CONFIG`, one level deep for a table
both carry (the daemon always sends `features`), so every leaf the daemon decided stays
authoritative.

The daemon carries one more deployment assertion of the same kind for Claude: the
`ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` variables and their `_NAME`,
`_DESCRIPTION` and `_SUPPORTED_CAPABILITIES` suffixes, which say which concrete model each
Claude alias resolves to behind this deployment's endpoint. Claude Code offers an alias it
was told nothing about only when the signed-in account's own rollout list names it, and a
gateway-backed pool has no such list — so without a declaration its model picker is the
built-in aliases and nothing else, which is why a pool that serves Fable never offered it.
The daemon reads them at boot (`--k8s` only; a self-hosted launch inherits the host
environment already) and writes them onto BOTH the spawn env and the cluster probe's, so the
picker the console shows is the one a session can actually run — the probe env allowlist
carries the same names for the same reason. Written like the codex floor: last, and never
over a key the daemon itself authored. A sandbox minted before the value changed still gets
it, because the daemon writes it rather than the frozen pod spec. The pool's shared probe
answer is keyed on the image PLUS a digest of these declarations (and the codex floor), since
changing one is a rollout that replaces env and not the image tag: keyed on the image alone, a
member the rollout started would inherit an answer produced without the new declaration and
advertise it until its next restart while its sessions ran with it.

## 1. Why a seam at all

`AcpHost` used to own two unrelated jobs: the ACP protocol, and the mechanics of a child
process (PATH resolution, sandbox wrapping, process groups, signal escalation). Only the
first is about ACP; the second is about _where the runtime lives_, which is exactly what
changes when it moves into a pod.

`SpawnDriver` (`src/acp/spawn-driver.ts`) is that seam. It is deliberately narrow — a
byte-stream pair plus a lifecycle:

```ts
interface SpawnedRuntime {
  toAgent: WritableStream<Uint8Array>
  fromAgent: ReadableStream<Uint8Array>
  onExit(listener: () => void): void
  stop(deadlineMs: number): Promise<void>
}
```

`ndJsonStream` and the ACP client were already transport-agnostic, so the protocol layer
never needed to know about processes.

Two resolutions live _below_ the seam rather than above it: the command lookup and the
`CLAUDE_CODE_EXECUTABLE` fallback. Both search a filesystem, and only the driver knows
which filesystem the runtime will see — a daemon-side lookup would hand a sandbox pod
absolute paths from the daemon pod. The host states the policy as a declarative hint; the
driver performs the lookup where it applies.

## 2. The shim, and why the daemon dials it

Once the runtime is in another pod, everything the daemon used to do by sharing a
filesystem and a set of unix sockets needs an explicit protocol: materializing secrets and
config files, proxying the git-credential socket, the MCP bridge, and the whole workspace
git orchestration. The **shim** is the thin arm inside the sandbox that performs those, and
it holds no policy — every decision stays in the daemon.

The tunnel names a **closed set** of daemon-side servers (`gitcred`, `mcp`) at paths the
runtime image fixes. `gh`'s token helper is not among them because it shares `gitcred.sock`
with the credential helper: a second name would be a second in-pod path onto one server.
`mcp` is served for every pod agent, because any session may carry tools and the listener belongs
to the pod's lifetime; the `mcpServers` spec that dials it is decided per session instead.

That spec is in **pod coordinates**, and the launch half of it is reported by the image rather
than assembled here: the runtime probe answers with the interpreter and the bridge bundle (a
fourth single-file shim artifact, spawned by the agent's harness once per session), and the daemon
copies both into `mcpServers` beside the tunnel's in-pod socket. Even `node` by name would be an
assumption about a filesystem and a PATH the daemon cannot see. An image built before the bridge
reports neither and gets no tool server at all, which is the honest outcome: the daemon's own
bridge path sent into a pod is not a degraded spec but an unspawnable one, and a runtime handed it
retried a missing module on a backoff for the life of the session.

The `mcp` stream is also the one tunnel with no idle deadline. A credential stream is one request
and its reply, so silence means no answer is coming; the bridge holds a single connection for the
life of an ACP session and is idle between tool calls, and ending that is the agent losing its
tools mid-session. Its bound is the channel: a lost or superseded one stops every stream.

**The shim listens; the daemon dials the ready pod's IP.** The Sandbox status already reports
the backing pod's addresses, so no per-sandbox Service is required. The sandbox
NetworkPolicy is now a single coarse ingress rule — the pool namespace to the fixed shim
port — which replaced the per-envelope sandbox→member egress allowances when the per-org
envelope was deleted. The daemon no longer exposes a shim listener. This
direction is what makes the daemon pool possible: the duty holder dials the
sandbox it owns without publishing a callback endpoint for every daemon. What
"duty holder" means — the pool, the lease ledger, the heartbeat exchange, and
the activation rendezvous — is [k8s-daemon-pool.md](k8s-daemon-pool.md).

The daemon pool and agent sandboxes are separate namespaces. The runtime plane requires
`AC_K8S_SANDBOX_NAMESPACE` and uses it for every `SandboxClaim` and `Sandbox` request; it never
defaults to the namespace mounted into the daemon Pod's ServiceAccount.

Runtime probes use a member-hashed claim name plus an expiry annotation, so simultaneous member
startup never races on one probe claim and a missed teardown cannot retain a Sandbox forever: the
pool's orphan reconciler collects an expired one ([k8s-daemon-pool.md](k8s-daemon-pool.md) §3–§4).
That one sandbox answers both halves of the probe — the image's runtime table over the `probe`
channel, then the runtimes it named, RUN over the `acp` channel to read the models they advertise —
so the probe claim is granted exactly `probe` + `acp` and nothing else. A second claim for the
second half would cost another pod for an answer this one can already give.

## 3. Binding: proving which pod accepted the connection

A shim connection must be bound to the pod it claims to be, before it is given anything.

Two tempting shortcuts are wrong, and both were rejected explicitly:

- **A bootstrap token in the SandboxClaim.** A claim carrying non-empty `env` bypasses
  warm-pool adoption, and claim env does not propagate to a rebuilt pod — so after a
  resume or an eviction the pod would hold only an exhausted token and the wake path would
  deadlock.
- **Trusting the dial target's IP.** Pod IPs are reusable and the Sandbox status that mirrors
  them is asynchronous. The address selects where to connect, but never authenticates the
  peer; the projected token and exact launch-record match remain the trust inputs.

What is used instead is the pod's own Kubernetes credential:

1. the pod template mounts an **audience-restricted projected ServiceAccount token**
   (minute-scale TTL, rotated by the kubelet, invalid the moment the pod is gone) and pins
   a dedicated runtime ServiceAccount that holds **no RoleBindings**. Audience-restricted
   plus permissionless means the token is useless anywhere except proving "I am this pod"
   to this endpoint;
2. after the Sandbox is Ready, the daemon reads its pod name and IP and connects to the shim;
3. the daemon sends the agent id and generation it expects, and the shim answers with its
   projected token;
4. the daemon calls **TokenReview** with the expected audience — omitting the audience
   would accept a token minted for something else entirely — and takes the bound pod
   name/UID from the response;
5. the reviewed pod name must exactly match the launch record used for this dial. No match,
   no binding: an authenticated sibling pod binds to nothing;
6. **only then** is a session credential issued, short-lived and bound to this pod and
   generation.

Because the identity is the pod's own rotating credential, first bind, resume from
suspension, and eviction/rescheduling are indistinguishable to the protocol: each new pod
simply presents its own token. There is no one-shot token that can be revived.

Rejections carry one coarse reason and a message that names no pod, token, or agent.

The same proof runs in the other direction one hop up: a daemon Pod the
deployment placed authenticates to the control plane with its own
audience-scoped projected token, verified there rather than here. See "Identity
is per Pod, not per org" in [k8s-daemon-pool.md](k8s-daemon-pool.md) — the
audiences differ, so neither token is accepted at the other end.

## 4. The five invariants, and where they are enforced

1. **Mutual authentication** — the shim proves its pod through TokenReview; the daemon
   proves itself by being the only party that can issue a working session credential.
2. **Binding identity** — a connection is bound to (sandbox UID, pod UID, org, agent,
   generation), and only to a pod matching a live spawn record.
3. **Per-operation capability** — holding the channel is not holding every operation on
   it. Each request is authorized against the grants of that launch, so one runtime can
   never reach another's credentials.
4. **Replay fence** — every post-binding frame carries its generation; a frame from a
   previous pod incarnation is refused, and a re-bind drops the superseded credential.
5. **No long-lived credential in the sandbox** — what the shim holds expires and is
   re-obtained by re-handshaking. It never holds an org-scoped credential.

These are enforced through **one predicate**, `ShimBindingRegistry.authorize`
(`src/shim/binding.ts`): credential (compared in constant time), expiry, generation,
capability. There is no other way to turn a credential into a binding, so a channel added
later cannot accidentally skip a check — an invariant is only as strong as its weakest
enforcement point, and spreading these across call sites is how one gets missed.

The shim re-checks the credential, generation, and grant before serving, rather than
trusting that the daemon already did. That is deliberate redundancy on the boundary that
matters most.

## 5. What is not in the channel

The workspace git orchestration is _executed_ in the sandbox through the shim, but its
logic stays in the daemon. Moving that logic into the shim would look like code reuse and
would actually be a trust-boundary move: the shim is the half-trusted side.

`exec` takes an argv array and never composes a shell string, and path containment is
re-checked on the shim side — a daemon-side check cannot assume anything about the shim's
environment. That re-check covers the `cwd` **and** a clone's target, which is a path in
argv the cwd fence never looks at.

The `read` channel — the console's workspace file list/read/write/delete — is the one place
where the rule above inverts, and for a reason that is the rule rather than an exception to
it. There is no orchestration to keep: the daemon names ONE operation and the file work is
placement, not policy. So the shim runs the _same_ `localWorkspaceFiles` implementation the
daemon runs for a local workspace, which means its containment is not a second version of
the daemon's checks that could drift from them — it is those checks, executing on the side
that holds the filesystem. The daemon still decides which agent, which root, and whether the
workspace may be written at all, and sends that answer with the request; the shim fences the
root it was given against its own workspace root and enforces the write gate again.

Two refusals travel as DATA in the reply rather than as an error frame: a containment
violation (with its machine-readable reason) and an optimistic-concurrency conflict. An error
frame carries only a string, and the console needs to tell "that path is not readable" from
"the daemon may be offline" — flattening them would make a contained path escape look like an
outage. Everything else stays an error frame, which is what an unexpected `EIO` should read as.

**The pod side holds descriptors, not names.** This is the one place where the two halves run
different code, and the reason is that they stand on filesystems with different owners. A
self-hosted daemon's workspace is on its own disk; a cluster agent's is on a volume that agent's
runtime writes to, and there every "check this path, then act on this path" is a window it can
open — rename the checkout aside, install a symlink, let the work follow it, restore the original
before any closing check. No amount of re-validating the name closes that, because a name is not a
directory. So `shim/fd-workspace-files.ts` resolves exactly one path — the mount, which cannot be
renamed out from under itself — and takes every step below it from an open descriptor, one
component at a time with `O_NOFOLLOW`.

Three consequences worth stating plainly:

- It is **Linux-only**: Node exposes no `openat`, so the descent addresses handles through
  `/proc/self/fd/<n>`. That is fine for an image the deployment controls and is exactly why this
  lives in `shim/` rather than in the shared placement layer.
- A **symlinked directory inside the workspace is refused** rather than resolved, which the
  daemon-local path allows. It is the only behavioural divergence, and it is pinned by a test. A
  side effect is that the pod side stops distinguishing "absent" from "outside" for such a path,
  closing an existence oracle the local path still has.
- What the two DO share is every rule about the answer — the sort, the page, the frame budget, the
  UTF-8 boundary, the scratch gate, the edit validation — so a console cannot learn which
  filesystem its agent is on from the shape of a reply.

## 6. The credential tunnel, and which way it runs

A tunnel exists because a process **inside** the pod wants a daemon-side server, while shim
requests only ever flow daemon → shim. So the pod announces each accepted connection as a
`connect` event on a stream id it mints, and the daemon answers by dialling its own socket;
bytes then travel as events one way and `data` requests the other.

Its Unix-socket listeners belong to the **pod**, not to a channel. At half the credential
TTL the shim closes the channel and the daemon reconnects; tearing down those listeners on
every renewal would break any client mid-request, so `listen` is idempotent and each socket
lives as long as the pod does.

A frame that was travelling when the socket was replaced is a different matter, and the
resolution is deliberate: the renewal aborts requests in flight, and that abort says a
_reply_ was lost, not whether the request landed. Re-sending is therefore unsafe — these
tunnels carry request/response protocols where a duplicated fragment is a corrupt request
rather than a retry — so the stream is **terminated** and the in-pod client sees EOF at once.
For git that is an authentication failure it can be retried, where leaving the stream open
would be git waiting out an idle timeout. Streams that were idle across the renewal are
untouched.

This is why a bound channel is announced only after its `shim/bound` frame is on the wire:
the peer refuses anything that arrives ahead of its own binding, so an earlier notification
made that cleanup unserviceable. Ordering on the socket is what makes the fix sufficient
rather than merely likely.

The helper git runs in the pod is the runtime image's own executable, root-owned and
unwritable by the runtime — one it could rewrite is one it could replace with a helper that
asks the daemon for credentials in its name. It shares its implementation with the daemon's
CLI helper and differs only in which socket it dials.

## 7. Runtime-image rollout ownership

The daemon does not force a running agent onto a new runtime image. Agent compute migrates through
the ordinary idle suspension path described below: when a later launch finds its Sandbox Suspended,
the daemon resolves its configured SandboxWarmPool and SandboxTemplate, then atomically patches the
persisted Sandbox's `runtime` container image and `operatingMode: Running`. The name and observed
image are JSON Patch preconditions, so a concurrent container reorder or image edit rejects the
whole wake instead of changing a sidecar or starting an unverified image.

This is a resume-time update, not a proactive rollout. A Sandbox already Running keeps serving its
current image until it naturally becomes idle, and a template edit racing the daemon's fresh read is
picked up by a later resume. The SandboxClaim, Sandbox UID, immutable volumeClaimTemplates, and
workspace PVC all survive; only the pod incarnation changes. The daemon Role therefore reads the
configured `sandboxwarmpools` and `sandboxtemplates` but still never reads or writes Pods directly.

## 8. The lifecycle of an idle agent: suspend, resume, discard

A rollout is not the only reason a pod should stop existing. An agent that has gone quiet holds
a pod that is running nothing, and an agent that has been deleted holds a volume nobody will
ever read again. Those are two different endings, and conflating them is how a product either
burns cost or loses work.

**Quiet ⇒ suspend, keep the volume.** The daemon's idle sweep already reclaims a host whose
agent has no recent activity and no in-flight turn. The same sweep then suspends the Sandbox of
any agent it holds a launch for that no longer has a host. Suspension deletes the pod and
nothing else: the Sandbox object and the workspace volume survive, so the next message resumes
onto the same checkout and the same runtime history rather than paying a clone.

**On a pool the sweep is duty-gated, because a launch is not evidence of ownership** — the
`busy` counter a member reads is its own, so an ex-holder that kept its launch record would
see zero holders and suspend a pod its successor is binding. The launch therefore follows
the duty and idleness is floored at the takeover, which is
[k8s-daemon-pool.md](k8s-daemon-pool.md) §4.

Suspension and acquisition exclude each other, and the lease counter is not what does it: `busy`
counts holders, it does not keep new ones out, so a dispatch arriving during the Kubernetes write
would lose its pod and then find its launch forgotten by the suspend's own success path. The
decision is published before the first await and `ensureSandbox` waits it out — publication is
synchronous with the `busy` read, so a holder either appears in that read or arrives to a gate
that is already closed. A waiter resumes into the ordinary path: no cached launch, so it claims a
new one, which is the resume it would have performed a moment later anyway.

The sweep reads the driver's launches rather than chaining onto host reclaim, for two reasons —
a launch outlives the host it was made for (a bind for workspace preparation makes one before
any runtime exists), and a rule evaluated from state each tick cannot be stranded by a teardown
that failed. The cost is at most one sweep interval of delay after the host goes.

A turn needs no separate wake path: `bindChannel` already patches `Running` before it waits for
readiness, so the next turn resumes the instance as a side effect of needing it. That is also
what makes the resume measurable — `ensureSandbox` reports `resume` rather than `warm` when it
finds the Sandbox Suspended. The one caller that is not a turn is the console's explicit wake
(below): it needs the pod for a workspace read rather than for a runtime, so it drives the same
resume and stops at the shim bind, creating no host and no ACP session.

One gap this leaves, deliberately: a pod still Running from _before_ a daemon restart has no
launch in the new process, so nothing considers it until the agent is used again — at which
point it acquires a launch and the rule applies from then on. On a pool member the duty grant
closes it, since re-deriving the launch is exactly what the grant does; a single daemon
restarting still pays one pod until its agent's next message. Naming the gap beats a
startup-time reconstruction of every Sandbox in the namespace: the steady-state case is covered,
and the cost of the restart case is that one pod.

**A departed pod ends its launch.** Suspension, an eviction and a node drain all produce the
same thing: a channel that does not come back. The session behind it is terminal — `attach()`
is a no-op once lost — while a cached launch keeps its generation, so a re-bind that matched
generations would re-attach the dead session and hand the resumed pod a channel that can never
serve a request. Losing the channel therefore drops both the session and the launch, which is
what makes the next turn claim a **fresh generation** — the fence the replacement pod is bound
against. `forgetLaunch` describes exactly this recovery and was, until this rule existed,
called by nothing.

After loss is reported, the driver revokes the outbound dial and forgets the launch. A late
socket therefore cannot reattach to the terminal session; the next turn creates a fresh
generation and dials the pod through the ordinary wake path.

**The loss window is measured from the pod being up, not from the socket that dropped.** A
shim cannot dial back while its pod is still binding a PVC and pulling an image, so a fixed
grace window counted a genuine cold start as a lost launch: the binding was revoked, the ACP
host stayed memoized dead, and every later turn failed with a closed connection until the
member was replaced. The loss check now reads the Sandbox the driver already watches —
`ready | starting | absent` — re-reads while the pod is coming up, restarts the whole grace
window when it arrives, and is bounded by the same pod-up timeout the launch path waits on,
so a pod that never arrives is still reported lost. Each readiness read carries what is left
of that ceiling as an abort signal, because the Kubernetes client has no request deadline and
an accepted-but-unanswered GET would otherwise hold the check open forever. A terminal
runtime is paired with the ordinary rebuild: the host is reclaimed on `onTerminal`, returning
the agent to provisioned so the next message starts a fresh one.

**Waking is an explicit press, never a read.** A cluster agent's files live on its pod's
volume and are readable only through a running sandbox, so the console has `POST
/agents/:id/wake` — authorized like the other agent writes, resolved through the placement
resolver's dispatch answer (so a set agent nobody currently serves reaches a live member,
which claims it the way a turn would), debounced per agent, and sent only to a daemon
advertising the wake capability. The daemon claims the duty if it does not hold it, answers
`running` when the channel is already bound, and otherwise brings the sandbox to Running and
binds the shim — **no host and no ACP session** — answering `starting`. That bind is what the
workspace `read` channel serves on, so a woken sandbox is exactly a readable one, and the
launch it records gets a full idle window before the sweep may suspend it again. A GET still
wakes nothing: the refusal is transient by design and the console re-issues the read behind
the press.

**The generation belongs to the agent, not to the daemon process.** A sandbox pod's shim
records the highest generation it has ever bound and refuses anything below it for the rest of
that pod's life, so the number has to be allocated from state every daemon that may hold the
agent shares — `LocalStore.nextSandboxGeneration`, one atomic upsert, on the pool's shared
Postgres store for a pool member and on SQLite for a local daemon. A per-process counter was
correct only under the original assumption of one daemon per sandbox for the sandbox's life:
in the pool an agent moves to another member on every rollout, and a successor restarting at 1
would be closed with `stale generation` on every dial — every turn ending in a launch timeout
until the pod happened to be recycled. Because the number fences a pod rather than a claim,
the row deliberately outlives the claim it was allocated for.

**Removed ⇒ delete the claim, and the volume with it.** Where the local path deletes the
agent's checkout, the cluster path deletes its SandboxClaim; the volume is not reachable from
the daemon's filesystem, so nothing else can. This is removal only. A **detached or moved**
agent keeps its volume: both are reversible, the archive they leave behind is the promise that
the work is still there, and the source daemon is never told that a move committed — so
deleting on detach would trade a leaked volume for a lost workspace on every rollback. Its pod
still goes, through the idle rule above, which is where the cost actually is.

The delete is best-effort by construction: the durable local removal has already succeeded, and
failing the lifecycle ACK over a leaked claim would leave the CP and the daemon disagreeing
about whether the agent exists. A failure is reported with the command that finishes the job.

## 9. Editing the workspace of an agent that already has a volume

A workspace edit is a **replacement**: the console says so, and the local path implements it that
way — clone beside the target, `renameSync` for an atomic swap, and a rollback that restores the
previous tree if the activation is refused. None of those three exist through the shim, and the
step that would need them runs at `agent/activate`, _before_ the CP has acknowledged the edit. So
the cluster path splits the operation across the two places that can each do half of it.

**Activation records an intent.** It writes the target materialization to a daemon-side file beside
the marker and returns; it destroys nothing, which is what makes the CP's rollback able to undo it
by simply activating the original definition again. The marker is deliberately not advanced —
it says what the volume HOLDS, and preparation reads it back as attestation of the repository.

**Preparation performs it,** inside the bound sandbox, from the pod's own side: empty the checkout,
then materialize the configured workspace — a clone for a git-repo target, nothing for a scratch
one, since the checkout's absence IS the scratch workspace. Emptying is fail-closed; a clear that
did not happen would leave the previous repository's tree serving as the new workspace.

The two disagreeing is what "still due" means, so retries are free and repeats impossible: a failed
clone leaves an empty checkout that the next preparation clones again, and a marker that has
advanced to the target ends the conversion whether or not the intent file was cleaned up. A rolled
back edit takes its intent with it, and a repository **rename** — the same changed URL, arriving
without `reconcileWorkspace` — writes no intent at all and keeps its existing behaviour of
repointing the checkout rather than replacing it.

**A rejected activation gives back nothing — and that is the point.** `ensureHostAsync` runs
before the ACK, so preparation may already be replacing the volume when the activation is rejected
— for an ACP failure, a supersession, or a staging-commit failure — and nothing reaches a pod's
tree to undo it. Withdrawing the intent, or restoring the marker, would tell the CP's restored
definition that nothing changed, and it would repoint the rejected tree and be ACKed onto it with
a pull failure degrading quietly. Left standing, the pair says the volume is unattributable and
whichever definition arrives next re-materializes it — so the recovery needs no rollback to run at
all. A stale intent costs nothing: a marker that proves the target ends the conversion.

**The marker is dropped before the checkout is, not after.** Everything between the two — the
clone, its repo-local helper pin, the marker write itself — can fail, and every one of those leaves
a volume holding the new tree that nothing has proved. A marker still naming the emptied workspace
during that stretch is the same lie as restoring one, so it goes first and the destructive step is
ordered after it. Which is also why the intent's PRESENCE is the gate rather than the workspace it
names: at that point the volume matches no definition, and the one that arrives next is as likely
to be the rollback as a retry of the edit.

Session-isolated (worktree) workspaces are covered the same way: the WorkspaceFs seam
(`workspace-fs-channel.ts`) and the shim's exec allowlist (`worktree add`/prune) materialize a
session's own worktree on the pod's volume at `<mount>/worktrees/<sid>`, and the same retention GC
that retires worktrees locally reads the pod's tree through the same seam
([multi-repository-workspaces.md](multi-repository-workspaces.md) Phase 7).
