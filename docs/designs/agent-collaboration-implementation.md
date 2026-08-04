# Agent Collaboration - Implementation Design

**Status:** Implemented. See
[`loop-breaker-design.md`](loop-breaker-design.md) for loop safety.

> **Routing update:** [`send-message-routing-rework.md`](send-message-routing-rework.md)
> is implemented. Finalized AgentConnect-authored platform mentions are now routable
> (through their own ladder, never through implicit routing), the visible in-thread
> `sendMessage` forms are gone while `toAgent + channel` remains as a channel-root
> send, and a parent-session reply is injected into the parent session (never
> published) while resuming it as an ordinary turn. Agent-to-agent activation is no
> longer exclusively the internal `messageAgent` path — a verified explicit mention is a
> second, equally hop-bounded path. Read that document for the verification, hop
> transition, and activation rendezvous rules.

> **Current behavior:** the `sendMessage` peer-agent target and
> `startOrchestration` use the daemon's internal `messageAgent` delivery
> primitive. A peer wake is postless unless `sendMessage` explicitly includes a
> channel. Runtime code and protocol schemas are authoritative for exact
> payload shapes.

> This document is the concrete implementation design for
> [`agents-collaboration-design.md`](agents-collaboration-design.md). That
> document explains what and why; this document explains how it lands in the
> code.
>
> Three major areas:
>
> - **Section 2: Agent-mention delivery data plane** - agent-to-agent delivery that uses an @mention in a channel/thread to wake another agent
> - **Section 3: Main-agent orchestration** - direct-message workers + wait/collect + summarize, including correlation, completion detection, and result collection
> - **Section 4: Concurrency model** - natural concurrency across threads/sources, serialization within one conversation line, and backpressure/limits
>
> The canonical safety rules for feedback loops are in [`loop-breaker-design.md`](loop-breaker-design.md). This document defines delivery and orchestration; that document defines when a platform conversation, agent-call chain, or future interaction graph must stop and how it recovers.

---

## 1. Overview

### 1.1 In One Sentence

The platform provides a first-class **agent-to-agent** capability: an agent can
wake a peer in the current conversation context, or act as a main agent that
fans work out to multiple workers, waits for results, and summarizes them. The
daemon remains on the message hot path and CP remains off it.

### 1.2 Current State

| Stage                       | Current behavior                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session identity**        | `sessionKey = platform:channel:thread:agentId`; the same platform thread maps to a separate session per agent.                                                                                                     |
| **Peer discovery**          | `listAgents` (alias `listChannelAgents`) uses the `channel/agents` control request. Scope is the requester's **organization**, filtered by the directional call policy; `channel` is an optional narrowing filter. |
| **Agent-to-agent delivery** | The `sendMessage` peer target invokes the internal `messageAgent` primitive locally or uses `rd/agentmsg` → `rd/agentmsg/fwd` → `rd/agentmsg/ack` across daemons. Message bodies never traverse CP.                |
| **Call authorization**      | The caller's outbound policy and target's inbound policy must both allow the edge; directory, source daemon, relay, and target daemon verify independently.                                                        |
| **Orchestration**           | `startOrchestration`, `getOrchestration`, and `cancelOrchestration` use durable daemon-local state, trusted correlation metadata, and deadline wakes.                                                              |
| **Concurrency**             | Different sessions run concurrently; a per-`sessionKey` admission gate serializes one conversation and enforces queue/capacity limits.                                                                             |

### 1.3 Implemented Surface

- `listAgents` for authenticated, org-scoped peer discovery
  (`listChannelAgents` remains a deprecated alias of the same handler).
- `sendMessage` for peer wakes, parent-session replies, and visible platform
  posts; its peer branch uses the same-daemon or cross-daemon
  `messageAgent` delivery primitive.
- A durable inbox and per-session admission gate.
- Fan-out orchestration with correlated worker replies, deadlines, and
  cancellation.

### 1.4 Boundaries / Non-Goals

- Do **not** introduce synchronous "agent calls agent" RPC. Delivery is always an **asynchronous wake-up**: the message enters the peer's session and the peer handles it in its own turn, matching the asynchronous social-peer model.
- Do **not** put CP on the message hot path. Cross-daemon message bodies use the **relay data plane (daemon -> relay -> daemon)** and **never pass through CP**. CP distributes only placement/routing metadata without message bodies through `rc/*`, including call policy.
- Do **not** treat channel membership as authorization — not as a sufficient condition, and (since the org-scoped directory) not as a necessary one either. The directional call policy (`outboundPolicy` / `allowedTargetAgentIds` on the caller, `callPolicy` / `allowedCallerAgentIds` on the target) is the whole authorization predicate, org-scoped, and it is checked by a trusted endpoint against the authenticated caller (section 2.5).
- Do **not** change ACP. The target agent processes an inbound agent message exactly as it processes a human message.

---

## 2. Agent-Mention Delivery Data Plane

An agent can select a visible peer and wake it in the current conversation
context without creating a visible platform post.

### 2.1 Existing Seam (Why This Does Not Require a Large Rewrite)

All inbound traffic converges on one function:

```
dispatch(agentId, msg: NormalizedMessage, integrationId)   // packages/daemon/src/daemon.ts:2442
  -> sessions.handle(...)  // Build ACP blocks, including section 8.5 catch-up replay, then prompt the ACP host.
  -> onAcpUpdate returns the response.
```

Two existing call sites **explicitly select an agent and bypass arbitration**:

- `handleRelayIm` (`daemon.ts:1733`): relay IM directly delivers `msg.agentId`.
- The webchat `explicitAgentId` shortcut (`routing-table.ts:56-60`).

**Conclusion: waking an agent means constructing a `NormalizedMessage` whose coordinates identify the target agent's `platform:channel:thread`, then calling `dispatch(targetAgentId, msg)`.** Because the session key includes `agentId`, the message naturally enters the target agent's own session (`local-store.ts:102`). It touches neither `routeRules` nor ACP.

### 2.2 Peer Discovery and Unified Sending

The daemon injects these tools from `packages/daemon/src/mcp/tools.ts`. It holds
platform tokens and routing credentials; the agent never sees them.

**`listAgents`** (deprecated alias: `listChannelAgents`)

```ts
// Input: { channel? }  // OPTIONAL FILTER. Omitted => the whole org directory.
// Output: [{ agentId, name, displayName?, description?, status }]
```

The daemon derives `platform` and `requesterAgentId` from trusted session
context, then sends `channel/agents` to the Control Plane. Tool input cannot
override caller identity or platform; `channel` is the only agent-supplied
field, and it can only narrow the answer.

Two scopes, one roster (`packages/control-plane/src/ws/handlers/channel-agents.ts`):

- **`channel` absent — the org-wide peer directory.** This is the default.
  The CP reads `AgentRepo.orgDirectory(orgId)` for the _authenticated daemon's_
  organization and applies the section 2.5 predicate. The reply omits `channel`.
- **`channel` present — the same directory intersected with that channel's
  membership** (`IntegrationRepo.agentsInChannel`). Literally a filter over the
  org roster, never a substitute for it, which is what keeps an unroutable agent
  out of _both_ scopes rather than only one of them. A session-identity platform
  (`webchat` / `hook` / `dream`) has no persisted integration, so a channel
  filter on one of those short-circuits to an empty roster instead of reaching
  persistence.

