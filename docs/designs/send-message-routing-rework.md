# `sendMessage` Routing Rework

**Status:** Implemented

This document defines the `sendMessage` contract and the corresponding
agent-authored message-routing behavior. It replaced the visible in-thread
`sendMessage` forms and the rule that AgentConnect-authored platform messages can
never activate another AgentConnect agent.

It is authoritative for routing; [`session-concept.md`](session-concept.md),
[`agent-collaboration-implementation.md`](agent-collaboration-implementation.md),
and [`../product-conventions.md`](../product-conventions.md) have been updated to
match and defer here for the verification, hop-transition, and activation
rendezvous rules.

Two implementation notes, recorded where they will be looked for:

- **Slack is the only platform with agent-authored routing.** §5 makes this a
  transport capability rather than a product rule: a driver qualifies only once it
  can prove an exact author and deliver one finalized logical message. Slack does
  both through message metadata plus a selectively-admitted `message_changed`
  event. Telegram, Discord, and Feishu keep the postless `toAgent` path.
- **Response metadata rides in Slack message metadata**, so the visible text stays
  exactly what the agent wrote. That requires the receiving app to be delivered
  message metadata on `message` events; a deployment where it is not will see
  agent mentions recorded but never routed — the fail-closed direction.

## 1. Goals

1. Let a finalized platform message authored by an AgentConnect agent participate
   in normal routing, so the agents in a thread see what each other said.
2. Make the ordinary reply the way an agent talks in its current thread. Its text
   — `@mention` or not — is what the conversation shows; delivery is the ordinary
   routing ladder's decision, and whether to answer is the reader's.
3. Keep `sendMessage` for postless agent calls, direct messages, channel-root
   posts, and parent-session replies.
4. Make a parent-session reply an injection: the report itself is never published
   to IM, while the parent it resumes runs an ordinary turn and may answer in its
   own conversation.
5. Preserve directional agent-call policy, loop protection, transcript
   consistency, and exactly-once activation.

## 2. Product invariants

### 2.1 Current-thread communication uses the ordinary reply

An agent that wants to address an agent or human in its current platform thread
writes an ordinary turn reply containing the platform-native mention. It does
not call `sendMessage`.

Examples on Slack:

```text
<@U_AGENT_B> Please verify the rollout.
<@U_HUMAN> The rollout is ready for approval.
```

The ordinary reply already has the correct channel, thread, transport scope,
streaming lifecycle, and sender identity. A second sending tool invocation would
create an unnecessary competing delivery path.

### 2.2 `sendMessage` has no visible in-thread form

No message-target branch accepts `thread`. A visible `sendMessage` post is either
a direct message or a channel-root message.

The complete target union is:

```ts
type AgentTarget = {
  toAgent:
    | string
    | {
        agentId: string
        needsReply?: boolean
      }
  channel?: string
  message: string
}

type UserTarget = {
  toUser: string | string[]
  channel?: string
  platform?: Platform
  integrationId?: string
  message: string
}

type ChannelTarget = {
  channel: string
  platform?: Platform
  integrationId?: string
  message: string
}

type SessionTarget = {
  sessionId: string
  correlationId?: string
  message: string
}
```

The supported forms are:

| Target         | Without `channel`                                   | With `channel`                                                     |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `toAgent`      | Direct, postless agent call                         | One visible channel-root mention plus one logical agent activation |
| `toUser`       | Direct message to exactly one human                 | One channel-root post mentioning one or more humans                |
| bare `channel` | Not applicable                                      | One channel-root post with no recipient                            |
| `sessionId`    | Direct insertion into the authorized parent session | Not applicable                                                     |

Consequences:

- `toAgent + channel + thread` is invalid.
- `toUser + channel + thread` is invalid.
- bare `channel + thread` is invalid.
- A `toUser` array still requires `channel`; it never means group DM.
- A channel-root post still starts a new platform thread/session according to
  the platform's conversation model.

### 2.3 Agent-authored messages route like any other message

A verified AgentConnect-authored platform message takes the SAME arbitration
ladder a human message takes, with the author removed from the candidate set:

- **A thread is a conversation, so everyone in it hears what is said.** Delivery goes
  to every agent already PARTICIPATING in the thread, minus the author — not to one
  agent chosen per message. That holds whoever spoke: a human's follow-up and an
  agent's reply reach the same room.
- **An `@mention` JOINS an agent to the thread**, at the root or midway through. That
  is the whole of what a mention does for routing. After joining, the agent keeps
  receiving what is said next whether or not the next message names it — which is why
  agents do not have to name each other to keep a conversation going.
- **A channel-`auto` agent participates in the whole channel**, so every message there
  reaches it without any mention at all.
- A mention names EVERY agent it matches, never whichever routing rule happened to be
  found first. On a bot serving several agents that distinction is the difference
  between deterministic delivery and delivery that depends on rule order.
- **Whether to answer is the reader's decision, not routing's.** An agent's own bot
  user id is standing context (`- Slack identity: bot user <@U…> is YOU`), sourced from
  the daemon's own live connection, so it can tell whether a message concerns it and
  decline with `NO_RESPONSE`.
- Selecting the EXCLUSIVE recipient by parsing the body was tried and removed. It made
  delivery depend entirely on mapping an opaque `<@U…>` back to an agent through the
  collaboration directory. A live workspace exposed two metadata bugs in that path:
  `botUserId` was absent for most agents, and `botShared` meant "the app is shareable"
  rather than "this bot user currently backs several agents in this conversation."
  Mention metadata now converges from Slack identity and actual channel placements, but
  it is used only to render addresses and JOIN named agents; existing participants never
  disappear merely because an address cannot be resolved.
- ONE structured exception: the visible half of a paired `toAgent + channel` send
  (§3.2). Its target came from the tool call as an agent id, and the activation
  rendezvous only converges when the visible observation and the internal wake name the
  SAME agent. Both ladders special-case it on `agentCallDeliveryId`.
- Each peer is an INDEPENDENT delivery: its own session, `!stop` mute, Off fence, and
  inbox row. A muted participant stays muted — `!stop` is per (thread, agent), and
  hearing the room is exactly what it was told to stop doing.
- **An ordinary platform reply can never target its author.** An agent's own reply
  always matches its own rule, so echo-based self-activation is not a loop the hop cap
  slows down — it is unconditional. The author is excluded once, before any ordinary
  routing rung. The paired `toAgent + channel` exception above is driven by its internal
  envelope, not by routing the author's platform echo.
- A third-party bot keeps its existing behavior: where supported, it may activate
  an agent only through an explicit mention. The difference is verification, not
  bot-ness — we know exactly which agent wrote a verified message and have already
  checked its policy, so it is a participant rather than anonymous bot traffic.

Every selected edge is still an agent call: it spends from the shared hop budget
(§4.1), passes directional call policy, and passes the conversation Off/gated
fence. It is also _implicit_, so it obeys the `!stop` thread mute exactly like a
human's implicitly-routed message. Agent traffic can no longer LIFT that mute
either — lifting it was the explicit-mention path, and clearing a stop is properly
a human act (an `@mention` on the ordinary ladder, or `!resume`). `!stop` is the
direct control a human has over a running exchange, so agents talking among
themselves must not be able to reopen it.

**Consequence, stated plainly.** A multi-agent conversation now terminates because
it hits a limit, not because someone stops addressing anyone. The hop cap and the
durable loop guard become the ordinary terminating conditions rather than
exceptional ones. On dedicated bots this is amplified: each app receives the same
channel event on its own connection, so one agent message can wake every other
agent in the channel. A channel with several `auto`-routed agents will reach the
loop guard quickly, and the guard is a latch that only an explicit `!resume`
clears. Operators wanting bounded multi-agent chatter should prefer `@mention`
addressing or a narrower per-channel trigger.

## 3. `toAgent` delivery behavior

### 3.1 Postless form

`{"toAgent":"<agent-id>","message":"..."}` remains the trusted internal
agent-call path. It posts nothing to an IM platform and is available to agents
without any platform integration.

Its child session is headless. The daemon derives its delivery coordinates from
the trusted caller session instead of treating a platform channel supplied by the
model as authorization. The child retains origin lineage, hop count, optional
correlation, `needsReply`, and `viewSessionStatus` support.

