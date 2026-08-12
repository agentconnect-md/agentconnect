# Cluster Spawn and the In-Sandbox Shim

How a daemon runs an agent's ACP runtime in a Kubernetes sandbox pod instead of as a
local child process, and how the two halves talk. Companion to
[cli-daemon-split.md](cli-daemon-split.md) §7 (trust boundaries) and
[daemon-detailed-design.md](daemon-detailed-design.md) §2.6 (`--k8s`).

Staged scope: this describes the mechanism. The hardened security model — an isolating
runtimeClass, admission policy, egress control, and a managed egress proxy so a provider
key never enters the sandbox — is a separate, later plan. Until it lands, the pod and the
per-org namespace are the only isolation boundaries, and a provider key is present inside
the sandbox, so this shape suits internal dogfooding and self-hosted
bring-your-own-key. As an interim step the runtime image accepts deployment-owned provider
config from the pod environment — `AC_CLAUDE_BASE_URL`/`AC_CLAUDE_API_KEY` and
`AC_CODEX_BASE_URL`/`AC_CODEX_API_KEY`, which the shim maps onto the matching runtime's
`ANTHROPIC_*`/`OPENAI_*` variables at spawn (fill-in only; a daemon-sent value wins) — so
the key can live in the SandboxTemplate instead of traveling over the shim channel.

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

## 2. The shim, and why it dials out

Once the runtime is in another pod, everything the daemon used to do by sharing a
filesystem and a set of unix sockets needs an explicit protocol: materializing secrets and
config files, proxying the git-credential socket, the MCP bridge, and the whole workspace
git orchestration. The **shim** is the thin arm inside the sandbox that performs those, and
it holds no policy — every decision stays in the daemon.

The tunnel names a **closed set** of daemon-side servers (`gitcred`, `mcp`) at paths the
runtime image fixes. `gh`'s token helper is not among them because it shares `gitcred.sock`
with the credential helper: a second name would be a second in-pod path onto one server.
`mcp` is declared but not yet opened — the in-pod bridge that would dial it is not in the
image, so a listener for it would be a socket nothing can use.

**The shim dials out; the daemon listens.** The sandbox therefore needs zero inbound: its
NetworkPolicy keeps an empty ingress list and no per-sandbox Service exists. The reverse
direction would need a Service per sandbox, an ingress allowance, and a readiness probe —
all surface for nothing.

## 3. Binding: proving which pod is calling

A shim connection must be bound to the pod it claims to be, before it is given anything.

Two tempting shortcuts are wrong, and both were rejected explicitly:

- **A bootstrap token in the SandboxClaim.** A claim carrying non-empty `env` bypasses
  warm-pool adoption, and claim env does not propagate to a rebuilt pod — so after a
  resume or an eviction the pod would hold only an exhausted token and the wake path would
  deadlock.
- **Reverse-looking the source IP.** Pod IPs are reusable and the Sandbox status that
  mirrors them is asynchronous. Inside that stale window, a sibling sandbox in the same
  namespace could present a just-recycled IP and claim a victim agent's channel. The
  connection's source address is therefore a logging and correlation hint only, never a
  trust input.

What is used instead is the pod's own Kubernetes credential:

1. the pod template mounts an **audience-restricted projected ServiceAccount token**
   (minute-scale TTL, rotated by the kubelet, invalid the moment the pod is gone) and pins
   a dedicated runtime ServiceAccount that holds **no RoleBindings**. Audience-restricted
   plus permissionless means the token is useless anywhere except proving "I am this pod"
   to this endpoint;
2. the shim reads it and dials the daemon, presenting it as its only claim;
3. the daemon calls **TokenReview** with the expected audience — omitting the audience
   would accept a token minted for something else entirely — and takes the bound pod
   name/UID from the response;
4. the daemon maps that pod to its own spawn record. No match, no binding: an
   authenticated pod that this daemon did not launch binds to nothing;
5. **only then** is a session credential issued, short-lived and bound to this pod and
   generation.

Because the identity is the pod's own rotating credential, first bind, resume from
suspension, and eviction/rescheduling are indistinguishable to the protocol: each new pod
simply presents its own token. There is no one-shot token that can be revived.

Rejections carry one coarse reason and a message that names no pod, token, or agent, so
the endpoint cannot be probed for valid identities.

The same proof runs in the other direction one hop up: a daemon the operator
provisioned authenticates to the control plane with its own audience-scoped
projected token, verified there rather than here. See "Daemon identity" in
[agentconnect-org-operator.md](agentconnect-org-operator.md) — the audiences
differ, so neither token is accepted at the other end.

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

## 6. The credential tunnel, and which way it runs

