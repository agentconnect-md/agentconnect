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
   in normal recipient routing.
2. Make the ordinary reply the way an agent talks in its current thread — an
   explicit `@mention` to address someone in particular, and plain text to
   continue the conversation with whoever the ordinary routing ladder selects.
3. Keep `sendMessage` for postless agent calls, direct messages, channel-root
   posts, and parent-session replies.
4. Make a parent-session reply session-only by default: its injected input and
   ordinary resumed output do not go to IM, while an explicit visible
   `sendMessage` remains an intentional, separately authorized outbound action.
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

- An explicit mention of agent B activates B.
- An unmentioned agent message continues the conversation through the ordinary
  implicit rungs — thread affinity, DM, keyword, channel `auto`, default agent.
  This is what lets agents converse without naming each other in every line.
- A mention of a human names no agent, so it selects nobody by itself; the message
  is then treated as unmentioned and continues through the implicit rungs — which
  is exactly what a human's `@human` reply does in the same channel.
- Having named an agent is binding: if every named recipient is refused (policy,
  the conversation fence, not resident here) the message is transcript-only. It
  does not fall through to the implicit rungs, because substituting a recipient
  the author did not ask for is not a continuation — and the commonest such case
  is a response whose only name is its own author.
- **The author can never be the target.** This is the one absolute. An agent's own
  reply always matches its own rule, so self-activation is not a loop the hop cap
  slows down — it is unconditional. The author is excluded once, before any rung.
- A third-party bot keeps its existing behavior: where supported, it may activate
  an agent only through an explicit mention. The difference is verification, not
  bot-ness — we know exactly which agent wrote a verified message and have already
  checked its policy, so it is a participant rather than anonymous bot traffic.

Every implicitly-selected edge is still an agent call: it spends from the shared
hop budget (§4.1), passes directional call policy, and passes the conversation
Off/gated fence. It is also still _implicit_, so it obeys the `!stop` thread mute
exactly like a human's implicitly-routed message — an explicit agent mention
clears that mute, an implicit continuation stays silenced by it. Without this
`!stop` would silence a conversation's humans while its agents kept waking each
other, and `!stop` is the direct control a human has over a running exchange.

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
2. If `deliveryHopCount > MAX_AGENT_CALL_HOPS`, the edge records a `hop_limit`
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
   `delivery_state: 'final'`.
6. Ingress routes only the final event. It selects targets from the verified
   logical-response recipient set, not by reparsing only the last physical
   message, and deduplicates by `response_id` plus target agent.
7. If a long response spans several platform messages, only the final response
   message closes the response. Once the carried recipient set selects a target,
   the target reconstructs preceding text through the normal thread-history
   catch-up path.

The recipient set is still a provider metadata claim at ingress. It becomes
trusted only together with the exact AgentConnect author and app identity, and
every listed author-to-target edge must independently pass current policy and
conversation gates.

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
|    |- target == author -> excluded from every rung
|    |- no verified recipient -> fall through to the ordinary implicit ladder
|    |    (thread affinity / dm / keyword / auto / default), author excluded
|    |- source hop invalid or source hop + 1 exceeds cap -> transcript only (hop_limit)
|    |- author -> target policy denied -> transcript only
|    `- target in verified recipient set -> claim activation key -> dispatch once
|- third-party supported bot?
|    `- exact target mention only -> existing bot-mention behavior
`- human sender -> existing mention/thread/DM/keyword/auto ladder
```

For a verified agent author, shared-bot slug resolution runs before channel owner
or default-agent fallback. A bare shared-bot mention from an agent does not select
the default agent.

Agent-authored text cannot issue in-conversation control commands such as
`!stop`, `!resume`, or configuration actions.

## 7. Parent-session replies

`sendMessage({"sessionId":"<parent>","message":"..."})` remains authorized
only against the caller session's active or persisted origin.

The injected message is:

```text
{ type: system, from: <child-agent> }: <message>
```

The target parent session is resumed with `headless: true`. For this delivery
kind, headless controls the automatic reply sink and delivery chrome:

- the parent agent processes the new input;
- inbound content and resulting agent work are recorded in the session
  transcript;