Both scopes are computed by the same `visibleToRequester()` filter, so they can
never answer differently about a given agent.

Why the default is org-wide, not the current channel:

- **A2A delivery has been postless since #854.** A `sendMessage` with `toAgent`
  and no `channel` publishes nothing, so the channel plays no part in _delivery_
  and must not act as an authorization key either.
- **Some sessions have no channel the CP has ever seen.** Webchat, webhook/`hook`,
  dreaming, and memory-only agents have no IM integration at all, yet must still
  collaborate. Under channel-gated discovery they were structurally undiscoverable.

Rolling upgrade: the channel-less form exists only on a CP that advertises the
`agent-directory-org-scope-v1` server feature in `register/ok.serverFeatures`.
The daemon negotiates it — when the feature is absent it substitutes the caller's
trusted _current_ channel (exactly the pre-change behavior) rather than sending a
payload an older CP would reject. An explicitly requested `channel` filter is
passed through to either CP unchanged.

**Rename.** The tool is `listAgents`; `listChannelAgents` is kept as a
deprecated alias with the same input schema, routed to the same handler, so a
session already warm with the old tool set — and prompts or skills that learned
the old name — keeps working.

**`sendMessage` peer target**

```ts
// Input: {
//   toAgent: string,            // From listAgents. Direct form: no channel.
//   channel?: string,           // Channel-ROOT form. There is no in-thread form.
//   message: string
// }
// Output: { delivered: boolean, targetSession: sessionKey }
```

With no `channel`, `sendMessage` performs a direct, postless peer wake through
the daemon's internal `messageAgent` primitive. With a `channel`, it also
publishes a visible platform message at the channel ROOT — carrying the target's
rendered `@mention` — and anchors the peer to that post. The two halves are
reconciled through the activation rendezvous so the peer is admitted exactly once.
The target receives caller-attributed text in its own agent session:

- `toAgentId` selects the peer to wake.
- A postless delivery remains anchored to the caller's trusted
  platform/channel/thread context.
- Target call policy controls activation. A denied call returns
  `delivered:false, reason:'not_allowed'`.
- Trusted daemon/relay code derives `fromAgentId`; an agent cannot attest its
  own identity.
- `correlationId`, `subtaskId`, hop count, and orchestration status are trusted
  call metadata, not caller-authored message fields.

### 2.3 Delivery Paths (Two Target Locations)

**Same daemon, where the target agent runs locally:** call local `dispatch` directly.

```
messageAgent(toAgentId, text, coords)
  -> Construct NormalizedMessage {
      platform, channel, thread,           // Target coordinates.
      text: direct caller-attributed message,
      from: { kind: 'agent', agentId: currentAgent },
      msgId: stable monotonic deliveryId,
    }
  -> admit + dispatch(toAgentId, msg)
```

- **Deduplication / ordering (see section 6.3):** **Generating a unique msgId and reusing existing deduplication is insufficient.** The `(sessionKey,msgId)` cache wraps only `rd/msg`; same-daemon `dispatch` and `rd/agentmsg` bypass it. `transcriptCoords()` also derives ts from the final msgId segment, while `transcriptSince` sorts by ts, so a random UUID can reorder or omit replay. Use a **stable `deliveryId` + monotonic `ts`** and one admission idempotency layer shared by local and relay paths.
- **Return path:** A worker's reverse `messageAgent` call wakes the main agent
  and supplies the result. Trusted correlation metadata updates orchestration
  completion; no platform echo is used as a trigger.

**Cross daemon, where the target agent runs elsewhere:** use the **daemon -> relay -> daemon data plane**; the message body **does not pass through CP**. Reuse the physical shared-bot links—daemons connected to relays and relays holding connections by daemonId—described in [`shared-bot-relay.md`](shared-bot-relay.md), but **do not address through existing `members`**:

- **Collaboration-routing snapshot:** CP sends bot-independent placement and
  policy metadata to relays and daemons; it contains **no message bodies**. It has
  two parallel parts, both FULL-REPLACE:
  - `channels[]` — channel membership keyed by `(orgId, platform, channelId)`.
    Value per agent: `{ agentId, daemonId, integrationId?, botAppId?, callPolicy,
allowedCallerAgentIds, outboundPolicy, allowedTargetAgentIds, name?, displayName? }`.
    Still the authority for the genuinely channel-shaped questions: which reply
    integration to use for a visible post, and which inbound bot app belongs to
    another AgentConnect agent.
  - `agents[]` — the **flat, channel-free org directory** (`CollabOrgAgent` = a
    placement plus its own `orgId`, minus the per-channel `integrationId` /
    `botAppId`). This is the authorization input. The channel-keyed structure
    _structurally cannot_ express an integration-less agent: such an agent appears
    in no `channels[]` entry at all, so "which agents exist in this org" — exactly
    the input channel-free authorization needs — is unanswerable from it. Unplaced
    agents (`daemonId` null) are dropped from both parts: with no owning daemon
    there is nothing to route to.
  - Relay resolves `toAgentId` to its owning `daemonId` from `agents[]`, then gets the connection through `relay-daemon-server.get(daemonId)`.
  - `CollabRoutesSnapshot` travels to relay through `rc/collab-routes` and to
    daemons through `register/ok` plus `collaboration/routes`.
  - **Old-CP fallback.** A CP that does not advertise
    `agent-directory-org-scope-v1` sends no `agents[]` (it decodes to the schema
    default `[]`). Relay and daemon then _derive_ the directory from the channel
    rows — every row carries its `orgId` and its members are placements — so
    integration-backed pairs keep resolving across a rolling upgrade. An
    integration-less agent stays absent, and the predicate fails closed on it,
    which is that CP's pre-existing behavior anyway.

```
agentA@daemon-1
  messageAgent(toAgentId=B)
  -> daemon-1 cannot find B locally -> send relay op
     rd/agentmsg { claimedFromAgentId, toAgentId, text, coords, correlationId, hopCount }
       over the direct rd/* data plane, not CP  // claimedFromAgentId is untrusted; see section 2.5.
  -> relay resolves B to owning daemonId through the collaboration-routing snapshot
     -> get(daemonId) obtains the connection
  -> relay verifies that claimedFromAgentId belongs to the authenticated socket's daemonId
     per the flat org directory, that caller and target are in the SAME org, and that both
     directional call policies admit the edge  // channel membership is NOT consulted
  -> relay then creates a trusted caller claim containing trustedFromAgentId + org assertions
     and sends it with the message to daemon-2
  -> daemon-2 handleRelayAgentMsg performs final verification of the trusted caller claim
     -> constructs NormalizedMessage -> dispatch(B, msg)
```

- Relay op `rd/agentmsg` in `relay-daemon.ts` carries `{ claimedFromAgentId, toAgentId, text, coords, correlationId, hopCount }`. Because one authenticated daemon can host several agents, the socket's daemonId cannot identify which agent initiated a call. The frame therefore carries a **claimed, untrusted `fromAgentId`**. Relay verifies it against socket daemonId + the flat org directory (the claimed id must exist and its placement must be owned by the authenticated sending daemon — that daemon-ownership check, not channel membership, is what makes the claim unforgeable), then and only then creates a trusted caller claim for forwarding. `msg.coords` rides along as the **delivery coordinate** for the woken session, never as an authorization input; the target's reply `integrationId` prefers its placement in the coords channel and falls back to its directory entry when it has no row there (an integration-less peer legitimately has none).
- See section 2.5 for authorization, including target call policy and creation of trusted caller identity.