### 3.2 Channel-root form

`{"toAgent":"<agent-id>","channel":"<channel-id>","message":"..."}`:

1. Resolves and authorizes the target before posting.
2. Renders the target's platform-native mention into the visible body.
3. Posts one message at the channel root.
4. Anchors the target session to the root post's platform message ID.
5. Returns the admitted child session as the existing agent-call contract does.

For a dedicated Slack bot the body begins with `<@U_TARGET>`. For a shared Slack
bot it begins with the shared bot mention plus the target slug, for example
`<@U_SHARED> reviewer`, because the shared bot user ID alone cannot identify an
agent.

The internal wake and the platform echo are two observations of one logical
delivery. The visible post carries a daemon-minted `agent_call_delivery_id`, and
both observations share an activation key:

```text
activationKey = platform + transportScope + platformMessageId + targetAgentId
```

The target daemon keeps a durable rendezvous record for the activation key. The
internal wake is the semantic authority for a paired `toAgent + channel` call
because it carries the complete trusted call envelope: delivery ID, caller and
parent lineage, origin coordinates, correlation, `needsReply`, hop count,
external-origin metadata, and privacy gates. The platform event contributes the
provider-authenticated visible coordinates and transcript observation; its
delivery ID is correlation, not authority.

The rendezvous behaves identically in both arrival orders:

- **Internal wake first:** atomically store the complete envelope, admit the
  child once, and reconcile the later platform observation into the same
  transcript row.
- **Platform event first:** claim the key as `pending`, record the visible
  observation, and do not dispatch. The later internal wake attaches the
  complete envelope and atomically changes `pending` to `admitted` before
  dispatch.

A pending platform observation that never receives its internal envelope expires
as transcript-only and raises an operational delivery failure; it must never
fall back to an envelope-less child. Retries reuse the delivery ID and rendezvous
record. An ordinary agent-authored `@mention` has no
`agent_call_delivery_id`, so it remains independently platform-routable and is
not held for an internal wake.

This preserves the synchronous `delivered` / `childSessionId` agent-call result,
the full lineage contract, and exactly-once activation while also allowing
ordinary agent-authored platform messages to route.

For cross-daemon delivery the platform message ID already travels as
`transcriptTs`; the target daemon owns the durable rendezvous because both the
forwarded wake and routed IM event converge there. The relay forwards the
verified pairing ID but never synthesizes or stores the call envelope.

## 4. Trusted agent authorship

The system must distinguish a verified AgentConnect author from a generic bot.
Model-visible text is never proof of identity.

Slack already stamps `author_agent_id` in AgentConnect message metadata. Extend
the daemon-owned metadata to carry the finalized response boundary, recipients
resolved from the complete logical response, trusted loop depth, and an optional
paired-call correlation ID:

```ts
{
  author_agent_id: string
  response_id: string
  delivery_state: 'streaming' | 'final'
  hop_count: number
  mentioned_agent_ids: string[]
  agent_call_delivery_id?: string
}
```

The daemon derives `mentioned_agent_ids` before platform splitting. Model text
cannot directly populate it. `agent_call_delivery_id` is present only on the
visible half of `toAgent + channel`; ordinary replies omit it. `hop_count` is
the trusted depth of the author's current turn before this platform delivery. A
human/root turn has depth `0`; the model cannot set or reset this field.

Ingress treats `author_agent_id` as a claim until it verifies that:

1. the provider event is authentic;
2. the sending app/bot identity belongs to AgentConnect in this organization and
   conversation;
3. the claimed author is one of the agents represented by that identity; and
4. the resolved author-to-target edge passes outbound policy, inbound call
   policy, organization equality, and the target conversation gate.

Relay ingress performs the first authorization and forwards a trusted author
claim outside the normalized provider payload. The target daemon repeats the
policy and placement checks against its local collaboration snapshot before
dispatching.

Drivers that cannot prove an exact agent author may still classify the sender as
a third-party bot, but must not grant it AgentConnect call-policy identity. A
shared bot with no exact author claim fails closed because its platform identity
represents more than one agent.

### 4.1 Trusted hop transition

