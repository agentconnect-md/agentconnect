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
  **participant agents** with a designated **primary agent** (the first agent
  it ever had). The roster grows by owner-initiated joins — at creation or
  mid-conversation — and never shrinks in v1.
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
  multi-agent conversations. A conversation containing the built-in
  `agentconnect` preset **may** grow a roster, but the administrative catalog
  is available only while the conversation is single-participant
  (section 10.3).
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

**The roster grows; it never shrinks (v1).** The owner selects the initial
participants when starting the conversation and may **add** more at any point
mid-conversation:

```
POST /orgs/:orgId/webchat/conversations/:conversationId/agents   { agentId }
```

- Owner-only, idempotent, capped at the roster limit. Adding requires the
  owner to currently `canView` the agent — the same check the token mint
  applies today (`webchat-token.ts:40-86`) — and re-checks the capability gate
  (section 6.3) for the new agent AND every existing participant, so a
  conversation can never grow onto a daemon that cannot serve it. Because
  participation is an explicit act by a user who can see the agent, a
  `restricted` agent needs no extra gating rule: selecting it _is_ the
  per-conversation enablement (the webchat analogue of the gated
  Off/Mention/All model in `packages/control-plane/src/orchestrator/placement.ts:188`).
- **The primary never changes**: it is the first agent the conversation ever
  had. Joins append (`ord` = next slot). No transfer, no promotion logic, no
  primary-related UI.
- **Roster refresh is a reconnect, not a protocol.** The relay caches the
  verified roster per browser connection; after a join, the browser (which
  made the HTTP call) simply rebuilds its socket — the fresh
  `rc/verify` returns the grown roster. No `roster_refresh` op, no relay↔CP
  push. Other tabs converge on their next reconnect; until then their stale
  roster only limits what they can target, never what they can see.
- A joined agent sees the conversation's earlier posts the same way a late
  channel joiner does: its transcript starts at join (context fan-out reaches
  it from then on); backfilling pre-join history is deliberately out of scope.

### 3.1a Future: removal

Removing a participant stays unsupported. When it is wanted, the sketch is
recorded here so it is not re-derived: owner-only
`DELETE /orgs/:orgId/webchat/conversations/:conversationId/agents/:agentId`;
removal closes the participant's current session pointer while its transcript
rows remain; removing the primary auto-promotes the longest-standing remaining
member (by `addedAt`, tie-broken by `agentId`, swapped with the mirrored
`agentId` column in one transaction); removing the last participant is
refused.

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

### 4.2 Membership is a standing mention

The Slack mental model, applied literally: pulling agents into a conversation
is equivalent to having @-mentioned them all in its first message. From then
on, **every user message activates the whole roster** unless it explicitly
@-mentions someone — a mention narrows the turn to the named participants:

1. **Mentions** — `targets = mentions` when non-empty.
2. **Everyone** — no mention: every participant is activated. Each agent runs
   the standing response-choice contract
   ([product-conventions.md](../product-conventions.md) §No-response control
   marker) and silently declines with `AC_NO_RESPONSE` when the message is
   plainly for someone else; the daemon holds the live stream while the body
   could still be the bare sentinel, so a decline never flashes into the
   browser and commits no canonical post. Turn-final context refresh
   (section 5.4) keeps the concurrent answers coherent — a slower participant
   sees the faster ones' replies before committing.

The relay applies the same default itself (`targets` absent or empty ⇒ the
whole roster), so a resumed conversation with no client-side roster — or an
older browser build — still reaches everyone; the browser admits stream lanes
lazily from ANY tagged frame carrying the in-flight turn's id — usually the
per-agent ack, but a warm session's first output can beat its ack to the
browser (the daemon emits it synchronously inside turn admission), and
dropping it would strand that lane's ordering cursor. `targets ⊄ roster` is refused with the
`not_participant` ack reason per offending target. A one-participant roster
makes every rule above collapse to today's single-agent behavior.

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
There is **no automatic round-table**: neither answer is fed to the other
agent as a new activation. Each peer's answer reaches the other only as
conversation context at its next activation, or when someone — the owner or an
agent — explicitly mentions it. This matches the Slack-channel behavior:
posting in a thread never auto-triggers the other bots present. (A racing
sibling may still regenerate once at commit time to stay current with the
conversation — section 5.4 — which changes freshness of the same turn, never
activation.)

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
  attachments?: [...]   // user turns only, existing 160 KiB image cap;
                        // carried on context copies too (full fan-out)
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
- `WebchatEvent` gains a `superseded` kind (carrying the replacement's
  generation ordinal), used by the turn-final context refresh (section 5.4):
  the discarded candidate's lane collapses in place and the replacement
  streams under the same `turnId`. Supersession is an event rather than a
  terminal frame — the turn still ends with exactly one `done`.