### 2.4 Target-Agent Experience

Target agent B receives an ordinary inbound message whose `from` identifies `@agentA`. It handles it in **its own turn** and can:

- Reply to its parent session with `sendMessage` and the parent `sessionId`,
  preserving trusted correlation.
- Use the `sendMessage` peer target to wake a third agent for chained
  collaboration.

**Loop protection is daemon-managed; the agent cannot supply hop/origin:**
`sendMessage` has no `hopCount` or `originId` input. The daemon's active-turn
context carries trusted call metadata, preventing an agent from omitting or
resetting chain depth.

> The current implementation includes trusted `hopCount` but not `originId` / interaction budgets. See sections 7-8 of [`loop-breaker-design.md`](loop-breaker-design.md) for their precise boundaries and evolution plan.

- `hopCount` is **trusted inbound call metadata on the active turn**, using the
  same daemon-side turn context as section 3.3a `call_metadata`. A future
  `originId` must use the same trust boundary.
- When the agent calls the `sendMessage` peer branch during that turn, the
  daemon automatically sets outbound `hopCount = current turn hopCount + 1`.
  It ignores any agent-supplied value.
- Queue replay restores the persisted turn hop; compaction cannot reset it.
- The daemon rejects delivery above the shared `MAX_AGENT_CALL_HOPS` threshold
  (currently 20).
- **Test:** omitting hop arguments or explicitly passing `hopCount:0` cannot reset chain depth; the daemon uses turn-bound hop + 1.

### 2.5 Authorization: The Directional Call Policy, Org-Scoped

Authorization is the intersection of the caller's outbound policy and the
target's inbound policy, within one organization. See
[`directional-agent-visibility.md`](directional-agent-visibility.md).

**The predicate.** Caller A may discover and wake target B iff **all** of:

1. A and B are both **known in the org-scoped directory** — a missing entry fails
   **CLOSED**, so a missing or stale snapshot never grants access;
2. A and B are in the **same organization** (a cross-org pair never resolves, and
   is reported indistinguishably from a nonexistent target so there is no
   cross-org probing);
3. **A's `outboundPolicy`** is `all`, or `allowedTargetAgentIds` contains B;
4. **B's `callPolicy`** is `all`, or `allowedCallerAgentIds` contains A.

A caller **always sees itself** in a _listing_: an agent whose `outboundPolicy`
is `selected` does not normally name itself in its own allow-list, yet it must
still appear in its own directory answer. (A self-_wake_ is still rejected
separately, with `reason:'self'`.)

**Channel membership is not part of the predicate** — in either direction. It is
not sufficient (a `selected` policy still denies a channel-mate) and it is no
longer necessary (peers that share no channel, and peers with no IM integration
at all, are legitimate). The single implementation is
`CpCollabRoutes.admits()` on the daemon and `CollaborationRouter.admits()` on the
relay; `visibleToRequester()` is the CP-side twin used for both discovery scopes.

**Two unrelated things are both called "visibility" — keep them apart:**