Every agent-to-agent delivery uses one transition and the same
`MAX_AGENT_CALL_HOPS`, whether it is a same-daemon internal call, a relayed
internal call, a direct-daemon platform mention, or a relayed platform mention.
The trusted source is active-turn call metadata for an internal call and verified
response metadata for a platform mention. Every routing edge computes:

```text
deliveryHopCount = verifiedSourceHopCount + 1
```

The transition is enforced as follows:

1. A missing, non-integer, negative, or otherwise unverifiable source depth is
   transcript-only; it cannot activate an AgentConnect agent.
2. If `deliveryHopCount >= MAX_AGENT_CALL_HOPS`, the edge records a `hop_limit`
   rejection and does not dispatch.
3. A direct daemon computes the transition and installs `deliveryHopCount` as
   trusted active-turn call metadata on the admitted target turn.
4. Relay ingress performs the identical addition and cap check, then forwards a
   relay-minted `trustedDeliveryHopCount` outside the provider payload. The
   target daemon terminal-verifies its range and installs it without incrementing
   it a second time.
5. Every ordinary platform response produced by that target turn stamps its
   installed depth as the next event's `hop_count`. A subsequent target therefore
   advances by one again. Queue persistence and replay retain the installed
   depth; restart, compaction, and platform text cannot reset it.

A paired `toAgent + channel` delivery remains governed by the complete internal
call envelope at the rendezvous. Its envelope already contains the incremented
target depth under the existing internal-call contract, so the platform echo
does not perform another increment or replace it with provider metadata. Any
metadata/envelope depth mismatch is an operational integrity error, but the
platform observation never weakens or rewrites the authoritative envelope.

## 5. Final-message routing

Agent replies are streamed. The first platform post may contain only a prefix of
the eventual answer, so routing it immediately could prompt the target with
partial text and ignore later edits.

For AgentConnect-authored messages:

1. The daemon assigns one `response_id` to the complete logical response and
   resolves every exact agent mention against the conversation-specific agent
   directory before splitting it for platform delivery.
2. The resulting `mentioned_agent_ids` set is immutable response metadata. The
   final routing event carries that set even when the visible mention appeared
   in an earlier physical message.
3. A platform splitter treats every platform-native mention address as one
   indivisible token. It must not cut inside a human or agent mention. For a
   shared Slack bot, `<@U_SHARED> reviewer` is one address and the splitter must
   not separate the bot mention from its agent slug. If one address cannot fit a
   platform message, delivery fails instead of publishing a broken address.
4. Outbound streaming posts and intermediate edits carry
   `delivery_state: 'streaming'` and do not enter recipient routing.
5. Turn finalization marks exactly one response event as
   `delivery_state: 'final'`. Preferred form: the routing facts of the complete
   response are resolved before the final body flush, so a terminal section that
   is first posted at finalization is born `final` — one post, no closing edit.
   Born-final requires every peer to post under a bot identity other than the
   author's: a shared-bot peer's ingress admits only the closing-edit shape past
   its self-echo filter (§6), so a conversation where a peer shares the sending
   bot keeps the closing edit. The content-identical closing `chat.update` also
   remains the fallback for a final message that was already fully delivered
   mid-stream; it is skipped entirely when the conversation's directory holds no
   agent besides the author, because the final event then has no consumer and
   the edit would only mark the visible reply "(edited)". (A peer added during
   that turn's snapshot-propagation window misses one activation and catches up
   on the next turn.)
6. Ingress routes only the final event, and deduplicates by `response_id` plus
   target agent. The ordinary ladder may supply a primary, but delivery also goes
   independently to every existing participant and every agent the body newly
   mentions. The recipient set selects an exact target only for a paired
   `toAgent + channel` delivery, whose target the tool named.
7. If a long response spans several platform messages, only the final response
   message closes the response. The woken target reconstructs preceding text
   through the normal thread-history catch-up path.

The recipient set is still a provider metadata claim at ingress. It becomes
trusted only together with the exact AgentConnect author and app identity, and
every author-to-target edge — however the target was selected — must
independently pass current policy and conversation gates.

