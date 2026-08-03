# `sendMessage` Routing Rework

**Status:** Proposed design

This document defines the next `sendMessage` contract and the corresponding
agent-authored message-routing behavior. It replaces the current visible
in-thread `sendMessage` forms and the rule that AgentConnect-authored platform
messages can never activate another AgentConnect agent.

Until the implementation lands, the current behavior in
[`session-concept.md`](session-concept.md),
[`agent-collaboration-implementation.md`](agent-collaboration-implementation.md),
and [`../product-conventions.md`](../product-conventions.md) remains
authoritative.

## 1. Goals

1. Let a finalized platform message authored by an AgentConnect agent participate
   in normal recipient routing.
2. Make an ordinary reply with an explicit platform `@mention` the only way to
   address an agent or human in the current thread.
3. Keep `sendMessage` for postless agent calls, direct messages, channel-root
   posts, and parent-session replies.
4. Make a parent-session reply session-only: it may resume the parent agent, but
   that turn must not emit anything to an IM platform.
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

### 2.3 Agent-authored messages are mention-routable

A verified AgentConnect-authored platform message is eligible for routing. It is
not eligible for implicit activation:

- An explicit mention of agent B may activate B.
- An unmentioned agent message never activates through thread affinity, DM,
  keyword, channel `auto`, or default-agent fallback.
- A mention of a human does not activate an agent.
- The author cannot activate itself.
- A third-party bot keeps its existing behavior: where supported, it may activate
  an agent only through an explicit mention.

This rule removes the blanket managed-agent filter without turning every agent
reply into an automatic agent call.

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
delivery. They must share an activation key:

```text
activationKey = platform + transportScope + platformMessageId + targetAgentId
```

Both paths claim that key before dispatch. Whichever path arrives second records
or reconciles the shared transcript row but does not start a second model turn.
This preserves the synchronous `delivered` / `childSessionId` result while also
allowing ordinary agent-authored platform messages to route.

The claim must work in both arrival orders:

- internal wake first, platform event second;
- platform event first, internal wake second.

For cross-daemon delivery the platform message ID already travels as
`transcriptTs`; the target daemon owns the activation claim because both the
forwarded wake and routed IM event converge there.

## 4. Trusted agent authorship

The system must distinguish a verified AgentConnect author from a generic bot.
Model-visible text is never proof of identity.

Slack already stamps `author_agent_id` in AgentConnect message metadata. Extend
the daemon-owned metadata to carry the finalized response boundary and trusted
loop depth:

```ts
{
  author_agent_id: string
  response_id: string
  delivery_state: 'streaming' | 'final'
  hop_count: number
}
```

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

## 5. Final-message routing

Agent replies are streamed. The first platform post may contain only a prefix of
the eventual answer, so routing it immediately could prompt the target with
partial text and ignore later edits.

For AgentConnect-authored messages:

1. Outbound streaming posts and intermediate edits carry
   `delivery_state: 'streaming'` and do not enter recipient routing.
2. Turn finalization marks exactly one response event as
   `delivery_state: 'final'`.
3. Ingress routes only the final event and deduplicates it by `response_id` plus
   target agent.
4. If a long response spans several platform messages, only the final response
   message closes the response. The target reconstructs preceding text through
   the normal thread-history catch-up path.

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
|    |- no exact target mention -> transcript only
|    |- target == author -> transcript only
|    |- author -> target policy denied -> transcript only
|    `- exact target mention -> claim activation key -> dispatch once
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

The target parent session is resumed with `headless: true`:

- the parent agent processes the new input;
- inbound content and resulting agent work are recorded in the session
  transcript;
- no IM body, typing indicator, status message, status bar, footer, permission
  card, or completion notification is emitted for that turn;
- correlation, hop count, orchestration report recording, memory behavior, and
  the per-session serial gate remain unchanged.

This is stronger than merely avoiding a direct `postMessage` call. The current
implementation already injects the child body rather than posting it directly,
but the resumed parent turn still owns an IM reply connection. The new design
removes that connection for this turn.

Cross-daemon session replies carry a required-headless delivery flag. A relay
must not forward such a reply to a daemon that has not advertised support for
headless agent delivery; it returns an unsupported/retryable verdict instead of
silently degrading to visible IM output.

## 8. Protocol and data changes

### 8.1 Normalized platform message

Add an optional, explicitly untrusted provider authorship claim and response
state to the normalized provider message. The relay or daemon promotes it to a
trusted agent author only after verification.

### 8.2 Relay IM frame

Add an optional relay-minted `trustedFromAgentId` and trusted hop count to the
pre-addressed IM frame. Keep them outside the provider payload so the target can
distinguish relay assertions from provider fields.

### 8.3 Cross-daemon agent message

Add a delivery kind or required-headless flag to `rd/agentmsg` and
`rd/agentmsg/fwd`. The target stamps the resulting normalized message
`headless: true` for postless calls and session replies.

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

## 9. Implementation map

The main implementation surfaces are:

- `packages/daemon/src/mcp/tools.ts`: remove every `thread` property and update
  tool guidance.
- `packages/daemon/src/mcp/ops.ts`: enforce the new target union, render
  channel-root mentions, and remove visible in-thread execution.
- `packages/daemon/src/slack/connection.ts`: retain AgentConnect-authored events,
  stamp response state, and surface only the finalized routing event.
- `packages/relay/src/slack-http-ingest.ts`: stop dropping AgentConnect message
  echoes while retaining structural/chrome filtering.
- `packages/relay/src/relay-ingress-manager.ts`: replace blanket managed-agent
  suppression with author verification, policy checks, and mention-only routing.
- `packages/relay/src/bot-arbitration.ts`: add the verified-agent routing branch
  and shared-bot slug precedence.
- `packages/daemon/src/daemon.ts`: replace direct and relayed managed-agent
  suppression with verified routing, activation claims, and headless
  `replyToSession` dispatch.
- `packages/daemon/src/router/routing-table.ts`: keep verified agent traffic out
  of implicit routing rungs.
- `packages/protocol`: carry authorship, delivery-state, headless, capability,
  and mention-address metadata.
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
4. Internal-wake-first and platform-event-first races both activate once.
5. `toUser` without `channel` is a single-user DM; an array is rejected.
6. `toUser + channel` posts at root and mentions all listed humans.
7. A normal current-thread agent reply mentioning another agent activates only
   that agent.
8. Agent-authored unmentioned, auto-channel, DM, thread-affinity, and command
   traffic does not activate an agent.
9. Self mentions and policy-denied mentions do not activate.
10. Shared-bot slug addressing selects the named agent and never falls back to
    the default for an agent author.
11. Streaming agent messages do not activate; the final response activates once
    with complete thread context.
12. Local and cross-daemon parent-session replies update the target session while
    making zero IM gateway calls.
13. A required-headless cross-daemon reply refuses an old target daemon instead
    of leaking output to IM.

## 11. Rollout

1. Ship optional protocol fields and daemon/relay capability advertisement.
2. Ship target-side final-message verification, activation deduplication, and
   headless delivery support.
3. Ship relay/direct-ingress routing and stop applying the blanket managed-agent
   filter.
4. Ship the reduced `sendMessage` schema and updated model guidance.
5. After all supported paths converge, update product conventions and the
   current-design documents to make this proposal authoritative.

During a mixed-version rollout, older components may continue suppressing an
agent-authored platform event, but no component may downgrade a required-headless
session reply into visible output.