| Field                                                                        | Governs                                                                          | Affects the peer directory?                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Agent.visibility` / `sharedWith` (`ResourceVisibility` org \| restricted)   | **Human** console access, see [`resource-visibility.md`](resource-visibility.md) | **Never.** A `restricted` agent is still a discoverable, callable peer. |
| `callPolicy` / `outboundPolicy` (labelled "Agent visibility" in the console) | **Agent-to-agent** discovery and wakes                                           | **Yes — it is the whole gate.**                                         |

The CP's `orgDirectory` read deliberately omits the `visibilityWhere` clause for
exactly this reason.

**Coordinate integrity is a separate check, not a removed one.** Channel checks
did not disappear; they moved from _authorization_ to _coordinate validation_. An
asserted coordinate channel that the snapshot knows about still requires the
caller to be in it, and a visible post still resolves through the channel's
definite reply integration (section 6.2). What changed is the consequence: a
channel the directory has never heard of no longer makes a peer _unreachable_ —
but it also no longer silently becomes that peer's session key.

The rule is **one three-way decision**, factored into a single place per package
(`CollaborationRouter` on the relay, `CpCollabRoutes` on the daemon) that returns a tagged
verdict rather than a bare boolean, so no call site re-derives it:

| Asserted coordinate                                                                                                                                                          | Verdict                                                                                            | Why                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KNOWN** — the snapshot holds a non-empty membership at `(orgId, channelId)`                                                                                                | caller in it ⇒ use the **asserted** coordinate unchanged; caller absent ⇒ **reject** `not_allowed` | Preserves the deliberate "land in the same thread a human sees" behavior, and keeps the assertion honest.                                                                                                                               |
| **UNKNOWN on any chat-shaped platform** — every id outside the session-identity set (`isSessionIdentityPlatform`: `webchat`/`hook`/`dream`), UNKNOWN ids included (S1a §6.1) | **reject** `not_allowed` — FAIL CLOSED                                                             | An unrecorded chat coordinate is either a conversation the caller cannot reach or a stale/departed row whose session is still resumable. Admitting it is exactly what let a caller alias an existing platform session.                  |
| **UNKNOWN and channel-free** — exactly the session-identity platforms (`webchat`, and a `hook`/`dream` session's raw platform, on the same-daemon AND the cross-daemon path) | **substitute** a synthetic coordinate `a2a:<callerAgentId>`                                        | Rejecting would kill the case the org-scoped directory exists for. Instead the asserted channel never becomes the session key: the woken peer's coordinate is derived from the TRUSTED caller, which cannot alias any platform session. |

Fail-closed on the middle row is the intended direction: a brief snapshot lag can
transiently reject a genuine wake, and the caller retries. Admitting it, by contrast, is
unrecoverable — the aliased session has already been resumed and read back.

**Which platform value each path feeds it.** The RAW trusted session platform, everywhere
— the historical `narrowPlatform` fold (unknown → `'slack'`) is deleted (S1a §6.3), the
wire's `coords.platform` reads as an open string (S1a §6.2), and since the S1a fleet gate
passed the daemon emits raw values too: `localWakeDecision` passes `req.platform`
verbatim, `handleRelayAgentMsg` passes `msg.coords.platform` verbatim, and a CROSS-DAEMON
wake out of a target-less `hook`/`dream` session carries its real platform and takes the
bottom row on both sides, exactly like the same-daemon path.

**Lineage replies never take the bottom row's substitution.** A `SessionTarget` reply into
a channel-free origin would otherwise be substituted into a DIFFERENT synthetic session
(`a2a:<replier>`), stranding a `needsReply` result outside the originating turn. The reply
therefore rides the wire as a first-class lineage reply (`rd/agentmsg.lineageReplyTo` = the
origin's acpSessionId): the sender's daemon enforced origin-only authorization, possession
of the high-entropy id — handed out only through wake lineage — is the cross-daemon
capability, and the TARGET daemon terminally validates the session exists and belongs to
the target agent, dispatches into it, and NAKs `not_found` when it is gone. SessionTarget
never creates a session, on either path.

The synthetic coordinate is collision-free by construction: real Slack / Telegram /
Discord channel ids never contain `:`, and webchat conversation ids are UUIDs, so an
`a2a:`-prefixed value can never equal a platform conversation id. Two different asserted
channels from the same caller therefore collapse into **one pairwise session**, which is
the right semantics for a postless agent-to-agent conversation.

**Where each half runs.** The relay's job is validation only — it applies the KNOWN and
persisted-IM rows and NAKs, byte-for-byte identically to the daemon. The substitution is
applied where the session key is actually **minted**, on the daemon (`childSessionId` on
the relay-forwarded path, `targetSession` on the same-daemon path), so relay and daemon can
never disagree about the resulting key. All **three** wake paths run the decision so none
can drift:

| Wake path                       | Call site                          |
| ------------------------------- | ---------------------------------- |
| cross-daemon ingress            | `AgentMsgRouter.route()` step (b2) |
| cross-daemon terminal-verify    | `Daemon.handleRelayAgentMsg`       |
| same-daemon (and its preflight) | `Daemon.localWakeDecision`         |

Two properties of the membership key are load-bearing:

- **Platform-free _lookup_.** The coordinate platform is deliberately not part of the
  membership key — it is consulted only afterwards, to classify a coordinate the lookup
  did not find (reject vs. substitute). Historically it COULD not be part of the key:
  session keys were computed through the since-deleted `Daemon.narrowPlatform` fold
  (`feishu` — and any value it did not recognise — became `'slack'`), while snapshot
  channel rows are keyed by the **integration** platform, so a platform-keyed lookup
  searched a different key space than the session key it protects, and the original
  admit-on-miss branch turned every such mismatch into a **pass**. Session keys carry the
  raw platform now (S1a §6.3), but the channel-id-only match stays: it closes the
  relabelling dodge in both directions regardless of key regime and needs no fold twin on
  the relay, which never had one. It over-blocks only if one org uses the same channel id
  on two platforms — which then demands membership in one of them.
- **Non-empty membership counts as "known".** An agent-less row is a channel nobody in the
  org can reach, so treating it as known would reject every call naming it while
  protecting nothing.

The same-daemon path needs this as much as the relay hop, not less: `channel` and
`thread` reach `MessageAgentReq` from the **model**, so without the check a
prompt-injected agent could name a channel it cannot reach and resume a co-located peer's
session living there. Relative to the `hasMembers(caller, target)` membership check it
replaced, the rule is weaker on the KNOWN row only (the **target** no longer has to be in
the channel), unchanged on an unrecorded IM coordinate, and no longer keyed on the channel
at all in the channel-free case — which is the case that check made unreachable.

**What the fail-closed branch actually covers.** The verdict cannot ask "is this an IM
channel the caller may speak in?"; it can only ask what the snapshot records. Direct
conversations _are_ recordable — `IntegrationChannel.kind` is
`channel | im | mpim`, and `IntegrationRepo.channelPlacements` selects the channel rows
with **no** `kind` filter, so an `im`/`mpim` row that exists is a KNOWN coordinate with the
owning integration's agent as a member. Such a row is written only after observation:
Slack's authoritative membership snapshot enumerates `public_channel,private_channel`
only, while `Daemon.reportObservedConversation` and the CP shared-bot
`reportConversation` emit `im`/`mpim` for every visibility. An ordinary DM therefore
becomes a known coordinate after its first inbound message; before that observation an
A2A wake asserting it is refused. Refusing the brief unknown state is recoverable where
admitting it is not (the aliased session has already been resumed and read back). The
same applies to a row that has disappeared — bot removed, integration set inactive, or a
snapshot that has not caught up.

The data model stores:

- `Org.defaultAgentVisibility: 'all' | 'selected'`, defaulting to `all`, seeds both
  directions for newly created agents and never rewrites existing ones.
- `callPolicy: 'all' | 'selected'`, defaulting to `all`; when `selected`, accepts no peer until allowed.
- `allowedCallerAgentIds: string[]` is the set of agent IDs allowed when `callPolicy='selected'`.
- `outboundPolicy: 'all' | 'selected'`; its
  `allowedTargetAgentIds` constrain which peers the caller may select.

An agent create may override either direction explicitly. The Agent columns retain `all`
database defaults for writes that bypass the repository creation seam.

`AgentSpec` carries local target policy, while the versioned collaboration
snapshot supplies caller/target organization, placement, and policy data for
_every_ agent in the org — local or remote. Missing or stale policy fails closed,
which is also why a local-only daemon that has never received a snapshot cannot
authorize an agent call at all.

Checking only same org + same channel would bypass policy. A target may reject
all calls or allow only specific callers. Both internal `messageAgent` delivery
paths enforce call policy from the sources above:

- **Same daemon:** the daemon evaluates the org-scoped predicate against its
  snapshot _before_ looking the target up locally — so the same verdict covers a
  remote target and an id in no directory at all — and then also re-checks a
  local target's spec policy. Caller identity is the current session agentId that
  invoked the tool and is locally trusted. A local agent id is **not** sufficient
  authority on its own.
- **Cross daemon: never trust `claimedFromAgentId` from the frame.** `rd/hello` authenticates only the connection's **daemonId** through `relay-daemon-connection.ts` states AUTHENTICATING -> READY; one daemon can host multiple agents, so the socket cannot attest the agent:
  1. Relay binds the request to the socket's authenticated daemon identity.
  2. Relay uses the trusted collaboration-routing snapshot to verify that `claimedFromAgentId` exists in the flat org directory and that its placement is owned by that daemon. Org is bound from the caller's own entry — the frame carries no `orgId`.
  3. Relay resolves B in the **same org** (absent or cross-org ⇒ `not_found`), then checks A's outbound and B's inbound policy. The two halves stay separate calls (`outboundAdmits` / `inboundAdmits`) so each denial keeps its own log line. Only then does it create a trusted caller claim (trustedFromAgentId + org assertion, or a verifiable capability).
  4. The **target daemon performs final defense-in-depth verification** with its distributed policy/snapshot or relay-verifiable capability. Terminal-verify is **org**-scoped, not `(org, channel)`-scoped: the relay's asserted org must equal the org the daemon's own directory records for the target, and `admits(trustedFromAgentId, toAgentId)` must hold. Missing snapshot / unknown agent fails closed.
- On rejection, return `delivered:false, reason:'not_allowed'` and **do not wake** the target.
- **Tests:** a caller outside a `selected` allowlist is rejected locally and cross-daemon; `all` permits it; cross-org is rejected; missing or stale policy/snapshot **fails closed**.

### 2.6 Implementation Map

| Layer         | Current responsibility                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol      | Defines `channel/agents`, relay `rd/agentmsg`, versioned collaboration-routing snapshots, and policy fields on `AgentSpec`; hop and claimed caller values remain untrusted until verified                                          |
| Daemon        | Injects `listAgents` (alias `listChannelAgents`) and unified `sendMessage`, performs local delivery and org-scoped target-side verification, maintains trusted call metadata, and receives the versioned collaboration snapshot    |
| Relay         | Routes `rd/agentmsg` using the bot-independent snapshot, binds the authenticated daemon, verifies claimed caller ownership, creates the trusted caller claim, and enforces policy                                                  |
| Control plane | Distributes versioned membership, placement, route, and policy snapshots (channel-keyed `channels[]` **plus** the flat org `agents[]`) to relays and daemons without message bodies, and advertises `agent-directory-org-scope-v1` |
| Tests         | Cover tool validation, local and relay delivery, directional-policy rejection, forged caller claims, missing/stale snapshots, cross-organization rejection, trusted correlation, and hop-depth enforcement                         |

### 2.7 Follow-Ups (Explicitly Not Done Here)

Org-scoped discovery removed channel from **authorization**. These items are known
remaining work and are deliberately out of that change's scope:

1. **A general channel-free session-coordinate scheme.** `channel` is still the
   _session key_ (`sessionKey = platform:channel:thread:agentId`, with a wake's
   `msgId` / fallback thread `agentcall:<channel>:…`), and the coordinate-integrity
   verdict above now substitutes `a2a:<callerAgentId>` for it in exactly one case —
   an unknown coordinate on a channel-free platform. Everything else keeps the
   asserted coordinate verbatim, so a first-class `dm:`-style session identity for
   agent-to-agent conversations generally (see open question 1 in section 5) is
   still a separate change.
2. **`ws/connection.ts` handler-throw hardening.** A throwing daemon↔CP WS handler
   still closes the whole control socket (`close(1011)`), which is why the
   `channel/agents` handler must short-circuit a session-identity platform before
   reaching persistence rather than letting the repo throw. Turning a handler
   fault into a per-request error is a separate change.
3. **Optional org-level discovery-scope switch.** Org-wide is currently the only
   default. An operator who wants the old channel-scoped default back has no
   setting for it; an explicit per-org policy switch is a possible follow-up.
4. Snapshot lifecycle (§6.5): per-entry tombstones, TTL after a CP disconnect,
   and fail-closed-on-stale remain unimplemented for the flat directory exactly
   as for `channels[]` — `generation` is the version hook, a live CP is assumed.
5. **A positive notion of "coordinates this agent may assert."** The verdict above closes
   the admit-on-unknown hole by failing closed, which costs recall: an unrecorded but
   legitimate direct conversation is refused rather than admitted (see "What the
   fail-closed branch actually covers"). Recovering that recall means recording direct
   conversations for ungated integrations too, or checking the asserted coordinate against
   the target's existing **session** rows rather than the membership snapshot. Neither is a
   tweak to this rule.
6. **The flat directory is pushed org-wide to every daemon.**
   `collabRoutes.broadcast` ships every placed agent's id, daemonId, name and all four
   policy fields to _every_ daemon in the org, because terminal-verify needs the (remote
   caller, local target) pair. So the `channel/agents` daemon-ownership bind is an
   **integrity** control (only the owning daemon may speak as an agent) plus
   confidentiality for `description`/`status` — it is _not_ what keeps
   `callPolicy: 'selected'` unreadable, since a daemon can compute any org agent's
   policy-filtered peer set from the pushed snapshot offline. Narrowing the per-daemon
   push to the peers that daemon can actually reach is the follow-up.

---

## 3. Main-Agent Orchestration (Fan-Out + Wait/Collect + Summarize)

> Goal: a **main agent** divides work into subtasks, directly messages multiple
> worker agents, waits for their return, and summarizes one result.

### 3.1 Principle: Do Not Build a New Scheduler

The main agent is an ordinary agent whose **prompt/skill** explains the
available workers, instructs it to plan and message each one, and asks it to
summarize after collection. The model supplies the planning behavior; the
daemon supplies durable delivery and collection rather than a general DAG
engine.

On top of section 2 `messageAgent`, only three mechanisms are needed: **correlation, completion detection, and result collection**. The model is asynchronous wait + collect.

### 3.2 Core Question: How Does Main "Wait"?

| Model                               | Method                                                                                                                                                                                 | Problem                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Synchronous blocking**            | Turn `messageAgent` into request/response and keep the main turn blocked until the worker replies                                                                                      | Simple, but occupies the whole main turn, blocks other messages, holds the ACP host, and makes timeout difficult. Multiple workers make serial behavior worse |
| **Asynchronous wake (recommended)** | Main sends N messages, ends its current turn/yields, and schedules a cron deadline. A worker report or timeout **wakes** a new main turn, which reads collected results and summarizes | Does not occupy a turn, is naturally concurrent, and permits partial completion; requires tracking in-progress orchestration state                            |

Use asynchronous wake. Deadline wake-up does **not** assume a reminder subsystem, because none exists. Reuse/extend the cron scheduler as described in section 3.5.

### 3.3 Three Mechanisms

**Correlation: reply <-> subtask**

- Main includes a **unique correlationId**, such as `<orchestrationId>.<subtaskIdx>`, in each `messageAgent`.
- On completion, the worker returns the **same correlationId** when messaging main. Tool I/O and the prompt convention preserve it.
- **Merely adding `correlationId` to `NormalizedMessage` does not expose it to the agent:** `SessionManager.handle()` creates only a `msg.text` block for the current message at `session-manager.ts:97`, and transcript stores only sender/text. Agent-call metadata must therefore be **explicitly injected into the turn as structured context**, as described in section 3.3a. Only then can the worker return it and main observe trusted `fromAgentId`.
- Persist a lightweight daemon-local `orchestration` record with the main session: `{ orchestrationId, mainSessionKey, subtasks: [{correlationId, toAgentId, status, result?}], deadline }`. Do **not** store it in CP. **Persist before delivery** to avoid the lost-result window described in section 3.4.

**Section 3.3a: How Agent-Call Metadata Enters a Turn Without Becoming Forgeable**

Current constraint: transcript supports only `text | tool | reasoning` at `local-store.ts:81`, and `transcriptSince()` replays only `text`. Three obvious approaches all fail: storing it as `text` lets a platform user forge it; adding a new kind leaves it unread by current replay; and an ordinary ACP text block is still user-prompt content. Define this storage/assembly contract:

- **Separate `call_metadata` body:** Add a structured payload that does **not enter the user-prompt body**: `{ trustedFromAgentId, correlationId?, orchestrationId?, hopCount, originId }`. The daemon injects it during prompt assembly at the same layer as seed/persona in section 8.5. **Never parse it from platform text.** A user typing identical text does not create trusted metadata.
- **Bind active-turn correlation to daemon-side tool context:** Do not ask the model to copy a value from visible prompt text. Store current-turn `call_metadata` in daemon turn context. When a worker calls `messageAgent` to reply, the daemon **automatically reads `correlationId` from turn context**. It similarly propagates/increments hop/origin.
- **Trusted `trustedFromAgentId`:** A trusted endpoint from section 2.5, either local session or relay caller claim, writes it to `call_metadata`. Never derive it from agent prose or raw frame fields.
- **Recover after replay/session load:** Persist `call_metadata` with the turn on the daemon side, outside the platform-pollutable text transcript, so compaction/restart can rebuild turn context without losing correlation.
- **Tests:** worker turn receives correlationId + trusted fromAgentId; main sees a trusted identity rather than a self-filled frame field; a platform user's forged `call_metadata` text is ignored; metadata remains after replay.

**Correlation security cannot rely on correlationId alone.** Another agent in the same channel, or a duplicate/stale worker report, may carry the value and incorrectly mark a subtask done. A trusted endpoint handling a report must verify all of:

1. The orchestration belongs to the **current main session**, with matching `mainSessionKey`.
2. `correlationId` identifies an **unfinished** subtask.
3. **`fromAgentId === subtask.toAgentId`**; the reporter is the worker originally assigned, and section 2.5 supplies an unforgeable fromAgentId.
4. **Idempotency:** repeated reports for one correlation do not increment twice or overwrite the stored result unless updates are explicitly allowed.

Discard a report that fails any condition, log at debug level, and do not affect completion.

**Completion: N-of-N + timeout**

When main wakes from a valid report or timeout:

```
Valid report passes the four checks -> mark subtask done + store result.
if all subtasks are done              -> trigger complete summary.
else if deadline reached (cron wake)  -> trigger partial summary with received results and timed-out/failed entries.
else                                  -> remain pending; end the turn and yield.
```

- **N-of-N:** summarize immediately when all are done.
- **Timeout:** At start, schedule a one-shot deadline job through the existing cron scheduler. It wakes the main session for a **partial summary** and marks missing workers `timed_out`.
- **Worker failure:** A worker report with `status=error` counts as a received response and participates in completion.

**Result collection**

- Worker output enters main's session through the `text` returned via `messageAgent`, optionally with a structured summary + detail link.
- Main reads all `result` values from its orchestration record and writes one final human-facing response to the original trigger thread.
- Do not put **large output** in the message body. Workers return a link to their own session details; main summarizes links and concise results, preserving the existing principle of key channel information + links.

### 3.4 End-to-End Sequence

**Order is critical: persist the orchestration before delivering.** Sending three immediately executable tasks before creating the record creates a **lost-result window**: a fast worker can report before the record exists, and section 3.3 discards the unknown correlation.

```
Human in thread T: @main please upgrade these three RPC nodes.
  main turn #1:
    listAgents() -> [workerA, workerB, workerC]   // org-wide; no channel filter
    plan: three subtasks
    1. Persist orchestration o1 first:
       {mainSessionKey, subtasks:[o1.0->A, o1.1->B, o1.2->C all status=pending], deadline=null}
    2. Deliver one at a time and atomically update each subtask to delivered | failed after messageAgent returns:
         messageAgent(workerA, "Upgrade node 1", correlationId=o1.0) -> o1.0=delivered
         messageAgent(workerB, "Upgrade node 2", correlationId=o1.1) -> o1.1=delivered
         messageAgent(workerC, "Upgrade node 3", correlationId=o1.2) -> o1.2=delivered
       o1 already exists, so even an immediate A response matches o1.0.
    3. After all delivery attempts, schedule a one-shot cron deadline for +30m
       that wakes the main session, and write o1.deadline.
    Tell the human "Dispatched three subtasks; I will summarize when complete" and end the turn.

  workerA/B/C work in their own sessions -> complete
    -> messageAgent(main, result, correlationId=o1.x)

  main turn #2, woken by workerA and passing correlation checks:
    mark o1.0 done; not complete -> end.
  main turn #3, woken by workerB:
    mark o1.1 done; not complete -> end.
  main turn #4, woken by workerC:
    mark o1.2 done -> complete.
    Read all o1 results -> summarize -> reply in T:
    "All three nodes were upgraded: ... See each link for details."
    Cancel the cron deadline.
  If a worker never replies, the cron deadline wakes main for a partial summary + timed_out marker.
