# Session Concept

**Status:** Current design

> This document does one thing: define **session** precisely--what it is, what
> it contains, how messages record source and destination, how agent-to-agent
> communication and cross-platform sends enter sessions, and how **replies**
> flow back across sessions.
>
> **All sending uses one `sendMessage` tool.** It combines the existing
> `sendPlatformMessage`, which posts to a platform channel or user at
> `mcp/tools.ts:65`, with `messageAgent`, which wakes another agent at
> `mcp/tools.ts:409`. Agent-to-agent calls,
> cross-platform messages, and replies to a parent session all use
> `sendMessage`; see section 3.
>
> This terminology is shared by
> [agent-collaboration-implementation.md](agent-collaboration-implementation.md),
> which implements delivery and orchestration,
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
  contains `acpSessionId` created by `host.newSession(...)`. The
  `SessionTarget.sessionId` used by `sendMessage` is this stable handle; it is
  also the value shown on the `Session` line of the `# Agent` block in section
  2.3. A model treats it as opaque.

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

An outbound `agent` message does **not** necessarily reach an IM platform. The
session's output mode, `none < minimal < low < medium < high`, decides whether
owner output is delivered to Slack, Telegram, or another platform. Regardless
of delivery, the complete output remains in the session and audit view. At the
extreme `none` mode, full responses are recorded without sending any IM text,
typing, or status. The session is the complete truth; IM is one projection.

### 2.2 Content type: message form

Independent of source `type`, content has a shape:

```text
type: 'text' | 'tool' | 'reasoning' | ...
```

- `text` is a text segment.
- `tool` is a tool call and its result. Agent-to-agent communication,
  cross-platform sending, and replying to a parent all use the one
  `sendMessage` tool.
- `reasoning` is reasoning work.
- More shapes may be added.

A source message with `{ type: agent }` may contain text or a tool call. The
dimensions combine independently.

### 2.3 Standing metadata injected when a session starts

At session start, the daemon injects standing location metadata into the first
`{ type: system }` message. Existing code already builds this block as
`agentMeta` in `session-manager.ts:312`: Markdown beginning with `# Agent` and
one `- Key: value` per line. Claude receives it through `_meta.systemPrompt`;
other runtimes receive it inline as the first system block.

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
- Parent session: <origin session id>     # Only for a session woken by sendMessage
```

- **`Thread`** is the current session's platform thread:
  `msg.thread ?? msg.msgId`.
- **`Session`** is its runtime `acpSessionId`. It is conditional because
  `agentMeta` is assembled before `host.newSession(...)`
  (`session-manager.ts:312` versus `session-manager.ts:411`), while a new
  `acpSessionId` is returned only by that call. A resumed session can include it
  reliably.
- **`Parent session`** is the **origin session's ID**, described in section 5.1.
  It appears only when `sendMessage` created or woke this session, as in cases
  2, 3, and 3b. A human-created root session has no line. This is exactly the
  `SessionTarget.sessionId` the owner uses to reply. `CallMeta.originSessionId`
  carries it into the daemon, which renders this line.

In other words, a session has a replyable parent exactly when its `# Agent`
block contains `Parent session`. The agent submits that opaque value as a
SessionTarget, and the daemon still authorizes the write.

---

## 3. `sendMessage`: one sending tool

**One tool handles every outbound send.** Before consolidation,
`sendPlatformMessage` posted to a channel and `messageAgent` woke another agent.
After consolidation:

```ts
sendMessage(to: MessageTarget | SessionTarget, message: string): void
```

`to` is a discriminated union addressed either by platform coordinates or by
session.

### 3.1 MessageTarget: platform-coordinate addressing

```ts
type MessageTarget = {
  platform?: 'slack' | 'telegram' | 'discord' | 'feishu' | ... // Defaults to current session; narrowed to installed platforms
  channel?: string   // Channel ID or name; omitted means no visible channel post
  toUser?: string    // Platform user ID to mention or direct-message
  // AgentConnect agent ID to wake. The object form adds delivery options; see section 5.4.
  toAgent?: string | { agentId: string; needsReply?: boolean }
  thread?: string    // Existing thread in which the receiver should reply
}
```

Every field is optional. Two orthogonal decisions use different fields:

1. `channel` and optional `platform` decide whether and where to post a visible
   IM message.
2. `toAgent` decides which agent to wake; `toUser` decides which human to
   mention or message.

