# Slack Native Streaming Turn Output

**Status:** Implemented — **chrome only**. A Slack turn's TOOL-CALL CHROME rides one native
`chat.startStream` card stream; the agent's answer does not, and the body pipeline is
byte-identical to what it was before this document existed.

This is the second attempt. The first one streamed the BODY and was reverted; §1 records why,
and why body streaming stays rejected. Reading this document as "streaming came back" is the
one misreading it is written to prevent: what came back is the _progress message_, rendered as
a native plan card instead of a `chat.postMessage` the daemon edits in place.

Layer 0 ([#1462](https://github.com/agentconnect-md/agentconnect/pull/1462),
[#1471](https://github.com/agentconnect-md/agentconnect/pull/1471),
re-landed on the typed `@slack/web-api` 8.1 SDK in
[#1563](https://github.com/agentconnect-md/agentconnect/pull/1563)) adopted Slack's Agent
Sessions control surface: the `processing` / `active` lifecycle enum deduped per
`channel:thread`, the native rename, and the native stop button — `agent_session_stopped`
resolved by (channel, thread) into the existing cancel seam, on Socket Mode directly and on
HTTP through a conversation-addressed `RdSlackAction` member. None of that changes here.

## 1. The revert, and what survives it

[#1483](https://github.com/agentconnect-md/agentconnect/pull/1483),
[#1487](https://github.com/agentconnect-md/agentconnect/pull/1487) and
[#1489](https://github.com/agentconnect-md/agentconnect/pull/1489) put the agent's answer and
its tool cards on ONE stream. [#1495](https://github.com/agentconnect-md/agentconnect/pull/1495)
reverted all three, for one reason, recorded in
[#1494](https://github.com/agentconnect-md/agentconnect/issues/1494):

> **A channel stream is visible live to exactly one recipient.** `chat.startStream` takes a
> `recipient_user_id` outside a DM, and only that person sees the message grow. Everyone else
> in the thread sees an italic "Thinking…" placeholder until the stream stops, and only then
> the finished content.

For an ANSWER that is unacceptable: a channel is a shared surface, and an agent that answers
one person live while everyone else waits on a placeholder is worse than an agent that posts
once. Nothing about the platform has changed, so **body streaming remains rejected** and
issue #1494 keeps that half of its posture.

What the revert did NOT establish is that the _mechanism_ is unusable. Applied to CHROME the
same single-recipient property is close to irrelevant: tool cards are the part of a turn a
reader most wants folded away, the placeholder is a truthful "working" signal for everyone
else, and the finished plan card lands for the whole channel at stop. So the split this
document designs is:

| Output             | Transport                                                               |
| ------------------ | ----------------------------------------------------------------------- |
| The agent's answer | unchanged — `chat.postMessage` / `chat.update`, exactly as today        |
| Tool-call chrome   | ONE cards-only `chat.startStream` stream per turn, replacing `progress` |

Because the body never rides the stream, everything the reverted design needed in order to
move an answer between transports is gone with it (§9).

## 2. Goals / Non-goals

**Goals**

1. Replace the in-place `progress` message with a native, collapsed plan card, so a
   medium/high turn's tool activity reads as one folded container rather than a message the
   daemon rewrites.
2. Change **nothing** about the body: post / live-reply / final-live-reply, response
   finalization by edit, the attribution footer, the transcript, the status bar, the transient
   status text, permission and elicitation cards, attachments, the ACP plan message, the
   high-mode Thinking message, and tool-output code blocks are untouched.
3. Degrade to today's `progress` message wherever streaming is unavailable — detected from
   Slack's own errors, with no configuration knob and no environment kill switch.
4. Leave Layer 0's stop seam, `setSessionLifecycle`, the manifest, the relay, the control
   plane, the protocol, and every other platform alone.

**Non-goals**

- Streaming the body. See §1.
- Other platforms. Telegram, Discord and Feishu convergers and appliers are untouched.
  (Feishu's CardKit streaming is the structural precedent this design copies, not a thing it
  changes.)
- Webchat, the Control Plane, and message normalization. This is egress only, plus the two
  minimal ingress filters in §8.
- Slack's feedback-buttons block. `chat.stopStream` accepts one, but AgentConnect has no
  feedback sink; adding one is a separate product decision.

## 3. Pipeline

### 3.1 Where the seam is

The seam is the one Feishu already established for CardKit, reused verbatim:

| Layer             | Feishu (shipped)                                                     | Slack (this design)                                                             |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Converger IR      | `card-start` / `card-stream` / `card-final` / `card-cancel`          | `stream-start` / `stream-append` / `stream-stop`                                |
| Converger members | `onStart()`, `hasStreamingUpdate()`, `streamUpdate()`, `onFailure()` | `enableStreaming()`, `hasStreamingUpdate()`, `streamUpdate()`, `settleStream()` |
| Daemon timer      | `armFeishuStream(p)`                                                 | `armSlackStream(p)`                                                             |
| Applier           | `applyFeishuAction` resolves against `startStreamingCard` / …        | `applySlackAction` resolves against `startTurnStream` / …                       |
| Connection        | `FeishuConnection.startStreamingCard` etc.                           | `SlackConnection.startTurnStream` / `appendTurnStream` / `stopTurnStream`       |

No new mechanism is introduced. `OutputConverger` gains a `streaming` axis that changes **one**
production rule — the `tool_call` / `tool_call_update` branch emits card chunks instead of a
`progress` action — and adds a Thinking card on the thought branch. Every other action it
produces, in every mode, is byte-identical.

**Deciding the axis.** `createConverger(ctx)` runs at turn start, before any Slack call can be
made, so the axis is set there from a synchronous capability read (`conn.streamingLikely()`,
§7) plus the two facts that can be known in advance: the platform is Slack, and the turn has a
thread. Output mode is the converger's own gate — only `medium` and `high` render tool chrome
at all, so `none` / `minimal` / `low` never take the axis whatever the workspace supports.

**Opening is lazy.** The axis being set does not open a stream. `stream-start` is emitted by
the FIRST `streamUpdate()` that has a card to show, so a turn that runs no tools never calls
`chat.startStream` and produces exactly the bytes it produces today. This is the main reason
the change is safe to ship without a flag: the population it can affect is precisely the
population that would otherwise have seen a `progress` message.

### 3.2 What stays

Everything, except the `progress` message. Explicitly, and each one verified as untouched in
the diff:

- **The body.** `post` / `live-reply` / `final-live-reply`, section splitting,
  `protectedAddresses`, the §5.5 response finalization edit, the attribution footer, and
  `closeSlackResponse`.
- **The transcript.** The stream is chrome; nothing about `recordOnly` posts or
  `appendTranscript` rows changes, and no transcript row is produced from a card.
- **The status text and the session enum.** `setStatus` still writes the free text and then
  `setSessionLifecycle`, in that order, on every turn including a streaming one. The stream
  makes no status call of either kind, and `setSessionLifecycle` remains the enum's single
  writer (§4, fact 6).
- **The session status bar**, permission and elicitation cards, attachments, the ACP `plan`
  message, the high-mode Thinking message, and high-mode tool-output code blocks.

### 3.3 Cadence and the send queue

All three streaming calls go through the connection's single `PlatformSendQueue` (350 ms
spacing, FIFO, 30 s per-task timeout), like every other Slack write. Two consequences:

- **No nested enqueue.** `startTurnStream` / `appendTurnStream` / `stopTurnStream` each enqueue
  once and never call each other from inside a queued task. Layer 0's
  `setStatus` → `setSessionLifecycle` comment (_"Already inside the send queue — must not
  enqueue again"_) is the precedent for the trap.
- **Appends must not starve real posts.** `chat.appendStream` is Tier 4 (100+/min) against
  `chat.startStream` / `chat.stopStream` at Tier 2 (20+/min). `armSlackStream(p)` therefore
  coalesces exactly as `armFeishuStream` does: a single `SLACK_STREAM_FLUSH_MS` (750 ms) timer
  survives a burst of tool updates, and the append that fires carries the LATEST state of every
  dirty card. There is no character threshold, because there is no body to measure.

`armIdle` / `IDLE_FLUSH_MS` is untouched.

## 4. Live-verified platform facts

Probed against a real workspace on **2026-08-28**. These are the load-bearing facts; several
contradict the published documentation, and two of them changed the design.

1. **Cards-only chunks-mode streams work end to end.** The finalized message renders a native
   `plan` block `{title, tasks: [{task_id, title, status}]}`; its `text` is the fixed string
   `This message contains interactive elements.`; the message carries
   `streaming_state: 'in_progress' | 'completed'`; and `chat.stopStream`'s `metadata` lands on
   the finalized message.
2. **`chat.startStream` REQUIRES `thread_ts`.** Omitting it fails `invalid_thread_ts`, in DMs
   too — the documentation's "omit it for a top-level message" does not hold live. A
   channel-root turn therefore cannot stream, and that is a structural carve-out, not a
   degrade.
3. **A stop with `in_progress` cards still open is destructive.** Slack renders the plan title
   as "Something went wrong" and flips those cards to `error`. So **every** stop is preceded by
   a settle append: all open cards written to their real terminal status, plus a final
   `plan_update`. Normal turn end: all `complete`, title `Completed N steps`, with `· M failed`
   appended when M cards ended in error — counted from the cards the turn emitted, never
   narrated by the model. Cancel / user Stop / suppression: in-flight cards → `error`, title
   `Stopped` (an explicit title survives error-status cards; verified).
4. **A normal `chat.postMessage` into the same thread while a stream is open works**, with no
   restriction. Two concurrent streams in one thread are also ACCEPTED by the API — so #1563's
   thread displacement has no API landmine here; the displaced turn's cancel settles and stops
   its own stream for UX reasons, not correctness ones.
5. **The native Stop click does NOT kill the stream server-side.** Appends kept succeeding 50 s
   after a real click. Slack renders "Stopping &lt;bot&gt;…", delivers `agent_session_stopped`,
   and then waits for the app. So the daemon's turn-cancel seam — reached by
   `agentSessionStopped`, the status-bar Cancel, thread displacement, `onSuppress` and the
   `onSettle` backstop — is what must settle and stop the chrome stream. `stopped_by_user` is
   still handled defensively on appends: it retires the handle, and nothing more is appended or
   stopped against it.
6. **`session_status` is never passed on `chat.stopStream`.** Its default is already `active`,
   and Layer 0's `setSessionLifecycle` stays the enum's single writer — unchanged on streaming
   turns.
7. **Rendering.** During a cards-only stream the native "&lt;bot&gt; is working…" row with Stop
   appears in the bot DM AND in channel threads. The stream's recipient sees live card updates;
   every non-recipient sees an italic "Thinking…" placeholder that flips to the full plan card
   at stop. Body posts are real-time for everyone throughout — which is exactly the property
   that makes chrome-only viable and body streaming not (§1).
8. **`username` / `icon_url` / `icon_emoji` are accepted on `chat.startStream`.** The stream
   therefore takes the same identity policy as today's chrome rows — the agent's name and icon
   in a channel, the app's own in a DM — reusing the existing `customUsernameRetryAt` cooldown
   for a workspace without `chat:write.customize` (retry undecorated, re-probe in five minutes).
9. **Recipient.** Channel only; a DM passes none. A human-initiated turn names the initiating
   human's Slack user id plus the team id. A turn with no human initiator — agent-to-agent,
   cron, hook, dream — names the bot's OWN user id and its team id, which Slack accepts. There
   is no structural carve-out for non-human turns.

## 5. ACP → card mapping

Slack's streaming chunk vocabulary, as `@slack/types` declares it, is
`{ type: 'markdown_text', text }`,
`{ type: 'task_update', id, title, status, details?, output? }` (256 chars, status
`pending` | `in_progress` | `complete` | `error`), `{ type: 'plan_update', title }` and
`{ type: 'blocks', blocks }`. **This design sends no `markdown_text` chunk, ever.**

**The fields do not all behave the same way, and that is the single most load-bearing detail.**
`title` and `status` REPLACE per card id — re-send them as often as you like. `details`
**appends** server-side, and `output` is written once at completion. Refreshing an appending
field per update therefore concatenates on Slack's side instead of replacing it: streaming a
thinking line into `details` on every chunk is what ran repeated `**bold**` fragments together
into literal `****`, since card fields render as plain text and never interpret emphasis. The
rule is **write-once for anything that appends**: `output` at completion, `details` never, and
everything else expressed through `title` / `status`.

| ACP `session/update`             | today                                              | with the chrome stream                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_message_chunk`            | buffered → `post` / `live-reply`                   | **unchanged**                                                                                                                                                                                    |
| `tool_call` / `tool_call_update` | in-place `progress` message + rotating status text | `task_update` keyed by `toolCallId`; ACP `pending`/`in_progress` → `in_progress`, `completed` → `complete`, `failed` → `error`. The status text is unchanged; the `progress` message is replaced |
| `agent_thought_chunk`            | `high`: in-place Thinking message; status text     | plus ONE `task_update` per thinking run, `title: "Thinking"`, status only. `high` keeps its full in-place Thinking message, which is where 2,800 characters belong                               |
| `plan`                           | in-place `plan` message                            | **unchanged** — an ACP plan is a full entry list with per-entry statuses, i.e. a checklist, not a one-line container label                                                                       |
| tool output, terminal (`high`)   | separate code-block message                        | **unchanged**, plus the result written ONCE as the card's `output` (high only), clamped to 256 characters                                                                                        |
| `usage_update`                   | dropped                                            | dropped                                                                                                                                                                                          |

**`task_display_mode: 'plan'`, fixed, never configurable.** Every task card is collected into
ONE collapsed-by-default container, and `{ type: 'plan_update', title }` is the line printed on
it. `timeline` — the API default — renders each card flat and separate, which is the shape the
first attempt shipped and then abandoned after seeing it: a column of tool chrome buries
everything around it. The container's own arc:

- **while working** — `Working…`, written on the first card;
- **at the terminal stop** — `Completed 3 steps`, or `Completed 3 steps · 1 failed`.

Counted rather than narrated, deliberately: it is derived from the cards the turn actually
emitted, so it needs no second model call and cannot disagree with what is inside the container.

**Output modes.** `none`, `minimal` and `low` have no tool chrome today and gain none: they
never take the axis. `medium` gets card titles and statuses; `high` adds the card `output`.
This is the same ladder the modes already express — the stream changes the transport of the
medium/high rung, not which rung shows what.

**DM and channel take the same code path.** The only difference is the recipient argument
(§4 fact 9).

**A turn that fails** settles its cards like a finished one — `complete` and the counted
summary. The tool calls did not necessarily fail; the turn did, and the `⚠️ Agent failed to
respond` notice carries that in the body where it belongs. Marking them `error` would blame the
tools for the runtime.

## 6. Stop

**There is one stop event, and Layer 0 already handles it.** `agent_session_stopped` fires for
the native session stop; Slack does not transition the session on the click — _"Your app is
responsible for transitioning the status"_ — which is what Layer 0's `agentSessionStopped`
already does, unchanged here.

What §4 fact 5 adds is that Slack does not end the STREAM either. So the daemon's existing
turn-cancel seam owns it: `onSuppress` clears the append timer and enqueues
`settleStream('stopped')` with `allowWhenSuppressed`, exactly as Feishu cancels its card today.
Every path that cancels a turn — the native Stop, the status-bar Cancel, the modal's Cancel
turn, thread displacement, loop protection, shutdown — reaches that one hook.

Three prohibitions, all of them about a stream that is already dead:

- **No append after a definite dead-stream answer.** `stopped_by_user` or
  `message_not_in_streaming_state` on an append retires the handle immediately.
- **No second stop.** The handle is dropped the moment Slack accepts a stop, or proves the
  message was already settled.
- **No replacement message.** A dead chrome stream is not re-opened and its cards are not
  re-posted as prose. Chrome is lossy-tolerant; the answer never depended on it.

**A stop is retryable until Slack accepts it.** `chat.stopStream` failing transiently — a rate
limit, a dropped connection, the send queue's own timeout — is precisely the case the `onSettle`
backstop exists for, so neither the turn's handle nor the connection's is retired on it; doing
so would leave the message streaming with nothing to retry. Only a definite answer retires a
handle: success, or `message_not_in_streaming_state` / `stopped_by_user`. The settle append has
already run by then, so the retry owes only the stop itself.

**Dedupe.** Two stop clicks, or a stop click racing turn-end, collapse harmlessly: the cancel
seam is idempotent (`cancelSessionByKey` on an already-cancelled turn is a no-op), the relay's
`slack-action:` digest dedupes redeliveries, `setSessionLifecycle` dedupes the `active`
transition per `channel:thread`, and `settleStream` is one-shot per turn.

## 7. Eligibility and degrade

No configuration knob, and no environment kill switch. Streaming is unavailable in real
workspaces for reasons the daemon cannot know in advance — some AI features require a paid
plan, workspace guests cannot access Agents-enabled apps — so the answer has to come from
Slack's own errors.

**Two error classes, following the `customUsernameRetryAt` precedent** (the only prior art for
a TTL-bounded re-probe; a permanent latch is wrong for a capability a workspace can gain by
upgrading a plan):

- **Capability refusals** — `unknown_method`, `missing_scope`, `channel_type_not_supported`,
  `messages_tab_disabled`, or the SDK exposing no such method — latch
  `streamingUnavailableUntil = Date.now() + STREAM_REPROBE_MS` (5 minutes, the
  `CUSTOM_USERNAME_REPROBE_MS` value). `streamingLikely()` reads that latch.
- **Contextual refusals** — `channel_not_found`, `not_in_channel`, `missing_recipient_*`, rate
  limits, send-queue timeouts — degrade **this turn only**. A per-channel or per-turn error must
  never latch a per-connection capability off; that is how one bad channel silently kills
  streaming workspace-wide.

**Structural carve-outs**, decided before the call is attempted: no `thread_ts` (§4 fact 2), and
output mode below `medium`. That is the whole list. There is no shareable-bot carve-out and no
non-human-turn carve-out — §4 fact 9 removed the reason for the second, and §1's split removed
the reason for the first.

**Degrade is cheap, because the body never moved.** A turn whose `chat.startStream` fails falls
back to today's `progress` message for the rest of the turn: each `stream-append` carries the
legacy `progress` rendering it would have produced, so the applier renders that instead. Task
chunks are NEVER rendered as prose — a thinking-only append carries no legacy text and shows
nothing, which is what it shows today. A mid-turn append failure is even cheaper: that card
update is dropped and the handle is kept.

## 8. Backfill and ingress hygiene

A streaming message is not conversation and must never be read back as one. Two filters, both
minimal extensions of existing ones:

- **The stop stamps the chrome marker.** `chat.stopStream` carries the same
  `SLACK_CHROME_EVENT_TYPE` metadata (plus the owning agent id) that today's chrome
  `chat.postMessage` path stamps, so a peer daemon's thread backfill skips the finalized card
  through the filter it already has.
- **An OPEN stream carries no metadata**, so `getThreadReplies` also marks a row as chrome when
  it carries `streaming_state`, or when its body is the fixed placeholder text (§4 fact 1); and
  `isRoutableMessageEvent` drops such an event at Socket Mode ingress. The string
  `This message contains interactive elements.` must never reach an agent as a message body.

Neither addition lets a stranger make ordinary conversation disappear by copying a marker: the
backfill filter stays provenance-gated (`trustedAgentBot`), and the placeholder TEXT is
evidence only from an app author — a person typing that same sentence is routed as the
conversation it is.

## 9. What the reverted design carried that is retired

Everything below existed only because the BODY rode the stream. Each is deleted, not deferred:

| Retired                                       | Why it existed                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| The 12,000-character rollover                 | one markdown block caps at 12k; cards have no such limit                    |
| The re-anchor rollover (`reanchorStream`)     | a streamed ANSWER had to move below a card posted under it; chrome does not |
| The fallback body buffer + response ownership | a refused append still owed the ANSWER to the channel by another route      |
| The shareable-bot carve-out                   | A2A routing reads the finalization edit, which body streaming removed       |
| Ingress finalization-from-metadata (its lift) | same — the body's finalization still rides its own `chat.update` edit       |
| Stop-time §5.5 finalization and its `blocks`  | the footer and the final delivery state belong to the body message          |
| The legacy loading-row re-issue choreography  | the stream displaced a row the ANSWER needed beside it                      |
| `setLoadingStatus` (text without the enum)    | a body-streaming turn owned the whole status slot; a chrome one does not    |
| `disableStreaming()` mid-turn demotion        | the axis owned a display cursor; the applier now owns the whole degrade     |

`staleReplyFooters`, `finalizeSlackResponse`, `closeSlackResponse` and the `attribution` action
are all still there and still work the way they did before #1483.

## 10. Blast radius

**Manifest: no change.** `chat:write` covers streaming, `agent_view` is the declared feature,
and `agent_session_stopped` was subscribed by Layer 0. Nothing to add, so no manifest refresh
for installed apps.

**Protocol, relay, control plane, web: no change.** No new frame member, no new
`SlackHttpIngest` branch, no schema, no DTO. Both transports get this for free because it is
egress plus two daemon-local ingress filters: a shared bot's send-only `SlackConnection` posts
through the same Web API client as a Socket Mode one.

**Eval connection-surface guard** (`evals/test/connection-surface.test.ts`) reflects over
`SlackConnection.prototype` and fails on any name that is neither implemented by
`VirtualSlackConnection` nor listed in `EXEMPT` (TypeScript `private` is erased, so private
helpers need entries too). New members and their disposition:

| Member                               | Disposition                                                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTurnStream`                    | **Implement** on `VirtualSlackConnection`, returning "unsupported" — the arena has no Slack API, so every arena turn deterministically takes the legacy path and every baseline stays byte-identical |
| `appendTurnStream`, `stopTurnStream` | No-op stubs, as `setStatus` / `setTitle` already are                                                                                                                                                 |
| `streamingLikely`                    | Stub returning `false` — consistent with the above                                                                                                                                                   |
| `noteStreamFailure`, `closeStream`   | `EXEMPT` — private error classification / stop bookkeeping, reached only from the three members above                                                                                                |

`collaboration-arena-baseline.md` pins this file's test count and needs the same edit if tests
are added.

**Unchanged:** Telegram / Discord / Feishu convergers and appliers; webchat (its own sink; the
applier's headless no-`conn` path is untouched); `@agentconnect.md/message` normalization; the
transcript contract; the session status bar; the status text and session enum; permission and
elicitation cards; attachments; §5.5 routing semantics; the body pipeline in full.

## 11. Rollout

**One PR — this one**, carrying the code and this document. §10 establishes that the manifest
already declares everything needed, so the manifest-first split that would normally apply has
nothing to carry.

**No kill switch, and no code flag.** Three reasons, all stronger for a chrome-only change than
they were for the reverted one:

- The **degrade path is the design, not a fallback**. §7's feature detection keeps the legacy
  `progress` message compiled, reachable, and exercised — on every arena turn, every
  channel-root turn, every `minimal`/`low` turn, and every turn that runs no tools.
- The **promotion gate already provides the temporal separation** a flag would buy: a change
  reaches a prerelease environment first, soaks, becomes stable, and reaches production only
  through a manual promote.
- A flag's "off" state is indistinguishable from `streamingUnavailableUntil` being set, so it
  would double the test matrix for behavior no test can tell apart.

**Sequencing within the PR** is the natural dependency order: connection members and their
error classification → converger axis and card production → applier actions → `armSlackStream`
and the `onSuppress` / `onSettle` hooks → ingress filters → eval guard.

## 12. Open questions

**Q1. Does the container label read well after a long turn?** `Completed 41 steps` is honest
but not informative. A model-narrated label was rejected (a second call, and a label that can
disagree with the cards). If the count proves useless in practice, the next candidate is the
last tool's title rather than a summary — one more `plan_update`, no new mechanism.

**Q2. Should a `failed` tool card carry its error text as `output` on medium?** Today `output`
is a high-only rung, matching the legacy pipeline where tool output is high-only. A failure is
arguably different in kind from a result. Left as-is until someone asks: the card already says
`error`, and the high rung already shows the text.