### 5.4 Turn-final context refresh before commit

[turn-final-context-refresh.md](turn-final-context-refresh.md) defines the
daemon-owned answer workflow for IM turns: refresh context at turn start,
stage the candidate answer, refresh again after `session/prompt` resolves,
regenerate in the same ACP session when non-self conversation events arrived
meanwhile, and commit only a candidate that passed the final check. That
design deferred webchat explicitly because a single-agent conversation has no
independently moving thread. A multi-agent conversation **is** one — the owner
can address other agents and peers can post while an agent is generating — so
multi-agent webchat adopts the same workflow with three adaptations:

- **Refresh source.** Webchat has no provider history API. The refresh source
  is the daemon's local conversation transcript, fed by activations and
  context frames (section 5.2), which are durably recorded on arrival — the
  same observed-only completeness contract that design assigns to Telegram.
  The context-revision fence and the per-thread commit mutex apply unchanged.
- **The commit point is the canonical post.** The conversation post — the
  turn-end transcript write plus the `rd/webchat-post` fan-out (section 6.1)
  — is the staged answer's commit. The invalidation set is posts authored by
  the owner or by peer agents and recorded after the generation's fence; the
  agent's own output and chrome never invalidate. An owner message targeted
  at the same busy agent is a queued activation and follows that design's
  coalescing rules verbatim (start-fence absorption, regeneration
  absorption); owner messages targeted elsewhere and peer posts are pure
  context churn.
- **Browser streaming stays live.** IM staging withholds body text because
  the audience is a shared channel; the webchat live stream is a watch
  surface private to the one human who is also the only source of human
  churn. Tokens keep streaming as today. When the final refresh invalidates a
  candidate, the browser receives a `superseded` stream EVENT (carrying the
  replacement's generation ordinal) — not a terminal frame: the turn still
  ends with exactly one `done`, so replay windows, busy state, and older
  browsers (which ignore unknown event kinds) stay coherent. The console
  folds the discarded blocks into the collapsible work lane together with a
  "the conversation moved on — updating this answer" marker at the point the
  update happened — live-only chrome, since a refresh rebuilds from the
  persisted transcript, which records only the accepted generation — and the
  replacement streams under the same `turnId`. Only the accepted generation becomes the canonical post, fans
  out as context, and is recorded as delivered; discarded generations follow
  that design's transcript and usage rules — audit-visible, usage counted,
  never delivered.
- **One co-hosting subtlety.** A co-hosted participant dispatching the SAME
  user turn bumps the shared trigger row's transcript revision (its
  recipient-delivery write), which would re-surface this agent's own trigger
  as a "new" message at the final fence. The trigger's canonical `at` is
  carried on the message, so the invalidation filter excludes that exact ts.

Retry budgets are the IM defaults (three replacement generations, a
two-minute regeneration cap, the 50-event replay cap). Exhaustion closes the
browser turn explicitly — a daemon-authored warning message event followed by
`done { stopReason: 'context_churn' }` — and commits no canonical post.

Two scope rules:

- **Single-participant conversations keep today's behavior.** With
  `roster == 1` there are no peer writers; the owner's follow-ups remain
  queued turns, and the existing Playground UX is untouched.
- **Concurrent multi-target turns race intentionally.** In "@a @b compare",
  whichever agent commits first is unaffected; the slower agent's final
  refresh sees the earlier post and regenerates once — exactly as two agents
  racing in one Slack thread do. This does not reopen the rejected
  auto-round-table (section 4.3): no new activation is created; the same
  admitted turn is made current before it commits. Excluding same-turn
  sibling posts from the invalidation set was considered, to keep "compare"
  answers independent, and rejected: it would silently diverge webchat from
  IM freshness semantics, and the regeneration notice already tells the agent
  to re-evaluate rather than defer.

## 6. Wire protocol changes

### 6.1 Relay ↔ daemon

- `RdMsgWebchat` keeps a **singular `agentId`** — the relay fans out, one
  pre-addressed frame per target, preserving the "relay delivers pre-addressed
  content, daemon does not re-arbitrate" contract. Additions:
  - `payload.op: 'turn'` gains `mentions?: string[]` and the canonical
    `post: { postId, at }` identity;
  - new `payload.op: 'context'` carrying a `WebchatPost` (transcript-only, no
    ack beyond transport, deduplicated by `postId`);
  - `resume` and `cancel` carry `agentId` as above;
  - the `set_*` runtime ops are unchanged and carry no `agentId`: multi-agent
    conversations expose no runtime override (section 9.3), so these ops
    occur only in single-agent conversations.
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
  `conversationId` (absent = create, with `agentIds[]` naming the roster —
  first entry is the primary). The legacy per-agent path stays as an alias
  that creates or resumes a single-participant conversation.
