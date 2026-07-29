# Directional agent visibility

> Status: implemented
>
> Scope: agent-to-agent discovery and direct delivery. Human console access remains
> governed by `ResourceVisibility` and is intentionally separate.
>
> **Two unrelated things are called "visibility".** `callPolicy` / `outboundPolicy`
> — the subject of this document, labelled "Agent visibility" in the console — is
> the **only** gate on agent-to-agent discovery and wakes. `Agent.visibility` /
> `sharedWith` (`ResourceVisibility`: `org` | `restricted`, see
> [`resource-visibility.md`](resource-visibility.md)) governs **human** console
> access and must **never** affect the peer directory: a `restricted` agent is
> still a discoverable, callable peer. The control plane's peer-directory read
> deliberately omits the `ResourceVisibility` clause for exactly this reason.

## Problem

The original collaboration policy was target-side only:

- `callPolicy='all'|'selected'`
- `allowedCallerAgentIds`

It answered “which peer agents may call this agent?” but could not constrain what the
agent itself could discover or message. That left an administrator unable to give a
planner access to two workers while preventing it from discovering every other agent in
the channel.

## Model

Each agent now has an outbound half as well:

- `outboundPolicy='all'|'selected'`
- `allowedTargetAgentIds`

For two distinct agents A and B, A may discover or message B only when all of these hold:

1. A and B are both **known in the org-scoped peer directory** — an agent the
   directory has never seen fails **CLOSED**, so a missing or stale snapshot never
   grants access.
2. A and B are in the **same organization**. Channel membership is **not** part of
   the predicate: since A2A delivery became postless the channel has no role in
   delivery, so it must not act as an authorization key, and agents with no IM
   integration at all (webchat / hook / dream / memory-only) have no CP-visible
   channel yet must still collaborate. Channel survives only as an **optional
   filter** on a directory listing.
3. A's outbound policy is `all`, or `allowedTargetAgentIds` contains B.
4. B's inbound `callPolicy` is `all`, or `allowedCallerAgentIds` contains A.

A caller always resolves **itself** in a listing, even under a `selected` policy
that omits it — an agent does not normally name itself in its own allow-list, yet
it must still appear in its own directory answer. A self-_wake_ stays forbidden.

This is an intersection, not an override. Selecting B on A never grants A access through
B's inbound restriction, and selecting A on B never expands A's outbound scope. Self-call
and hop-limit guards remain independent and unchanged.

Both directions default to `all`, preserving the pre-migration graph. Under `all`, the
associated id array is stored empty; under `selected`, an empty array means no peers.

## Control plane and console

The existing `PUT /agents/:id/call-policy` endpoint updates both directions atomically.
The outbound fields are optional on input so an older client updating only the inbound
half does not reset an existing outbound restriction. The server accepts only visible,
same-organization peers and preserves still-valid hidden grants that a collaborator
cannot see, matching the existing inbound-edit behavior.

The Agent visibility card presents two explicit questions:

- Who can call this agent?
- Who can this agent see and call?

Changing either half attempts a hot-push of the local `AgentSpec` and the full
collaboration routing snapshot. Accepted channel-membership reports hot-push that
snapshot too, so both joins and removals immediately affect the effective edge.
Reconnect reconciliation remains the convergence backstop when a daemon is offline
or a live push fails.

## Data-plane enforcement

`listAgents` (deprecated alias `listChannelAgents`) computes the effective A → B edge over
the requester's **organization** and omits B unless both directional checks pass. The
requester still sees itself as directory context, but self-message stays forbidden. A
`channel` argument only narrows that answer to the agents present in that channel.
Discovery is the authorization surface — a peer that fails the predicate is omitted, never
listed-but-uncallable.

`sendMessage({toAgent})` repeats authorization at every trust boundary:

- source daemon: validates the trusted local caller's outbound policy, then the org-scoped
  directional predicate against its own copy of the collaboration snapshot (which also
  decides a _remote_ target, because that snapshot is org-wide rather than per-daemon);
- same-daemon delivery: also validates a local target's inbound policy from its spec;
- relay: validates that the claimed caller exists in the flat org directory and is owned by
  the authenticated sending daemon, then caller outbound + target inbound policy in the
  same org;
- target daemon: terminal-verifies the asserted org and both policies against its own
  snapshot before wakeup.

None of these consult channel membership. `coords` still travels with a wake, but as the
**delivery coordinate** for the woken session — and as the preferred source of the target's
reply integration for a visible post — not as an authorization input.

All policy denials return `delivered:false, reason:'not_allowed'` and create no visible
platform message or shared-transcript row. Live routing still carries only
placement and policy metadata through the control plane; message bodies remain
on the daemon/relay data path. Authorized bounded BFF read-back is a separate,
transient path and is not persisted by the control plane.

### Origin-session replies

`sendMessage({sessionId})` is intentionally outside the outbound target allow-list. It
does not discover or select a peer: the daemon accepts only the exact origin session bound
to the caller's current turn. Keeping that narrow return capability allows B to answer A
after a permitted A → B delegation even when the independently configured B → A edge is
closed. A new direct wake of A still requires B → A authorization.

## Compatibility and failure behavior

On a fresh agent, the new policy defaults to `all`. When a newer daemon decodes an older
control-plane payload, both outbound fields remain absent so the daemon preserves the
complete on-disk outbound half instead of retaining `selected` while clearing its list.
Once a `selected` outbound policy is received, enforcement is fail-closed: missing targets
are denied. Local and cross-daemon delivery both fail closed when the collaboration
snapshot does not contain **both** the caller and the target in one organization.
Consequently, a local-only daemon that has never received a control-plane collaboration
snapshot cannot authorize same-daemon direct agent calls.

Rolling upgrade: the flat org directory arrives only from a control plane that advertises
`agent-directory-org-scope-v1`. Against an older control plane, relay and daemon derive the
directory from the channel-keyed rows they do receive, so integration-backed pairs keep
resolving; an integration-less agent stays invisible until the flat list arrives, which is
exactly the pre-change behavior. A daemon likewise keeps sending the caller's current
channel with a discovery request until the feature appears.

A data-plane consumer from before this design ignores the new fields and therefore keeps
the historical unrestricted outbound behavior. A selected outbound restriction is fully
effective only on daemon and relay versions that understand the directional policy.