```

**Mid-dispatch failure:** If `messageAgent` returns `delivered:false` because of busy/offline/not_allowed, set that subtask to `failed`; it no longer counts as pending. Main still waits for other delivered subtasks. Completion counts only the delivered set as N, while `failed` / `timed_out` appear under incomplete in the final summary. If **every delivery fails**, do not schedule a deadline; immediately report dispatch failure to the thread.

### 3.5 Reused Delivery and Durable Deadline Wake

- **Delivery:** Everything uses section 2 `messageAgent`, both same-daemon and cross-daemon. Orchestration needs no new delivery channel.
- **Wake:** A worker report is itself a `messageAgent` to main, naturally waking a new main turn.
- **Deadline / timeout:** The deadline is a durable orchestration field in
  `local-store.ts`. It is the source of truth for a one-shot, cancellable
  direct wake of `mainSessionKey`; the general cron scheduler is not involved.
- **Concurrency:** Workers run naturally in parallel in distinct sessions. Section 4's per-session serialization gate sequences main's wake turns.

### 3.5a Orchestration API That the Main Agent Can Actually Call

The daemon owns orchestration storage and exposes tools rather than asking a
skill or prompt to mutate local state:

- **Atomic `startOrchestration`.** Daemon performs "create record with pending
  subtasks -> deliver each through messageAgent -> atomically record
  delivered/failed -> schedule deadline" in one operation, returning
  `{ orchestrationId }`. Persist-before-send ordering does not depend on model
  tool order.
  ```ts
  // Input: { subtasks: [{ toAgentId, text }], deadlineMs?, replyTarget }
  // Output: { orchestrationId, delivered: [...], failed: [...] }
  ```
- **Read/control tools:** `getOrchestration(orchestrationId)` lets main inspect all subtask/result state after wake. `cancelOrchestration(orchestrationId)` removes the deadline and writes the durable cancelled state. Section 3.3a `call_metadata` automatically preserves correlation in a worker response; main does not manually supply it.
- **Completion trigger:** On every worker report or durable deadline wake, main calls `getOrchestration` and determines complete/timeout. Daemon applies the four section 3.3 correlation checks and idempotency when storing report results.
- `startOrchestration`, `getOrchestration`, and `cancelOrchestration` live on
  the daemon MCP tool surface; durable state lives in `local-store.ts`.

### 3.6 Implemented Surface

| Layer    | Behavior                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon   | Carries `correlationId` and trusted caller metadata through the turn, persists a daemon-local orchestration record before delivery, and applies idempotent state transitions and correlation checks. |
| Deadline | Stores a cancellable one-shot deadline in the orchestration record and wakes `mainSessionKey` directly.                                                                                              |
| Tools    | Exposes `startOrchestration`, `getOrchestration`, and `cancelOrchestration`; worker replies inherit trusted correlation metadata.                                                                    |
| Tests    | Cover record-before-send, replay, partial delivery failure, forged or duplicate reports, serialized main wakes, N-of-N completion, deadline partial summaries, and worker errors.                    |

---

## 4. Concurrency Model (Concurrent Sessions, Serialized Line, Backpressure)

> Goal: define what is concurrent, what is serialized, and what happens at capacity. Sections 2 and 3 amplify concurrency substantially, so rules must be fixed first.

### 4.1 Current State

- **Session isolation naturally supports concurrency:** `sessionKey = platform:channel:thread:agentId` at `local-store.ts:102`. Different threads, sources, or agents use different sessions and do not interfere.
- **One agent handles multiple sessions concurrently:** One ACP host per agent from `hostFor` has multiple `pending` turns at `daemon.ts:2533`. Keep this behavior.
- **One conversation is serialized:** the per-`sessionKey` admission gate
  claims before dispatch, queues subsequent work in arrival order, and releases
  on completion, failure, or cancellation.
- **Current capacity enforcement is local to a conversation:** same-session
  work queues to a hard-coded depth of 10 and returns `queue_full` beyond it.
  The daemon does not yet enforce a collaboration-specific per-agent
  concurrent-turn limit or orchestration fan-out width.

### 4.2 Rules

| Dimension                           | Rule                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Across sessions**                 | **Concurrent**, unchanged. Different `sessionKey` values run fully in parallel.                             |
| **Within one session/conversation** | **Serialized / in order.** Handle inbound events for one `sessionKey` by arrival order, one turn at a time. |
| **Total for one agent**             | No collaboration-specific admission limit is currently enforced across sessions.                            |
| **One orchestration fan-out**       | `startOrchestration` accepts the supplied subtask array; no schema-level width limit is currently enforced. |

### 4.3 Per-Session Serialization Gate

The serialization gate applies **before** `sessions.handle()` by logical
`sessionKey`; a cold session has no ACP ID. Its atomic in-flight/queue state
claims the key before any await, preventing two concurrent dispatches from
entering the same ACP session and overwriting `pending`.

**Preserve the existing `dispatch(): Promise<string|null>` completion contract.** Today `dispatch` resolves with sessionId only **after that message's turn completes** and rejects prompt errors to its caller. `onCronFire` at `daemon.ts:649` relies on it for success/failed reports, and tests directly await it. If `runLoop` is not awaited and the queue branch returns immediately, callers see false early success and lose their own sessionId/error. Every serialQueue entry carries its own `resolve/reject`; the promise returned by `dispatch` settles when **that specific message** finishes:

```
dispatch(agentId, msg): Promise<string|null>
  key = sessionKey(platform, channel, thread, agentId)   // Logical key; independent of ACP ID.
  return new Promise((resolve, reject) => {
    const entry = { msg, resolve, reject }
    // Atomic: check+claim in one synchronous tick, before yielding at any await.
    if inflight.has(key):
        if !enqueue(key, entry): reject(QueueFull)
        return
    inflight.add(key)
    runLoop(key, entry)          // Do not await; the loop retains ownership until the queue is empty.
  })