At finalization the platform driver tokenizes mention-address spans before
choosing physical-message boundaries. A preferred line or paragraph boundary
that falls inside a span moves to the start of that span; the following section
starts with the complete address. The sections must concatenate to the exact
logical response, including whitespace around the mention.

Slack must selectively normalize the final `message_changed` event instead of
dropping every edit wrapper. Chrome and other structural messages remain
filtered.

This final-boundary requirement is transport capability, not Slack-specific
product semantics. A platform driver may enable agent-authored routing only when
it can provide a trustworthy author and one finalized logical message. Provider
APIs that never deliver bot-authored messages cannot support platform re-entry;
the postless `toAgent` path remains available.

## 6. Routing order

The direct-daemon and relay arbitration ladders use the same rules:

```text
final platform event
|
|- structural/chrome event -> drop
|- verified AgentConnect author?
|    |- target == author -> excluded everywhere
|    |- source hop invalid or source hop + 1 reaches/exceeds cap -> transcript only (hop_limit)
|    |- paired `toAgent + channel` (agentCallDeliveryId) -> the agent the tool named
|    `- any other reply -> the thread's PARTICIPANTS, author excluded
|         (agents already in the thread + any the body newly names)
|         -> claim activation key -> dispatch once per peer
|- third-party supported bot?
|    `- exact target mention only -> existing bot-mention behavior
`- human sender -> existing ladder may nominate a primary
     `- explicit joins + existing participants + channel-auto agents
          -> dispatch once per peer with a target-specific mention/implicit cause
```

Mention resolution still exists to RENDER an address (`listAgents`' `mention` field, a
channel-root `toAgent` post), to name the paired target, and to JOIN every agent an
ordinary platform mention matches. A mention never narrows an ordinary reply to one
recipient: existing participants still receive their independent implicit copies. A
shared bot's address therefore still needs its agent slug when an agent wants to write
one; a bare `<@U_SHARED>` joins only the routes that token can actually resolve.

The author-removal rule applies to ordinary platform replies. An explicit paired
`toAgent` channel-root delivery may target its own author: the internal envelope activates
the new child once, while the platform echo remains only the paired observation. The
postless form still rejects self-targets because it has no new conversation boundary.

Agent-authored text cannot issue in-conversation control commands such as
`!stop`, `!resume`, or configuration actions.

## 7. Parent-session replies

`sendMessage({"sessionId":"<parent>","message":"..."})` remains authorized
only against the caller session's active or persisted origin.

The injected message is:

```text
{ type: system, from: <child-agent> }: <message>
```

What must stay invisible is the REPORT, not the parent's turn. The child's body
is injected into the parent session — recorded in its transcript, never
published to a platform by any component, on either the local or the
cross-daemon path. That is structural, not a flag: nothing in the daemon
publishes inbound delivery content.

The parent session is therefore resumed as an ORDINARY turn:

- the parent agent processes the new input;
- inbound content and resulting agent work are recorded in the session
  transcript;
- the turn keeps its ordinary reply sink and delivery chrome, so an answer the
  parent writes lands in the parent's own conversation — where the humans who
  delegated the work are waiting;
- correlation, hop count, orchestration report recording, memory behavior, and
  the per-session serial gate remain unchanged.

An earlier revision resumed the parent with `headless: true` to prevent a second
copy of an answer the child had already delivered. That trade only holds when
the child answered in the SAME conversation the parent would speak in. When the
child answered somewhere else (its own channel-root thread) or nowhere at all (a
postless child), muting the parent meant the delegated outcome reached nobody:
the parent processed the report and answered into a dropped connection. The
duplicate-copy concern is editorial and belongs to the standing "do not restate
what the thread already shows" guidance, not to a transport-level mute.

Postless `toAgent` deliveries keep their own headless stamp (§3.1) — a postless
child has no visible conversation of its own by construction.

Cross-daemon session replies behave identically: the target dispatches them into
the named parent session and resumes it as an ordinary turn. The relay still
refuses to forward the kind to a daemon that has not advertised
`headless-agent-delivery-v1`, because such a daemon predates the delivery kind
entirely and would key the reply by coordinates instead of session id; that
refusal is a compatibility fence, no longer a silence requirement.

## 8. Protocol and data changes

### 8.1 Normalized platform message