A tunnel exists because a process **inside** the pod wants a daemon-side server, while shim
requests only ever flow daemon → shim. So the pod announces each accepted connection as a
`connect` event on a stream id it mints, and the daemon answers by dialling its own socket;
bytes then travel as events one way and `data` requests the other.

Its listeners belong to the **pod**, not to a channel. The shim re-dials at half the
credential TTL, and a socket torn down on every renewal would break any client mid-request —
so `listen` is idempotent and the socket lives as long as the pod does.

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

## 7. Draining for a runtime-image rollout

The daemon owns when an agent's pod runs, so an image rollout cannot simply replace it — a
forced suspend would kill whatever turn is in flight. Instead the operator _asks_, by writing
`agentconnect.md/drain-requested` on the Sandbox
([`agentconnect-org-operator.md`](agentconnect-org-operator.md)), and the daemon answers with
the one action that is its to take: it stops placing new work on that instance and suspends it
once the work already there ends — immediately when there is none. The operator's conditioned
image patch then applies, because the instance is Suspended.

The consumer is a list-then-watch over the namespace's Sandboxes, started with the runtime
plane rather than by a launch: the instance a rollout waits on is usually the idle one nobody
is about to launch, and a request nothing reads would stall the rollout until its deadline.
Three properties this shape buys:

- **Snapshots converge.** Each re-LIST replaces the whole drain set, so a watch gap that swallowed
  a request's removal cannot hold an instance down forever.
- **No launch record required.** Requests are keyed by Sandbox name, not by agent, so an instance
  this daemon has not bound in this process — after a restart, or for an agent that has been quiet
  — is still drained. Keying by agent would have made exactly the idle case unreachable.
- **In-flight work is held, not raced.** Work leases its Sandbox: the bind, the cold workspace
  preparation that runs in the pod after it (clone, pull, skill materialization — one lease around
  the whole of it, not around the bind alone), the runtime until it exits, and the runtime probe
  across its whole request rather than across its bind — a probe can run for minutes with nothing
  else marking that sandbox as in use, and a daemon whose probe failed advertises no runtimes and
  does not retry. A request that
  arrives while a lease is held waits for it instead of pulling the pod out from under it.
  Taking a lease on an already-draining instance is refused instead, by type
  (`SandboxDrainingError` → the `draining` launch outcome): nothing has started yet, so the
  rollout wins that decision and the caller retries once the request clears.

A drain the daemon never completes is the rollout's to give up on, not the daemon's to force:
the operator marks the instance `failed` after its own deadline, and the pod keeps serving.

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

There is no separate wake path: `bindChannel` already patches `Running` before it waits for
readiness, so the next turn resumes the instance as a side effect of needing it. That is also
what makes the resume measurable — `ensureSandbox` reports `resume` rather than `warm` when it
finds the Sandbox Suspended.

One gap this leaves, deliberately: a pod still Running from _before_ a daemon restart has no
launch in the new process, so nothing considers it until the agent is used again — at which
point it acquires a launch and the rule applies from then on. The drain path solves the same
problem by keying on Sandbox name, which works because a rollout needs no agent identity;
suspension does need it, to ask whether that agent has been quiet, and the Sandbox object
carries no agent label to recover it from (the labels go to the pod). Inventing a mapping is
worse than naming the gap: the steady-state case is covered, and the restart case costs one
pod until the agent's next message.

**A departed pod ends its launch.** Suspension, an eviction and a node drain all produce the
same thing: a channel that does not come back. The session behind it is terminal — `attach()`
is a no-op once lost — while a cached launch keeps its generation, so a re-bind that matched
generations would re-attach the dead session and hand the resumed pod a channel that can never
serve a request. Losing the channel therefore drops both the session and the launch, which is
what makes the next turn claim a **fresh generation** — the fence the replacement pod is bound
against. `forgetLaunch` describes exactly this recovery and was, until this rule existed,
called by nothing.

The narrow case this leaves is a socket that comes back _after_ loss was reported while its pod
stayed alive — a blip longer than the rebind grace. That connection is bound to a generation
nothing is waiting for any more, so it simply sits there, and the launch recovers when the shim
next re-dials at credential renewal. Closing it to force an immediate re-dial is deliberately
NOT done: a first bind is indistinguishable from it at that point (the session is created after
the channel arrives), and every pod would re-dial into a close loop after a daemon restart.
Recovering at renewal is slower than that would be, and strictly better than the alternative it
replaced, which was a channel that could never serve again until the daemon restarted.

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

What this does not cover is a **session-isolated** (worktree) git-repo workspace: that needs
`worktree add` in the sandbox and a retention GC that reads the pod's tree, and is still refused
by name at session preparation.