async runLoop(key, firstEntry):
  let entry = firstEntry
  while entry:
      try:
          const sid = await sessions.handle(agentId, entry.msg, ...)
          entry.resolve(sid)     // Settle this entry's promise.
      catch (err):
          entry.reject(err)      // Propagate prompt errors to this message's caller.
          // Do not silently swallow the queue on failure. Default may drain;
          // a session-wide stop must clear and reject/report every queued entry.
      // Still own inflight(key); take the next queue head before releasing.
      entry = dequeue(key)
  // Release atomically only after confirming that the queue is empty.
  inflight.delete(key)
  // A message arriving after release claims ownership itself, preserving order.
```

- **Key 1:** `inflight.add` and the check happen in one synchronous tick before any await, preventing two dispatches from both entering handle and overwriting pending.
- **Key 2:** Draining retains key ownership and directly processes the queue head. Release only after confirming the queue is empty. Never delete `inflight` before dequeue/re-dispatch; an arrival in that gap could claim the key ahead of the old head and violate FIFO.
- **Key 3:** Each message settles its own promise. The dispatch promise is bound to its queue entry and resolves/rejects only after that entry's `handle`, preserving `onCronFire` and test assumptions.
- `inflight` and `serialQueue` hold `QueueEntry` values with a hard-coded depth
  cap. They coexist with the explicit `!queue` / `pending` controls.
- Preserve `!queue` / `!cancel` semantics as explicit overrides above the default gate. `!cancel` clears serialQueue, settles every entry, and interrupts the current turn.
- Agent-to-agent delivery uses the same `dispatch`, so it automatically passes the gate. Multiple main agents waking one worker are processed in order rather than tearing its session concurrently.
- **Tests:** arrival simultaneous with turn completion preserves FIFO by injecting a new message between handle resolution and `inflight.delete`, then asserting it follows the existing queue head. `await dispatch` for a queued message receives **its own** sessionId or prompt-error rejection, not the head's.

### 4.4 Backpressure / Limits

Current enforcement provides **fast failure + explicit reporting** for the
per-session queue:

1. **Per-session queue depth:** `MAX_QUEUED_PER_SESSION` is 10. At capacity, the
   daemon rejects the new inbound event with `queue_full`.
2. **Per-agent concurrent-turn limit:** not implemented as a collaboration
   admission gate.
3. **Orchestration fan-out width:** not enforced by the current
   `startOrchestration` schema.

For orchestration:

- If a worker is busy, `messageAgent` returns `delivered:false, reason:'busy'`. Main uses a **cron deadline job** from section 3.5 to retry later rather than blocking.
- If a target agent is **offline or not placed**, fail fast similarly; main retries or marks the subtask `unavailable`.

### 4.5 Loop / Explosion Protection

This section lists collaboration-side mechanisms only. See [`loop-breaker-design.md`](loop-breaker-design.md) for unified platform feedback loops, durable latches, restart/replay, and recovery permissions.

- **hopCount:** Increment every agent-to-agent delivery and reject above the shared `MAX_AGENT_CALL_HOPS` threshold, preventing an A <-> B wake loop.
- **Orchestration depth limit:** Bound nested orchestration when a worker acts as a main agent, preventing exponential fan-out.
- **Self-delivery protection:** Reject `messageAgent(toAgentId == self)` to avoid self-wake loops.

### 4.6 Current Surface and Remaining Limits

| Layer  | Current behavior                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon | Atomic `sessionKey` admission serializes a conversation, caps its queue at 10, releases or fail-stops queued work on failure/cancel, enforces the shared `MAX_AGENT_CALL_HOPS` maximum (20), and rejects self-delivery. |
| Tool   | Peer delivery reports typed outcomes including offline, queue-full, policy denial, and hop-limit failures.                                                                                                              |
| Config | `maxAgents` bounds placed agent capacity and `maxConcurrentSessions` is part of daemon config; neither supplies the missing collaboration-specific per-agent turn limit or orchestration fan-out width described above. |
| Tests  | Cover concurrent cold-session admission, queue ordering and failure, queue-full reporting, hop-limit rejection, and self-delivery rejection.                                                                            |

---

## 5. Open Questions

1. **Independent DM semantics:** should direct delivery support a new `dm:`
   session instead of remaining anchored to the caller's channel/thread?
2. **Ownership rendering:** how should the target transcript display
   `from=@agentA` to a human without appearing self-authored?
3. **Late results:** should a report arriving after timeout publish an
   idempotent supplemental summary?
4. **Concurrency defaults:** too small a per-agent turn limit reduces
   throughput; too large overwhelms model rate limits. Configure by
   runtime/model with a conservative default.
5. **Worker reject/cannot-claim semantics:** align with task-claim failure while
   preserving hop/depth limits and typed reports.

---

## 6. Safety, Durability, and Identity Contracts

Every stable-ID, durable-write, CAS, and fail-closed requirement in this
section is part of the contract, not an optional optimization.

### 6.1 Session Context and Trusted Identity (Daemon)

- MCP `SessionContext` captures the triggering agent, platform, integration,
  channel, thread, DM state, and the agent's integration snapshot at
  `session/new`. The daemon derives these fields from the real trigger; tools
  never trust caller-supplied identity or platform claims.
- Caller identity, `mainSessionKey`, origin, and reply target for
  `listAgents`, the `sendMessage` peer branch, and orchestration tools
  come entirely from trusted `SessionContext`. `listAgents` takes only an
  optional `channel` **filter** from tool input; the trusted current channel is
  carried separately, and is used solely to build a compatible request for a CP
  that lacks `agent-directory-org-scope-v1`.

### 6.2 Target Addressing: Deterministic `(platform, channel, toAgentId) -> {daemonId, integrationId}`

- The destination snapshot must provide a **deterministic target `integrationId`** for `(platform, channel, toAgentId)`. It cannot be optional or fall back to the first connection. Propagate it through local/relay dispatch; otherwise a multi-platform / multi-integration agent can use the wrong platform or `replyConnFor` can fall back to the wrong connection.
- Returning to the current session coordinates likewise depends on the true platform/integrationId injected by section 6.1.
- Since the org-scoped directory the two halves of this lookup come from different
  parts of the snapshot: **`daemonId` from the flat `agents[]`** (identity /
  ownership, channel-free) and **`integrationId` from the channel row** for the
  requested coordinates, falling back to the directory entry when the target has
  no row there. That keeps "deterministic reply integration" intact for a
  channel-backed target without making an integration-less target unroutable.

### 6.3 Stable deliveryId + Monotonic ts + Shared Admission Idempotency

- **Do not use a random UUID as msgId:** `transcriptCoords()` takes ts from the final `:` segment, and `transcriptSince` uses `ts > lastDeliveredTs ORDER BY ts`; a random ID reorders or omits replay. Define a **stable agent-call `deliveryId` + independent monotonic `ts`**, or a timestamp ID compatible with current format.
- Retries reuse the same `deliveryId`. Add one admission-idempotency layer shared by local direct delivery and relay paths; existing `(sessionKey,msgId)` caching wraps only `rd/msg`, while same-daemon `dispatch` and new `rd/agentmsg` bypass it.

### 6.4 Bidirectional Admission Protocol (Source -> Relay -> Target; ACK Does Not Wait for Model Turn)

In READY, the collaboration wire uses:

1. Source daemon -> relay: agent-call REQ.
2. Relay -> target daemon: admission REQ.
3. Target checks **pause / drain / policy / queue capacity**, durably accepts the queue entry, then returns **ACK/NAK without waiting for the model turn**.
4. Relay returns typed `busy` / `offline` / `queue_full` / `not_allowed` to source.

Timeout, retransmission, and deduplication at each hop use the stable
`deliveryId`. `rd/agentmsg` (D→R REQ) → `rd/agentmsg/fwd` (R→D) →
`rd/agentmsg/ack` returns typed reasons
`busy/offline/queue_full/not_allowed/not_found/hop_limit`.

### 6.5 Snapshot Distribution Wire and Lifecycle

- `rc/*` is the **CP↔relay** wire; daemons receive the full collaboration
  snapshot in `register/ok` plus live `collaboration/routes` updates.
- Staleness must be **detectable** for fail-closed behavior: define generation / full-replace semantics, deletion tombstones, triggers on policy/channel/placement change, reconnect baseline, and **TTL/expiry** after CP disconnection. Otherwise an old allowlist can continue to authorize after revocation.
- Test that old versions are rejected after revocation, channel removal, or migration.

### 6.6 Trusted-Metadata Storage Layer: ACP Has No Per-Turn System Channel

- ACP has **no per-turn system/context layer outside user prompt**. Only `session/new|load` accepts `_meta.systemPrompt`; `session/prompt` accepts only `ContentBlock[]`. Section 3.3a cannot both show `call_metadata` to the model and claim it does not enter the prompt. Split it:
  - Keep **authoritative metadata only in daemon-private turn context**. Authorization, correlation, hop, and automatic tool propagation read only this context.
  - If the model needs the caller identity, daemon generates an ordinary/embedded display context that is **never a security input**.
- If a trusted per-turn system channel is truly required, make an **ACP/runtime extension an explicit prerequisite**.

### 6.7 Turn-Context Lifecycle / Key + Reply vs New Call

- An MCP token is **statically session-scoped**, and queued turns in the session share it. Bind metadata to one `QueueEntry` by `deliveryId` / msgId. Install its active context **before prompt begins**, clear it in `finally`, and reject tool calls with **no active turn**. Durable replay of the same delivery restores its own correlation/hop, but nothing survives after turn finally to contaminate the next delivery.
- **Split semantics:** `messageAgent` must not automatically inherit correlation for every call, or a worker delegating to a third agent would incorrectly reuse the parent task correlation. Add `replyToAgentCall` or a mode: **only a reply inherits correlation**, while **every child call must inherit hop/origin**.
- **Do not conflate security IDs:** `correlationId` is only for subtask/reply association, never a loop root. A future `originId` must be minted by the daemon and durably persisted end to end; see sections 7.3 and 8.1 of [`loop-breaker-design.md`](loop-breaker-design.md).

### 6.8 Orchestration: Durable Owner / Outbox / State Machine / Owner Authorization

- **Durable owner:** Orchestration state is daemon-local. A placement move cannot
  silently abandon an active orchestration; the move must either rehydrate it
  on the new owner or reject/terminate it with a user-visible result.
- **Deadline durability:** Store the deadline in the durable orchestration
  record, re-arm it at startup, and make cancellation idempotent. The wake
  dispatches directly to `mainSessionKey` and does not reuse cron
  `fireTrigger`, which would create a new platform anchor.
- **Atomic start boundary:** A database write and cross-daemon send cannot be
  one atomic operation. Record the orchestration and stable per-subtask
  delivery/correlation ids before delivery, use monotonic state transitions,
  and recover idempotently. A later ACK must not overwrite a result that
  already completed.
- **Subtask state machine:** `pending -> sending -> delivered -> succeeded |
worker_error | timed_out`; `busy` and `offline` are retryable attempt states,
  not terminal. Transitions use CAS plus idempotent delivery/report ids.
- **Tool owner/auth:** Derive `mainSessionKey`, caller, origin, and reply target
  for start/get/cancel from trusted `SessionContext`. `get` and `cancel` verify
  that the current agent and session own the orchestration. Cancellation writes
  a durable tombstone and idempotently removes the timer; it does not delete the
  record.

### 6.9 Concurrency Gate: Durable Inbox / Complete DispatchContext / dispatchOne / Fail-Stop / One Queue

- **Durable inbox:** The serialization gate, unified queue, fail-stop behavior,
  depth cap, and SQLite `inbox` are implemented. The inbox preserves full call
  metadata and replays by `sessionKey` FIFO at startup. `loopGuardCounted`
  prevents replay from consuming breaker budget twice. Persistence is currently
  best effort: `appendInbox` failure logs and continues to dispatch/ACK. The
  remaining hardening is to ACK only after a successful write and otherwise
  return typed `persistence_unavailable`; see section 5 of
  [`loop-breaker-design.md`](loop-breaker-design.md).
- **Complete `DispatchContext`:** A queue entry carries `integrationId`,
  webchat conversation/turn/sink state, trusted call metadata, `deliveryId`,
  and reply transport. This prevents replies through the wrong connection and
  keeps turn metadata isolated.
- **Whole-turn ownership:** `dispatchOne(entry)` owns `sessions.handle`,
  `host.prompt`, rendering, usage/report, and finalization. The promise settles
  only after that complete turn.
- **Default fail-stop:** A prompt or host failure stops subsequent queued work
  instead of automatically chaining it into a broken session.
- **One unified queue:** Ordinary inbound work and `!queue` share the same
  `sessionKey` admission queue. Cancel, stop, drain, and shutdown enumerate and
  settle the full queue before releasing the session.