| Combination                             | Meaning                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Only `toAgent`**, no channel          | **Wake an agent without posting any IM.** One agent delegates work to another without channel noise. |
| `channel` + `toAgent`                   | Wake another agent **and** post a visible mention in the channel, as in cases 2b and 3b.             |
| `channel` without `toUser` or `toAgent` | Post to the channel without mentioning anyone, as in cases 2a and 3.                                 |
| `channel` + `toUser`                    | Post and mention or direct-message a **human**, without waking an agent.                             |

- The target must identify something actionable: either a `channel` to post to
  or a `toAgent` to wake. The daemon rejects an empty action.
- Separate `toUser` and `toAgent` make human delivery and agent wake-up
  explicit in the type system. The daemon no longer guesses whether an ID is a
  platform user or an AgentConnect agent. `toAgent` comes from
  `listChannelAgents`; `toUser` is a platform member ID.
- Omitting `platform` means the current session platform. Cross-platform cases
  3 and 3b specify it. The daemon owns all bot tokens and selects the connection
  by platform and, when necessary, integration. The model sees no token.
  This preserves the existing `sendPlatformMessage` boundary at
  `mcp/tools.ts:55-98`.
- The daemon injects the caller agent ID from session context. It is never a
  tool argument, so a caller cannot impersonate another agent or call itself as
  a different identity.
- `thread` determines the platform thread only when `channel` is present.
  Passing an existing thread posts there. Omitting it or passing `""` posts a
  new top-level channel message, **not the current session thread**. Normal
  owner output already replies in the current thread, so an explicit
  `sendMessage` defaults to a clean top-level post. Posting at the root creates
  a new owner session, as in case 2a; specifying a thread continues the
  corresponding session. This is platform placement, distinct from replying to
  a parent by SessionTarget, which uses only `sessionId`.

### 3.2 SessionTarget: session addressing

```ts
type SessionTarget = {
  sessionId: string // Stable target handle from section 1.1
}
```

- Inject the message directly into that session without platform or channel;
  the daemon knows where it lives, even across platforms or daemons.
- This implements a reply to a parent:
  `sendMessage({ sessionId: <origin> }, message)`.
- The caller may address only a session it may write, such as its origin or a
  visible session. The daemon validates `sessionId`; an agent cannot inject into
  an arbitrary session.

### 3.3 Discrimination and invariants

- If `to` contains `sessionId`, it is a SessionTarget; otherwise it is a
  MessageTarget.
- A `sendMessage` call is always recorded in the caller's session as a
  `{ type: agent, from: <caller> }` tool message. Its effects--posting an IM,
  waking another agent, or injecting another session--happen in other sessions,
  which each record an inbound `{ type: system, ... }`.

---

## 4. Agent-to-agent communication is `sendMessage` with `toAgent`

Agent-to-agent communication is not a separate mechanism. It is a
`sendMessage` whose `toAgent` names an AgentConnect agent ID.

- The caller session records an outbound `{ type: agent, from: agentA }` tool:
  `sendMessage(to={toAgent: "agentB", ...}, message)`.
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

## 5. Replies: origin sessions and SessionTarget

In cases 2 and 3, one session is created by another session's `sendMessage`.
The new session needs a path to return results to its creator. A reply uses
`sendMessage` with a **SessionTarget**. There is no separate
`replyToParentSession` tool.

### 5.1 Origin session

When session A wakes and creates session B, B stores a reference to A: its
**origin session**, also called parent. This lineage edge is the only reliable
way to find the destination of a reply. It cannot be derived from B's
`sessionKey`, because B may live in another thread or platform. Capture it
explicitly at wake-up and carry it through B's turn. It is independent of
channel, thread, platform, and owner equality.

### 5.2 Reply with `sendMessage({ sessionId: <origin> }, message)`

The operation **does not create a session**. It inserts a system message into
the existing origin.

- In the child session, the call is an ordinary
  `{ type: agent, from: <child owner> }` tool record.
- Its effect is an insertion into the origin:

  ```text
  { type: system, from: <child owner> }: <message>
  ```

  This feeds the reply as **system input** to the origin's owner and resumes or
  wakes that existing session, unlike cases 2 and 3, which create a session.

As in agent-to-agent delivery, there is one outbound and one inbound record.
`from` always identifies the child owner that initiated the reply.

A child can reply only when it has the origin `sessionId`. The daemon exposes
`originSessionId` in inbound context only when a session has a parent. A
human-created root session has no origin and receives no ID. The daemon rejects
any SessionTarget the caller is not allowed to write. With one tool, parent
availability is represented by the presence of an origin ID plus daemon
authorization, not by injecting or omitting a separate reply tool.

### 5.3 Implementation: how a reply finds its parent

The parent is not discovered later; it is **captured at wake-up** and carried by
the daemon as trusted per-turn `CallMeta`. Existing `messageAgent` already
implements the same-thread form, and unified `sendMessage` reuses it.