- **`rc/verify`** (`relay-cp.ts:82-112`): the verdict returns the roster with
  placements — `participants: [{ agentId, daemonId, primary }]` — instead of
  the singular `agentId`/`daemonId`. The relay caches it per browser
  connection; a mid-conversation join refreshes it by REBUILDING the browser
  socket (section 3.1), so the cache is valid for the connection's lifetime.
  A daemon placement moved mid-connection surfaces as a failed delivery and
  the relay re-verifies once — the same lazy re-resolution reconnects use.
  The CP stays off the per-message path.
- The `ready` frame to the browser carries the roster.
- `CollabRoutesSnapshot` gains the webchat rosters slice (section 3.2).

### 6.3 Capability negotiation

Daemons advertise `webchat_multi_agent_v1` (register capability, re-announced
via `capabilities/update`). Enforcement sits at **every roster growth point**
— multi-agent creation and each mid-conversation join: the CP refuses unless
every participant's daemon (existing and new) advertises the capability.
Single-agent creates never require it, so existing flows and older daemons are
untouched, and the relay/browser never see a mixed-capability roster. Relay
and web ship the feature versioned as usual; the browser gates the multi-agent
creation affordance on a CP-reported feature flag.

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
- **Title**: the conversation title comes from the **primary** agent's
  `session_info` stream (the flow that renames a live `pg_` session today);
  other participants' `session_info` titles apply only to their own session
  rows. The sessions-list grouping shows the conversation title; per-agent
  drill-down keeps per-session titles.
- **Visibility**: all participant sessions are private to the owner, exactly
  the current webchat classification; publishing follows the existing
  session-visibility rules per session.

## 9. Web UI

### 9.1 Entry: the composer is the assembly area

There is no separate "new multi-agent conversation" screen. The existing entry
points keep working and gain roster assembly in place:

- **Home composer** (`packages/web/src/components/console/views/HomeView.tsx`)
  — the main entry. The Agent pill stays the single-select fast path: pick one
  agent and send, identical to today. Beside it, a `+` chip (rendered only
  when the CP feature flag is on) opens the same `ComposerMenu` list as a
  multi-select; agents whose daemon lacks `webchat_multi_agent_v1` are dimmed
  with the reason in the description line, exactly like today's offline/auth
  dimming. With two or more selected, the pill expands into a **roster chip
  row**. Every chip — including the first — is removable until the first
  send; the primary carries **no visual marker** and is simply the first
  agent of the final list at send time, re-derived automatically when a chip
  is removed. Primary is an internal anchor (default route, title source,
  compat column), not a concept the user manages or sees.
- **Multi-agent hides the runtime pills.** The Model / Effort / Permission
  selectors (and the runtime mark on the agent pill) are meaningful only when
  one agent runs the turn; as soon as the roster has two or more agents the
  composer footer shows the roster chips only, and every participant runs its
  configured runtime defaults. A single-agent composer keeps today's pills
  unchanged.
- **`@` in the composer text** is the second way in: before the first send the
  autocomplete lists eligible org agents, and picking one joins the roster and
  inserts a mention chip — so "@b @c compare your answers" composes the
  conversation and its first turn in one gesture.
- **Agent detail and Getting started** keep their one-click single-agent
  entries (`AgentDetailView.tsx` `onPlayground`, `GettingStarted.tsx`); the
  live conversation composer allows `@`-adding agents only until the first
  message is sent.

**Growth points.** Before the first message, chips are pure client state and
freely removable; the Home path creates the conversation at send
(`HomeView.tsx:169-182` calls `openPlayground` inside `send()`), minting with
`agentIds[]`. After that, agents join through the section 3.1 endpoint — the
`+` chip stays available in the live conversation composer — and the client
rebuilds its socket so the relay picks up the grown roster. What is never
possible is REMOVING an agent from an existing conversation (section 3.1a).

### 9.2 In-conversation composer

- `@` autocomplete covers the roster; mention chips serialize to `mentions[]`
  and the ladder of section 4.2 computes `targets[]`.
