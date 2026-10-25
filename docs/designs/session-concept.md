# Session Concept

**Status:** Current design

> **Routing update:** [`send-message-routing-rework.md`](send-message-routing-rework.md)
> is implemented and authoritative for message ROUTING. It removed every visible
> in-thread `sendMessage` form, kept `toAgent + channel` as a channel-root send,
> made current-thread addressing use ordinary `@mention` replies, and made
> parent-session reply turns session-only. Sections 3 and 6 below are updated to
> match; read that document for the verification, hop-transition, and activation
> rendezvous rules behind them.

> This document does one thing: define **session** precisely--what it is, what
> it contains, how messages record source and destination, how agent-to-agent
> communication and cross-platform sends enter sessions, and how **replies**
> flow back across sessions.
>
> **All sending uses one `sendMessage` tool.** It combines the existing
> `sendPlatformMessage`, which posts to a platform channel or user at
> `mcp/tools.ts:65`, with `messageAgent`, which wakes another agent at
> `mcp/tools.ts:409`. Agent-to-agent calls, a session's delegated tasks,
> cross-platform messages, and replies to session messages all use
> `sendMessage`, each selected by an explicit `action`; see section 3 and
> [send-message-guide.md](send-message-guide.md).
>
> This terminology is shared by
> [agent-collaboration-implementation.md](agent-collaboration-implementation.md),
> which implements delivery,
> [loop-breaker-design.md](loop-breaker-design.md), which decides when to stop,
> and [daemon-detailed-design.md](daemon-detailed-design.md), which implements
> it in the daemon. User-visible message presentation and delivery conventions
> live in [product-conventions.md](../product-conventions.md).

---

## 1. In one sentence

**A session is one agent's continuous conversational context. It is
agent-scoped.**

Exactly one agent owns a session. It contains every input that agent receives,
every output it produces, and intermediate work such as tools and reasoning.
It is the sequence displayed line by line in the audit view.

### 1.1 Session identity

```text
sessionKey   = platform : channel : thread : agentId    // Logical primary key; current local-store.ts shape
acpSessionId                                             // Runtime-side ID from host.newSession
sessionId                                                // Stable opaque addressing handle
```

- `sessionKey` is an **agent-scoped four-tuple**, which creates two hard
  properties:
  - **Different agents in the same thread have different sessions.** A channel
    thread may represent one topic, but every participating agent maintains its
    own session.
  - **Ownership is unique.** The final `agentId` segment of `sessionKey` is the
    owner. Every `type: agent` message in the session has that owner in `from`.
- A session is logically addressed by `sessionKey`. Its runtime row also
  contains `acpSessionId` created by `host.newSession(...)`. The `sessionId` a
  `callAgent` names to reach an existing peer session is this stable handle; it is
  also the value shown on the `Session` line of the `# Agent` block in section
  2.3. A model treats it as opaque.

**`sessionId` and `acpSessionId` are two NAMES for one session, each used in its
own scope — never two concepts, and never interchangeable words for the same
scope.** Which name is correct is decided by who is being addressed:

- **`sessionId`** is the session's identity everywhere OUTSIDE the ACP hop: the
  wire to the control plane, the console and its deep links, `sendMessage`
  targets, the `# Agent` block, and the model-credential claims the gateway
  verifies. It must exist BEFORE the runtime does — a credential is minted to
  start the runtime, so an identity that only appears afterwards cannot be in it.
- **`acpSessionId`** is the identity the RUNTIME knows the session by, and it is
  needed in both directions on that hop: the daemon keys `session/prompt`,
  `session/cancel` and `session/set_config_option` by it, and the runtime keys
  every `session/update`, permission and elicitation notification by it. The
  daemon can never discard it.

The daemon mints the outward id when the session slot is first resolved — before
any credential is issued, so a credential can carry it. Where a runtime adopts
the id proposed on `session/new`, the two hold the same value; our adapters do
not propose it yet, so today they normally differ, and a runtime is always free
to insist on its own id. That does not break the doctrine: the daemon stores
both, uses `acpSessionId` for the ACP hop alone, and keeps answering the rest of
the world with `sessionId`. Translation happens at that one boundary and nowhere
else.

The field name is the contract, and it is readable from the frame alone: a field named
`acpSessionId` carries the runtime's id, because what it addresses lives on that hop and dies
with it — an ACP lease, a `session/update` stream. A field named `sessionId` carries the outward
one, whoever is asking: session metadata, usage, a purge receipt, a credential's claims, a
transcript page, a workspace read, a webchat delivery target. A daemon that receives one resolves
its slot by the outward id (falling back to the ACP id, which is what a pre-v12 session was
reported under) and works internally in ACP terms from there.

LINEAGE is outward for the same reason, and it is the case where the ACP id fails hardest: an
`originSessionId`, a `lineageReplyTo`, a session message's source, a `callAgent` `sessionId`
and a reported `parentSessionId` all name a session to someone who is not its runtime — another
agent, another daemon, the CP. A lineage link written in the runtime's name matches nothing on
the other side: the control plane keys its session rows by the outward id, so a child reporting
an ACP-named parent is a child whose parent "does not exist" — no console lineage, and no
visibility to inherit (session-visibility.md §5.1). The `Session` and `Created by session` lines
of the `# Agent` block carry the same kind of id, so either names a session the console, a status
view or another daemon can find.

What this rules out, in both directions:

- Reporting the ACP id (or anything derived from `sessionKey`, such as a hash of
  it) as the outward identity. `sessionKey` carries platform coordinates —
  channel and thread — which must not leave the daemon, and the ACP id does not
  exist early enough to be minted into a credential.
