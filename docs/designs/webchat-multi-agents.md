# Webchat Multi-Agent Conversations

**Status:** Proposed design

> This document designs multi-agent conversations for webchat (the console
> Playground): one human owner talking with **several agents in one
> conversation**, addressing them with structured @mentions, while agents can
> also post into the conversation and wake each other there. It deliberately
> mirrors the IM-channel model already shipped —
> [shared-bot-relay.md](shared-bot-relay.md) §10 for relay arbitration and
> fan-out, [session-concept.md](session-concept.md) for agent-scoped sessions,
> and [agent-collaboration-implementation.md](agent-collaboration-implementation.md)
> for agent-to-agent wakes — rather than inventing a webchat-only paradigm.

---

## 1. Summary

Today a webchat conversation is hard-bound to exactly one agent. The binding is
enforced in four independent places:

1. the CP token claim and the `webchat_conversation.agentId` column
   (`packages/control-plane/src/http/routes/webchat-token.ts:69-83`,
   `packages/control-plane/prisma/schema.prisma` `WebchatConversation`);
2. the relay verification verdict `RcVerifyResult.agentId`
   (`packages/control-plane/src/registry/webchatVerification.ts:34-42`);
3. the wire frame `RdMsgWebchat.agentId`
   (`packages/protocol/src/frames/relay-daemon.ts:116-127`); and
4. the daemon session key `webchat:<conv>:webchat:<conv>:<agentId>`
   (`packages/daemon/src/daemon.ts:4916-4920`).

Routing is bypassed entirely: `routeRules` short-circuits on `explicitAgentId`
(`packages/daemon/src/router/routing-table.ts:75-79`) and `mentionedBots` is
hard-coded `[]` (`daemon.ts:4868`). Nothing in the webchat path can express
"@agent-b".

This design turns a webchat conversation into a **recorded conversation with a
participant roster** — a private mini-channel owned by one human:

- The conversation keeps one owner (`userId`) and gains an ordered set of
  **participant agents** with a designated **primary agent**.
- The browser addresses agents with **structured mentions**; an unmentioned
  turn routes by a deterministic client-side ladder (mention → last responder →
  primary agent), validated server-side against the roster.
- The relay fans a turn out to the targeted agents' daemons (they may differ)
  and fans every conversation post to the other participants' daemons as
  **context**, so each agent's next activation sees the full conversation —
  the same shared-transcript / catch-up-replay shape IM threads use
  (`docs/designs/daemon-detailed-design.md` §8.5).
- Each participant keeps its **own agent-scoped session** per
  [session-concept.md](session-concept.md) §1.1; there is no shared ACP
  session. The conversation view is a merge of per-agent sessions.
- The conversation becomes a **recorded coordinate with known members** for
  agent-to-agent wakes: `sendMessage({toAgent, channel: <conversationId>})`
  from a participant lands in the peer's session _in this conversation_ and
  leaves a visible post, instead of being substituted by the pairwise
  `a2a:<callerAgentId>` coordinate.

Architecture invariants are preserved: the Control Plane stays off the message
hot path (it only mints tokens, verifies them, and stores roster metadata), the
relay persists no content, and message bodies remain daemon-local.

## 2. Goals and non-goals

### 2.1 Goals

- Multiple agents in one webchat conversation, addressable by @mention, with
  deterministic routing when no mention is present.
- Participants placed on **different daemons** work; fan-out rides the existing
  relay data plane.
- Every participant sees the whole conversation as context at its next
  activation, exactly like agents sharing an IM thread.
- Agent-to-agent mentions inside the conversation are visible posts plus wakes,
  reusing `sendMessage` and the directional call policy unchanged.
- Concurrent turns: two agents may be streaming at once; the browser renders
  per-agent streams.
- Backward compatible: every existing conversation is a one-participant
  conversation; the single-agent wire shape keeps working during rollout.

### 2.2 Non-goals

- Multiple **human** participants. The conversation stays single-owner; session
  visibility stays private-by-default per
  [product-conventions.md](../product-conventions.md) §Session visibility.