Add optional, explicitly untrusted provider authorship, logical-response
recipient, response-state, source-hop, and paired-delivery claims to the
normalized provider message. The relay or daemon promotes them only after
verifying the producing AgentConnect identity. Provider `hop_count` always means
source-turn depth, never already-incremented delivery depth.

### 8.2 Relay IM frame

Add optional relay-minted `trustedFromAgentId`, response ID, recipient IDs,
paired agent-call delivery ID, and `trustedDeliveryHopCount` to the pre-addressed
IM frame. Keep them outside the provider payload so the target can distinguish
relay assertions from provider fields. The relay computes the trusted delivery
depth exactly once as verified source depth plus one; the target never increments
that frame value again.

### 8.3 Cross-daemon agent message

Add a delivery kind to `rd/agentmsg` and `rd/agentmsg/fwd`. The target stamps the
resulting normalized message `headless: true` for postless calls. A
`session-reply` is dispatched into the session named by `lineageReplyTo` and
resumes it as an ordinary turn (§7); the injected report is never published
regardless of the stamp.

### 8.4 Relay capability negotiation

Add relay-daemon hello capabilities, including `headless-agent-delivery-v1`. A
`session-reply` fails rather than being forwarded to a target daemon too old to
advertise it — that daemon predates the delivery kind and would key the reply by
coordinates instead of dispatching it into the named parent session.

### 8.5 Agent discovery

A channel-filtered `listAgents` result includes an optional platform-ready
`mention` string. An organization-wide listing omits it when there is no single
conversation-specific address.

Examples:

```json
{ "agentId": "...", "name": "reviewer", "mention": "<@U_REVIEWER>" }
{ "agentId": "...", "name": "reviewer", "mention": "<@U_SHARED> reviewer" }
```

This gives the model an exact token for an ordinary current-thread reply without
exposing credentials or guessing from display names.

### 8.6 Activation rendezvous

The target daemon persists a bounded activation record before either observation
can dispatch:

```ts
type ActivationRecord = {
  activationKey: string
  agentCallDeliveryId?: string
  platformObservation?: {
    platformMessageId: string
    transcriptCoordinates: string
  }
  callEnvelope?: TrustedAgentCallEnvelope
  state: 'pending' | 'admitted' | 'transcript-only'
  childSessionId?: string
  expiresAt: number
}
```

Creation, envelope attachment, and `pending -> admitted` are atomic with the
daemon's durable inbox/admission fence. An admitted record returns its stored
`childSessionId` to retries and never dispatches again. A platform-first paired
record cannot become `admitted` until `callEnvelope` is present. Expiry changes
an envelope-less record to `transcript-only`; it does not synthesize missing
lineage from platform metadata. The record and any message body remain on the
daemon, never the Control Plane or relay.

## 9. Implementation map

The main implementation surfaces are:

- `packages/daemon/src/mcp/tools.ts`: remove every `thread` property and update
  tool guidance.
- `packages/daemon/src/mcp/ops.ts`: enforce the new target union, render
  channel-root mentions, and remove visible in-thread execution.
- `packages/daemon/src/slack/connection.ts`: retain AgentConnect-authored events,
  stamp response/recipient/pairing state, split only at mention-safe boundaries,
  and surface only the finalized routing event.
- `packages/relay/src/platforms/slack/http-ingest.ts`: stop dropping AgentConnect
  message echoes while retaining structural/chrome filtering.
- `packages/relay/src/relay-ingress-manager.ts`: replace blanket managed-agent
  suppression with author verification, source-hop transition/cap enforcement,
  per-edge policy checks, and cross-daemon participant fan-out — with the paired
  `toAgent + channel` delivery kept on its exact, tool-named target.
- `packages/relay/src/bot-arbitration.ts`: track the participant set beside legacy
  single-owner affinity, exclude the author from every rung, and resolve explicit
  joins and implicit participant copies independently.
- `packages/control-plane/src/persistence/repositories/thread-affinity.repo.ts`:
  persist the participant set separately from the compatibility owner, broadcast
  joins to every relay, and return the full set on a relay affinity miss.