- Sending the outward id to the runtime as if it were the ACP id when the
  runtime did not adopt it.

The session's `platform` is where the owner agent receives and sends. It may
differ from a target platform operated on by one message. See
[case 3 in section 7.4](#74-case-3-send-from-telegram-to-a-slack-channel-without-mentioning-another-agent).

---

## 2. Two orthogonal metadata dimensions on session messages

Every session message carries two independent classifications:
**source metadata**, describing where it came from or goes, and
**content type**, describing its form.

### 2.1 Source metadata: identity and direction

```ts
{
  type: 'system' | 'agent' | 'human',
  from?: 'agentA' | 'humanXXX',   // Sender; system input also identifies its trigger
  platform?: 'slack' | 'telegram' // Associated platform, when relevant
}
```

`type` also encodes **direction**, which is the central rule:

| `type`   | Direction      | Meaning                                                                                |
| -------- | -------------- | -------------------------------------------------------------------------------------- |
| `system` | **to agent**   | System input for the owner: system prompt, agent-to-agent delivery, or reply injection |
| `human`  | **to agent**   | Human input for the owner                                                              |
| `agent`  | **from agent** | Output from the owner: text, tool use, or reasoning                                    |

Therefore:

- `system` and `human` are inbound to the agent.
- `agent` is outbound from the agent, and `from` always equals the owner.

Prompt assembly surfaces `from` to the owner: a human trigger is delivered as
`[<sender id>] <text>` — the same shape as thread-context and quoted-source
lines — so the agent always knows who is speaking and never has to guess the
sender from ambient account context. Synthetic (cron/hook) triggers stay bare,
and an agent-to-agent delivery already names its caller in the forwarded text.

A `human` turn may also enter a platform session via the **console ingress**
(webchat-cross-integration-continuation.md): it carries the same source
metadata shape, is attributed to the console user, and is mirrored to the
origin thread before dispatch so both projections stay honest.

An outbound `agent` message does **not** necessarily reach an IM platform. The
session's output mode, `none < minimal < low < medium < high`, decides whether
owner output is delivered to Slack, Telegram, or another platform. Regardless
of delivery, the complete output remains in the session and audit view. At the
extreme `none` mode, full responses are recorded without sending any IM text,
typing, or status. The session is the complete truth; IM is one projection.

### 2.2 Content type: message form

Independent of source `type`, content has a shape:

```text
type: 'text' | 'tool' | 'reasoning' | 'plan' | ...
```

- `text` is a text segment.
- `tool` is a tool call and its result. Agent-to-agent communication,
  cross-platform sending, and replying to a session message all use the one
  `sendMessage` tool.
- `reasoning` is reasoning work.
- `plan` is the turn's task list. An ACP plan update carries the whole list
  every time, so this is the one shape that is a SNAPSHOT rather than an
  append: a turn holds exactly one plan row, rewritten in place as the agent
  revises it, keeping the position it took when first published.
- More shapes may be added.

A source message with `{ type: agent }` may contain text or a tool call. The
dimensions combine independently.

### 2.3 Standing metadata injected when a session starts

At session start, the daemon injects standing location metadata into the first
`{ type: system }` message. Existing code already builds this block as
`agentMeta` in `session-manager.ts:312`: Markdown beginning with `# Agent` and
one `- Key: value` per line. Claude receives it through `_meta.systemPrompt`.
Runtimes advertising AIR `customInstructions` receive it through
`_meta.jetbrains.air.customInstructions`; Codex maps this to native developer
instructions. Other runtimes receive standing context inline as the first prompt
block. Incoming messages and repository content remain in the user prompt; they
are not promoted to standing instructions.

The daemon sends the native form again on `session/load`, but only Claude
applies it there (`AcpHost.appliesSystemPromptOnLoad()`). Codex applies
developer instructions only when a thread starts and keeps the copy in its
history, and an inline runtime keeps the block in its first prompt. So each
session row records a digest of the standing context its model last received:
at `session/new` on the native channel, on a load that applies it, and when the
runtime answers a prompt that carried it inline (`sessions.standingDigest`,
local store v50). ACP acknowledges a prompt only with its response, so that
response, whatever its stop reason, is the delivery point; a new inline session
holds none until its opening prompt is answered. On the first prompt after a
`session/load` on any other runtime, the daemon builds the current standing
context; if its digest differs, that prompt carries it as a block whose first
line says it replaces the earlier standing instructions. Until a prompt carrying
it is answered the refresh stays due, so a turn paused, cancelled or rejected
before its prompt reaches the runtime hands it to the next prompt. A row
without a digest counts as changed. The digest covers the standing context
alone, not the memory catalog appended beside it on the native channel, and
leaves out the `Session` line, which the turn that opens a session does not have
yet. General standing-context changes take effect on the next resume.

Before each turn, the daemon compares an in-memory fingerprint of the effective
tool descriptors, configured MCP servers, and daemon-owned task instructions.
Object key order and tool/server list order do not change the fingerprint;
connection tokens, clocks, and release versions are excluded. An unchanged
fingerprint leaves the runtime session, MCP registration, and prompt prefix
untouched. No filesystem or network lookup is needed for this comparison.

A changed fingerprint closes and loads only that runtime session before its next
quiescent turn, installing the current tool list while preserving native history.
Live SDK background tasks or completion wakes defer the refresh and retain the old
fingerprint for a later turn. Relay capability advertisements survive disconnects,
so temporary relay unavailability does not invalidate the tool list. If
close/load is unavailable or fails, the existing recreation path restores
the conversation from its transcript. Organization research rules are standing
instructions in this comparison, so rerunning an existing task receives current
rules without repeating them on unchanged turns. The fingerprint belongs to the
host's attachment: a cold resume always assembles the current tools.

Installing the current tools is not enough on its own: a runtime may render the
definitions a session's transcript recorded when that session started, and add
only tools with new names, so a load keeps an earlier description or argument
schema of a tool it already has. A runtime declares this as
`keepsSessionToolDefinitions` in its runtime definition; without a declaration
the audited runtimes' default applies. The session row records a digest of each
daemon tool's description and argument schema that its model received. A new
session records the definitions it started with. Before a later turn, once the
session's bridge serves the current tools, a digest that differs on a runtime
that keeps definitions puts the current definitions of the changed and added
tools, and the names of removed ones, at the head of that turn's prompt. A row
without digests, from before they were recorded, gets every current definition
once. The digests are recorded when the runtime takes that prompt, so a rejected
prompt leaves the note due. On a runtime that lists the current tools on load,
the row records the current digests and the prompt carries no note.

Current fields identify the agent and source:

```text
# Agent
- Name: <agent name>
- ID: <agent id>                         # agent.id
- Source: <platform>                     # Platform where this session lives; session-manager.ts:316
- Channel: <channel id>
- Channel name: <resolved channel name>  # Optional
<agent description...>
```

Add three fields so the owner knows the thread, this session's identifier, and
its origin:

```text
- Thread: <current thread id>             # thread segment from sessionKey; session-manager.ts:216
- Session: <this session id>              # acpSessionId, when available
- Created by session: <origin session id> # Only for a session woken by sendMessage; a record, not a reply address
```

- **`Thread`** is the current session's platform thread:
  `msg.thread ?? msg.msgId`.
- **`Session`** is its runtime `acpSessionId`. It is conditional because
  `agentMeta` is assembled before `host.newSession(...)`
  (`session-manager.ts:312` versus `session-manager.ts:411`), while a new
  `acpSessionId` is returned only by that call. A resumed session can include it
  reliably.
- **`Created by session`** is the **origin session's ID**, described in section 5.1.
  It appears only when `sendMessage` created or woke this session, as in cases
  2, 3, and 3b. A human-created root session has no line. `CallMeta.originSessionId`
  carries it into the daemon, which renders this line.

The line is a record only. A session replies by answering a message it received, by that
message's id (send-message-guide.md §9.6); it never submits this id as a reply address.

---

## 3. `sendMessage`: one sending tool

**One tool handles every outbound send.** Before consolidation,
`sendPlatformMessage` posted to a channel and `messageAgent` woke another agent.
After consolidation:

```ts
sendMessage({ action, message, ...arguments }): Receipt
// action: 'callAgent' | 'delegateTask' | 'messageTask' | 'replyToSession' | 'postMessage'
```

Every call names its `action`, and the daemon validates the action's arguments before any
effect ([send-message-guide.md](send-message-guide.md) §3). `callAgent` wakes a peer agent, or
the caller itself into a channel, and `postMessage` reaches one or more humans or a channel: the
**two addressing modes** below, `toAgent` and `toUser`, each with **two delivery forms**
selected by the presence of `channel` (direct / channel root), plus a bare `channel`-only post
(no recipient). The session-addressed actions are in section 3.2: `delegateTask` and
`messageTask` for the session's delegated tasks, `replyToSession` to answer a session message by its
id, and `callAgent` with `sessionId` for an existing peer session.

The only visible in-thread form is the **update**: a bare `channel` post carrying
`thread`, which places a message in an existing conversation the agent is NOT answering
(send-message-routing-rework.md §2.4). To address an agent or a human in the thread the
agent is already in, it writes an ordinary turn reply containing the platform-native
`@mention`; that reply already carries the right coordinates, streaming lifecycle, and
sender identity, so a second sending path into the same thread would compete with it.
See [send-message-routing-rework.md](send-message-routing-rework.md) §2.

### 3.1 AgentTarget / UserTarget: who to reach, and in which form

```ts
// Mode 1 — action: 'callAgent', wake one AgentConnect peer (or yourself, with channel).
type AgentTarget = {
  toAgent: string | { agentId: string; needsReply?: boolean } // object form: see section 5.4
  channel?: string // absent ⇒ direct (postless wake, peers only); present ⇒ channel-root post + wake
}

// Mode 2 — action: 'postMessage', reach human platform members.
type UserTarget = {
  toUser: string | string[]  // one member id; the channel-root form also accepts a non-empty unique-id array
  platform?: 'slack' | 'telegram' | 'discord' | 'feishu' | ... // dm defaults to Slack; channel form defaults to current session
  channel?: string           // absent ⇒ dm (Slack DM); present ⇒ channel-root post
  integrationId?: string     // pick a specific bot when the agent has several on the platform
}

// Bare post — action: 'postMessage', publish a visible message without waking an agent or addressing a human,
// at the channel root or, with `thread`, as an update inside an existing conversation.
type ChannelTarget = {
  channel: string            // the channel ROOT unless `thread` names a conversation in it
  thread?: string            // an EXISTING thread's root id — the update form (§2.4)
  platform?: 'slack' | 'telegram' | 'discord' | 'feishu' | ... // defaults to current session
  integrationId?: string
}
```

Exactly one target key is required: `toAgent`, `toUser`, or `channel`. For the two
recipient modes the form is decided by the presence of `channel`:

| Mode             | direct                                                                               | channel root                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `toAgent`        | `{"action":"callAgent","toAgent":"A","message":"…"}` — postless wake, nothing posted | `{"action":"callAgent","toAgent":"A","channel":"C","message":"…"}` — visible root post that @-mentions A, plus the wake   |
| `toUser`         | `{"action":"postMessage","toUser":"U","message":"…"}` — Slack DM to one person       | `{"action":"postMessage","toUser":["U1","U2"],"channel":"C","message":"…"}` — one root post mentioning all listed users   |
| `channel` (bare) | —                                                                                    | `{"action":"postMessage","channel":"C","message":"…"}` — root post, no recipient; with `thread`, an update in that thread |

Only the bare `channel` branch accepts `thread`; supplying one on `toAgent`, `toUser`, or a
session-addressed action is rejected rather than silently posted at the root. A `callAgent` with
the caller's own id needs `channel`: work of its own that needs no conversation is a delegated task,
and the refusal gives the exact `delegateTask` call to make instead.

- The target must identify an action: `toAgent`, `toUser`, or `channel`. The
  daemon rejects an empty action and rejects mixing `toAgent` with `toUser` in
  one call. A bare `channel` post is the "no recipient" form — it publishes a
  visible message without waking an agent or @-mentioning anyone.
- Separate `toUser` and `toAgent` make human delivery and agent wake-up
  explicit in the type system. The daemon no longer guesses whether an ID is a
  platform user or an AgentConnect agent. `toAgent` comes from `listAgents`
  (deprecated alias `listChannelAgents`), which lists every peer in the caller's
  organization that the directional call policy admits — a peer need not share a
  channel with the caller, and need not have an IM integration at all. `toUser` is
  one platform member ID, or a non-empty array of unique member ids when `channel`
  is present.
- A `toAgent` wake is authorized by that call policy alone; `channel` is a
  **delivery coordinate**, not an authorization key. It still decides where the
  optional visible post lands and, through the session key, which session the peer
  is woken in — which is why the coordinate itself is validated even though it
  authorizes nothing. A coordinate the routing snapshot records requires the caller
  to be one of its members and is then used verbatim; an **unrecorded** coordinate on
  a persisted IM platform is refused (`not_allowed`) rather than silently becoming a
  session key it could alias; and an unrecorded coordinate on a channel-free platform
  (`webchat` / `dream`) is replaced by the caller-derived `a2a:<callerAgentId>`, so
  every wake from one caller into one peer shares a single pairwise session. See
  [agent-collaboration-implementation.md](agent-collaboration-implementation.md) §2.5.
- Omitting `platform` means Slack for a `toUser` DM (the member id is resolved to
  the app's direct-message conversation before posting) and the current session
  platform otherwise. Cross-platform cases 3 and 3b specify it. The daemon owns
  all bot tokens and selects the connection by platform and, when necessary,
  integration. The model sees no token. This preserves the existing
  `sendPlatformMessage` boundary at `mcp/tools.ts:55-98`.
- The daemon injects the caller agent ID from session context. It is never a
  tool argument, so a caller cannot impersonate another agent or call itself as
  a different identity.
- `toUser` is Slack-only for now: a `toUser` DM accepts one member id, opens or reuses
  the app's real DM conversation, and posts to the returned channel id. The
  channel-root form accepts one id or a non-empty unique-id array and prepends every
  corresponding `<@user>` mention to the single visible post. An array without `channel`
  is rejected rather than interpreted as a group DM. Any other platform is rejected
  before dispatch.
- Every visible send lands at the channel **root**, opening a new conversation there
  (case 2a). That is deliberate: normal owner output already replies in the current
  thread, so an explicit `sendMessage` is for somewhere else. Addressing the current
  thread is the ordinary reply's job, not a coordinate on this tool. This is platform
  placement, distinct from answering a session message with `replyToSession`, which uses
  only `messageId`.
- A `toAgent + channel` post renders the target's exact platform-native mention into the
  visible body, resolved from the daemon's conversation directory (never from model
  text). A target with no address in that conversation still receives its internal wake;
  the post is simply unaddressed.

### 3.2 Session addressing: `sessionId`, `taskId`, and `messageId`

```ts
// action: 'callAgent' — a new message into an existing session of the named peer.
type PeerSessionTarget = { toAgent: AgentRef; sessionId: string } // stable handle from section 1.1
// action: 'delegateTask' takes only `message`; action: 'messageTask' names one of this session's delegated tasks.
type TaskTarget = { taskId: string }
// action: 'replyToSession' — answer a session message this session received.
type ReplyTarget = { messageId: string }
```

- Each injects the message directly into a session without platform or channel;
  the daemon knows where it lives, even across platforms or daemons.
- `callAgent` with `sessionId` reaches an existing peer session only when it resolves
  to the agent named by `toAgent` and the people on the calling turn may read that
  session's conversation (send-message-guide.md §9.2). It is exclusive with `channel`.
- `delegateTask` hands work off as a delegated task of the current session and returns its
  `taskId`; `messageTask` sends that task more work. Only the task's **owning session**, the
  session that delegated it, may message it or stop it with `stopTask`, on any of its turns
  (send-message-guide.md §2.1, §8). A follow-up, taken with `followUp`, belongs to its place
  instead: the place's current long session messages it with `messageTask` and ends it with
  `stopTask`. The read-only `listTasks` tool lists the session's tasks: its delegated tasks and,
  while it is its place's current long session, the place's follow-ups, both with their
  `taskId`, and the approved proposals that report to it.
- `replyToSession` answers one session message by its id, and goes only to the session
  that sent it (section 5). It never names a session.
- An unknown, foreign, or unowned id is refused in words that reveal nothing about other
  sessions; an agent cannot inject into an arbitrary session.

### 3.3 Discrimination and invariants

- The `action` selects the operation and its validator; the daemon never infers the
  operation from which target fields are present, and a call without `action` is
  rejected before any effect.
- A `sendMessage` call is always recorded in the caller's session as a
  `{ type: agent, from: <caller> }` tool message. Its effects--posting an IM,
  waking another agent, or injecting another session--happen in other sessions,
  which each record an inbound `{ type: system, ... }`.

---

## 4. Agent-to-agent communication is `sendMessage` with `toAgent`

Agent-to-agent communication is not a separate mechanism. It is a
`sendMessage` whose `toAgent` names an AgentConnect agent ID.

- The caller session records an outbound `{ type: agent, from: agentA }` tool:
  `sendMessage({toAgent: "agentB", ...}, message)`.
- The call wakes agent B and records an inbound
  `{ type: system, from: agentA }` in B's session. To the receiver, an
  originating agent is a **system source**, not a human.
- Wake-up is independent of a visible IM. `toAgent` alone is silent delegation;
  adding `channel` also leaves a visible `@agentB` message. The double-trigger
  invariant below matters only for the latter.

Direction is symmetrical across two sessions: the caller records outbound
`agent`, the receiver records inbound `system`. One agent-to-agent call leaves
one record in each session.

### 4.1 Critical invariant: `@agentB` must not trigger twice

When an agent-to-agent call renders a real `@agentB` channel message, that
platform event must **not wake B a second time** through B's mention
subscription. Otherwise B receives one explicit delivery and one mention event,
creating duplicate sessions and duplicate work.

The implementation relies on an existing constraint: platform messages emitted
by an AgentConnect-managed agent are not trigger sources. `sender.appId`
identifies and suppresses messages from AgentConnect agent apps; see the
`appId` comment in `normalized.ts` and section 1.2 of
`agent-collaboration-implementation.md`. Explicit agent-to-agent delivery uses
the `dispatch` seam, while mention events from our own agent messages remain
silent.

---

## 5. Replies: session messages and the origin

In cases 2 and 3, one session's `sendMessage` reaches another session. Every such
input, whether a call, a task instruction, a reply, or a task's report, is a
**session message**: it has its own id and trusted metadata naming the session and
agent that sent it. A reply answers one session message, by its id, with
`sendMessage({action: "replyToSession", messageId, message})`. There is no separate
`replyToParentSession` tool, and no reply is addressed to a session. The full contract
is [send-message-guide.md](send-message-guide.md) §9.

### 5.1 Origin session

When session A's call creates session B, B records A as its **origin session**: the
creating agent and session, the kind of message that created it, and when. It is
written once, when B's row is created, and later calls never overwrite it; a session a
person or a schedule created has none. It cannot be derived from B's `sessionKey`,
because B may live in another thread or platform, so the daemon takes it from the
waking call's trusted lineage.

The origin records creation only. The `# Agent` block shows it as `Created by session`,
status views and the console may show it, and it still authorizes `viewSessionStatus`
(section 5.4), but it authorizes no reply, routes no reply, and is no standing reply
address. The creating call is itself a session message, so B answers its creator by
that message's id like any other.

### 5.2 Reply with `sendMessage({action: "replyToSession", messageId, message})`

The operation **does not create a session**. It inserts a system message into
the session that sent the answered message.

- In the replying session, the call is an ordinary
  `{ type: agent, from: <replier> }` tool record.
- Its effect is an insertion into the source session:

  ```text
  { type: system, from: <replier> }: <message>
  ```

  This feeds the reply as **system input** to the source's owner and resumes or
  wakes that existing session, unlike cases 2 and 3, which create a session.

As in agent-to-agent delivery, there is one outbound and one inbound record.
`from` always identifies the replier.

The answered message's record alone decides the reply: the id must name a message
the calling session received, and the reply goes only to that message's source. An
unknown, foreign, or forged id is refused with `message_not_found`, which reveals
nothing about other sessions. A message may be answered more than once, a reply is
itself a session message its recipient can answer in turn, and which message woke the
current turn or which caller came last is never consulted. With one tool, what a
session may answer is represented by the messages it received plus daemon
authorization, not by injecting or omitting a separate reply tool.

### 5.3 Implementation: how a reply finds its source

The source is not discovered later; it is **recorded when the message is admitted**,
from lineage the daemon carries as trusted per-turn `CallMeta`, a daemon-created
structure that is not model-visible prompt content.

1. **Carry the lineage with the call.** When agent A's `sendMessage` reaches B, the
   sending daemon mints the message id from the submission identity, so a transport
   replay keeps it, and dispatches with:

   ```ts
   interface CallMeta {
     callFrom: string // Caller agent ID
     hopCount: number // Agent-call depth for loop limits
     deliveryId: string
     originSessionId?: string // The sending session's outward id: the message's source
     messageId?: string // This session message's id
     messageKind?: SessionMessageKind // call, taskInput, reply, or report
     inReplyTo?: string // For a reply, the message it answers
     needsReply?: boolean // The sender asked for an outcome
   }
   ```

   Across daemons the same fields ride the relay frames; the relay forwards the
   message fields only to a daemon that advertises them (send-message-guide.md §9.8).

2. **Record the message on both sides.** The receiving daemon records the message
   when it admits the input, before the model sees it: its recipient, source session
   and agent, the return route a reply needs, its kind, and whether a reply was
   requested. The sending daemon records what it sent. B's input opens with
   `[Message <id>]` and its source and, when a reply is requested, closes with the
   exact `replyToSession` call; standing context lists the messages B may still answer.
   A task's input names its owning session as the source.
3. **Authorize and route on reply.** When B calls `replyToSession`, the daemon reads
   the record by id, refuses unless its recipient is B, and delivers to the source by
   the recorded return route: a local injection, or over the relay as
   `deliveryKind: "session-reply"` with `lineageReplyTo` and `inReplyTo`. The source's
   daemon admits it only into the session its own sent record names for that id. A
   reply to one of B's own tasks is admitted like `messageTask`.
4. **Preserve boundaries and invariants:**
   - Caller identity comes from daemon session context. `messageId` is a tool
     input but is authorized against the record, so an agent cannot inject
     arbitrary sessions.
   - A root human-created session has no origin and, until another session
     messages it, nothing to answer.
   - Reply injection is another agent call and obeys `hopCount` with
     `MAX_AGENT_CALL_HOPS` at `daemon.ts:3493`. Same-owner loops from cases 2a
     and 3 are bounded by [loop-breaker-design.md](loop-breaker-design.md).
   - The source may already be running. Injection must pass through the
     per-session serialization gate in section 4 of
     `agent-collaboration-implementation.md` to avoid racing its pending turn.
   - The source may live on another daemon. Body delivery uses the relay data
     plane through `routeAgentMsgCrossDaemon` at `daemon.ts:3623`, never the
     Control Plane.

### 5.4 Following the child: `childSessionId`, `viewSessionStatus`, `needsReply`

A wake is admission, not a result: `sendMessage` returns as soon as the child is
admitted, and the child runs its turn in its own time. A parent that delegated
work therefore needs a handle on the child and a way to ask how it is going.

- **The handle.** An admitted peer wake returns `childSessionId` alongside
  `wake` — the child's logical session key, the same value as
  `wake.targetSession`. A `delegateTask` returns the same kind of handle as
  `taskId`. A refused wake opened nothing, so the field is absent
  and `wake.reason` explains why.
- **Polling: `viewSessionStatus`.** The read counterpart of a reply, authorized
  by lineage: a parent may read **down** it, and nobody may reach sideways. The
  tool takes the `childSessionId` (as `sessionId`) or a task's `taskId` and returns
  `{ sessionId, agentId, status, state, updatedAt }`, where `status`
  collapses the section 7.3 lifecycle plus the last turn's outcome:

  | `status`      | When                                                                     |
  | ------------- | ------------------------------------------------------------------------ |
  | `in-progress` | admitted but not yet open, a turn in flight, or no turn has finished yet |
  | `done`        | the last turn ended cleanly                                              |
  | `failed`      | the last turn ended in a problem phase (spawn/ACP failure, loop breaker) |

  Authorization comes from the child's durable `originSessionId`, with an
  in-memory admission-time link covering the window before the child's session
  row exists. Anything else — an unknown id, a sibling, the caller's own
  session — is refused with one indistinguishable error, so a caller cannot
  probe for sessions it may not read. Only the returned logical key is
  addressable: an ACP session id is not accepted, because ACP ids are minted per
  runtime and are not unique across agents. `done` means the child's turn ended,
  not that it reported anything back.

  The answer also carries reply guidance separately from execution status:
  `reply: { requested, state }`, `nextAction`, and a short `message`. Reply state
  distinguishes `awaiting` from `queued-for-parent` (the agent replied and the
  serialized parent session will receive it in its next turn), as well as
  `not-sent`, `failed`, and `unknown`. In particular, a queued reply instructs
  the parent to end its current turn and not retry. This state-specific guidance
  lives in the tool result rather than the always-loaded tool description, so it
  consumes context only when the parent checks that child.

  A turn that is queued, running, or admitted-but-not-yet-started all report
  `in-progress`. That matters for a RE-delegation: until the child picks the new
  wake up, its row still holds the previous turn's outcome, so the daemon fences
  the window by snapshotting the child row's `updatedAt` at admission.

- **Children on another daemon.** A peer wake may be admitted on a different
  daemon, and that child is followable too. Daemons cannot address each other —
  the relay carries message delivery, not queries — so the read goes
  daemon → CP → owning daemon (`session/child-status` → `session/child-status/probe`),
  which is the same bounded-metadata proxy shape the BFF reads use. Authorization
  is **two-sided and neither half suffices**: the CP proves the asking daemon
  actually reported the parent session it claims (a daemon cannot name someone
  else's parent), and the owning daemon re-checks the real lineage rule against
  the child's `originSessionId`, because that rule belongs where the session
  lives. An unreachable owning daemon or a disconnected CP is reported as a
  retryable transport failure, never as "not your child" — the two must stay
  distinguishable to the agent.

  The handle itself must come from the owning daemon. A session key includes a
  transport scope derived from the reply integration the **relay** chose, which
  the calling daemon never sees — so the target returns the canonical child key on
  the admission ACK, and that is the `childSessionId` the agent receives. The
  target also records the lineage before ACKing, so a probe that lands in the
  window before its session row exists is still answered (`starting`) and still
  authorized.

- **A child may have more than one caller.** The same logical session can be
  woken by different sessions over its life. Both the durable first-wins
  `originSessionId` and the most recent waker recorded at admission are authorized
  to read it — denying the second would refuse a caller the child it just started.
  Replies need no such rule: each call is its own message, answered by its id.

- **Push: `toAgent.needsReply`.** Polling tells the caller _that_ the child
  stopped, never _what_ it produced. `needsReply: true` asks for the result
  instead: the daemon carries the flag as trusted `CallMeta` (never in the
  delivered text), and it opens a reply obligation on that one message. The
  message's input closes with the exact `replyToSession` call for its id, and
  standing context lists the messages the child may still answer, open obligations
  first. It travels cross-daemon on the `rd/agentmsg` frames, so a remote child
  takes on the same obligation. The obligation is persisted with the message
  record — it survives resume and later human-triggered turns — and it does
  **not** cascade: a grandchild is obliged only if its own caller asks. Answering
  one message settles only that message's obligation. A task needs no flag: every
  round reports its outcome to the owning session automatically. Prefer this over
  a tight polling loop.

### 5.5 Two reply shapes

- **Cross-agent reply, cases 2b and 3b:** child owner B inserts
  `{ type: system, from: agentB }` into the session of agent A that sent the
  answered message. This is the worker-to-main result collection path from
  section 3 of `agent-collaboration-implementation.md`.
- **Same-agent reply:** a session A opened with a self `callAgent` into a
  channel, or a task of A's session, inserts `{ type: system, from: agentA }`
  into A's older session. This creates a self-loop whose stopping rule belongs to
  [loop-breaker-design.md](loop-breaker-design.md). A session initialized by a
  bare post (cases 2a and 3) received no session message, so it has nothing to
  answer.

---

## 6. Complete picture

```text
             +---------------- session A (owner: agentA) ----------------+
  inbound -> | {type: system}                  system prompt              |
  to A       | {type: human, from: humanA}     @agentA request            |
             |                                                            |
  A output ->| {type: agent, from: agentA}     text: "..."                |
             | {type: agent, from: agentA}                                |
             |   tool: sendMessage({action:"callAgent",                   |
             |                      toAgent:"agentB", ...})               |-- A2A call
             +------------------------------------------------^-----------+
                    | message m1, source A;                   | reply to m1
                    | creates B, B.origin = A                 | inserts system from B
                    v                                         |
             +---------------- session B (owner: agentB) -----+-----------+
  inbound -> | {type: system, from: agentA}     [Message m1] request      |
  B output ->| {type: agent, from: agentB}                                |
             |   tool: sendMessage({action:"replyToSession",              |
             |                      messageId:"m1", ...})                 |-- reply
             +------------------------------------------------------------+
```

---

## 7. Case walkthrough

Notation is `{type: ..., from: ...}: <content>`. Session separators are shown
explicitly. `sendMessage` arguments are shortened to `{...}, msg="..."`.

### 7.1 Case 1: ordinary human message

A system prompt starts the session, followed by a human mention:

```text
--- session 1 started ---            (owner: agentA)
{type: system}:                      (system prompt)
                                     # Agent ... - Thread: T1 - Session: S1
                                     # No "Created by session" line
{type: human, from: humanA}:         @agentA Please handle this.
```

Both messages are inbound to agent A. Session 1 is a root, so it has no origin,
and having received no session message it has nothing to answer with
`replyToSession`.

### 7.2 Case 2a: post to a channel without mentioning another agent

Agent A calls `sendMessage` with action `postMessage` and only `channel`, no `toUser` or `toAgent`.
This is a plain channel post. It initializes a new idle session owned by A,
keyed by the returned platform message id, but does **not** run a model turn.
The post is A's own output rather than a new request, so activating on it would
allow `sendMessage` to recursively create more roots.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       {action: "postMessage", channel: "#channel"},
                                       msg="Please review this.")

--- session 2 initialized ---        (owner: agentA; origin: session 1; idle)
{type: agent, from: agentA}:         Please review this.  (recorded, not prompted)

  ... a human replies in the new thread ...

--- session 2 first turn ---
{type: context, from: agentA}:       Please review this.
{type: human, from: humanA}:         Here are the details.
```

Session 1 records A's outbound tool, while session 2 records the root for
transcript display and replays it as context with the first real reply. Session
initialization performs no prompt, tools, memory recall/capture, evaluation turn,
or usage accounting. Session 2 records session 1 as its origin, but a post is not
a session message, so session 2 has no message from session 1 to answer.

A bot's first-run welcome that roots a thread, in a conversation the agent is
enabled in, seeds the same idle session with no origin, so a reply under the
welcome reaches the agent without a mention.

### 7.3 Case 2b: post to a channel and mention another agent

Set `toAgent` to B's AgentConnect ID and include `channel` for a visible mention.
This wakes a new session owned by B.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       {action: "callAgent", toAgent: "agentB", channel: "#channel"},
                                       msg="Please investigate this.")

--- session 2 created ---            (owner: agentB; origin: session 1)
{type: system}:                      (system prompt)
                                     # Agent ... - Thread: T2 - Session: S2
                                     # Created by session: S1
{type: system, from: agentA}:        [Message m1] @agentB Please investigate this.

  ... agentB finishes and answers message m1 ...
{type: agent, from: agentB}:         tool: sendMessage(
                                       {action: "replyToSession", messageId: "m1"},
                                       msg="Done. Here is the result.")

--- session 1 continued ---          (owner: agentA)
{type: system, from: agentB}:        Done. Here is the result.
```

- Agent A is a **system source**, not a human, for B.
- The visible `@agentB` platform event and A's internal wake are **two observations of
  one delivery**, not two deliveries: they meet at a durable activation rendezvous keyed
  by the visible post, so B is admitted exactly once whichever arrives first. The
  internal wake is the authority — it alone carries lineage, `needsReply`,
  hop depth, and the privacy gate — so a platform observation whose wake never arrives is
  recorded as a delivery failure rather than becoming a lineage-less B session. See
  [send-message-routing-rework.md](send-message-routing-rework.md) §3.2 / §8.6.
- B's reply to m1 inserts into session 1, which sent it, without creating a
  session, and the resumed turn is **session-only**: it produces no automatic IM
  output (§7 of the routing rework).

### 7.3b Case 2c: wake another agent without posting any IM

Set only `toAgent`, with no `channel`. B wakes, but nothing is posted. This
suits delegation that should not interrupt a channel.

Postless behavior applies only when `channel` is absent. If both `toAgent` and
`channel` are present, the daemon first creates a visible ROOT post — carrying B's
rendered mention — and then anchors B's session to that post's own timestamp. The
visible request and B's replies therefore share one thread. This path does not use case
2a's `spawnChannelRootSession`, whose root session belongs to the caller; the thread
belongs to B. The `sendMessage` handler in `mcp/ops.ts` posts A's message before waking
B, because the anchor is the post's timestamp and that exists only after the send.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       {action: "callAgent", toAgent: "agentB"},
                                       msg="Run X and report back.")