- Changing IM routing, the relay bot-arbitration ladder, or the directional
  agent-visibility policy.
- A shared ACP session or merged model context across agents. Sessions stay
  agent-scoped.
- Extending the delegated `agentconnect-admin` MCP
  ([webchat-preset-agentconnect-mcp.md](webchat-preset-agentconnect-mcp.md)) to
  multi-agent conversations. Its grant tuple binds one `agentId`; v1 keeps
  delegated MCP conversations single-participant (section 10.3).
- Group webchat across organizations.

## 3. Conversation model

### 3.1 Roster

`WebchatConversation` keeps its existing columns and gains a participant
relation:

```prisma
model WebchatConversationAgent {
  conversationId  String
  agentId         String
  role            String   // 'primary' | 'member'
  addedByUserId   String
  addedAt         DateTime
  currentSessionId  String?   // per-agent session pointer (moves off the conversation row)
  currentSessionRev Int
  @@id([conversationId, agentId])
}
```

- The existing `WebchatConversation.agentId` column remains and always equals
  the `role='primary'` row. It stays the compatibility anchor for the token
  mint path, `owns()` checks, and the delegated-MCP grant tuple.
- Existing conversations are backfilled with a single `primary` row.
- The per-agent `currentSessionId`/`currentSessionRev` pointers replace the
  conversation-level columns (`session.repo.ts:754-772` advances the roster row
  for the reporting agent instead). The conversation-level columns remain as a
  mirror of the primary row during migration.
- **Roster cap:** 8 participants. The cap bounds relay fan-out and browser
  stream multiplexing; it is a config constant, not a schema property.

Roster mutations are CP HTTP, owner-only:

```
POST   /orgs/:orgId/webchat/conversations/:conversationId/agents   { agentId }
DELETE /orgs/:orgId/webchat/conversations/:conversationId/agents/:agentId
```

Adding requires the owner to currently `canView` the agent — the same check the
token mint applies today (`webchat-token.ts:40-86`). Because participation is
an explicit per-conversation act by a user who can see the agent, a
`restricted` agent needs no extra gating rule: adding it _is_ the
per-conversation enablement (the webchat analogue of the gated Off/Mention/All
model in `packages/control-plane/src/orchestrator/placement.ts:188`). Removing
a participant closes its current session pointer; its transcript rows remain.
The primary agent cannot be removed (transfer primary first; a v1 may simply
disallow both).

### 3.2 The conversation becomes a recorded coordinate

[product-conventions.md](../product-conventions.md) §Channel's remaining role
defines three coordinate-integrity cases. Webchat today falls under "genuinely
channel-free": an asserted webchat coordinate on an agent-to-agent wake is
discarded and substituted with `a2a:<callerAgentId>`
(`packages/relay/src/collaboration-router.ts:178-189`,
`packages/daemon/src/cp/cp-collab-routes.ts:204-237`,
`agent-collaboration-implementation.md` §2.5).

This design adds a carve-out that moves a rostered conversation into the
**"recorded coordinate with known members"** case:

- An asserted webchat `channel` that resolves to a conversation whose roster
  **contains the calling agent** is used **verbatim**: the peer wakes in
  `webchat:<conv>:webchat:<conv>:<peerAgentId>` and the visible post lands in
  the conversation.
- Any other asserted webchat coordinate — unknown id, conversation the caller
  is not a participant of, or a legacy single-participant conversation the
  caller doesn't belong to — keeps today's substitution to
  `a2a:<callerAgentId>`. Nothing fails that works today, and a wake can never
  alias a conversation its caller is not a member of.

Membership data reaches the two enforcement points the same way collaboration
routing data already does: the CP includes webchat rosters relevant to an
agent's placement in the `CollabRoutesSnapshot`
(`packages/protocol/src/frames/collab.ts:96`) it distributes to relays
(`rc/collab-routes`) and daemons (`register/ok` + `collaboration/routes`). A
stale snapshot fails closed into the substitution branch, which is safe.