1. **Capture the lineage edge at wake-up.** When agent A calls `sendMessage` to
   wake B, the daemon calls
   `dispatch(toAgentId, msg, integrationId, undefined, callMeta)` at
   `daemon.ts:3608`. `CallMeta`, defined at `daemon.ts:426`, is a daemon-created
   trusted structure and is not model-visible prompt content:

   ```ts
   interface CallMeta {
     callFrom: string // Caller agent ID
     correlationId?: string // N-of-N orchestration correlation
     hopCount: number // Agent-call depth for loop limits
     deliveryId: string
     originSessionId: string // Stable caller session address
   }
   ```

   `originSessionId` is new relative to existing `CallMeta`. Existing
   same-thread `messageAgent` can reuse child coordinates and needs only
   `callFrom`; cases 2, 3, and 3b may place the child in another thread or
   platform, so the parent cannot be inferred and must be addressed directly.

2. **Attach it to the child's turn and expose it to the child.** When B's turn
   starts, the daemon calls
   `this.activeTurnCallMeta.set(key, callMeta)` at `daemon.ts:6303`, where `key`
   is B's logical `sessionKey`, and deletes it at turn end at `daemon.ts:6605`.
   It also writes `originSessionId` as `Parent session` in B's `# Agent`
   system-prompt block at `session-manager.ts:312`. B can then call
   `sendMessage(to={sessionId: <Parent session>})`.
3. **Authorize and inject on reply.** When B calls a SessionTarget, the daemon:
   - Gets `inbound` from `activeTurnCallMeta.get(callerKey)` at
     `daemon.ts:3491`.
   - Verifies that the target is writable by B, such as
     `inbound.originSessionId` or another visible session.
   - When `sessionId === inbound.originSessionId`, automatically inherit
     `correlationId`, matching the existing reply test at
     `daemon.ts:3501-3502`. A main-agent orchestration can correlate results
     without exposing IDs to the agent.
4. **Preserve boundaries and invariants:**
   - Caller identity comes from daemon session context. `sessionId` is a tool
     input but is authorized, so an agent cannot inject arbitrary sessions.
   - A root human-created session has no `callMeta` or origin and is not
     authorized to reply elsewhere.
   - Reply injection is another agent call and obeys `hopCount` with
     `MAX_AGENT_CALL_HOPS` at `daemon.ts:3493`. Same-owner loops from cases 2a
     and 3 are bounded by [loop-breaker-design.md](loop-breaker-design.md).
   - The origin may already be running. Injection must pass through the
     per-session serialization gate in section 4 of
     `agent-collaboration-implementation.md` to avoid racing its pending turn.
   - The origin may live on another daemon. Body delivery uses the relay data
     plane through `routeAgentMsgCrossDaemon` at `daemon.ts:3623`, never the
     Control Plane.

### 5.4 Following the child: `childSessionId`, `viewSessionStatus`, `needsReply`

A wake is admission, not a result: `sendMessage` returns as soon as the child is
admitted, and the child runs its turn in its own time. A parent that delegated
work therefore needs a handle on the child and a way to ask how it is going.

- **The handle.** An admitted peer wake returns `childSessionId` alongside
  `wake` — the child's logical session key, the same value as
  `wake.targetSession`. A refused wake opened nothing, so the field is absent
  and `wake.reason` explains why.
