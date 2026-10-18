# AHP v1 adoption: daemon-owned client session synchronization

> **Status:** Proposal; no implementation or dependency changes in this PR.
> **Related:** [#1339](https://github.com/agentconnect-md/agentconnect/issues/1339).
> Revisits [#2081](https://github.com/agentconnect-md/agentconnect/pull/2081),
> originally proposed by stkevintan and deferred pending protocol stability.
> **Reviewed:** 2026-10-18, against AHP Spec `1.0.0` and
> `ahp-acp-gateway` `0.2.2` at `9bcd0d4b684b600bb620844fb4ad82feca50c965`.

## 1. Decision proposed

Add an AHP host inside the existing daemon, initially as a shadow projection,
then as the client-facing protocol for Webchat. Keep AgentConnect's execution,
authorization, durable session identity, and transcript ownership unchanged.
Console live views and external AHP clients can reuse that host later.

Use the official AHP SDK for protocol types, negotiation, and reducers where
applicable. Evaluate `ahp-acp-gateway` as a reference for the host implementation
and its interoperability tests. Do not deploy its default session store and ACP
process manager as a second owner of AgentConnect sessions.

This narrows #1339 to client synchronization. It does not unify AgentConnect's
business session model with the protocol's similarly named resources, replace
ACP, or move collaboration routing into AHP.

## 2. Why revisit now

[AHP Spec 1.0.0](https://github.com/microsoft/agent-host-protocol/releases/tag/spec/v1.0.0)
was released on October 2, 2026, after #2081 was deferred. Its
[stability index](https://github.com/microsoft/agent-host-protocol/blob/spec/v1.0.0/docs/specification/versioning.md)
marks Root, Session, and Chat stable. Automation remains early development;
Canvas is experimental, and MCP and Changeset have lower stability than the core.
The initial adoption should depend on the stable core only.

The earlier proposal's architecture remains useful, but several details need
updating to the v1 baseline. This is a comparison with that document, not a claim
that every capability below first appeared in the 1.0 release.

| Earlier proposal                                     | v1 design update                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Session-centered transcript state                    | Separate Session metadata/catalog from Chat turns, streaming, tools, and input requests.                           |
| Approval and human input treated as upstream gaps    | Map existing permission/elicitation behavior to defined chat actions; retain AgentConnect authorization.           |
| Multi-session observation treated as an upstream gap | Use multiple channel subscriptions on one connection and `initialSubscriptions`; batching beyond that is optional. |
| Conceptual snapshot/replay mapping                   | Specify both `reconnect` result branches, consistent snapshots, retention, and restart behavior before migration.  |
| Protocol maturity blocks evaluation                  | Pin a reviewed SDK version, negotiate compatibility, and scope adoption to stable channels.                        |
| Staged-generation discard and epoch assumptions      | Keep these as explicit mapping/fencing questions; v1 does not automatically implement AgentConnect's semantics.    |

## 3. Architecture and ownership

![Proposed AHP integration: relay-forwarded client traffic terminates at the daemon's new AHP host, which projects existing session state and delegates actions to the existing execution core.](ahp-adoption.svg)

The SVG is editable source. All added components in the diagram are proposed,
not current runtime behavior.

### 3.1 AHP host on the daemon

The new host has three responsibilities:

1. **Protocol endpoint:** handshake, version/capability negotiation, channel
   subscriptions, action validation, sequencing, replay, and snapshot responses.
2. **State projection:** fold masked execution output and daemon-owned lifecycle
   events into AHP state. The host is authoritative for the exposed AHP state,
   while its business facts come from the existing session and transcript owners.
3. **Action adapter:** translate permitted client actions into the existing
   admission, cancellation, configuration, and approval entry points. Never call
   a raw ACP subprocess directly from this adapter.

Memory/context assembly, tool registration, execution queues, deduplication,
background tasks, ACP attachment/recovery, and platform delivery stay in the
existing daemon. There is one execution path regardless of the observing client.

### 3.2 Relay and Control Plane

Preserve [architecture.md](architecture.md): live message bodies and execution
updates travel on the daemon/relay data plane. The relay forwards AHP frames
without persisting content or owning the reducer state. The CP retains identity,
registry, routing, metadata, and existing control RPC responsibilities.

Browsers cannot generally dial NAT-bound self-hosted daemons or cluster-internal
pool daemons directly. The existing relay route is the proposed carrier, but
`rd/*` is not itself a standard AHP WebSocket endpoint. Phase 1 must define the
AHP frame envelope, connection identity, routing, authenticated principal
propagation, backpressure, and either-hop failure signaling. An IDE integration
also needs a compatible public AHP endpoint and an explicit credential flow;
pointing VS Code at today's relay is not sufficient.

This proposal removes neither CP control dependencies nor every BFF operation.
Bounded transcript/workspace/memory reads can remain; replacing live transcript
invalidation/refetch is a separate Phase 2 decision.

### 3.3 One durable session owner

Existing session rows and transcripts remain the durable business record, using
the deployment's existing data-plane store. AHP snapshots and a bounded action
log are derived projection data; they must not introduce independently created
sessions, competing transcript writers, or a second restart policy.

Not all live state can be reconstructed from transcript text. Pending approval
requests, queued work, active generation identity, and settings also come from
their existing daemon owners. Cold reconstruction must classify interrupted
work according to AgentConnect's recovery policy rather than synthesizing a
successful or still-running turn. Snapshot size, historical pagination, action
retention, and crash-safe sequence allocation are implementation gates.

## 4. Resource and action mapping

Start with one AHP Session and one default Chat per agent-scoped AgentConnect
session. This avoids changing execution ownership to match protocol vocabulary.

| AgentConnect concept                     | Proposed AHP representation                              | Boundary                                                                                              |
| ---------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Stable outward `sessionId`               | `ahp-session:/<sessionId>`                               | Preserve existing deep links and external addressing.                                                 |
| One agent's conversation in that session | Stable `ahp-chat:/<chatId>` in its `defaultChat`/catalog | Persist or deterministically derive a non-sensitive chat identifier; independent of runtime restarts. |
| Runtime `acpSessionId`                   | Host-private binding                                     | Never use it as the public channel identity.                                                          |
| Dispatch `sessionKey`                    | No public mapping                                        | Keep platform coordinates and queue serialization private.                                            |
| Multi-agent Webchat conversation         | Existing roster plus N Session/Chat subscriptions        | Preserve each agent's context, visibility, and continuation rules.                                    |
| Shared conversation across daemons       | Existing routing and merged-view composition             | One host's subscriptions do not aggregate other hosts automatically.                                  |
| Daemon execution attempt/generation      | Internal fence plus an explicit projection mapping       | An AHP sequence number is not an execution lease.                                                     |

| AHP interaction                                  | AgentConnect behavior to preserve                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat/turnStarted`                               | Authorize the principal and admit through the current Webchat/session continuation path. Queue-full, paused, draining, and duplicate cases remain host decisions. |
| `chat/turnCancelled`                             | Use current interruption and cleanup barriers before admitting conflicting work.                                                                                  |
| `chat/toolCallConfirmed`                         | Use the existing approval policy and first-valid-answer settlement shared by all surfaces. Subscription alone confers no approval rights.                         |
| `chat/inputRequested`, answer/completion actions | Project supported input requests; validate answers and settle through the existing request owner. Do not advertise unsupported input variants.                    |
| `chat/responsePart`, `chat/delta`, tool actions  | Project already-masked output while retaining message boundaries, tools, and intermediate work.                                                                   |
| Reconnect/subscription                           | Re-authorize access, then return a consistent replay or snapshot of authorized channels.                                                                          |

Capabilities must be explicit. Do not claim arbitrary multi-chat creation,
automation, filesystem, terminal, or MCP forwarding support simply because the
SDK defines their types. Session creation and multi-agent roster management
can remain existing product APIs in the first migration; IDE discovery and
creation are later interoperability work.

## 5. Consistency, authorization, and generation boundaries

### 5.1 Projection inputs

Attach the projection after secret masking, alongside current output consumers.
Consume both runtime updates and daemon-owned events: admission/terminal state,
approval settlement, discard/reset, cancellation, and recovery. An ACP-only
consumer misses discarded generations and can append the replacement onto an
answer that should have been removed.

Preserve [product conventions](../product-conventions.md), including separate
reply blocks and the transition from live output to saved history. Do not retire
an unfinished live reply merely because its prompt was persisted.

### 5.2 Sequence and reconnect contract

- `serverSeq` is an ordering/replay cursor, not a proof of completeness. A client
  subscribed to only some channels can legitimately observe gaps.
- The relay must provide ordered delivery and surface failure on either hop.
  Detected failure triggers recovery; adjacent sequence arithmetic does not.
- Subscribing must establish a snapshot cursor and live subscription without a
  race that loses updates between the two. Reconnect replay must precede later
  live actions, or return fresh snapshots when the retained window is insufficient.
- Reconnect, replay, and snapshot responses must filter by current channel
  authorization. A previously authorized subscription is not a permanent grant.
- A crash/reassignment must never make an old cursor appear valid against a new
  unrelated log. Before Phase 1, specify durable sequencing or a negotiated
  host-incarnation mechanism with forced reinitialization/snapshot recovery.
  Do not assume v1 supplies an AgentConnect-compatible epoch field.
- Keep durable admission/idempotency separate from client optimistic-action
  reconciliation. Lost acknowledgments and resubmitted actions must not cause
  duplicate prompts or approvals.

### 5.3 Authorization and staged output

Apply [session visibility](session-visibility.md) and
[authorization policy](authorization-policy.md) to discovery, subscriptions,
history, actions, and reconnect. Bind the verified principal and organization
to the connection; `clientId` identifies a client, not an authenticated user.
Account for revocation during long-lived subscriptions using the existing
authority lifetimes; a single gateway bearer token is not multi-user policy.

Keep the [turn-final refresh workflow](turn-final-context-refresh.md), including
generation fencing and the regeneration loop. AHP can represent steering
messages, but actual model-context injection remains a runtime capability.

The projection must define how discarded output disappears or is retained as
intermediate work in every client, including one reconnecting during discard.
Evaluate standard v1 actions/reducers first. If a product-specific extension is
necessary, negotiate it and document fallback behavior for generic clients.
An arbitrary private reducer is not interoperable AHP. This mapping and a
no-stale-output test are prerequisites for deleting `superseded` handling.

## 6. What code can become simpler

AHP standardizes the state model and wire contract; it does not make host-side
state retention, transport reliability, or business logic disappear. The first
phase adds code. The benefit is realized when old paths are retired and more
than one client shares the replacement.

| Current surface                                                                                                                                                          | Proposed consolidation                                                 | What remains / deletion gate                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webchat/transport.ts`](../../packages/daemon/src/webchat/transport.ts): `bufferWebchatStreamEvent`, `probeWebchatStream`, `resumeWebchatStream`, `pruneWebchatStreams` | One AHP subscription/replay/snapshot implementation                    | Keep admission, continuation, cancellation, deduplication, and platform mirroring. Remove only the old streaming recovery machinery after parity and rollout. |
| [`frames/webchat.ts`](../../packages/protocol/src/frames/webchat.ts): output/done envelopes, per-turn indices, `lastIndex`                                               | Standard action envelopes and projected Chat state                     | Product-specific ingress/roster/attachment contracts and mixed-version compatibility still need adapters.                                                     |
| [`PlaygroundProvider.tsx`](../../packages/web/src/components/console/PlaygroundProvider.tsx) and stream consumers                                                        | Shared AHP client/reducer rather than independent event reconciliation | Keep rendering, merged multi-agent views, message identity, saved-history reconciliation, and extension fallback.                                             |
| [`webchat-daemon-bridge.ts`](../../packages/relay/src/webchat-daemon-bridge.ts)                                                                                          | Forward a defined AHP stream carrier                                   | Keep authentication, daemon routing, connection cleanup, flow control, and failure propagation.                                                               |
| Console live transcript invalidation/refetch                                                                                                                             | Subscribe to the same projection in Phase 2                            | Metadata lists and unrelated bounded BFF reads remain; do not remove all SSE or read APIs.                                                                    |
| New IDE/CLI clients                                                                                                                                                      | Reuse Session/Chat/ToolCall state and protocol recovery                | Each client still needs UI, endpoint discovery, credentials, and capability handling.                                                                         |

Do not replace platform renderers, collaboration routing, task orchestration,
memory, sandboxing, or ACP lifecycle with AHP. Avoid claiming a line-count saving
before the spike identifies which old paths can actually be deleted.

## 7. How to use ahp-acp-gateway

The reviewed [gateway](https://github.com/formulahendry/ahp-acp-gateway/tree/9bcd0d4b684b600bb620844fb4ad82feca50c965)
uses official AHP/ACP SDKs and implements a WebSocket host, action projection,
SQLite persistence, bounded replay/snapshot fallback, permission confirmation,
and restart repair. It is useful evidence that this host surface is implementable.
Its documented limitations include one public chat per session, no multi-user
policy or MCP forwarding, and no windowed subscriptions.

| Gateway component                                | AgentConnect application                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| ACP-to-AHP mapping                               | Reference for the projection; feed AgentConnect's masked events and daemon lifecycle events rather than bypassing the daemon. |
| Ordering, replay, snapshots, protocol validation | Reuse patterns and assess extractable code against our relay, storage, and ownership/fencing requirements.                    |
| Official-client/fake-ACP integration tests       | Reference scenarios for multi-client convergence, permission races, timeout isolation, and reconnect overflow.                |
| `AcpAdapterFactory`                              | Useful execution seam for a spike, but insufficient by itself for full integration.                                           |
| `GatewayStore` and `AcpV1Process`                | Do not adopt their default ownership. Bridge existing session/storage/recovery owners instead.                                |

In the reviewed code, `GatewayServer` directly constructs `GatewayStore`, and
the default factory starts an ACP subprocess per chat. Replacing only the
factory leaves session creation, storage, recovery, and authorization concerns
in the gateway. A production reuse decision needs separable execution, store,
event-ingress, and authorization boundaries; do not assume those are already
published stable library interfaces.

**Recommendation:** build the projection with the official SDK and use the
gateway as a reference/interop fixture. Consider extracting or upstreaming
reusable host components only after the spike demonstrates a clean boundary.
An independent gateway is useful for client experiments, but those sessions do
not automatically inherit AgentConnect's memory, tools, identity, or routing.

The gateway is MIT-licensed. Preserve attribution/license notices if code is
copied. This proposal adds no gateway code or dependency.

## 8. Incremental implementation and acceptance

### Phase 0: shadow projection

Create a proposed `packages/daemon/src/ahp/` projection alongside current output
consumers. No client traffic or execution ownership changes. Use the existing
session's masked output and daemon lifecycle events, and compare state against
current Webchat/transcript behavior.

Exit criteria:

- Text, tools, reasoning, reply boundaries, completion, cancellation, and
  approval state agree with the current surfaces.
- Discard/reset and late-output fencing do not leave superseded text visible.
- Snapshot reconstruction after restart uses durable records plus reconciled
  lifecycle state, with explicit treatment of interrupted work.
- The identity map, unsupported capabilities, and extension requirements are
  recorded; no private ACP identifiers or secrets leak into public state.

### Phase 1: Webchat behind a flag

Add the authorized relay carrier and AHP action adapter into existing execution
entry points. Keep old clients supported during a bounded migration period.
Roll back by selecting the old transport; never run the two paths as competing
execution owners for one action.

Before default-on and deletion of old streaming code, cover:

| Scenario                                                 | Required observation                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Two clients observe one existing session                 | Same ordered state and final transcript; observing creates no second runtime.                   |
| Lost acknowledgment, repeated action                     | One admission/effect, deterministic reconciliation.                                             |
| Replay within bounds / beyond bounds                     | Replay / snapshot recovery both converge without sequence-gap heuristics.                       |
| Relay hop loss, slow client, daemon restart/reassignment | Failure is surfaced; bounded buffering and recovery cannot mix stale output with new execution. |
| Cancel or approve concurrently from two surfaces         | Existing authorization and cleanup barriers hold; one valid settlement.                         |
| Revoked/foreign principal or guessed channel             | No discovery, replay, snapshot, or action access outside the audience.                          |
| Discard while streaming or disconnected                  | Every authorized observer reaches the same current generation.                                  |
| Multi-agent and cross-platform continuation              | Preserve roster/scope, reply attribution, origin mirroring, and merged-history behavior.        |
| Old/new clients during rollout                           | Explicit capability negotiation and working fallback; no silent unsupported action success.     |

### Phase 2: additional clients and optional Console migration

Reuse the same host for live Console views, then validate a real external AHP
client against the authenticated relay endpoint. Define provider/session
discovery and creation semantics explicitly. Do not promise full VS Code
feature parity from Chat support alone.

Retire only the live-view polling/invalidation paths whose replacements are
proven. Existing metadata and bounded workspace/memory APIs remain independently
useful. If Phase 2 does not justify its cost, Phases 0-1 stand alone.

## 9. References and scope of this change

- [Original proposal #2081](https://github.com/agentconnect-md/agentconnect/pull/2081)
  and [tracking issue #1339](https://github.com/agentconnect-md/agentconnect/issues/1339).
- AHP 1.0 [Chat](https://github.com/microsoft/agent-host-protocol/blob/spec/v1.0.0/docs/specification/chat-channel.md),
  [subscriptions](https://github.com/microsoft/agent-host-protocol/blob/spec/v1.0.0/docs/specification/subscriptions.md),
  [lifecycle](https://github.com/microsoft/agent-host-protocol/blob/spec/v1.0.0/docs/specification/lifecycle.md),
  and [versioning](https://github.com/microsoft/agent-host-protocol/blob/spec/v1.0.0/docs/specification/versioning.md).
- Gateway [architecture](https://github.com/formulahendry/ahp-acp-gateway/blob/9bcd0d4b684b600bb620844fb4ad82feca50c965/docs/architecture.md),
  [host implementation](https://github.com/formulahendry/ahp-acp-gateway/blob/9bcd0d4b684b600bb620844fb4ad82feca50c965/src/gateway.ts),
  and [adapter interface](https://github.com/formulahendry/ahp-acp-gateway/blob/9bcd0d4b684b600bb620844fb4ad82feca50c965/src/acp.ts).
- AgentConnect [session model](session-concept.md),
  [multi-agent Webchat](webchat-multi-agents.md), and
  [cross-integration continuation](webchat-cross-integration-continuation.md).

This change covers the refreshed adoption proposal, gateway assessment, code
retirement map, architecture diagram, and phased acceptance criteria. All
implementation, performance measurement, runtime interoperability, and rollout
work remains to be done; #1339 remains open.