`channel/agents` (`packages/control-plane/src/ws/handlers/channel-agents.ts`)
gains the mirror read: a `channel` filter naming a rostered conversation
returns its participants (call-policy-filtered) instead of short-circuiting to
the empty roster (`daemon.ts:2205-2213`), so `listAgents({channel})` works
inside a conversation.

## 4. Addressing and routing

### 4.1 Structured mentions

Webchat has no platform bot identities, so the mention identity **is the
`agentId`**. The composer resolves roster names to mention chips; the wire
carries both the display text (with `@Name` inline, so peers and transcripts
read naturally) and the structured list:

```ts
// RelayWebchatOp 'turn' additions
{
  op: 'turn',
  text: string,              // keeps inline "@Name" for display/context
  mentions?: string[],       // agentIds actually mentioned (chips), ⊆ roster
  targets?: string[],        // agentIds this turn activates, ⊆ roster
  turnId, attachments?, runtime?
}
```

There is no server-side text parsing: mentions are structural facts from the
composer, matching the "explicit platform @mention is a trusted routing fact"
rule in [product-conventions.md](../product-conventions.md).

### 4.2 The webchat ladder is computed client-side, validated server-side

IM needs server-side arbitration (`packages/relay/src/bot-arbitration.ts:116`)
because many humans type free text into a shared channel across many ingress
pods. A webchat conversation has exactly one composer, owned by the one human
owner, with structured mentions. The routing ladder therefore runs **in the
composer** and its result travels explicitly as `targets`:

1. **Mentions** — `targets = mentions` when non-empty.
2. **Conversation affinity** — no mention: target the last agent that posted
   in the conversation (the client renders the transcript, so it knows).
   This mirrors relay thread affinity without needing the 3-leg
   `rc/thread-assign` dance — there is no cross-pod ambiguity to resolve.
3. **Primary agent** — a fresh conversation with no agent post yet.

The relay does not arbitrate; it **validates and fans out**:

- `targets ⊄ roster` → the turn is refused with a new ack reason
  `not_participant` (per offending target).
- `targets` absent or empty → the relay substitutes the primary agent, which
  makes an old browser build indistinguishable from a one-participant
  conversation.

Trusting the client for _targeting_ is sound because it is a UX choice, not an
authorization boundary: the roster is CP-validated, every target is
membership-checked at the relay, and the daemon re-checks placement and
paused/draining state per target exactly as today. A malicious owner can only
mis-target agents they were already entitled to talk to.

### 4.3 What the targeted agent sees

For each target the relay emits one pre-addressed `RdMsgWebchat` to that
agent's daemon (section 6.1). The daemon synthesizes the `NormalizedMessage`
as today (`daemon.ts:4860-4885`) with these changes:

- `mentionedBots` = the turn's `mentions` (agentIds). The receiving agent's
  own id appearing there makes `trigger:'mention'` and feeds the existing
  explicit-mention assertion; an affinity/primary-routed turn keeps
  `trigger:'dm'`.
- `isDm` stays `true` (webchat activation is always addressed — there is no
  broadcast rung), and the private-visibility classification
  (`daemon.ts:13686-13693`) is unchanged. When the roster has more than one
  agent, `isGroupDm: true` is set so prompts can say "you are one of several
  agents in this conversation".
- The `# Agent` standing block gains a `Conversation participants:` line
  listing roster names/ids, so the agent knows who it can @mention
  (`session-manager.ts` `agentMeta`, same mechanism as the `Slack identity:`
  line at `session-manager.ts:606-614`).
- The standing `AC_NO_RESPONSE` response-choice contract applies unchanged.

Multiple targets on one turn (e.g. "@a @b compare your answers") each get
their own activation, their own ack, and their own turn stream, concurrently.

## 5. Conversation posts, context fan-out, and ordering

### 5.1 One canonical post record

Every conversation event is a **post**:

```ts
interface WebchatPost {
  postId: string        // relay-minted for user turns; daemon-minted for agent posts
  conversationId: string
  author: { kind: 'user' } | { kind: 'agent'; agentId: string }
  text: string
  at: number            // canonical timestamp, minted ONCE at origin
  attachments?: [...]   // user turns only, existing 160 KiB image cap
}
```