- **Polling: `viewSessionStatus(sessionId)`.** The read counterpart of a
  SessionTarget reply, and authorized as its mirror image: a child may reply
  **up** its lineage, a parent may read **down** it, and neither may reach
  sideways. The tool accepts the `childSessionId` (or the child's stable ACP id)
  and returns `{ sessionId, agentId, status, state, updatedAt }`, where `status`
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

- **Push: `toAgent.needsReply`.** Polling tells the parent _that_ the child
  stopped, never _what_ it produced. `needsReply: true` asks for the result
  instead: the daemon carries the flag as trusted `CallMeta` (never in the
  delivered text) and prompt assembly turns it into a standing directive in the
  child's system-prompt append, naming `originSessionId` as the reply target.
  It travels cross-daemon on the `rd/agentmsg` frames, so a remote child takes on
  the same obligation. The obligation is persisted on the child session and
  therefore sticky — it survives resume and later human-triggered turns — and it
  does **not** cascade: a grandchild is obliged only if its own parent asks.
  Prefer this over a tight polling loop.

  A session may be woken by more than one parent. The directive always names the
  parent **this turn** may actually reply to (the turn's wake origin, which is
  what the SessionTarget authorizer accepts), and is restated as a turn-scoped
  block when the standing context named a previous one — the durable link itself
  stays first-wins.

### 5.5 Two reply shapes

- **Cross-agent reply, cases 2b and 3b:** child owner B inserts
  `{ type: system, from: agentB }` into agent A's origin. This is the
  worker-to-main result collection path from section 3 of
  `agent-collaboration-implementation.md`.
- **Same-agent reply, cases 2a and 3:** child and origin are both owned by A.
  The child inserts `{ type: system, from: agentA }` into A's older session.
  This creates a self-loop whose stopping rule belongs to
  [loop-breaker-design.md](loop-breaker-design.md).

---

## 6. Complete picture

```text
             +---------------- session A (owner: agentA) ----------------+
  inbound -> | {type: system}                  system prompt              |
  to A       | {type: human, from: humanA}     @agentA request            |
             |                                                            |
  A output ->| {type: agent, from: agentA}     text: "..."                |
             | {type: agent, from: agentA}                               |
             |   tool: sendMessage(to={toAgent:"agentB", ...}, ...)       |-- A2A origin
             +-----------------------------------------------^------------+
                    | wake and create, B.origin = A           | SessionTarget A
                    v                                          | inserts system from B
             +---------------- session B (owner: agentB) ------+----------+
  inbound -> | {type: system, from: agentA}     @agentB request           |
  B output ->| {type: agent, from: agentB}                               |
             |   tool: sendMessage(to={sessionId: A}, ...)                |-- reply origin
             +------------------------------------------------------------+
```

---

## 7. Case walkthrough

Notation is `{type: ..., from: ...}: <content>`. Session separators are shown
explicitly. `sendMessage` arguments are shortened to `to={...}, msg="..."`.

### 7.1 Case 1: ordinary human message

A system prompt starts the session, followed by a human mention:

```text
--- session 1 started ---            (owner: agentA)
{type: system}:                      (system prompt)
                                     # Agent ... - Thread: T1 - Session: S1
                                     # No "Parent session" line
{type: human, from: humanA}:         @agentA Please handle this.
```

Both messages are inbound to agent A. Session 1 is a root, so it has no
`Parent session` and nowhere to reply through SessionTarget.

### 7.2 Case 2a: post to a channel without mentioning another agent

Agent A calls `sendMessage` with only `channel`, no `toUser` or `toAgent`.
This is a plain channel post. It wakes a new session owned by A, because the
outbound platform post returns as system input in A's future context.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       to={channel: "#channel"},
                                       msg="Please review this.")

--- session 2 created ---            (owner: agentA; origin: session 1)
{type: system, from: agentA}:        Please review this.
```

Session 1 records A's outbound tool, while session 2 records inbound system
input from A. Session 2 can later reply to session 1 through SessionTarget,
forming a same-agent loop.

### 7.3 Case 2b: post to a channel and mention another agent

Set `toAgent` to B's AgentConnect ID and include `channel` for a visible mention.
This wakes a new session owned by B.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       to={channel: "#channel", toAgent: "agentB"},
                                       msg="Please investigate this.")

--- session 2 created ---            (owner: agentB; origin: session 1)
{type: system}:                      (system prompt)
                                     # Agent ... - Thread: T2 - Session: S2
                                     # Parent session: S1
{type: system, from: agentA}:        @agentB Please investigate this.

  ... agentB finishes and reports using Parent session ...
{type: agent, from: agentB}:         tool: sendMessage(
                                       to={sessionId: S1},
                                       msg="Done. Here is the result.")

--- session 1 continued ---          (owner: agentA)
{type: system, from: agentB}:        Done. Here is the result.
```

- Agent A is a **system source**, not a human, for B.
- The visible `@agentB` platform event must not trigger another B session.
- B's SessionTarget reply inserts into the existing origin without creating a
  session. The daemon inherits `correlationId`.

### 7.3b Case 2c: wake another agent without posting any IM

Set only `toAgent`, with no `channel`. B wakes, but nothing is posted. This is
appropriate for orchestration where delegation should not interrupt a channel.

Postless behavior applies only when `channel` is absent. If both `toAgent` and
`channel` are present, the daemon first creates a visible post and then anchors
B's session to that post's thread. Without `thread`, the root post's own
timestamp becomes the anchor; with `thread`, the existing thread is reused.
The visible request and B's replies therefore share one thread. This path does
not use case 2a's `spawnChannelRootSession`, whose root session belongs to the
caller; the thread belongs to B. The `sendMessage` handler in `mcp/ops.ts`
posts A's message before waking B.