--- session 2 created ---            (owner: agentB; origin: session 1)
{type: system}:                      (system prompt)
                                     # Agent ... - Session: S2
                                     # Created by session: S1
                                     # No Thread because there is no channel
{type: system, from: agentA}:        [Message m1] Run X and report back.
```

There is no double-trigger risk because no platform mention exists. B replies
with `replyToSession` on message m1 exactly as in case 2b. A postless `callAgent`
accepts only a peer: work A does itself without a conversation is a delegated task
(`delegateTask`), not a self-call.

### 7.4 Case 3: send from Telegram to a Slack channel without mentioning another agent

A's session lives on Telegram, but `sendMessage` targets Slack:

```text
--- session 1 ---                    (platform: telegram, owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       {action: "postMessage", platform: slack, channel: "#channel"},
                                       msg="Please review this.")

--- session 2 initialized ---        (platform: slack, owner: agentA; origin: session 1; idle)
{type: agent, from: agentA}:         Please review this.  (recorded, not prompted)
```

The session platform, Telegram, is where it lives; `platform: slack` is the
platform this tool invocation operates. Cross-platform sending does not change
the caller session's platform. Initialization and first-reply replay match case 2a.

### 7.5 Case 3b: send from Telegram to Slack and mention another agent

This combines cross-platform and cross-agent delivery. A calls from a Telegram
session with `platform: slack` and `toAgent: "agentB"`, posting to Slack and
waking B in a Slack session.

```text
--- session 1 ---                    (platform: telegram, owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       {action: "callAgent", toAgent: "agentB", platform: slack, channel: "#channel"},
                                       msg="Please investigate this.")