**`at` is minted exactly once at the origin** (the relay when it accepts a user
turn; the owning daemon when an agent's turn completes) **and carried on every
frame that transports the post.** Every daemon stores the carried `at` instead
of minting its own. This single rule fixes two problems at once:

- **The same-daemon dedup gotcha.** Today each webchat dispatch mints a fresh
  process-global `monotonicTs()` (`session-manager.ts:400-407`,
  `packages/daemon/src/store/monotonic-ts.ts`) because `msgId` is stable per
  conversation. Two participants hosted on one daemon would mint two different
  `ts` for one user turn, producing two transcript rows instead of one shared
  row plus `transcript_recipient` delivery entries
  (`local-store.ts:2446-2517`). With a carried `at`, both dispatches share one
  timestamp and the shared-transcript shape is restored. (A local collision on
  the `(channel, thread, ts)` unique index bumps by 1 ms — same-conversation
  posts from one origin are strictly ordered, so this only smooths cross-origin
  ties.)
- **Cross-daemon merge.** All copies of a post agree on `at`, so the console
  and the resuming browser merge per-agent transcripts by `(at, postId)`
  without inventing a global sequencer. Cross-daemon clock skew can reorder
  _concurrent independent_ posts, never a post against the turn that caused it
  (an agent post's `at` is minted after its trigger was relayed). This is the
  same fidelity IM merges get from platform timestamps.

### 5.2 Fan-out

Two independent fan-outs, both relay-carried, neither CP-touching:

1. **To agents (context), keyed by daemonId — works with no browser
   connected.** When the relay accepts a user turn, it sends the activation to
   each target's daemon and a **context frame** carrying the same post to every
   other participant's daemon. When an agent's turn completes, its daemon sends
   the reply post to the relay, which fans it to the other participants'
   daemons the same way. Delivery to a daemon rides the existing authenticated
   `rd/*` socket, addressed by placement from the collaboration snapshot — the
   same routing shape as `rd/agentmsg`
   (`packages/relay/src/agent-msg-router.ts`).

   A receiving daemon **records the post into its local shared transcript and
   never activates on it**: it lands via the `recordUnrouted`-style path
   (`daemon.ts:7638`) with the author re-labeled as a trusted agent frame
   (mirror of the thread-history backfill re-label at `daemon.ts:7721`), and is
   deduplicated by `postId`. Because context frames are transcript-only,
   fan-out cannot self-trigger or loop — activation happens only via user
   targeting (section 4) or an explicit `sendMessage` wake (section 7), both of
   which the loop breaker and `hopCount` already bound. A daemon drops context
   frames authored by an agent it hosts (self-echo, mirroring
   `isAgentBotMessage` at `daemon.ts:4640`).

   At the agent's next activation the existing §8.5 catch-up replay presents
   the accumulated posts as `[<author>] <text>` context lines — participants
   see the full conversation exactly the way channel agents see a thread.

2. **To the browser, keyed by the chat sink — online only.** Streams and posts
   reach the browser through the relay instance holding the conversation's
   browser socket (`packages/relay/src/webchat-router.ts`). Agent posts that
   originate outside a browser-initiated turn (section 7) are sent by the
   owning daemon to its connected relays; the instance with the sink delivers,
   the others drop on lookup miss. A browser that was offline reconstructs the
   gap from persisted sessions on resume (section 8), so browser delivery
   needs no durable queue — unchanged semantics.

### 5.3 Per-agent streams to the browser

The browser ordering machinery is already per-turn
(`packages/web/src/lib/webchat-stream.ts` cursors keyed by `turnId`), so
concurrent agent streams need only an attribution field:

- `WebchatAck`, `WebchatOutput`, `WebchatDone`
  (`packages/protocol/src/frames/webchat.ts`) gain `agentId`.
- A multi-target turn produces **one ack per target**; the browser tracks
  admission per `(turnId, agentId)` and renders one stream lane per agent.
- `RdChat.seq` (`relay-daemon.ts:508-513`) stays a per-daemon-connection
  transport detail; with two daemons streaming into one conversation the relay
  treats it as opaque per-connection ordering and the browser orders by
  `(turnId, index)` as today. The daemon-side replay window
  (`daemon.ts:4925-5058`) is untouched — it is already keyed per turn on the
  owning daemon, and `resume` ops gain `agentId` so the relay can address the
  right daemon.
- `cancel` gains optional `agentId`; absent means every live turn in the
  conversation (today's resolution is already conversation-scoped,
  `daemon.ts:5240-5267`, but must stop matching only the first hit).

## 6. Wire protocol changes

### 6.1 Relay ↔ daemon

- `RdMsgWebchat` keeps a **singular `agentId`** — the relay fans out, one
  pre-addressed frame per target, preserving the "relay delivers pre-addressed
  content, daemon does not re-arbitrate" contract. Additions:
  - `payload.op: 'turn'` gains `mentions?: string[]` and the canonical
    `post: { postId, at }` identity;
  - new `payload.op: 'context'` carrying a `WebchatPost` (transcript-only, no
    ack beyond transport, deduplicated by `postId`);
  - `resume` and `cancel` carry `agentId` as above.
- New daemon → relay frame `rd/webchat-post { conversationId, agentId, post }`
  for a completed agent post, emitted at the same boundary that records
  `replyText` today (`daemon.ts:10394-10404`). The relay (a) delivers it to
  the browser sink if present and (b) fans `context` frames to the other
  participants' daemons.
- `rd/chat` / `WebchatEvent` streaming is unchanged apart from `agentId`
  attribution.

### 6.2 CP surfaces

- **Token mint** moves to the conversation:
  `POST /orgs/:orgId/webchat/conversations/token` with an optional
  `conversationId` (absent = create, with `agentId` naming the initial
  primary). The legacy per-agent path stays as an alias that creates or
  resumes a single-participant conversation.
- **`rc/verify`** (`relay-cp.ts:82-112`): the verdict returns the roster with
  placements — `participants: [{ agentId, daemonId, primary }]` — instead of
  the singular `agentId`/`daemonId`. The relay caches it per browser
  connection. After a roster mutation the browser (which made the HTTP call)
  sends a `roster_refresh` op; the relay re-verifies the token and re-caches.
  A placement moved between refreshes surfaces as a failed delivery and the
  relay re-verifies once — the same lazy re-resolution reconnects use. The CP
  stays off the per-message path.
- The `ready` frame to the browser carries the roster; roster changes are
  re-emitted so all tabs converge.
- `CollabRoutesSnapshot` gains the webchat rosters slice (section 3.2).

### 6.3 Capability negotiation

Daemons advertise `webchat_multi_agent_v1` (register capability, re-announced
via `capabilities/update`). Enforcement sits at the **roster mutation**: the CP
refuses to add an agent whose daemon does not advertise the capability, and
refuses to add any agent while the _primary's_ daemon lacks it. Existing
one-participant conversations therefore never require the capability, and the
relay/browser never see a mixed-capability roster. Relay and web ship the
feature versioned as usual; the browser gates the "Add agent" affordance on a
CP-reported feature flag.

## 7. Agent-to-agent inside the conversation

A participant that wants a peer to act calls the existing tool:

```ts
sendMessage({ toAgent: 'B', channel: '<conversationId>' }, 'please review …')
```

- **Authorization** is the directional call policy, unchanged. The `channel`
  is a delivery coordinate whose integrity is checked by the section 3.2
  carve-out: caller must be a roster member, otherwise the coordinate is
  substituted as today.
- **Delivery** rides the existing wake path (`dispatch` locally,
  `routeAgentMsgCrossDaemon` / `rd/agentmsg` across daemons). The wake lands
  in B's session for this conversation; `CallMeta.originSessionId` and the
  `Parent session` reply contract work unchanged.
- **Visibility**: the visible post form (`toAgent` + `channel`) emits the
  caller's message as a `WebchatPost` through `rd/webchat-post`, so the owner
  sees A asking B in the conversation, and the other participants receive it
  as context. The double-trigger invariant holds structurally: context frames
  never activate, so the visible post cannot wake B a second time beside the
  explicit delivery (the webchat analogue of the `sender.appId` suppression in
  [session-concept.md](session-concept.md) §4.1).
- **B's reply** is an agent-initiated turn: no browser `turnId` exists, so the
  owning daemon mints the turn id and announces the stream with an
  `initiator: 'agent'` marker on the first `WebchatOutput`. The browser
  renders it as an incoming stream lane; resume fencing works as today since
  the replay window lives on the owning daemon. (A v1 may land agent-initiated
  activity as complete posts only — `rd/webchat-post` without a stream — and
  add live streaming in a follow-up; the frame shapes above permit either.)

The owner's conversation therefore shows the whole exchange: their prompt, A's
answer, A's visible ask to B, and B's streamed reply — each attributed, each
recorded in the author's own session.

## 8. Sessions, persistence, and the console

- **Session identity is already right.** Each participant's session is
  `webchat:<conv>:webchat:<conv>:<agentId>` — the agent-scoped four-tuple from
  [session-concept.md](session-concept.md) applied verbatim. N participants =
  N `session_meta` rows sharing `platform='webchat'`, `channel=<conversationId>`.
- **Transcript reads** stay per-session BFF proxies
  (`packages/control-plane/src/http/routes/sessions.ts:594-637`); bodies stay
  daemon-local. The conversation view (live Playground resume and the console
  session detail for webchat) fetches the messages of every participant's
  current session and merges by `(at, postId)`; `postId` dedupes the copies
  each daemon holds. The sessions list groups the N rows under one
  conversation entry (grouping key: `channel`), with per-agent drill-down
  preserved for audit.
- **Attribution**: agent posts render with the agent's name and icon (the
  existing agent-avatar union), the owner as "You" via `isSelfSender`
  (`packages/web/src/lib/data.ts:1764-1774`) — unchanged, since `triggeredBy`
  still carries the CP principal handle.
- **Visibility**: all participant sessions are private to the owner, exactly
  the current webchat classification; publishing follows the existing
  session-visibility rules per session.

## 9. Web UI

- **Composer**: `@` opens roster autocomplete; picking a non-participant agent
  offers "Add to conversation" (runs the roster POST, then inserts the chip).
  Mention chips serialize to `mentions[]`; the ladder of section 4.2 computes
  `targets[]`.
- **Header**: participant chips with icons; add/remove affordances
  (owner-only); primary marked.
- **Streams**: one lane per `(turnId, agentId)`; per-agent typing/streaming
  indicators; per-agent ack failures surfaced inline ("B is busy — queued").
- **PlaygroundProvider** (`packages/web/src/components/console/PlaygroundProvider.tsx`)
  keys optimistic steps and cursors by `(turnId, agentId)` instead of `turnId`;
  the synthetic `pg_` session becomes a synthetic conversation that adopts N
  real session ids as they are reported (`applyStatus` already carries
  `sessionId` per stream).
- **Runtime controls** (model/effort/permission/fast) become per-agent — the
  existing `set_*` ops gain `agentId` and the UI scopes the control popover to
  an agent chip. Mobile keeps the single responsive tree per the console
  conventions.

## 10. Limits, gating, and security

### 10.1 Bounds

- Roster cap 8; relay fan-out per post ≤ roster size; context frames are
  bounded by the existing webchat text caps and are fire-and-forget with
  `postId` dedup.
- Turn concurrency is bounded per agent by the existing per-session
  serialization gate and `serialQueue` (`busy`/`queued` acks unchanged).
- Agent-initiated posts obey `hopCount` (`MAX_AGENT_CALL_HOPS`) and the loop
  breaker; context fan-out adds no activation edges, so it adds no cycles.

### 10.2 Authorization summary

| Action                           | Check                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| Mint conversation token          | owner + `canView` every participant's agent at mint                  |
| Add participant                  | owner + `canView(agent)` + daemon capability                         |
| Remove participant               | owner                                                                |
| Target a turn at an agent        | relay: target ∈ roster                                               |
| Agent wakes peer in conversation | directional call policy + caller ∈ roster (else `a2a:` substitution) |
| Read conversation                | session visibility per participant session (owner-private default)   |

A `restricted` agent is addable only by users who can view it, and its
participation is conversation-scoped — the same fail-closed posture as gated
IM conversations.

### 10.3 Delegated admin MCP

Conversations containing the built-in `agentconnect` preset stay
single-participant in v1: the grant's logical-authority tuple binds one
`agentId` and the confirmation UX assumes one acting agent. Adding a second
agent to such a conversation is refused with a clear message; relaxing this
later means extending the grant tuple per participant, which is out of scope
here.

## 11. Rollout

- **M0 — schema + roster API.** `WebchatConversationAgent`, backfill, roster
  endpoints, conversation-scoped token mint (legacy alias kept), per-agent
  current-session pointers. No behavior change for existing conversations.
- **M1 — multi-target turns.** `rc/verify` roster verdict, relay fan-out with
  membership validation, `RdMsgWebchat` additions, canonical `at`/`postId`,
  per-agent acks/streams, context fan-out of user turns and agent replies,
  composer mentions + targeting ladder, per-agent stream lanes. Capability
  `webchat_multi_agent_v1` gates roster growth.
- **M2 — a2a in-conversation.** Roster slice in `CollabRoutesSnapshot`, the
  recorded-coordinate carve-out in both collaboration routers,
  `rd/webchat-post`, agent-initiated posts (complete-post form), the
  `Conversation participants:` standing line, `channel/agents` conversation
  filter. Update [product-conventions.md](../product-conventions.md) §Channel's
  remaining role and `agent-collaboration-implementation.md` §2.5 tables in the
  same change.
- **M3 — polish.** Agent-initiated live streaming, grouped conversation view in
  the console sessions list, merged console transcript, per-agent runtime
  controls, mobile pass.

Each milestone is independently shippable; M1 without M2 already delivers the
user-facing product ("talk to several agents in one Playground conversation").

## 12. Alternatives considered

- **Broadcast every turn to every participant** (all agents answer, decline
  via `AC_NO_RESPONSE`) — rejected: N-fold token cost and noise for no
  addressing value; IM already solved this with mention-first ladders.
- **Server-side arbitration at the relay** (mirror `bot-arbitration.ts` with
  durable affinity) — deferred: with one composer, structured mentions, and a
  single owner, client-computed targeting is strictly simpler and equally
  deterministic. If webchat ever gains multiple human participants, the relay
  ladder and the 3-leg affinity dance are the known upgrade path.
- **One shared ACP session for the conversation** — violates the session
  concept (agent-scoped ownership, per-agent audit, per-agent runtime config)
  and every runtime's assumption of a single assistant identity.
- **CP-held conversation log for ordering/merge** — violates "the CP stores
  only control-plane metadata, never message bodies". The canonical-`at`
  carried on frames gives merge-stable ordering without central content.
- **Relay-allocated global conversation sequence** — the relay holding the
  browser socket could stamp a `convSeq`, but agent-initiated posts can occur
  with no browser connected and daemon→daemon context fan-out doesn't traverse
  the sink relay, so the sequence would have gaps exactly when it matters.
  `(at, postId)` merging degrades more gracefully.

## 13. Open questions

1. **Primary transfer.** v1 disallows removing the primary; is an explicit
   "make primary" mutation needed at M0, or can it wait for demand?
2. **Attachment fan-out.** v1 delivers a turn's image only to targeted agents;
   context copies carry a textual placeholder. Is full image fan-out to all
   participants worth the bandwidth on the context path?
3. **Session title.** With N sessions per conversation, the conversation title
   should come from the primary agent's `session_info` stream; per-agent
   titles stay per-session. Confirm this reads well in the sessions list
   grouping.
4. **Turn-level multi-target semantics.** "@a @b compare" activates both with
   the same prompt but neither sees the other's answer until its next
   activation. Is a follow-up "round-table" affordance (auto-feeding each
   answer to the other) wanted, or is explicit user relay enough for v1?
