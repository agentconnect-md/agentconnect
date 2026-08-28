# Slack Native Streaming Turn Output

**Status:** Implemented — **chrome only**. A Slack turn's TOOL-CALL CHROME rides one native
`chat.startStream` card stream; the agent's answer does not, and the body pipeline is unchanged.
What came back is the _progress message_, rendered as a native plan card instead of a
`chat.postMessage` the daemon edits in place — not body streaming (§1). Layer 0's Agent Sessions
control surface ([#1462](https://github.com/agentconnect-md/agentconnect/pull/1462),
[#1471](https://github.com/agentconnect-md/agentconnect/pull/1471),
[#1563](https://github.com/agentconnect-md/agentconnect/pull/1563)) is untouched.

## 1. The revert, and what survives it

[#1483](https://github.com/agentconnect-md/agentconnect/pull/1483) /
[#1487](https://github.com/agentconnect-md/agentconnect/pull/1487) /
[#1489](https://github.com/agentconnect-md/agentconnect/pull/1489) put the answer and its tool
cards on ONE stream; [#1495](https://github.com/agentconnect-md/agentconnect/pull/1495) reverted
all three for the reason recorded in
[#1494](https://github.com/agentconnect-md/agentconnect/issues/1494): a channel stream is visible
live to exactly ONE recipient (`recipient_user_id`), and every other member of the thread sees an
italic "Thinking…" placeholder until it stops. For an ANSWER on a shared surface that is
unacceptable, nothing about the platform has changed, and **body streaming remains rejected**.

Applied to CHROME the same property is close to irrelevant: tool cards are the part of a turn a
reader most wants folded away, the placeholder is a truthful "working" signal for everyone else,
and the finished plan card lands for the whole channel at stop. So the answer keeps
`chat.postMessage` / `chat.update` exactly as today, and only the tool-call chrome becomes one
cards-only stream per turn. Because the body never rides it, everything the reverted design needed
in order to move an answer between transports is gone with it (§9).

## 2. Goals / Non-goals

**Goals.** Replace the in-place `progress` message with a native collapsed plan card on
medium/high turns; change **nothing** about the body (post / live-reply / final-live-reply,
response finalization by edit, the attribution footer, the transcript, the status bar, the
transient status text, permission and elicitation cards, attachments, the ACP plan message, the
high-mode Thinking message, tool-output code blocks); degrade to today's `progress` message
wherever streaming is unavailable, from Slack's own errors, with no config knob and no environment
kill switch; and leave Layer 0's stop seam, `setSessionLifecycle`, the manifest, the relay, the
control plane, the protocol, and every other platform alone.

**Non-goals.** Streaming the body (§1). Other platforms — Feishu's CardKit streaming is the
structural precedent this copies, not a thing it changes. Webchat, the Control Plane, and message
normalization: this is egress only, plus the two ingress filters in §8. Slack's feedback-buttons
block, which `chat.stopStream` accepts but AgentConnect has no sink for.

## 3. Pipeline

The seam is Feishu's CardKit one, reused: a converger axis emitting
`stream-start` / `stream-append` / `stream-stop`, a coalescing daemon timer (`armSlackStream`),
the applier resolving those actions, and the connection members `startTurnStream` /
`appendTurnStream` / `stopTurnStream` plus the `settleAndStop` unit of §6. The axis changes **one**
production rule — `tool_call` / `tool_call_update` emits card chunks instead of a `progress`
action — and adds a Thinking card on the thought branch; every other action, in every mode, is
byte-identical.

**The axis is decided at turn start**, in `createConverger(ctx)`, from a synchronous
`conn.streamingLikely()` read (§7) plus the two facts knowable in advance: the platform is Slack
and the turn has a thread. Output mode is the converger's own gate — only `medium` and `high`
render tool chrome at all.

**Opening is lazy.** `stream-start` is emitted by the first drain that has a card to show, so a
turn that runs no tools never calls `chat.startStream` and produces exactly the bytes it produces
today — which is why this is safe without a flag: the population it can affect is exactly the
population that would have seen a `progress` message. The terminal settle opens one too when the
turn's only tool ran and finished inside a single coalescing window, or such a turn would end with
no chrome at all.

**Cadence.** All calls ride the connection's single `PlatformSendQueue`, one enqueue each, never
calling another from inside a queued task (Layer 0's `setStatus` → `setSessionLifecycle` comment is
the precedent for that trap). `chat.appendStream` is Tier 4 against Tier 2 for start/stop, so
`armSlackStream(p)` coalesces as `armFeishuStream` does: one `SLACK_STREAM_FLUSH_MS` (750 ms) timer
survives a burst of tool updates and the append that fires carries the LATEST state of every dirty
card. No character threshold — there is no body to measure. `armIdle` / `IDLE_FLUSH_MS` is
untouched.

**Streams are bookkept per MESSAGE, not per conversation.** One connection can host sibling turns
in the same (channel, thread) — same-message multi-agent fan-out, and displacement deliberately
lets the displaced turn coexist while it settles — so a conversation key would let the second open
orphan the first and leave it streaming forever.

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
   a settle append — all open cards written to their real terminal status, plus a final
   `plan_update` — and the two travel as ONE indivisible unit (§6). Normal turn end: all
   `complete`, title `Completed N steps`, with `· M failed` appended when M cards ended in
   error — counted from the cards the turn emitted, never narrated by the model. Cancel / user
   Stop / suppression: in-flight cards → `error`, title `Stopped` (an explicit title survives
   error-status cards; verified).
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

**The settle and the stop are one indivisible unit, owned by the CONNECTION.** They cannot be two
actions: a settle refused transiently would fall through to a stop that still has `in_progress`
cards, which is exactly the "Something went wrong" state §4 fact 3 forbids. And the retry cannot
belong to the turn, because `Pending` — its only owner — is dropped at turn settlement, so a stop
that failed twice would have nobody left to retry it. `SlackConnection.settleAndStop(stream,
settle, options)` therefore appends the settle, stops only if that landed, and re-arms itself on a
bounded backoff (a handful of attempts over a few minutes) keeping the settle content verbatim.
Past that the row is stuck for a reason retrying cannot fix. The applier retires the turn's handle
the moment it hands the pair over, so the turn can never race the sweep.

Three prohibitions, all about a stream that is already dead:

- **No append after a definite dead-stream answer.** `stopped_by_user` or
  `message_not_in_streaming_state` retires the handle immediately and cancels any owed stop —
  the message is settled, so the stop is moot.
- **No second stop.** The handle is dropped the moment Slack accepts a stop, or proves the
  message was already settled.
- **No replacement message.** A dead chrome stream is not re-opened and its cards are not
  re-posted as prose. Chrome is lossy-tolerant; the answer never depended on it.

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

**A send-queue timeout is INDETERMINATE, not a refusal.** `PlatformSendQueue` rejects at 30 s
while the queued task keeps running, so a timed-out `chat.startStream` may still open a message —
after the turn has already degraded and stopped watching. The open's real answer is therefore kept
on its own promise: if a `ts` arrives late, the connection immediately settles and stops that
stream itself. A resolved `ts` is never left unowned; the alternative is a working row nobody can
ever close.

**Structural carve-outs**, decided before the call is attempted: no `thread_ts` (§4 fact 2), and
output mode below `medium`. That is the whole list. There is no shareable-bot carve-out and no
non-human-turn carve-out — §4 fact 9 removed the reason for the second, and §1's split removed
the reason for the first.

**Degrade is cheap, because the body never moved.** A turn whose `chat.startStream` fails falls
back to today's `progress` message for the rest of the turn: each `stream-append`, and the
terminal `stream-stop`, carries the legacy `progress` rendering it would have produced, so the
applier renders that instead. Task chunks are NEVER rendered as prose — a thinking-only batch
carries no legacy text and shows nothing, which is what it shows today. A mid-turn append failure
is even cheaper: that card update is dropped and the handle is kept.

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

Each existed only because the BODY rode the stream, and each is deleted rather than deferred: the
12,000-character rollover and the `reanchorStream` re-anchor rollover (a markdown block caps at 12k
and a streamed ANSWER had to move below a card posted under it — cards have neither problem); the
fallback body buffer and its response-ownership flag (a refused append still owed the ANSWER to the
channel by another route); the shareable-bot carve-out and the ingress finalization-from-metadata
lift it required (A2A routing reads the finalization edit, which the body's finalization still
rides); stop-time §5.5 finalization and its `blocks`; the legacy loading-row re-issue choreography
and `setLoadingStatus` (a body-streaming turn owned the whole status slot; a chrome one does not);
and `disableStreaming()` mid-turn demotion (the axis owned a display cursor; the applier now owns
the whole degrade). `staleReplyFooters`, `finalizeSlackResponse`, `closeSlackResponse` and the
`attribution` action all still work as they did before #1483.

## 10. Blast radius

**No manifest change** — `chat:write` covers streaming, `agent_view` is the declared feature, and
`agent_session_stopped` was subscribed by Layer 0. **No protocol, relay, control-plane or web
change** — no frame member, no `SlackHttpIngest` branch, no schema, no DTO; both transports get
this for free because it is egress plus two daemon-local ingress filters. **Unchanged:** the other
platforms' convergers and appliers, webchat, `@agentconnect.md/message` normalization, the
transcript contract, the session status bar, the status text and session enum, permission and
elicitation cards, attachments, §5.5 routing semantics, and the body pipeline in full.

The **eval connection-surface guard** reflects over `SlackConnection.prototype`, so
`VirtualSlackConnection` implements `startTurnStream` (returning "unsupported", which
deterministically sends every arena turn down the legacy path and keeps every baseline
byte-identical) plus no-op `appendTurnStream` / `stopTurnStream` / `settleAndStop` /
`streamingLikely` stubs; the private helpers behind them are `EXEMPT` (TypeScript `private` is
erased). `collaboration-arena-baseline.md` pins that file's test count.

## 11. Rollout and open questions

One PR carries the code and this document; §10 establishes the manifest needs nothing. **No kill
switch and no code flag:** the degrade path IS the design and is exercised on every arena turn,
every channel-root turn, every `minimal`/`low` turn and every turn that runs no tools; the
promotion gate already provides the temporal separation a flag would buy; and a flag's "off" state
is indistinguishable from `streamingUnavailableUntil` being set.

Two cosmetic questions stay open. **Does the counted label read well after a long turn?**
`Completed 41 steps` is honest but not informative; a model-narrated label was rejected (a second
call, and a label that can disagree with the cards), and the next candidate is the last tool's
title. **Should a `failed` card carry its error text as `output` on medium?** Today `output` is a
high-only rung, matching the legacy pipeline; the card already says `error`.
