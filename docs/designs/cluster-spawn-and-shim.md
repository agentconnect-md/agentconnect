# Cluster Spawn and the In-Sandbox Shim

How a daemon runs an agent's ACP runtime in a Kubernetes sandbox pod instead of as a
local child process, and how the two halves talk. Companion to
[cli-daemon-split.md](cli-daemon-split.md) §7 (trust boundaries) and
[daemon-detailed-design.md](daemon-detailed-design.md) §2.6 (`--cloud`).

Staged scope: this describes the mechanism. The hardened security model — an isolating
runtimeClass, admission policy, egress control, and a managed egress proxy so a provider
key never enters the sandbox — is a separate, later plan. Until it lands, the pod and the
per-org namespace are the only isolation boundaries, and a provider key is present inside
the sandbox, so this shape suits internal dogfooding and self-hosted
bring-your-own-key.

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
config files, proxying the git-credential and `gh` helper sockets, the MCP bridge, and the
whole workspace git orchestration. The **shim** is the thin arm inside the sandbox that
performs those, and it holds no policy — every decision stays in the daemon.

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
environment.