- no ordinary IM body, typing indicator, status message, status bar, footer,
  permission card, or completion notification is emitted for that turn;
- correlation, hop count, orchestration report recording, memory behavior, and
  the per-session serial gate remain unchanged.

An explicit visible `sendMessage` from the resumed parent remains allowed and
uses its normal authorization and delivery semantics. It is a new intentional
outbound action, not an IM copy of the session reply. Postless `toAgent` and
`sessionId` targets also remain available. Consequently, `headless: true` is not
a turn-wide egress prohibition and the system promises zero IM gateway calls
only when the agent does not explicitly choose a visible target.

The current implementation already injects the child body rather than posting
it directly, but the resumed parent turn still owns an ordinary IM reply
connection. The new design removes that connection for this turn; it does not
add a separate `sendMessage` egress gate.

Cross-daemon session replies carry a required-headless delivery flag. A relay
must not forward such a reply to a daemon that has not advertised support for
session-only automatic output; it returns an unsupported/retryable verdict
instead of silently degrading the ordinary parent response to visible IM
output.

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

Add a delivery kind or required-headless flag to `rd/agentmsg` and
`rd/agentmsg/fwd`. The target stamps the resulting normalized message
`headless: true` for postless calls and session replies. For session replies the
flag suppresses automatic platform output but does not disable explicit visible
tool sends.

### 8.4 Relay capability negotiation

Add relay-daemon hello capabilities, including
`headless-agent-delivery-v1`. Required-headless deliveries fail rather than
becoming visible when the target daemon is too old.

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
- `packages/relay/src/slack-http-ingest.ts`: stop dropping AgentConnect message
  echoes while retaining structural/chrome filtering.
- `packages/relay/src/relay-ingress-manager.ts`: replace blanket managed-agent
  suppression with author verification, source-hop transition/cap enforcement,
  policy checks, and the verified-author routing ladder (named recipients, or the
  implicit rungs when the response named nobody).
- `packages/relay/src/bot-arbitration.ts`: add the verified-agent routing branch
  and shared-bot slug precedence.
- `packages/daemon/src/daemon.ts`: replace direct and relayed managed-agent
  suppression with verified routing, trusted hop propagation, durable activation
  rendezvous records, and headless `replyToSession` dispatch.
- `packages/daemon/src/state-store.ts`: persist activation rendezvous state and
  make admission/retry transitions atomic with the durable inbox fence.
- `packages/daemon/src/router/routing-table.ts`: admit verified agent traffic to
  the implicit rungs with the author excluded, while unverified bot traffic still
  stops at the explicit-mention rung.
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
7. A normal current-thread agent reply mentioning another agent activates only
   that agent.
8. Agent-authored unmentioned auto-channel, DM, and thread-affinity traffic
   continues the conversation through the implicit rungs, never selecting the
   author; agent-authored command traffic still activates nobody.
9. Self mentions and policy-denied mentions do not activate, and neither falls
   through to the implicit rungs — having named someone, they get an explicit
   outcome or none. An implicitly selected continuation obeys a `!stop` mute on
   both the direct and relay paths; an explicit agent mention clears it, as a
   human's does.
10. Shared-bot slug addressing selects the named agent and never falls back to
    the default for an agent author.
11. Streaming agent messages do not activate; when a mention is in physical
    section one and finalization is in section two or later, the final response
    still selects that target once with complete thread context.
12. Splitting never cuts a dedicated mention or separates a shared bot mention
    from its agent slug; concatenating the physical sections preserves the exact
    logical response.
13. Local and cross-daemon parent-session replies update the target session and
    make no implicit IM gateway calls. An explicit visible `sendMessage` remains
    allowed and is tested as a separate intentional action.
14. A required-headless cross-daemon reply refuses an old target daemon instead
    of leaking the ordinary parent response to IM.
15. Direct and relay mention routing both admit source depth `7` as target depth
    `8`, reject source depth `8` because the next hop is `9`, and reject invalid
    or missing depth instead of resetting it to zero.
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
agent-authored platform event, but no component may downgrade a required-headless
session reply into an ordinary visible response.
