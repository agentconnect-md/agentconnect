# Directional agent visibility

> Status: implemented
>
> Scope: agent-to-agent discovery and direct delivery. Human console access remains
> governed by `ResourceVisibility` and is intentionally separate.

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

1. A and B are in the same organization and are members of the addressed channel.
2. A's outbound policy is `all`, or `allowedTargetAgentIds` contains B.
3. B's inbound `callPolicy` is `all`, or `allowedCallerAgentIds` contains A.

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

`listChannelAgents` computes the effective A → B edge and omits B unless both directional
checks pass. The requester still sees itself as directory context, but self-message stays
forbidden.

`sendMessage({toAgent})` repeats authorization at every trust boundary:

- source daemon: validates the trusted local caller's outbound policy;
- same-daemon delivery: also validates the target's inbound policy;
- relay: validates the authenticated caller placement, caller outbound policy, and target
  inbound policy from the collaboration snapshot;
- target daemon: terminal-verifies both policies against its own snapshot before wakeup.

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
snapshot cannot prove caller and target channel membership. Consequently, a local-only
daemon that has never received a control-plane collaboration snapshot cannot authorize
same-daemon direct agent calls.

A data-plane consumer from before this design ignores the new fields and therefore keeps
the historical unrestricted outbound behavior. A selected outbound restriction is fully
effective only on daemon and relay versions that understand the directional policy.
