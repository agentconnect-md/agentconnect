# Slack Native Streaming Turn Output

**Status:** Implemented and shipped (Layer 1 of the Slack-native agent experience; Layer 0 is
merged). The §7.1 shareable-bot carve-out has since been **lifted**: shareable (multi-agent) bots
now stream like the rest, because ingress reads the finalization from `chat.stopStream`'s
stop-time metadata instead of the closing edit it no longer emits (§7.1).

Presentation was revised once after seeing it live: streams open in `plan` display mode rather
than `timeline`, the §5.5 finalization rides `chat.stopStream` instead of a closing `chat.update`
that was erasing the task cards, and the legacy loading row was restored and re-issued so it
coexists with the stream that would otherwise displace it. §4, §3.3 and §5 carry those decisions.

Layer 0 ([#1462](https://github.com/agentconnect-md/agentconnect/pull/1462),
[#1471](https://github.com/agentconnect-md/agentconnect/pull/1471)) adopted Slack's Agent
Sessions control surface: `agents.sessions.setStatus` (`processing` / `active`, deduped per
`channel:thread`), `agents.sessions.rename`, and the native stop button — `agent_session_stopped`
resolved by (channel, thread) into the existing cancel seam, on Socket Mode directly and on HTTP
through a conversation-addressed `RdSlackAction` member.

This document designs the delivery half: replacing the daemon's `chat.postMessage` +
`chat.update` converger cadence with Slack's streaming methods.

## 1. Context: one status slot, last writer wins

Layer 0 left Slack driving **two** status APIs against **one** UI slot:

- `assistant.threads.setStatus` — free text plus `loading_messages`, plus per-message
  `username` / `icon_url`. This is how a shared bot shows _which agent_ is working.
- `agents.sessions.setStatus` — a bare `processing` / `active` enum. No custom text, no
  `loading_messages`. This is what renders the native "Working…" UI and, because the app
  subscribes to `agent_session_stopped`, the native stop button.

Slack bridges the legacy call onto the session (non-empty `status` → `processing`, empty →
`active`), so the two land on the same slot and the **last writer controls the whole
presentation**. There is no partial merge: you get the legacy rendering (custom text, per-agent
authorship, no native UI, no stop button) or the session rendering (native UI and stop button, no
text, no per-agent identity).

`SlackConnection.setStatus` today writes text first, then the enum. But `setSessionLifecycle`
dedupes on `channel:thread`, so only the **first** status write of a turn reaches the enum at all;
every later one is text-only. Net effect in production: text wins, and Layer 0's stop button is
largely invisible.

[#1478](https://github.com/agentconnect-md/agentconnect/pull/1478) (`fix(daemon): set the Slack
session lifecycle before the free-text status`) makes that ordering consistent rather than
accidental. It is a correct fix for the _legacy_ path and does not resolve the tradeoff — nothing
can, while both APIs share one slot. Streaming is the path that yields native UI, native stop, and
per-agent authorship simultaneously, so **#1478 is expected to close as superseded** when this
lands. §7 Q5 covers the fallback-path ordering it would have fixed.

### 1.1 What the API research changed about this design

Two premises from the original framing did not survive the documentation:

- **There is no `message_stream_stopped` to subscribe to.** `docs.slack.dev` has no page for it;
  across the whole platform corpus the name appears only inside one `chat.startStream` error
  string (`not_subscribed_to_message_stream_stopped`), and `is_stoppable` appears only in that
  same sentence. The documented mechanism is
  [`agent_session_stopped`](https://docs.slack.dev/reference/events/agent_session_stopped) — the
  event **Layer 0 already subscribes to and already routes on both transports**. Its payload
  carries `streaming_message_ts`, "the timestamps of your app's in-progress streaming messages
  that Slack stopped in response to the click… an empty array when no stream was active." One
  event, both scopes.
- **The streaming methods own the session lifecycle themselves.**
  [`chat.startStream` creates the session and sets it to `processing`](https://docs.slack.dev/ai/agent-sessions);
  `chat.stopStream` transitions it via `session_status` (default `active`). A streaming turn
  therefore makes **zero** status calls of either kind.

Together these mean Layer 1 needs no new Slack event, no new scope, no manifest change, and no new
wire frame. It is a daemon-local change with a built-in degrade path.

## 2. Goals / Non-goals

**Goals**

1. Agent output appears in Slack as a native streaming message, with the native processing UI and
   the native in-message stop control, **without** losing custom progress narration or per-agent
   authorship on a shared bot.
2. Retire the daemon's post-once/`chat.update`-thereafter cadence for the agent's answer.
3. Degrade to today's pipeline, byte-identically, wherever streaming is unavailable — detected
   from Slack's own errors, with no configuration knob.
4. Change nothing about Layer 0's stop seam, the transcript, §5.5 response routing, the session
   status bar, permission/elicitation cards, or attachments.

**Non-goals**

- Other platforms. Telegram, Discord and Feishu convergers and appliers are untouched. (Feishu's
  CardKit streaming is the structural precedent this design copies, not a thing it changes.)
- Webchat, the Control Plane, and message normalization. Streaming is egress only.
- Slack's feedback-buttons block. `chat.stopStream` accepts one, but AgentConnect has no feedback
  sink; adding one is a separate product decision.
- `agent_session_title_changed` handling. Still subscribed-but-inert, as Layer 0 left it.

## 3. Pipeline

### 3.1 Where the seam is

The seam is the one Feishu already established for CardKit, reused verbatim:

| Layer             | Feishu (shipped)                                                     | Slack (this design)                                                       |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Converger IR      | `card-start` / `card-stream` / `card-final` / `card-cancel`          | `stream-start` / `stream-append` / `stream-stop`                          |
| Converger members | `onStart()`, `hasStreamingUpdate()`, `streamUpdate()`, `onFailure()` | same three plus the existing `flushTerminal()`                            |
| Daemon timer      | `armFeishuStream(p)`                                                 | `armSlackStream(p)`                                                       |
| Applier           | `applyFeishuAction` resolves against `startStreamingCard` / …        | `applySlackAction` resolves against `startTurnStream` / …                 |
| Connection        | `FeishuConnection.startStreamingCard` etc.                           | `SlackConnection.startTurnStream` / `appendTurnStream` / `stopTurnStream` |

No new mechanism is introduced. `OutputConverger` gains a `streaming` axis alongside the existing
`mode` axis, and emits the `stream-*` actions instead of `post` / `live-reply` /
`final-live-reply` / `progress` when it is set. Every other action it emits is unchanged.

**Deciding the axis.** `createConverger(ctx)` runs before `openTurnChrome`, and `startTurnStream`
is async, so the converger is built **optimistically** from a synchronous latch read
(`conn.streamingLikely()`, §6) and `openTurnChrome` either records the opened stream on
`SlackTurnState` or calls a one-way `conv.disableStreaming()`. That is safe because
`openTurnChrome` is already documented to run before `host.prompt` can emit its first chunk — the
demotion happens while there is provably no output yet.

### 3.2 What stays

Everything that is _chrome around the answer_ rather than the answer:

- **Session status bar** (`status-bar` / `clear-status-bar`) — still its own message, still posted
  before the stream opens so it stays above.
- **Permission and elicitation cards**, and their resolved replacements — separate messages,
  unchanged.
- **Tool-output code blocks** (`high` mode) — separate messages. A `task_update` chunk caps at 256
  characters; verbatim command output does not belong there.
- **Attachments** (`uploadFile` / `shareFile`) — unchanged.
- **Notices** and the `⚠️ Agent failed to respond` line — see §5.
- **Transcript.** The paired `recordOnly` posts and `appendTranscript` rows are emitted exactly as
  today. The stream is display; the transcript is the record.
- **Permalinks** (`workspaceUrl`), thread coordinates, `protectedAddresses` splitting.
- **§5.5 response finalization** — but **carried by the stop, not by a follow-up edit.** See
  below; this is the one item in this list that streaming genuinely changes.

### 3.3 The attribution footer gets simpler

`chat.stopStream` accepts a `blocks` array "rendered at the bottom of the finalized message", and
[unfurling is disabled in streaming messages](https://docs.slack.dev/ai/developing-agents) — which
is exactly what the current path spends a `unfurl_links: false` post boundary to achieve.

So a stream is **born without a footer and gains it exactly once, at stop**. The
`staleReplyFooters` retry machinery is not needed on the streaming path: there is never a moment
where two messages carry a footer. It stays for the fallback path, and `onSettle` keeps its retry.

This satisfies
[`product-conventions.md` §"Slack message attribution footer"](../product-conventions.md) — the
footer is attached to the final message of the response and is never a separate message.

**And §5.5's finalization rides the same stop.** The original plan kept the closing `chat.update`
on the streamed message, carrying `delivery_state: 'final'` and the resolved recipient set. That
turned out to be the single most destructive call in the pipeline: `chat.update` **replaces** a
message's whole content, so it wiped every task card the turn had rendered and left the answer
marked "(edited)". `chat.stopStream` takes both of the things that edit was for — `blocks`, which
are appended below everything already streamed rather than replacing it, and `metadata` — so the
final delivery state is stamped at stop time and no edit is issued at all. The samples corroborate
the shape: none of them calls `chat.update` on a streamed message.

**Why this was safe to do, and what the carve-out lift owed.** Nothing reads the finalization
event except agent-to-agent routing, and A2A happens only on shareable bots — which §7.1 kept
off the streaming path while it existed. So no consumer could miss it. That made it a
**prerequisite of lifting the carve-out**, not an afterthought: before a shareable bot could
stream, relay and Socket Mode ingress had to first recognise the finalization from stop-time
metadata, since the `message_changed` edit they keyed on is no longer emitted. Both are now done
— `normalizeSlackResponseFinalization` recognises a `final` claim whether it arrives on a
`message_changed` edit (legacy) or at the top level of a stop-time event (streamed), so the
carve-out is lifted (§7.1).

### 3.4 Length and continuation

`markdown_text` is documented as ≤ 12,000 characters **per call**; no total per-message cap is
documented. Rather than guess, the design **preserves today's observable behavior**: cap the
accumulated stream at `SLACK_MARKDOWN_BLOCK_LIMIT` (12,000, the constant the current splitter
already uses) and roll over.

A rollover is `stopTurnStream` then `startTurnStream`, two separate `PlatformSendQueue` enqueues
from the applier — never one nested pair. Section boundaries come from the existing
`splitIntoSections(text, undefined, protectedAddresses)`, so a compound shared-bot mention is
never cut in half (§5.3).

Two rules on a rollover stop:

- it carries **no footer blocks** (only the last stop does), and
- it must not release the session. `session_status` defaults to `active`, which would drop the
  processing UI mid-turn, so the rollover stop passes `session_status: 'processing'`. If Slack
  rejects that value, the immediately-following `startTurnStream` restores `processing` anyway,
  at the cost of a sub-second flicker. See §7 Q2.

**A rollover is also how the stream re-anchors.** The daemon already marks live chrome to
continue below a newly posted chronological boundary — a permission/elicitation card, or
visible agent-authored text — via `liveReplyReanchor`, because an in-place message that keeps
being edited above a card makes the conversation read out of order. A streamed message has
that problem in its strongest form: it can only ever grow at its own timestamp. So a boundary
triggers the same rollover, on ORDER instead of on size — settle the current message, open the
next, tail continues below the card — and, exactly like the live reply, it is **lazy**: an
empty tail keeps the current message and its footer rather than opening one to say nothing.

**A stopped stream is unrecoverable, and a rollover is a new message by construction.**
`chat.appendStream` against a settled message fails `message_not_in_streaming_state` (or
`stopped_by_user` when the person ended it), and `chat.startStream` takes no existing `ts` —
it only ever mints a message. There is therefore no "resume" to attempt and no code path may
imply one: once a stream ends, for any reason, its handle is dropped, nothing appends to it,
and no second stop is issued against it. Continuation happens the only way the API allows —
by opening the next message — and that is exactly what makes the 12k rollover safe.

### 3.5 Cadence and the send queue

All streaming calls go through the connection's single `PlatformSendQueue` (350 ms spacing, FIFO,
30 s per-task timeout), like every other Slack write. Two consequences:

- **No nested enqueue.** `startTurnStream` / `appendTurnStream` / `stopTurnStream` each enqueue
  once and never call each other from inside a queued task. Layer 0's
  `setStatus` → `setSessionLifecycle` comment (_"Already inside the send queue — must not enqueue
  again"_) is the precedent for the trap.
- **Appends must not starve real posts.** `chat.appendStream` is Tier 4 (100+/min) against
  `chat.startStream` / `chat.stopStream` at Tier 2 (20+/min), and Slack's own SDK buffers 256
  characters before calling. `armSlackStream(p)` therefore coalesces: one append per tick carrying
  everything buffered since the last, fired when either ~256 characters have accumulated or a
  ~750 ms timer expires. This mirrors `armFeishuStream` exactly — _"a single timer survives token
  bursts, so at most one write is queued per interval while still flushing the newest full
  snapshot when it fires."_

`armIdle` / `IDLE_FLUSH_MS` is untouched; it continues to drive the fallback path.

## 4. ACP → stream mapping

Slack's streaming chunk vocabulary — as the resolved SDK declares it, see §10 Q3 — is
`{ type: 'markdown_text', text }`, `{ type: 'task_update', id, title, status, details?, output? }`
(256 chars, status `pending` | `in_progress` | `complete` | `error`),
`{ type: 'plan_update', title }` and `{ type: 'blocks', blocks }`.

**The fields do not all behave the same way, and that is the single most load-bearing fact
here.** `title` and `status` REPLACE per card id — re-send them as often as you like. `details`
**appends** server-side, and `output` is written once at completion. Refreshing an appending
field per update therefore concatenates on Slack's side instead of replacing it: streaming a
thinking line into `details` on every chunk is what ran repeated `**bold**` fragments together
into literal `****`, since card fields render as plain text and never interpret emphasis. The
rule this design follows is **write-once for anything that appends**: `output` at completion,
`details` at most once per card, and everything else expressed through `title`/`status`.

| ACP `session/update`             | today                                                  | streaming                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`            | buffered → `post` / `live-reply`                       | appended as `markdown_text` (coalesced, §3.5)                                                                                                                                                                                                 |
| `tool_call` / `tool_call_update` | in-place `progress` message + rotating status text     | `medium`/`high`: `task_update` keyed by `toolCallId`; ACP `pending`/`in_progress` → `in_progress`, `completed` → `complete`, `failed` → `error`; the tool's result written ONCE as `output` at completion. `minimal`/`low`: nothing, as today |
| `agent_thought_chunk`            | `high`: in-place Thinking message; others: status text | `medium`/`high`: one `task_update` per thinking run, `title: "Thinking"` and status only — no per-line detail, because that field appends. `high` keeps its full in-place Thinking message, which is where 2,800 characters belong anyway     |
| `plan`                           | in-place `plan` message                                | unchanged (see below)                                                                                                                                                                                                                         |
| tool output, terminal (`high`)   | separate code-block message                            | unchanged                                                                                                                                                                                                                                     |
| `usage_update`                   | dropped                                                | dropped                                                                                                                                                                                                                                       |

**`task_display_mode`: `plan`, not `timeline`.** The first version reasoned from the names —
`timeline` "renders task updates as individual task cards interleaved with streamed text", which
sounded like a stream of ACP tool calls — and shipped that. Seeing it rendered settled the
question the other way: flat, separate cards bury the answer under a column of tool chrome, and
what a reader wants is the answer with the activity folded away.

`plan` is that shape. Every task card is collected into ONE collapsed-by-default container, and
`{ type: 'plan_update', title }` is the line printed on it. So the container gets a small arc of
its own:

- **while working** — a generic honest label (`Working…`), written once when the stream opens;
- **at the terminal stop** — a counted summary: `Completed 3 steps`, `Completed 3 steps · 1
failed`, or `Done` when the turn ran no steps at all.

Counted rather than narrated, deliberately: it is derived from the cards the turn actually
emitted, so it needs no second model call and cannot disagree with what is inside the container.
`minimal` and `low` open no container and get no label — they stream body text alone.

The ACP `plan` keeps its existing separate in-place message. That is now a stronger decision than
it was: the container's label is one plain-text line, and an ACP plan is a full entry list with
per-entry statuses that it resends on every update, which is a checklist, not a label.

**Output modes.** `none` never streams (transcript only, unchanged). `minimal` and `low` stream
body text only. `medium` and `high` add task chunks. This is the same ladder the modes already
express — streaming changes the _transport_ of each rung, not which rung shows what.

## 5. Status choreography

On a streaming turn the daemon never writes the **session enum**. It writes only the **legacy
loading text**, and it keeps that row alive for the whole turn. Live testing settled two facts a
channel thread makes plain: the enum's loading UX and the native stop button are **DM /
assistant-container surfaces only** — neither renders in a channel thread — and `chat.startStream`
(and every append after it) **displaces** the legacy `assistant.threads.setStatus` row. So a
streaming turn drives only the legacy status, with no enum and no `is_stoppable`, and it re-issues
that status to make it coexist with the stream:

| Moment                               | Today                                                                                 | Streaming                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch`, before the session opens | `showActivity(…, plan.startupActivityLabel)` → legacy text (+ enum, first write only) | the same legacy text and `loading_messages`, **text only** — never the enum                                                                                               |
| `openTurnChrome`                     | `showActivity(…, 'is thinking…')`                                                     | `chat.startStream` — creates the session, sets `processing`. No second write                                                                                              |
| loading, while streaming             | (the status simply persists)                                                          | startStream and each append displace the row, so it is re-issued after the stream opens and on each visible append — it then coexists with the message and its plan cards |
| each activity change                 | `set-status` → legacy text, enum deduped away                                         | `task_update` chunk on the stream; the loading row is re-issued on the same append seam                                                                                   |
| turn end (`onFinal`)                 | `set-status ''` → legacy clear + enum `active`                                        | `chat.stopStream` with the footer blocks; the loading text is cleared once                                                                                                |

**Why the loading state came back.** The first version wrote no status of either kind and read
well on paper — the stream is the lifecycle, so why narrate it? In practice a cold start opens a
visible empty bubble and then shows nothing until the first token, which is a blank wait exactly
where a user most wants a sign of life.
[Slack's own loading-state guidance](https://docs.slack.dev/ai/developing-agents) and the
official assistant templates both do the obvious thing instead: set the free-text status with
`loading_messages` while working, and let the message carry the content. So does this design now.

Three rules keep it from re-opening the one-slot conflict of §1:

- **Text only, never the enum.** `chat.startStream` already set the session `processing`, and the
  enum's loading UX renders nothing in a channel thread anyway — writing it would only overwrite
  the native rendering with the legacy one for nothing. The connection therefore exposes a
  `setLoadingStatus` that writes the free text alone, and a streaming turn uses only that.
- **Kept alive, cleared at the end.** The row is written once before the stream, then re-issued —
  right after `chat.startStream`, and on each visible append — because both displace it. The
  re-issue is what makes it coexist with the message and plan cards rather than vanishing on first
  content. The clear is explicit and happens once at the terminal stop: Slack's bridge used to
  clear the legacy status when the app posted a message, and a streaming turn no longer posts one.
- **Uniform across rungs.** `minimal`/`low` (body-only stream) and `medium`/`high` (stream + plan
  cards) all carry the same persistent loading row as the working signal. The applier's
  `set-status` case still skips the enum-driving path while a stream is open.

The re-issue rides the existing send queue and activity seam — no extra timer — so the row simply
tracks the stream it sits beside.

The legacy free-text path is otherwise **retired where streaming works and kept verbatim as the
fallback**. Nothing about `setStatus`, `setSessionLifecycle`, or their dedup map changes; on a
non-streaming turn they run exactly as they do today.

Per-agent authorship moves to where it belongs. `username` / `icon_url` / `icon_emoji` are
per-message arguments on `chat.startStream`, populated from the same
`slackAgentPostOptions(plan)` values a post uses today, under the same `chat:write.customize`
dependency — so the existing `customUsernameRetryAt` cooldown covers a workspace that has not
granted it (retry the start undecorated, re-probe in five minutes). Note that on
`agents.sessions.setStatus` the equivalent overrides
[apply only to the loading UX, not to messages](https://docs.slack.dev/ai/agent-sessions), which
is the other half of why the two APIs could never both win.

**Error flush.** `flushTerminal()` exists because some runtimes narrate a terminal error into the
message stream and then reject the prompt, so the buffer holds text no later flush will take. On a
streaming turn it drains into the open stream, and the `⚠️ Agent failed to respond: <reason>`
notice — still suppressed when the flushed text already carries the same reason — is appended to
the same stream rather than posted as a separate message. Then `chat.stopStream`.

**…except after a user stop.** The error flush runs from the turn's catch, and a cancelled turn
reaches it too. When the person pressed Stop, the stream is already dead (§3.4) and the daemon
must do **neither** of the two things that would look like recovery: it must not append the
notice to the settled message, and it must not open a replacement message to carry it. The
existing `outputSuppressed` gate is what enforces this — it is set before the cancel reaches the
prompt, the catch returns early on it, and `enqueueApply` drops anything already queued — so the
streaming error flush inherits the rule rather than restating it. The failure is still reported
through the turn's own outcome; it is simply not narrated into a conversation the person ended.

**A stream must never be left open.** A turn that dies without stopping leaves Slack rendering a
permanently-streaming message and a session stuck in `processing` for an hour. So the stop is
idempotent per stream `ts` and is also issued from:

- `onSettle` — the terminal settlement hook, as a last resort;
- `onSuppress` — loop protection and shutdown, with `allowWhenSuppressed`, exactly as Feishu
  cancels its card today.

Both benign post-stop errors (`message_not_in_streaming_state`, `stopped_by_user`) are swallowed
by the same best-effort pattern the other edits use.

## 6. Stop

**There is one stop event, and Layer 0 already handles it.** `agent_session_stopped` fires for
the native session stop _and_ for the in-message stream stop; its `streaming_message_ts` array
names the streams Slack ended (empty when none was active). Slack does **not** transition the
session on a stop click — _"Your app is responsible for transitioning the status"_ — which is
exactly what Layer 0's `agentSessionStopped` already does.

So the entire stop story for Layer 1 is: **nothing changes.** Specifically:

- No manifest event. `agent_session_stopped` is already in `SLACK_BOT_EVENTS`.
- No new `RdSlackAction` member. The relay's existing `agent-session-stopped` member already
  carries (channel, thread, user) to the owning daemon over the conversation-ownership ladder.
- `streaming_message_ts` is deliberately **not** forwarded. The daemon already knows the stream
  it opened for that conversation's turn, so forwarding the array would widen the wire contract to
  restate something the receiver has. If a future case needs it, it is an optional field on the
  existing member, not a new one.

What the daemon does when the cancel lands: mark the turn's stream closed, so the turn-end path
skips its own `chat.stopStream` and the applier stops appending. The existing `outputSuppressed`
gate on `enqueueApply` already prevents queued actions from publishing after an interrupt; the
stream flag is the same idea one level down.

**A stop is not a delivery failure, and the two must not share a return value.** An append can
come back unsuccessful for two unrelated reasons: Slack refused it (a rate limit, a dropped
connection), or the person ended the stream. The first owes the content to the channel by
another route; the second forbids exactly that. Collapsing them into one boolean is how a
buffered tail gets posted as a fresh reply into a conversation somebody just stopped — the
append response can beat `agent_session_stopped`, so the daemon cannot rely on the event
having arrived. `appendTurnStream` therefore answers `ok` / `refused` / `stopped`, and
`stopped` means the turn's output ends there: no buffer, no post, no replacement message, no
closing edit. The connection also remembers WHICH conversations the person stopped, so a
queued append arriving after the event is answered `stopped` rather than `refused`; the marker
clears when a later turn opens its own stream there.

Both halves of that are prohibitions, not best-effort cleanups. After a stop the daemon may
**neither append to the dead stream nor open a replacement message** — not for the remaining
body, not for the error notice, not for the attribution footer. A person who pressed Stop asked
for the answer to end where it ended; a fresh message appearing underneath would be the daemon
overruling that. The closed flag lives on the connection (keyed by the conversation, because
that is what `agent_session_stopped` carries) so that `appendTurnStream` and `stopTurnStream`
both become no-ops for that message without every caller having to remember.

**Dedupe.** Two stop clicks, or a stop click racing turn-end, collapse harmlessly: the cancel seam
is idempotent (`cancelSessionByKey` on an already-cancelled turn is a no-op), the relay's
`slack-action:` digest dedupes redeliveries, and `setSessionLifecycle` dedupes the `active`
transition per `channel:thread`. The one ordering rule is that `chat.stopStream` precedes the
lifecycle release, so the message settles before the session says idle.

The status bar's "Cancel run" overflow option and the modal's "Cancel turn" button reach the same
seam and are unaffected.

## 7. Fallback and detection

No configuration knob. Streaming is unavailable in real workspaces for reasons the daemon cannot
know in advance —
[some AI features require a paid plan](https://docs.slack.dev/ai/developing-agents),
workspace guests cannot access Agents-enabled apps, and `recipient_user_id` /
`recipient_team_id` are required outside DMs — so the answer has to come from Slack's own errors.

**Turn-start decision, one branch point.** `openTurnChrome` attempts `chat.startStream`. Success
⇒ the turn streams; failure or no returned `ts` ⇒ `conv.disableStreaming()` and the turn runs
today's pipeline unchanged. A turn is never half-streamed.

**Two error classes, following `customUsernameRetryAt` precedent** (the only prior art here for a
TTL-bounded re-probe; `missingScopes` is the only prior art for a permanent latch, and a permanent
latch is wrong for a capability a workspace can gain by upgrading a plan):

- **Capability refusals** — `unknown_method`, `missing_scope`, `channel_type_not_supported`,
  `messages_tab_disabled`, or any failure while the SDK exposes no such method — latch
  `streamingUnavailableUntil = Date.now() + STREAM_REPROBE_MS` (5 minutes, the
  `CUSTOM_USERNAME_REPROBE_MS` value). `streamingLikely()` reads this latch.
- **Contextual refusals** — `channel_not_found`, `not_in_channel`, `missing_recipient_user_id`,
  rate limits, send-queue timeouts — degrade **this turn only**. A per-channel or per-turn error
  must never latch a per-connection capability off; that is how one bad channel silently kills
  streaming workspace-wide.

**Structural carve-outs** decided before the call is even attempted, because they cannot succeed:

- No `thread_ts`. Streamed messages must be replies.
- A channel turn with no human initiator — agent-to-agent, cron, hook, dream — because
  `recipient_user_id` / `recipient_team_id` are required outside DMs and there is no honest value
  to supply. DMs are unaffected.
- Output mode `none`.

These four are the only carve-outs left. A fifth — the shareable-bot staged rollout — has since
been lifted; see §7.1.

**Mid-turn failure.** If an append fails, stop the stream best-effort and finish the remaining
body through the ordinary `post` path — the same shape Feishu already ships (_"A final CardKit
update failure must not lose the answer"_: cancel the card, fall back to `postMessage`).

**The APPLIER changes sink; the converger's axis does not flip.** This is the one place where
the obvious implementation is wrong, so it is worth stating as a rule. Production and
application are separated by the apply chain, so when a refusal lands, later appends — and
often `onFinal` itself — are already converged and queued. Flipping the axis then affects only
_future_ convergence, which leaves two holes: the queued actions no-op and the text they
carried is never shown, and text already drained as `recordOnly` can never take the post
boundary. Worse, the axis owns the _display_ cursor while the transcript cursor advances on
its own slower clock, so resuming ordinary `post` output from the transcript buffer re-posts
the overlap between them. Truncation and duplication, from the same one-line change.

So the converger keeps streaming and keeps its cursors — they are the only exact record of
what Slack has been shown — and the applier redirects. From the refusal on, every stream
action feeds a fallback buffer instead of a message: the refused append first (its text is the
only remaining copy, the converger having already advanced past it), then every later one,
including the terminal stop. The buffer is delivered at the closing stop through the ordinary
reply boundary, so it arrives with the attribution footer, the response metadata and the §5.5
anchor. Task chunks are dropped — chrome with no legacy form, and a task card rendered as
prose is worse than an omitted one. Net effect: the answer lands exactly once, and no queued
action silently discards the content it carried.

Two consequences follow from "the answer lands exactly once", and both are easy to get wrong:

- **Degradation moves the response only once the buffer holds body text.** A refusal that
  dropped nothing but task chrome leaves the accepted stream holding the whole visible answer,
  so that message must still be closed as the attributed final response — and must therefore
  stay OPEN until the terminal stop rather than being settled at the refusal. Settling it
  early, or treating "degraded" as "the fallback owns the response", ends a
  `body → tool card → end` turn footerless and with nothing for §5.5 to finalize.
  **That ownership is explicit state, not a length check on the buffer.** The buffer empties
  on every flush, so a stop retried afterwards — the double-failure case, where the rollover
  stop and then the terminal stop are both left unresolved — would read "no fallback body" and
  re-anoint the retained old message as final, moving the footer and the §5.5 anchor onto it
  and restamping it with the tail's text. Ownership is therefore one-way for the turn: once
  the fallback has taken the response, no later retry hands it back.
- **A failed ROLLOVER stop degrades its tail instead of reusing the old handle.** The retained
  handle (§3.4/§5 keep it for the settlement retry) is the message the rollover was trying to
  leave. Appending the tail there would undo the whole point — post-boundary output back above
  the boundary, or the size cap defeated — and, because the converger has already reset its
  per-message text, the closing edit would then replace the combined message with just the
  tail, deleting the prefix. So the tail goes to the fallback buffer and lands BELOW as an
  ordinary reply, which is what the rollover wanted; the old message keeps its prefix and
  settlement keeps retrying its stop.

**A stop is retryable until Slack accepts it.** `chat.stopStream` failing transiently — a rate
limit, a dropped connection, the send queue's own timeout — is precisely the case the §5
settlement backstop exists for, so neither the turn's handle nor the connection's is retired
on it; doing so would leave the message streaming and the session in `processing` with nothing
to retry, the exact terminal state that backstop prevents. Only a definite answer retires a
handle: success, or `message_not_in_streaming_state` / `stopped_by_user`, which prove the
message is already settled. The unaccepted stop is remembered verbatim so settlement reissues
_that_ stop rather than a bare abort — otherwise the retry would settle the message but
silently drop its attribution footer. The same rule governs an append refusal: it retires the
handle only when the error proves the message stopped, so a transient one still leaves
something for the stop to land on.

### 7.1 The shareable-bot carve-out, lifted

The first version shipped one more carve-out, and unlike the four structural ones it was a
**staged rollout expressed as a predicate**: turns on a **shareable** (multi-agent) Slack bot
took the legacy pipeline while dedicated bots streamed. It has since been **lifted** — shareable
bots now stream too — once ingress learned to read the finalization from stop-time metadata. This
section records why it existed and what the lift required.

**Why it existed.** The open question was §10 Q1: whether the §5.5 closing `chat.update` still
worked on a stopped stream and still emitted the `message_changed` event ingress recognises was
undocumented in both directions. Agent-to-agent routing over Slack depends on that finalization
being seen — and **agent-to-agent conversation only happens on a shareable bot**, because that is
the only bot that hosts more than one agent to address. So the population where a wrong answer to
Q1 could cost real behavior was precisely the population the carve-out excluded, which converted
Q1 from a merge gate into a bounded post-deploy verification.

It gated on the codebase's **existing** shareable predicate — the same
`platformIntegrationConfig('slack', …).shareable` fact that decides whether the status bar offers
"Switch agent" — not on a new flag. Nothing new became configurable, so nothing could acquire
callers and become permanent.

**Why the lift owed an ingress change first.** §3.3 moved the §5.5 finalization onto
`chat.stopStream`, because the closing `chat.update` it replaced was erasing the task cards. That
means a streamed turn no longer emits the `message_changed` event ingress used to key on. Harmless
while shareable bots did not stream (the only consumer is A2A routing, which happens only there) —
but it made the lift a two-part change, in order:

1. **Teach relay and Socket Mode ingress to recognise a finalization from stop-time metadata**,
   alongside the edit they read for the legacy path.
2. **Then** delete the predicate from the eligibility check.

Doing (2) without (1) would silently stop agent-to-agent routing on exactly the bots that use it.

**How both landed.** The daemon already stamps the §5.5 `final` metadata onto `chat.stopStream`
(§3.3) — the SAME `agentconnect_thread_event` payload (`author_agent_id`, `response_id`,
`delivery_state: 'final'`, `hop_count`, `mentioned_agent_ids`, `addressed_anyone`) the legacy
`chat.update` carried. `normalizeSlackResponseFinalization` now recognises that `final` claim
whether it arrives nested in a `message_changed` edit (legacy) or at the **top level** of an
ordinary stop-time event (streamed); both map to the same `response-final`-tagged finalization,
so downstream A2A routing (`verifyAgentAuthor` → the §6 ladder) is unchanged. Both ingress seams
call that one normaliser, before their own-echo filter, so relay and Socket Mode gain the
recognition together. With (1) in place, (2) is the removal of the single shareable line from
`slackStreamingEligible`.

**The `include_all_metadata` requirement.** The live routing path reads the metadata off the
message EVENT (the Events API payload on the relay, the Socket Mode frame on the daemon), which
carries it natively for the app that published it — a shared bot posts and receives under one app,
so the payload includes the full `event_payload`. The only place a **read-back** is used —
`conversations.replies` thread backfill — must pass `include_all_metadata: true`, or Slack returns
just `metadata.event_type` and drops the payload; `getThreadReplies` already does. `chat.stopStream`
`metadata` persists on the finalized message intact (verified live), so a read-back sees it too.

**SDK note.** `@slack/web-api` resolves to 8.0.0 in this workspace, and — checked against the
resolved package, not assumed — it **does** type all three methods (`chat.startStream`,
`chat.appendStream`, `chat.stopStream`) plus the chunk union, through `@slack/types` 3.0.0. So
`apiCall` is not needed here, unlike Layer 0's `agents.sessions.*`. The connection still declares
the three members as OPTIONAL on its `AppLike` surface: their absence is one of the capability
refusals §7 latches on, which is also what keeps every existing inert test app on the legacy path
without edits.

## 8. Blast radius

**Manifest: no change.** `chat:write` is held, `agent_view` is already the declared feature (not
the `assistant_view` that deprecates in February 2027), `assistant:write` is present, and
`agent_session_stopped` was subscribed by Layer 0. There is nothing to add and therefore no
manifest refresh for installed apps — which is the payoff of #1471's decision to pre-provision
inert events.

**Protocol and relay: no change.** No new frame member, no new `SlackHttpIngest` branch, no new
`forwardSession*`. Both transports get streaming for free because it is pure egress: a shared
bot's send-only `SlackConnection` posts through the same Web API client as a Socket Mode one, and
the Socket Mode arm needs no new `app.event` handler.

**Eval connection-surface guard** (`evals/test/connection-surface.test.ts`) — the guard reflects
over `SlackConnection.prototype` and fails on any name that is neither implemented by
`VirtualSlackConnection` nor listed in `EXEMPT` (TypeScript `private` is erased, so private
helpers need entries too). New members and their disposition:

| Member                               | Disposition                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTurnStream`                    | **Implement** on `VirtualSlackConnection`, returning "unsupported" — the arena has no Slack API, so every turn deterministically takes the legacy path and every existing arena baseline stays byte-identical |
| `appendTurnStream`, `stopTurnStream` | No-op stubs, as `setStatus` / `setTitle` already are                                                                                                                                                          |
| `streamingLikely`                    | No-op stub returning `false` — consistent with the above                                                                                                                                                      |
| `noteStreamFailure`, `closeStream`   | `EXEMPT` — private error classification / stop bookkeeping, reached only from the three members above (TypeScript `private` is erased, so they need entries)                                                  |

`collaboration-arena-baseline.md` pins this file's test count and needs the same edit if tests are
added.

**Unchanged:** Telegram / Discord / Feishu convergers and appliers; webchat (its own sink; the
applier's headless no-`conn` path is untouched); the Control Plane (no route, no schema, no DTO);
`@agentconnect.md/message` normalization (egress only); the transcript contract; the session
status bar; permission and elicitation cards; attachments; §5.5 routing semantics.

## 9. Rollout

**One PR — this one.** The two-PR split that would normally apply here — manifest additions ahead
of the code that needs them, so installed apps take a single refresh — has nothing to carry: §8
establishes that the manifest already declares everything streaming needs. The principle stands
for the next change that does add an event; it simply does not bite this one. The design doc
travels with the implementation, which is why this document ships in that PR rather than ahead of
it.

**Decided, so the sequence has no branches left in it:**

1. **This PR** lands the whole pipeline — connection members, converger axis, applier, daemon
   hooks, the status-choreography guards, the eval guard, and this document.
2. **A follow-up PR lifted the §7.1 shareable carve-out** (done). It taught ingress to read the
   stop-time finalization metadata, then deleted the predicate from the eligibility check, so
   shareable bots stream and A2A routing is unchanged (§7.1).
3. **[#1478](https://github.com/agentconnect-md/agentconnect/pull/1478) closes as superseded when
   this merges** — not merged first, not rebased. Its ordering fix applies to a path streaming
   retires wherever it works, and §10 Q5 explains why its order is the wrong one for the
   remaining fallback turns. Its regression test survives, retargeted at the stronger assertion
   (a streaming turn writes _neither_ status API).
4. **No environment kill switch.** The three reasons below stand, and the degrade path is
   exercised on every arena turn and every carved-out turn, so an unexercised second off-switch
   would add a failure mode rather than remove one. If review disagrees, the maximal acceptable
   form is still the single variable described below — but it is not being added pre-emptively.

**Should the pipeline sit behind a code flag, so production keeps the stable legacy path?**
Recommended: **no.**

- The **promotion gate already provides the temporal separation** a flag would buy. A change
  reaches a prerelease environment first, soaks, becomes stable, and only reaches production
  through a manual promote. A flag would add a fourth, hand-operated gate on top of three
  automatic ones.
- The **degrade path is not hypothetical, it is the design**. §7's feature detection keeps the
  legacy pipeline compiled, reachable, and exercised on every turn that cannot stream — including
  every arena turn (§8). A flag would gate a fallback that already exists, and its "off" state
  would be indistinguishable from the state a workspace on the wrong plan already reaches.
- The **test matrix doubles**. Converger and applier assertions already need streaming and
  fallback variants across five output modes. A flag multiplies that by two for behavior no test
  can distinguish from `streamingUnavailableUntil` being set.

If extra insurance is wanted, the **maximal acceptable form is a single daemon environment
variable** (`AC_SLACK_STREAMING=0`) that forces `streamingLikely()` false, documented in the PR as
temporary and removed after one stable cycle. Not a product-config field, not per-org, not a
console toggle — those acquire callers and become permanent.

**Sequencing within the PR** is the natural dependency order: connection members and their error
classification → converger `streaming` axis → applier actions → `armSlackStream` and the
`openTurnChrome` / `onSettle` / `onSuppress` hooks → the `showActivity` and `set-status` guards →
eval guard.

## 10. Open questions

**Q1. Does `chat.update` work on a stopped stream, and does it emit the `message_changed` event
ingress needs?** §5.5 routing depends on the closing edit being _seen_: relay and Socket Mode both
recognise a finished agent answer by `normalizeSlackResponseFinalization` on that edit, and
without it agent-to-agent mentions over Slack stop resolving. Undocumented either way.
_Resolved, and then made moot._ §7.1 ships the shareable-bot carve-out up front, so the only
population a wrong answer could hurt never streams. Seeing the edit run in a real workspace then
answered the question in the worst way available: it works, and it is destructive — `chat.update`
replaces the message wholesale, erasing every task card and marking the answer "(edited)". So the
edit is gone from the streamed path entirely (§3.3), and what replaces it is stop-time metadata.
The open question became "can ingress read a finalization that never arrives as an edit" —
_now answered yes._ The finalized message carries the stop-time `metadata` intact (verified live;
readable back with `include_all_metadata: true`), and it reaches ingress as an ordinary message
event carrying that metadata at top level. `normalizeSlackResponseFinalization` reads the `final`
claim from either the nested edit or the top-level event, so the carve-out is lifted (§7.1).

**Q2. What is the accumulated-length cap of a streamed message, and does `chat.stopStream` accept
`session_status: "processing"`?** The 12,000 figure is documented per call, not per message;
`session_status` is documented only in the Agent sessions guide, with `suspended` shown by example
and `active` named as the default. _Recommended:_ cap the accumulated stream at 12,000 and roll
over (§3.4) — that preserves today's split behavior whatever the real limit is — and pass
`session_status: "processing"` on a rollover stop, accepting the sub-second flicker if Slack
rejects it.

**Q3. Which `task_update` chunk shape is real?** The docs carry three mutually inconsistent
versions: a flat `{ id, title, status }` on the method reference pages, a nested
`{ task: { task_id, title, status, output } }` in the developing-agents guide, and
`{ type: "task", id, text, status }` in the design guide — with the status vocabulary differing
(`complete` vs `completed`) between them. _Resolved from the resolved SDK, which outranks all
three prose versions:_ `@slack/types` 3.0.0 (what `@slack/web-api` 8.0.0 depends on) declares the
chunk union outright — `TaskUpdateChunk` is the **flat** shape **with an explicit `type`
discriminator** the method reference omits:
`{ type: 'task_update', id, title, status: 'pending' | 'in_progress' | 'complete' | 'error',
details?, output?, sources? }`, alongside `{ type: 'markdown_text', text }`. So the status word is
`complete`, the text field is `title` (not `text`), and there is no `task` wrapper. Task chunks
still ride the same per-error degrade as everything else, so a shape Slack later rejects costs the
task cards, not the answer.

**Q4. Can `task_display_mode` change mid-stream?** _Answered, and the question turned out not to
matter._ Every stream now opens in `plan` (§4), which is the mode we want for the whole turn, so
nothing needs to switch. `plan_update` is used for the container's own label, not for the ACP
plan, which keeps its separate in-place message — a full entry list with per-entry statuses is a
checklist, and the container's label is one plain-text line.

**Q5. On the fallback path, keep main's current enum-last order, or land #1478's reorder?** Once
streaming ships, the legacy path runs only where streaming is impossible — and #1478's order means
the enum is written first and then immediately overwritten by text, so the native stop button never
appears there at all. _Resolved:_ close #1478 as superseded without merging, and leave main's order alone (§9 step 3).
Its regression test is kept, retargeted at the stronger assertion that a **streaming** turn writes
neither status API.