```text
--- session 1 ---                    (owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       to={toAgent: "agentB"},
                                       msg="Run X and report back.")

--- session 2 created ---            (owner: agentB; origin: session 1)
{type: system}:                      (system prompt)
                                     # Agent ... - Session: S2
                                     # Parent session: S1
                                     # No Thread because there is no channel
{type: system, from: agentA}:        Run X and report back.
```

There is no double-trigger risk because no platform mention exists. B replies
through `sendMessage(to={sessionId: S1})` exactly as in case 2b.

### 7.4 Case 3: send from Telegram to a Slack channel without mentioning another agent

A's session lives on Telegram, but `sendMessage` targets Slack:

```text
--- session 1 ---                    (platform: telegram, owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       to={platform: slack, channel: "#channel"},
                                       msg="Please review this.")

--- session 2 created ---            (platform: slack, owner: agentA; origin: session 1)
{type: system, from: agentA}:        Please review this.
```

The session platform, Telegram, is where it lives; `to.platform`, Slack, is the
platform this tool invocation operates. Cross-platform sending does not change
the caller session's platform. Reply behavior matches case 2a.

### 7.5 Case 3b: send from Telegram to Slack and mention another agent

This combines cross-platform and cross-agent delivery. A calls from a Telegram
session with `platform: slack` and `toAgent: "agentB"`, posting to Slack and
waking B in a Slack session.

```text
--- session 1 ---                    (platform: telegram, owner: agentA)
  ...
{type: agent, from: agentA}:         tool: sendMessage(
                                       to={platform: slack, channel: "#channel", toAgent: "agentB"},
                                       msg="Please investigate this.")

--- session 2 created ---            (platform: slack, owner: agentB; origin: session 1)
{type: system, from: agentA}:        @agentB Please investigate this.

  ... agentB finishes ...
{type: agent, from: agentB}:         tool: sendMessage(
                                       to={sessionId: "session 1"},
                                       msg="Done. Here is the result.")

--- session 1 continued ---          (platform: telegram, owner: agentA)
{type: system, from: agentB}:        Done. Here is the result.
```

- Session 1 lives on Telegram; session 2 lives on Slack. Agent-to-agent delivery
  naturally crosses platforms.
- The real Slack `@agentB` event must not trigger B twice.
- SessionTarget returns across platforms without specifying platform or
  channel. The daemon resolves session 1 from its ID and inserts system input
  from B into the Telegram-side session.

---

## 8. Invariant summary for review and tests

1. **Unique owner:** exactly one agent owns a session, and every
   `type: agent` message has `from == owner`.
2. **Source type determines direction:** `system` and `human` are inbound;
   `agent` is outbound.
3. **The session is complete truth:** output mode decides whether outbound
   agent messages reach IM, but every message remains in the session.
4. **One sending tool:** `sendMessage` combines `sendPlatformMessage` and
   `messageAgent`. Agent-to-agent, cross-platform, and parent replies all use
   it. `to` is either a MessageTarget, whose optional platform and channel
   control IM while `toUser` and `toAgent` control mention and wake-up, or a
   SessionTarget with `sessionId`.
5. **Visible post and wake-up are independent:** `toAgent` wakes; `channel`
   controls whether an IM is visible. `toAgent` alone is silent. The caller
   records an outbound agent tool, and the receiver records inbound system input
   from the caller.
6. **Replies use the origin edge:** a session woken by `sendMessage` has an
   origin. `sendMessage(to={sessionId: origin})` inserts system input from the
   child owner into that existing origin without creating a session, even
   across platforms.
7. **Startup metadata:** the `# Agent` system-prompt block includes `Thread` and
   `Session` when available. It includes `Parent session`, equal to the origin
   ID, if and only if a parent exists.
8. **Caller identity cannot be forged, and SessionTarget is authorized:** the
   daemon injects the caller ID and validates every target ID. An agent can
   write only its origin or another visible session.
9. **No double trigger:** when an agent-to-agent call with `channel` leaves a
   real `@agentB` message, that platform event cannot create a second session
   for an AgentConnect-managed agent. Silent delegation has no such event.
10. **Session platform differs from target platform:** a session's platform is
    where it lives. `sendMessage.to.platform` may differ, and the two sides of
    agent-to-agent delivery may live on different platforms.
11. **Lineage is readable in exactly one direction:** an admitted wake returns
    the child's `childSessionId`, and `viewSessionStatus` accepts only a session
    whose parent is the calling session. Unknown and unauthorized ids are
    indistinguishable. `status: done` means the child's turn ended, not that it
    reported back — `toAgent.needsReply` is what obliges it to report, as a
    sticky standing directive on the child, never as delivered message text.