- The `+` chip beside the roster chips adds an agent mid-conversation
  (section 3.1) — the same affordance as pre-send assembly, now backed by the
  join endpoint plus a socket rebuild. Refused while a turn is streaming.
- **Routing is always visible**: the composer footer shows a small
  "→ <agent>" indicator of who will receive the message — the mentioned set
  when chips are present, else the affinity/primary target — so the implicit
  rungs of the ladder are never a surprise.
- Picking a non-roster agent from the `@` autocomplete offers "Add to this
  conversation" directly — no escape-hatch detour through a new conversation.

### 9.3 Conversation header and streams

- Header: participant chips with icons; no primary marker. Clicking a chip
  opens a small popover with a deep link to that agent's session (audit) and
  its configuration page. There are **no in-conversation runtime controls in
  a multi-agent conversation** — each agent runs its configured defaults, so
  the `set_*` ops stay single-agent-conversation-only and need no `agentId`
  in v1. Single-agent conversations keep today's controls unchanged.
- One stream lane per `(turnId, agentId)`; per-agent typing/streaming
  indicators; per-agent ack failures surfaced inline ("B is busy — queued");
  a superseded generation collapses and re-streams in place (section 5.4).

### 9.4 Sessions list and resume

- Conversation rows group by `channel` and show stacked participant avatars
  plus the conversation title (the primary's `session_info`, section 8);
  per-agent rows remain reachable for audit.
- Resume reopens the merged conversation view (section 8) with the roster in
  the header.

### 9.5 Provider and mobile

- **PlaygroundProvider** (`packages/web/src/components/console/PlaygroundProvider.tsx`)
  keys optimistic steps and cursors by `(turnId, agentId)` instead of `turnId`;
  the synthetic `pg_` session becomes a synthetic conversation that adopts N
  real session ids as they are reported (`applyStatus` already carries
  `sessionId` per stream). Runtime staging (`stageRuntimeChange`) applies only
  to single-agent conversations, where behavior is unchanged; a multi-agent
  send stages nothing.
- **Mobile** keeps the single responsive tree per the console conventions:
  the roster multi-select and the per-agent popover render as bottom sheets,
  the roster chip row scrolls horizontally, and the `@` autocomplete is
  unchanged.

## 10. Limits, gating, and security

### 10.1 Bounds

- Roster cap 8; relay fan-out per post ≤ roster size; context frames are
  bounded by the existing webchat text caps and are fire-and-forget with
  `postId` dedup. A turn's image attachment fans out with its context copies,
  so the worst case per turn is roster-size × the existing 160 KiB cap —
  bounded and small enough to keep every participant's transcript complete.
- Turn concurrency is bounded per agent by the existing per-session
  serialization gate and `serialQueue` (`busy`/`queued` acks unchanged).
- Agent-initiated posts obey `hopCount` (`MAX_AGENT_CALL_HOPS`) and the loop
  breaker; context fan-out adds no activation edges, so it adds no cycles.

### 10.2 Authorization summary

| Action                           | Check                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| Create conversation              | owner + `canView` every selected agent + daemon capability when N > 1 |
| Join agent to conversation       | owner + `canView(agent)` + daemon capability across the whole roster  |
| Mint conversation token          | owner + `canView` every participant's agent at mint                   |
| Target a turn at an agent        | relay: target ∈ roster                                                |
| Agent wakes peer in conversation | directional call policy + caller ∈ roster (else `a2a:` substitution)  |
| Read conversation                | session visibility per participant session (owner-private default)    |

A `restricted` agent is selectable only by users who can view it, and its
participation is conversation-scoped — the same fail-closed posture as gated
IM conversations.

### 10.3 Delegated admin MCP

A conversation containing the built-in `agentconnect` preset **may** be
multi-agent, but the administrative catalog is available only in
single-participant conversations. The grant's logical-authority tuple binds
one `agentId` and the confirmation UX assumes one acting agent
([webchat-preset-agentconnect-mcp.md](webchat-preset-agentconnect-mcp.md) §3),
so the **`roster size == 1` condition is checked live in the shared authority
predicate** (`resolveLiveWebchatMcpAuthority`) that both issuance and every
delegated request run through. A preset selected into a multi-agent roster
never gets the `agentconnect-admin` descriptor; a mid-conversation join that
grows the roster past one participant suspends the catalog on the very next
delegated request — fail-closed, without waiting for grant expiry or a
revocation broadcast — and the session surfaces "administration tools are
unavailable in multi-agent conversations" the same way descriptor-attachment
failure does.

Extending the grant model to multiple acting agents is explicitly out of scope
here.

## 11. Rollout

- **M0 — schema + roster growth.** `WebchatConversationAgent`, backfill,
  conversation-scoped token mint with creation-time `agentIds[]` (legacy alias
  kept), the mid-conversation join endpoint, per-agent current-session
  pointers. No behavior change for existing conversations.
- **M1 — multi-target turns.** `rc/verify` roster verdict, relay fan-out with
  membership validation, `RdMsgWebchat` additions, canonical `at`/`postId`,
  per-agent acks/streams, context fan-out of user turns and agent replies
  (attachments included), composer mentions + targeting ladder, per-agent
  stream lanes. Capability `webchat_multi_agent_v1` gates multi-agent
  creation. The preset issuance condition `roster size == 1` (section 10.3)
  lands here, with the matching §5.2 addition to
  [webchat-preset-agentconnect-mcp.md](webchat-preset-agentconnect-mcp.md).
- **M2 — a2a in-conversation.** Roster slice in `CollabRoutesSnapshot`, the
  recorded-coordinate carve-out in both collaboration routers,
  `rd/webchat-post`, agent-initiated posts (complete-post form), the
  `Conversation participants:` standing line, `channel/agents` conversation
  filter. Update [product-conventions.md](../product-conventions.md) §Channel's
  remaining role and `agent-collaboration-implementation.md` §2.5 tables in the
  same change. Turn-final context refresh for multi-agent conversations
  (section 5.4) also lands here — a2a wakes make peer churn common — and
  depends on the `ThreadContextCoordinator` extraction, rollout step 1 of
  [turn-final-context-refresh.md](turn-final-context-refresh.md).
- **M3 — polish.** Agent-initiated live streaming, grouped conversation view in
  the console sessions list, merged console transcript, per-agent runtime
  controls, mobile pass.

Each milestone is independently shippable; M1 without M2 already delivers the
user-facing product ("talk to several agents in one Playground conversation").

## 12. Alternatives considered

- **Mention-first ladder with a single default target** (mention → last
  responder → primary) — the original v1 shape, replaced by the standing-
  mention model of section 4.2: a roster the owner explicitly assembled IS the
  addressing, so activating all of it is not indiscriminate broadcast, and the
  no-response contract plus turn-final refresh absorb the noise the original
  rejection feared. Cost stays bounded by the roster cap the owner chose.
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

## 13. Decision log

Questions resolved during design review:

1. **The roster grows mid-conversation; it never shrinks (v1)** — the owner
   may add agents to a live conversation at any point (revising the earlier
   fixed-at-creation call); roster refresh is a plain browser reconnect.
   Removal stays future work with its shape recorded in section 3.1a.
2. **Primary never changes** — it is the first agent the conversation ever
   had, a derived compatibility/default anchor with no user-facing management.
   (The auto-promotion rule in section 3.1a applies only if removal ships
   later.)
3. **Attachment fan-out** — full fan-out: a turn's image travels with its
   context copies to every participant, bounded by roster cap × the 160 KiB
   image cap (sections 5.1, 10.1).
4. **Conversation title** — taken from the primary agent's `session_info`
   stream; other participants title only their own session rows (section 8).
5. **Preset conversations** — the built-in `agentconnect` preset may be in a
   multi-agent conversation; the delegated admin catalog is unavailable while
   the roster has more than one member, enforced live per request so a
   mid-conversation join suspends it immediately (section 10.3).
6. **No automatic round-table** — a multi-target turn produces independent
   answers; peers see each other's output only as context at their next
   activation or via an explicit mention, matching Slack-channel behavior
   (section 4.3).
7. **Turn-final context refresh applies to multi-agent conversations** — the
   canonical post is staged and committed only after a final context check,
   mirroring the IM answer workflow; the browser stream stays live and a
   superseded generation is replaced in place. Single-participant
   conversations keep today's behavior (section 5.4).
8. **Membership is a standing mention (revised targeting)** — an unmentioned
   user message activates the whole roster (as if every participant had been
   @'d when it joined), with explicit mentions narrowing the turn; the
   last-responder/primary default ladder is retired, and `AC_NO_RESPONSE` +
   turn-final refresh keep all-respond coherent (section 4.2).
9. **Primary is invisible** — no "default" marker anywhere; during assembly
   every chip is removable and the primary is re-derived as the first agent
   of the final list (section 9.1).
10. **No runtime controls in multi-agent conversations** — the Model / Effort /
    Permission pills and per-agent overrides disappear when the roster has two
    or more agents; each participant runs its configured runtime defaults, and
    the `set_*` ops stay single-agent-only (sections 9.1, 9.3).