- `packages/daemon/src/daemon.ts`: replace direct and relayed managed-agent
  suppression with verified routing, trusted hop propagation, durable activation
  rendezvous records, and parent-session `replyToSession` dispatch.
- `packages/daemon/src/state-store.ts`: persist activation rendezvous state and
  make admission/retry transitions atomic with the durable inbox fence.
- `packages/daemon/src/router/routing-table.ts`: admit verified agent traffic to
  the implicit rungs with the author excluded (unverified bot traffic still stops
  at the explicit-mention rung), and expose `mentionedAgents` / `participantAgents` /
  `automaticAgents` — the whole named set, the thread's existing members, and the
  channel-wide participants — for conversation-wide delivery.
- `packages/protocol`: carry authorship, logical recipient, paired-delivery,
  source/delivery hop, delivery-state, headless, capability, and mention-address
  metadata.
- `packages/control-plane`: include public mention-address inputs in the
  collaboration/directory snapshot; message bodies remain off the Control Plane.

The Control Plane remains outside the message hot path. It distributes only
identity, placement, policy, and mention-address metadata.

## 10. Tests

At minimum, cover:

1. `sendMessage` schemas expose no `thread` property in any branch.
2. `toAgent` without `channel` is postless and headless.
3. `toAgent + channel` posts at root, renders the exact agent mention, and
   produces one child activation.
4. Internal-wake-first and platform-event-first races both activate once with
   the same complete call envelope; platform-first with `needsReply: true`
   preserves parent lineage and reply behavior.
5. `toUser` without `channel` is a single-user DM; an array is rejected.
6. `toUser + channel` posts at root and mentions all listed humans.
7. A normal current-thread agent reply reaches every OTHER participant of the
   thread, whether or not it mentions anyone; a mention adds whoever it names, and
   names all of them rather than the first matching rule.
8. Agent-authored auto-channel, DM, and thread-affinity traffic continues the
   conversation through the implicit rungs, never selecting the author;
   agent-authored command traffic still activates nobody.
9. An ordinary platform reply never targets its author on any connection, and a body
   naming the author, a human, or an unresolvable peer does not change delivery. An agent-authored
   delivery obeys a `!stop` mute on both the direct and relay paths and can never
   lift one — clearing a stop stays a human act.
10. A paired `toAgent + channel` delivery reaches the exact agent the tool named,
    including the caller itself, on both ladders, so its rendezvous halves converge
    and activate one child exactly once.
11. Streaming agent messages do not activate; when a mention is in physical
    section one and finalization is in section two or later, the final response
    still selects that target once with complete thread context.
12. Splitting never cuts a dedicated mention or separates a shared bot mention
    from its agent slug; concatenating the physical sections preserves the exact
    logical response.
13. Local and cross-daemon parent-session replies update the target session
    without publishing the injected report, and resume the parent as an ordinary
    turn whose own answer reaches the parent's conversation.
14. A cross-daemon `session-reply` refuses a target daemon that never advertised
    `headless-agent-delivery-v1` instead of letting it key the reply by
    coordinates.
15. Direct and relay mention routing both admit source depth
    `MAX_AGENT_CALL_HOPS - 2` as target depth `MAX_AGENT_CALL_HOPS - 1`, reject
    source depth `MAX_AGENT_CALL_HOPS - 1` because the next hop reaches the
    exclusive boundary, and reject invalid or missing depth instead of resetting
    it to zero.
16. An A -> B -> A ordinary-mention chain installs and re-stamps monotonically
    increasing trusted depths, stops at the shared cap, and preserves its depth
    across queue replay/restart.

## 11. Rollout

1. Ship optional protocol fields and daemon/relay capability advertisement.
2. Ship target-side final-message verification, logical recipient carry,
   source-hop transition/propagation, activation rendezvous/deduplication, and
   headless automatic-output support.
3. Ship relay/direct-ingress routing and stop applying the blanket managed-agent
   filter.
4. Ship the reduced `sendMessage` schema and updated model guidance.
5. After all supported paths converge, update product conventions and the
   current-design documents to make this proposal authoritative.

During a mixed-version rollout, older components may continue suppressing an
agent-authored platform event, and no component may deliver a `session-reply` to
a daemon that cannot dispatch it into the named parent session.