--- session 2 created ---            (platform: slack, owner: agentB; origin: session 1)
{type: system, from: agentA}:        [Message m1] @agentB Please investigate this.

  ... agentB finishes ...
{type: agent, from: agentB}:         tool: sendMessage(
                                       {action: "replyToSession", messageId: "m1"},
                                       msg="Done. Here is the result.")

--- session 1 continued ---          (platform: telegram, owner: agentA)
{type: system, from: agentB}:        Done. Here is the result.
```

- Session 1 lives on Telegram; session 2 lives on Slack. Agent-to-agent delivery
  naturally crosses platforms.
- The real Slack `@agentB` event must not trigger B twice.
- The reply returns across platforms without specifying platform or
  channel. The daemon resolves session 1 from m1's record and inserts system
  input from B into the Telegram-side session.

---

## 8. Invariant summary for review and tests

1. **Unique owner:** exactly one agent owns a session, and every
   `type: agent` message has `from == owner`.
2. **Source type determines direction:** `system` and `human` are inbound;
   `agent` is outbound.
3. **The session is complete truth:** output mode decides whether outbound
   agent messages reach IM, but every message remains in the session.
4. **One sending tool:** `sendMessage` combines `sendPlatformMessage` and
   `messageAgent`. Agent-to-agent calls, tasks, cross-platform posts, and
   replies all use it, each selected by a required `action`. Platform and
   channel control IM while `toUser` and `toAgent` control mention and
   wake-up; `sessionId`, `taskId`, and `messageId` address an existing peer
   session, one of the session's own tasks, and a received session message.
5. **Visible post and wake-up are independent:** `toAgent` wakes; `channel`
   controls whether an IM is visible. `toAgent` alone is silent. The caller
   records an outbound agent tool, and the receiver records inbound system input
   from the caller.
6. **Replies are addressed to messages:** every input one session sends
   another is a session message with an id and a recorded source.
   `replyToSession` with that `messageId` inserts system input from the replier
   into the message's source session, without creating a session, even across
   platforms. It never reads the origin, which records creation only.
7. **Startup metadata:** the `# Agent` system-prompt block includes `Thread` and
   `Session` when available. It includes `Created by session`, equal to the
   origin ID, if and only if the session has an origin; the line is a record,
   not a reply address.
8. **Caller identity cannot be forged, and every target is authorized:** the
   daemon injects the caller ID and validates every target ID. A reply goes
   only to the source of a message the session received, a task message only
   to a task the session owns, and a peer-session call only where the calling
   turn's people may read.
9. **No double trigger:** when an agent-to-agent call with `channel` leaves a
   real `@agentB` message, that platform event cannot create a second session
   for an AgentConnect-managed agent. Silent delegation has no such event.
10. **Session platform differs from target platform:** a session's platform is
    where it lives. `sendMessage.platform` may differ, and the two sides of
    agent-to-agent delivery may live on different platforms.
11. **Lineage is readable in exactly one direction:** an admitted wake returns
    the child's `childSessionId` (a task's is its `taskId`), and
    `viewSessionStatus` accepts only a session whose parent is the calling
    session. Unknown and unauthorized ids are indistinguishable. `status: done`
    means the child's turn ended, not that it reported back —
    `toAgent.needsReply` is what obliges it to report, as an obligation on that
    message, never as delivered message text.
