import type { CreateElicitationRequest, RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import {
  ELICIT_ACTION_PREFIX,
  ELICIT_CONFIRM_ACTION,
  ELICIT_DISMISS_ACTION,
  ELICIT_FORM_FIELD_CAP,
  ELICIT_FORM_INPUT_ACTION,
  PERMISSION_ACTION_PREFIX,
  SLACK_STATUS_ACTION,
  elicitFormBlockId,
  elicitFormBlockIndex,
  encodePermValue,
  encodeSlackStatusOverflowValue
} from '@agentconnect.md/protocol'
export {
  ELICIT_ACTION_PREFIX,
  ELICIT_CONFIRM_ACTION,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  decodePermValue,
  elicitFormBlockId,
  elicitFormViewValues,
  encodePermValue,
  type SlackViewState
} from '@agentconnect.md/protocol'
import { renderAttributionMessage, type ReplyAttributionInfo } from '../messages/attribution.js'
import { flattenUnsafeLinks, referenceBufferStart } from '../messages/agent-links.js'
import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { AgentMessageRun } from '../messages/message-boundary.js'
import { splitAtParagraphBoundary } from '../messages/stream-boundary.js'
import { permissionModeDisplayLabel } from '../acp/permission-modes.js'
import { splitIntoSections } from './formatter.js'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'
import { extractToolOutput } from '../session/tool-output.js'

/**
 * The mode-aware ACP→Slack intermediate representation (§9.1). The daemon's
 * applyAction resolves these against a live SlackConnection:
 *  - `post`        a finalized body/result section → chat.postMessage in the thread.
 *  - `notice`      a system line (e.g. the done footer) posted to the thread but not recorded.
 *  - `set-status`  the transient working indicator (agents.sessions.setStatus; text = on/off only).
 *  - `set-title`   the native Slack app-thread title (agents.sessions.rename).
 *  - `progress`    the SINGLE in-place "main progress" message (medium/high) — posted
 *                  once then chat.update-ed in place as tool activity changes (in-place update).
 *  - `reasoning`   the SINGLE in-place reasoning "context block" (high only) — the
 *                  agent's accumulated thinking, edited in place as more arrives. Kept
 *                  separate from `progress` so reasoning and tool activity never
 *                  overwrite each other on one message (§9.1 agent_thought_chunk).
 *  - `plan`        the SINGLE in-place plan-summary message (medium/high).
 *  - `tool-output` a finished tool call's output as a code block (high only) — posted
 *                  to the thread but NOT recorded (the TranscriptRecorder captures tool
 *                  rows independently; this is live chrome, not the agent's words).
 */
export type SlackAction =
  // `post` carries the agent's own reply text (a flushed message buffer) — the daemon
  // posts it AND records it into the thread transcript (sender = agentId), so other
  // agents replaying the thread see what this one actually said. `attributed: false`
  // is reserved for daemon-generated failure notices that use the same transcript path.
  // `recordOnly: true` writes the text to the transcript WITHOUT posting to the channel —
  // used by `minimal` mode to keep the full audit trail while the channel shows only the
  // single collapsed `live-reply` message.
  // `terminal: true` marks the LAST body section of the turn's final flush: the complete
  // response is known when it posts, so the applier can stamp it `final` at birth
  // (send-message-routing-rework.md §5.5) instead of re-editing it after delivery.
  | { kind: 'post'; text: string; attributed?: boolean; recordOnly?: boolean; terminal?: boolean }
  // `live-reply` is `minimal` mode's single, in-place agent reply: posted once then
  // chat.update-ed as the turn streams (same post-once/edit-thereafter contract as
  // `progress`), collapsing what would otherwise be many `post` messages into one that
  // settles on the final answer. Display only — NOT recorded (the paired `recordOnly`
  // posts carry the full text to the transcript).
  | { kind: 'live-reply'; text: string }
  // `final-live-reply` settles minimal mode with the complete final segment. The daemon
  // splits it across Slack messages when it exceeds one markdown block, preserving all
  // content while keeping the common case to one in-place message.
  | { kind: 'final-live-reply'; text: string }
  // `notice` is a system line the daemon posts but must NOT record — recording it would
  // replay daemon chrome back to agents as thread context.
  | { kind: 'notice'; text: string }
  | { kind: 'set-status'; text: string }
  | { kind: 'set-title'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; text: string; blocks: unknown[] }
  // `tool-output` posts a finished tool's output (code block) but is NOT recorded — same
  // post-but-don't-record contract as `notice`.
  | { kind: 'tool-output'; text: string }
  // `status-bar` is the session-scoped status line (model / context / tokens / cost)
  // rendered as an interactive Block Kit row. Posted once for the Slack session (after
  // the ACP session is up, before the reply), then chat.update-ed in place as later
  // turns progress. `text` is the notification/accessibility fallback; `blocks` is the
  // Block Kit payload. Shown when the Agent's status-bar setting is enabled. NOT
  // recorded into the transcript.
  | { kind: 'status-bar'; text: string; blocks: unknown[] }
  // Remove a status row left by an earlier turn after the Agent disables it. The daemon
  // clears the persisted ts only after Slack accepts the delete, so a transient failure
  // can retry on the next turn.
  | { kind: 'clear-status-bar' }
  // `attribution` closes the footer lifecycle after the latest reply section was first
  // posted with it. The daemon uses this boundary to retry stale-footer cleanup or refresh
  // final metadata that changed during the prompt. Not transcript content.
  // `standalone` (minimal mode only): finalize the footer kept on the live reply.
  | { kind: 'attribution'; text: string; blocks: unknown[]; standalone?: boolean }
  // ── Native tool-call chrome (slack-streaming-turn-output.md §3) ──────────────
  // On a medium/high turn the in-place `progress` message becomes ONE cards-only
  // `chat.startStream` stream. The BODY never rides it: posts, live replies, the
  // footer, the transcript and the status calls are all unchanged.
  | { kind: 'stream-start' }
  // `progressText` is the same in-place `progress` rendering this batch would have
  // produced, so a turn whose stream never opened degrades to today's message.
  | { kind: 'stream-append'; chunks: SlackStreamChunk[]; progressText?: string }
  // The terminal settle rides the STOP rather than a preceding append, because the two
  // cannot be split: stopping while cards are still `in_progress` makes Slack render
  // "Something went wrong", so a refused settle has to hold its own stop back.
  | { kind: 'stream-stop'; settle: SlackStreamChunk[]; progressText?: string }

/**
 * The chunk vocabulary `chat.appendStream` accepts, as `@slack/types` declares it. No
 * `markdown_text` is ever sent — this stream carries chrome only.
 *
 * The FIELD SEMANTICS are not uniform, and that is the load-bearing fact here: `title` and
 * `status` REPLACE per id, while `details` and `output` APPEND server-side. Refreshing an
 * appending field per update concatenates on Slack's side rather than replacing — which is
 * how repeated `**bold**` fragments once ran together into literal `****`. So both bodies are
 * written EXACTLY ONCE, when the call completes; only `title` and `status` are ever refreshed.
 *
 * Both bodies are markdown (verified live 2026-08-29): a fenced value renders as a real code
 * block, which is what puts the command in `details` and its result in `output`. Slack accepts
 * far more than the documented 256 characters but SILENTLY DROPS an oversized field, so
 * everything is capped here rather than trusting an error.
 */
export type SlackStreamChunk =
  | {
      type: 'task_update'
      id: string
      title: string
      status: 'in_progress' | 'complete' | 'error'
      details?: string
      output?: string
    }
  // The collapsed container's own label. `plan` display mode renders every task card inside
  // one collapsed-by-default block, and this is the line the reader sees on it (§4).
  | { type: 'plan_update'; title: string }

/** Dynamic identity shown under the last reply section. All Slack integration modes use
 *  the same compact `context` footer so shared-bot attribution never looks like body text
 *  or causes its console links to sprout rich previews. */
export type SlackAttributionInfo = ReplyAttributionInfo

const THINKING = 'is thinking…'
const WORKING = 'is working…'
const MAX_LABEL = 100
const MAX_STATUS = 50
// A deliberately compact cap for the reasoning block (well under Slack's markdown-block
// limit) — it's a live "current thinking" view, not the main content, so keep only the
// newest tail and mark a drop with a leading ellipsis. The raw buffer is soft-capped at
// 2× so it can't grow unbounded across a long turn.
const MAX_REASONING = 2800
// Every streaming card field caps at 256 characters ON THE WIRE, per chunk. Because nothing
// appending is ever re-sent, a clamped field is also the card's final size.
const MAX_STREAM_TASK = 256
// A card title is a ONE-LINE step label, so it is clamped far below the wire cap: Slack wraps
// a long title into a paragraph of shell instead of truncating it, and there is no hover or
// per-title disclosure to recover the rest. The verbatim command rides the card's code block.
const MAX_CARD_TITLE = 72
// A COMMAND standing in for a missing description is clamped tighter still — Slack's thread
// panel fits roughly this much on one line (the channel view fits more, mobile less) — and cut
// at its first shell separator first: the opening command of a `&&` chain is a far better
// label than 72 characters of run-on shell. The full chain rides the card's code block.
const MAX_COMMAND_TITLE = 48
const SHELL_SEPARATOR = / (?:&&|\|\||;|\|) /
/** The card that stands for one thinking run until its first line names it. */
const THINKING_CARD = 'Thinking'
// How much of a thinking run to hold while waiting for its first line to end. A runtime opens
// a thought with a short `**heading**`, so this only ever buffers one line's worth.
const MAX_THINKING_HEAD = 400
/** The collapsed container's label while the turn is still working (§4). */
const STREAM_PLAN_WORKING = 'Working…'
/** …and after a cancel, a user Stop, or suppression — the in-flight cards settle as errors. */
const STREAM_PLAN_STOPPED = 'Stopped'
/** …and after the RUNTIME dies mid-turn. Same error settle as a stop — the in-flight step did
 *  not finish because the turn ended — under the label that says which way it ended. */
const STREAM_PLAN_FAILED = 'Failed'
/** A failed tool's title prefix — words, not card status: any `error` card reddens the whole
 *  container (the icon is derived, verified live 2026-08-29), and the title parses no markdown
 *  and no shortcodes, so plain text is the entire palette. */
const FAILED_PREFIX = '(failed) '

export function clampTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Drop paired bold markers, keeping every other kind of markdown. Card bodies parse markdown,
 *  and runtimes write each thought heading as `**heading**` — content worth keeping, shouting
 *  not. Bounded to a line so a stray `**` cannot swallow text across paragraphs. */
function stripBoldMarks(s: string): string {
  return s.replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/__([^\n]+?)__/g, '$1')
}

/** Flatten markdown emphasis for a card field. Task titles and plan labels render as PLAIN
 *  text, so `**bold**` would arrive as literal punctuation rather than styling. */
function plainCardText(s: string): string {
  return s
    .replace(/```[\s\S]*?```|`([^`]*)`/g, '$1')
    .replace(/[*_~]{1,3}(?=\S)([\s\S]*?\S)[*_~]{1,3}/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clampLabel(s: string): string {
  return clampTo(s, MAX_LABEL)
}

/** Wrap tool activity (a command line, tool title, or tool output) in a CommonMark code
 *  span so it renders monospace and verbatim — Slack posts these as `markdown` blocks, so
 *  unwrapped text with `*` / `_` / `#` would otherwise be interpreted as emphasis. A
 *  single-line value uses an inline span, multi-line (or `block`-forced) a fenced block;
 *  the delimiter is grown past the longest internal backtick run so values containing
 *  backticks stay intact (CommonMark's variable-length fence rule). */
function codeSpan(s: string, block = false): string {
  const text = s.trim()
  if (!text) return ''
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  if (block || text.includes('\n')) {
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${fence}\n${text}\n${fence}`
  }
  const ticks = '`'.repeat(longestRun + 1)
  // Pad when the content touches a backtick so the delimiters stay unambiguous.
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

// Head-clamp a finished tool's output for the channel. Kept well under Slack's
// markdown-block limit (so the whole code block posts as one intact message — a
// fence split across sections would break) and head-kept because the start of a
// command's output is usually the most informative; truncation is marked with an
// ellipsis. Empty/whitespace output yields ''.
const MAX_TOOL_OUTPUT = 2800
function capOutput(s: string): string {
  const t = s.trim()
  return t.length > MAX_TOOL_OUTPUT ? `${t.slice(0, MAX_TOOL_OUTPUT - 1)}…` : t
}

/**
 * A tool call's own TOP-LEVEL `rawInput` string, when the runtime sent one — the envelope a
 * runtime writes about its call, never the call's payload.
 *
 * A nested `arguments` object is deliberately NOT read: those keys belong to the tool, and a
 * tool is free to mean something else entirely by them. `createCodeHostMergeRequest` takes a
 * whole merge-request body as `arguments.description`, which is a document, not a step label.
 */
function rawInputField(update: { rawInput?: unknown }, key: 'command' | 'description'): string {
  const raw = update.rawInput as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return ''
  return typeof raw[key] === 'string' ? raw[key].trim() : ''
}

/** Whether a runtime's description can stand as a card's one-line label. Even at the top level
 *  this is a string we did not author, so it has to LOOK like a label — one line, and short
 *  enough that clamping it would not be hiding most of it. */
function isStepLabel(s: string): boolean {
  return s.length > 0 && s.length <= MAX_CARD_TITLE * 2 && !s.includes('\n')
}

/** Escape interpolated labels before embedding them in Slack mrkdwn. `|` is a link-label
 *  delimiter, so replace it rather than letting a configured display name break the URL. */
function escapeMrkdwnLabel(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '¦')
}

const MAX_SLACK_LINK_URL_LENGTH = 2_048

/** Validate an interpolated Slack link target without normalizing it. Slack parses
 *  `<url|label>` itself, so delimiters, controls, and whitespace must never reach
 *  that syntax even when the platform URL was derived from configuration. */
function safeSlackLinkUrl(raw?: string): string | undefined {
  if (!raw || raw.length > MAX_SLACK_LINK_URL_LENGTH || /[<>|\s\p{Cc}]/u.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return raw
  } catch {
    return undefined
  }
}

function attributionText(info: SlackAttributionInfo): string {
  const sessionUrl = safeSlackLinkUrl(info.sessionUrl)
  return renderAttributionMessage({
    agent: info.botName,
    runtime: info.runtime,
    model: info.model,
    renderSession: sessionUrl ? (label) => label : undefined,
    notice: info.notice
  })
}

function attributionMrkdwn(info: SlackAttributionInfo): string {
  const botName = escapeMrkdwnLabel(info.botName)
  const runtime = escapeMrkdwnLabel(info.runtime)
  const model = escapeMrkdwnLabel(info.model)
  const botUrl = safeSlackLinkUrl(info.botUrl)
  const sessionUrl = safeSlackLinkUrl(info.sessionUrl)
  return renderAttributionMessage({
    agent: botUrl ? `<${botUrl}|${botName}>` : botName,
    runtime,
    model,
    renderSession: (label) => (sessionUrl ? `<${sessionUrl}|${escapeMrkdwnLabel(label)}>` : undefined),
    notice: info.notice ? escapeMrkdwnLabel(info.notice) : undefined
  })
}

/** The per-turn footer is a compact secondary/gray Slack `context` block. Exported so
 *  the daemon can include it in the reply's initial chat.postMessage (the only reliable
 *  point at which Slack's unfurl controls apply). */
export function buildAttributionBlocks(info: SlackAttributionInfo): { text: string; blocks: unknown[] } {
  return {
    text: attributionText(info),
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: attributionMrkdwn(info) }] }]
  }
}

type PlanEntry = { content?: string; status?: 'pending' | 'in_progress' | 'completed' }

/** A plan entry is a task title, not a paragraph. Slack imposes no length on a rich-text
 *  list item (200 items of 3,000 characters all post fine), so this cap is editorial: it
 *  keeps one runaway entry from swallowing the message. */
const MAX_PLAN_LABEL = 150

/** Render an ACP plan (full entry list, resent on every update) as a native bulleted list:
 *  completed entries struck through, the entry in flight bolded, the rest plain, under a
 *  `Plan · n/m` heading and ruled top and bottom so it reads as the turn's own artifact
 *  rather than one more chrome message in the thread.
 *
 *  Deliberately NOT Block Kit `checkboxes`, which is the prettier first instinct: that
 *  element is an INPUT with no read-only variant, so it offers a click that can do nothing —
 *  the plan belongs to the agent, and a reader ticking a box states nothing the daemon should
 *  believe. It also caps at 10 options and 150 characters per label, both ENFORCED rather
 *  than truncated. A struck-through line says "done" just as plainly and promises nothing.
 *
 *  `text` is the notification/fallback string, never displayed when the blocks render. */
function renderPlan(entries: PlanEntry[]): { text: string; blocks: unknown[] } {
  const done = entries.filter((e) => e.status === 'completed').length
  const item = (entry: PlanEntry) => ({
    type: 'rich_text_section',
    elements: [
      {
        type: 'text',
        text: clampTo(entry.content ?? '', MAX_PLAN_LABEL),
        ...(entry.status === 'completed'
          ? { style: { strike: true } }
          : entry.status === 'in_progress'
            ? { style: { bold: true } }
            : {})
      }
    ]
  })
  // The fallback is NOT dead weight beside the blocks: Slack routes top-level `text` to screen
  // readers and to the notification preview, and reads neither from the interior blocks. Left
  // as the bare count it would be the one place the plan does not exist for those two readers,
  // which is a regression against the text renderer this replaces. Statuses spell out as words
  // rather than glyphs, because that is the form being read ALOUD.
  const spoken = (status?: string) =>
    status === 'completed' ? 'done' : status === 'in_progress' ? 'in progress' : 'to do'
  return {
    text: [
      `Plan · ${done}/${entries.length}`,
      ...entries.map((e) => `${spoken(e.status)}: ${clampTo(e.content ?? '', MAX_PLAN_LABEL)}`)
    ].join('\n'),
    blocks: [
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*Plan* · ${done}/${entries.length}` }] },
      { type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'bullet', elements: entries.map(item) }] },
      { type: 'divider' }
    ]
  }
}

/** Render the accumulated reasoning trace (high mode) as one in-place message. Posted as
 *  a `markdown` block (verbatim CommonMark, so `**bold**`), tail-clamped to a compact cap
 *  — the newest thinking is the most relevant, so keep the end and mark truncation with a
 *  leading ellipsis. */
function renderReasoning(buf: string): string {
  const trimmed = buf.trim()
  const tail = trimmed.length > MAX_REASONING ? `…${trimmed.slice(-MAX_REASONING)}` : trimmed
  return `:thought_balloon: **Thinking**\n${tail}`
}

/** The session status-bar inputs: the model selector (distilled by the daemon) plus the
 *  folded ACP usage snapshot. Every field is optional — a runtime may advertise no model,
 *  and context/token/cost each arrive on their own cadence (context/cost stream live;
 *  token totals refresh at turn end). */
export interface StatusBarInfo {
  model?: string
  effort?: string
  /** Effective session permission preset. Codex Auto is a composite value, not a raw ACP mode. */
  permissionMode?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
  costAmount?: number
  costCurrency?: string
  // Selectable model / effort lists + whether a fast toggle is offered — the modal's
  // dropdowns/toggle (and the console's, carried on the webchat frame). renderStatusBar
  // ignores these; only buildStatusModal / the web bar consume them.
  models?: string[]
  efforts?: string[]
  /** Selectable session presets; may include the synthetic Codex Auto value. */
  permissionModes?: string[]
  fastModeAvailable?: boolean
  /** A message sent during this turn can be steered into it (webchat status only). */
  steerable?: boolean
  // Current Slack output verbosity (daemon-side minimal/low/medium/high). Modal-only selector;
  // the level set is a fixed enum, so there's no "available" list. renderStatusBar ignores it.
  outputMode?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  sessionId?: string
  // Full token breakdown — shown in the Slack modal's detail block (the compact line only
  // shows totalTokens). All optional; absent fields are simply omitted from the detail.
  inputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

/** Concrete agent identity shown at the top of the Session modal. Kept separate from
 *  StatusBarInfo so agent chrome never leaks into the compact status/webchat payload. */
export interface StatusModalIdentity {
  name: string
  agentUrl?: string
  iconUrl?: string
  sessionTitle?: string
}

/** Compact a token count as `1.2k` / `3.4M` (whole numbers under 1000 stay verbatim). */
function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Render the compact in-thread status line as one `markdown` block — e.g.
 *  `:bar_chart: *opus-4.8* · fast · ctx 120k/200k (60%) · 45.2k tok`. Deliberately narrow:
 *  effort and cost are omitted here (they live in the Configure modal) to keep the line short in a
 *  Slack thread. Pure: unknown fields are dropped so a partial snapshot still yields a clean
 *  line, and an empty snapshot degrades to a bare `:bar_chart: —` placeholder. */
export function renderStatusBar(info: StatusBarInfo): string {
  const parts: string[] = []
  if (info.model) parts.push(`*${info.model}*`)
  if (info.fastMode) parts.push('fast')
  if (info.contextUsed !== undefined && info.contextSize !== undefined && info.contextSize > 0) {
    const pct = Math.round((info.contextUsed / info.contextSize) * 100)
    parts.push(`ctx ${compactCount(info.contextUsed)}/${compactCount(info.contextSize)} (${pct}%)`)
  } else if (info.contextUsed !== undefined) {
    parts.push(`ctx ${compactCount(info.contextUsed)}`)
  }
  if (info.totalTokens !== undefined) parts.push(`${compactCount(info.totalTokens)} tok`)
  return `:bar_chart: ${parts.length ? parts.join(' · ') : '—'}`
}

/** Slack action_ids for the interactive status bar + modal. The protocol owns the
 *  values because a shared bot receives the same actions on the relay first. */
export const STATUS_ACTION = SLACK_STATUS_ACTION

/** URL-only OAuth button. Direct Socket Mode bots still receive its interaction
 * payload and must ACK it; shared HTTP bots are ACKed by the relay ingress. */
export const PERMISSION_UPDATE_ACTION = 'ac_update_permissions'

/** The modal view's callback_id — used if we ever handle a submit (controls apply on
 *  interaction today, so there's no submit). */
export const STATUS_MODAL_CALLBACK = 'ac_status_modal'

/** Human label for the tool a permission request is about. ACP's `toolCall.title` is the
 *  intended display string, but some runtimes (e.g. codex) omit it at request time — fall
 *  back to the tool `kind`, then the `toolCallId`, then a generic phrase. */
function permToolLabel(params: RequestPermissionRequest): string {
  const tc = params.toolCall
  const label = tc?.title?.trim() || tc?.kind?.trim() || tc?.toolCallId?.trim() || 'a tool call'
  return clampTo(label, 200)
}

/** Slack button color for a permission option: green for allow, red for reject, default
 *  (gray) for anything else the runtime might send. */
function permOptionStyle(kind: string): 'primary' | 'danger' | undefined {
  if (kind === 'allow_once' || kind === 'allow_always') return 'primary'
  if (kind === 'reject_once' || kind === 'reject_always') return 'danger'
  return undefined
}

/**
 * Build the interactive permission-request card: a header naming the tool the agent
 * wants to run, and an actions row of buttons — one per ACP PermissionOption, green for
 * allow / red for reject. The choice rides each button `value` (`<requestId>|<optionId>`);
 * `requestId` ties the click back to the pending ACP request. Options are capped at 5
 * (Slack renders at most 5 buttons cleanly on one row). Pure — safe to unit-test.
 */
export function buildPermissionCard(
  requestId: string,
  params: RequestPermissionRequest,
  sessionTarget?: string
): unknown[] {
  const header = `:lock: *Permission requested* — ${permToolLabel(params)}`
  const buttons = params.options.slice(0, 5).map((o, i) => {
    const style = permOptionStyle(o.kind)
    return {
      type: 'button',
      action_id: `${PERMISSION_ACTION_PREFIX}:${i}`,
      text: { type: 'plain_text', text: clampTo(o.name, 75), emoji: true },
      value: encodePermValue(requestId, o.optionId),
      ...(style ? { style } : {})
    }
  })
  return [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'actions', ...(sessionTarget ? { block_id: sessionTarget } : {}), elements: buttons }
  ]
}

/**
 * Build the RESOLVED permission card (buttons removed) that replaces {@link
 * buildPermissionCard} in place once a choice is made — or when the turn is cancelled.
 * `decision` is the human label of what happened; `allowed` picks the icon (undefined ⇒
 * a neutral ⌛ for cancelled/expired). Pure.
 */
export function buildPermissionResolvedCard(
  params: RequestPermissionRequest,
  decision: string,
  allowed?: boolean
): unknown[] {
  const icon = allowed === undefined ? ':hourglass:' : allowed ? ':white_check_mark:' : ':no_entry_sign:'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:lock: *Permission* — ${permToolLabel(params)}\n${icon} ${decision}` }
    }
  ]
}

/** Context header for an approval DM (slack-approval-dm.md §5.2): which agent is
 * asking, who triggered the turn, a quote of the triggering Slack message, the
 * console session deep link, and a permalink to the source thread. Pure. */
export function buildApprovalDmIntro(info: {
  agentName: string
  requesterName?: string | null
  sessionUrl: string
  sourceUrl?: string
  sourceText?: string
}): unknown[] {
  const requester = info.requesterName ? ` for *${clampTo(info.requesterName, 60)}*` : ''
  // Quoted on every line so a multi-line message stays one visual quote block.
  const quote = info.sourceText?.trim()
    ? `\n${clampTo(info.sourceText.trim(), 300)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`
    : ''
  const links = [`<${info.sessionUrl}|Open session>`, ...(info.sourceUrl ? [`<${info.sourceUrl}|Source thread>`] : [])]
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${clampTo(info.agentName, 60)}* is waiting on an approval${requester}.${quote}\n${links.join(' · ')}`
      }
    }
  ]
}

/** Terminal rewrite for a DM card orphaned by a restart or takeover (§5.4): only the
 * stored row survives, so this renders from its bounded summary, no ACP params. Pure. */
export function buildApprovalOrphanCard(command: string, status: string, resolvedByName?: string | null): unknown[] {
  const icon = status === 'allowed' ? ':white_check_mark:' : status === 'denied' ? ':no_entry_sign:' : ':hourglass:'
  const by = resolvedByName ? ` by ${clampTo(resolvedByName, 60)}` : ''
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:lock: *Permission* — ${clampTo(command, 150)}\n${icon} ${status}${by}` }
    }
  ]
}

/** A workspace-level OAuth warning shown when Slack rejects an API call with
 * `missing_scope`. The URL button needs no daemon-side action handling: Slack opens
 * the app's OAuth & Permissions page directly so an owner can update/reinstall it. */
export function buildPermissionUpdateCard(updateUrl: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: *Permissions update required.* Please update and re-authorize this Slack app to ensure all features work correctly.'
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update permissions', emoji: true },
          style: 'primary',
          url: updateUrl,
          action_id: PERMISSION_UPDATE_ACTION
        }
      ]
    }
  ]
}

// ── Elicitation (ACP elicitation/create — structured questions) ──────────────

/** The field shapes an elicitation card can reduce a form to. `multi-enum` answers with a
 *  LIST of the chosen values, `number` with a real JS number, the rest with one scalar. */
export type ElicitKind = 'enum' | 'boolean' | 'multi-enum' | 'text' | 'number'

/** What a surface declares it is able to render — the field kinds it has controls for, and the
 *  most options one of those controls may offer. {@link elicitTarget} skips every property the
 *  surface has not claimed on either count, so a kind (or an option list) reaches a surface only
 *  once that surface claims it, and a form it cannot show whole is declined rather than trimmed.
 *  Every surface limit belongs here: a limit left inside a card builder is one the reduction
 *  cannot see, which is exactly how an over-long option list used to be quietly cut to fit. An
 *  option's own LENGTH is not among them any more — a Slack card carries positions rather than
 *  values ({@link elicitOptionToken}), so no surface refuses a long one (#1794). */
export interface ElicitSurface {
  kinds: ReadonlySet<ElicitKind>
  /** Per-kind option limits, because one surface's controls do not all hold the same list: on
   *  Slack a row of buttons and a select menu do not take the same number of options. A kind
   *  absent from the map is unlimited — webchat renders them all. Widening one kind's limit
   *  never widens another's. */
  optionLimits?: Partial<Record<ElicitKind, { maxOptions?: number }>>
}

/** Slack allows 25 elements in one `actions` block and wraps them across lines, so the card can
 *  offer every option of a list this long and still keep its Dismiss button. A longer list is
 *  declined: no card is built from a slice of it, which is what made a pick a misreported answer. */
const SLACK_ELICIT_MAX_BUTTONS = 24

/** Slack's own cap on a select menu's `options`. */
const SLACK_SELECT_MAX_OPTIONS = 100

const ELICIT_OPTION_TOKEN_PREFIX = 'ac_o'

/** The value one option carries ON A SLACK CARD: its POSITION in the field the card rendered,
 *  never the option's own value. Slack caps an option object's `value` at 75 characters and a
 *  button's at 2000, so an enum of paths, ids or a long URL could not carry its own answer and
 *  was declined outright (#1794). A position always fits, and it resolves without a lookup table
 *  to keep: the same trick {@link elicitFormBlockId} already uses for a field's block id, and
 *  safe for the same reason — the daemon re-derives the field list from the card's own params
 *  (#1815), so the position names the very option that was offered. Every Slack card carries
 *  positions, so a token can never be mistaken for a literal one of its own options spells. */
export function elicitOptionToken(index: number): string {
  return `${ELICIT_OPTION_TOKEN_PREFIX}${index}`
}

/** The option one carried card value stands for, or null when it names none this field offered —
 *  the server-side half of {@link elicitOptionToken}, and the only way a Slack answer becomes a
 *  literal again. Pure. */
export function elicitOptionLiteral(target: ElicitTarget, carried: string): string | null {
  if (!carried.startsWith(ELICIT_OPTION_TOKEN_PREFIX)) return null
  const digits = carried.slice(ELICIT_OPTION_TOKEN_PREFIX.length)
  if (!/^\d+$/.test(digits)) return null
  return target.options[Number(digits)]?.value ?? null
}

/** The literals a card's carried option value(s) stand for — `carried` unchanged for a field that
 *  offers no options, and null when one of them names no option this field rendered, which is the
 *  same verdict `fieldAccepts` reaches for an unoffered value. Pure. */
export function elicitCardValues(target: ElicitTarget, carried: string | string[]): string | string[] | null {
  if (!target.options.length) return carried
  if (!Array.isArray(carried)) return elicitOptionLiteral(target, carried)
  const out: string[] = []
  for (const one of carried) {
    const literal = elicitOptionLiteral(target, one)
    if (literal === null) return null
    out.push(literal)
  }
  return out
}

/** Slack renders a lone single-select or boolean as a row of buttons — one tap answers it — and
 *  every other shape as `input` blocks in the message with one Confirm, since a select, a
 *  checkbox list and a typed box all need something filled in before they can submit. The
 *  option-taking controls carry different lists, which is why the limits are per kind rather than
 *  one number for the surface. */
export const SLACK_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: SLACK_ELICIT_MAX_BUTTONS },
    'multi-enum': { maxOptions: SLACK_SELECT_MAX_OPTIONS }
  }
}

/** The approval DM's card is a button row whose taps settle through the editor path, which holds
 *  no per-card state — so every kind that needs a Confirm to submit could be shown there but never
 *  confirmed, and all of them are withheld rather than posted dead. What is left is exactly the
 *  one-tap half of the in-channel Slack surface. */
export const SLACK_DM_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: { enum: { maxOptions: SLACK_ELICIT_MAX_BUTTONS } }
}

/** Webchat's card has toggles, a confirm control and a typed input, so it takes every kind,
 *  and its list scrolls, so it declares no option limit. */
export const WEBCHAT_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number'])
}

/** The auth CLI drives a real terminal: an arrow-key list for the pickable kinds and a typed
 *  line for the rest, so it claims every kind, and its list scrolls like webchat's — no limit. */
export const CLI_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'multi-enum', 'text', 'number'])
}

/** The `format` values MCP `2025-11-25` defines for an elicited string — exactly these four. */
export type ElicitFormat = 'email' | 'uri' | 'date' | 'date-time'
const ELICIT_FORMATS: readonly ElicitFormat[] = ['email', 'uri', 'date', 'date-time']

/** The one form field an elicitation card renders as buttons. */
export interface ElicitTarget {
  /** Property name in the form schema — the key the accepted value is returned under. */
  propName: string
  kind: ElicitKind
  /** Selectable options: `value` is the wire value returned in the accept content,
   *  `label` is the human button text. Empty for `text`/`number`, which offer none. */
  options: { value: string; label: string }[]
  /** Selection bounds from the array schema — `multi-enum` only, absent when unbounded. */
  minItems?: number
  maxItems?: number
  /** String bounds — `text` only. `pattern` is present only when {@link safeElicitPattern} cleared it. */
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: ElicitFormat
  /** Numeric bounds — `number` only; `integer` marks the schema's `integer` type. */
  minimum?: number
  maximum?: number
  integer?: boolean
  /** The schema's `default`, kept only when it satisfies this target's own constraints —
   *  the card seeds its control with it, and the reader may still answer something else. */
  defaultValue?: string | number | boolean | string[]
  /** The property's own `description` — the question text, where `title` is only its header
   *  (an AskUserQuestion bridge splits them that way). Absent when the schema gave none. */
  description?: string
  /** Set on a select question's free-text companion: the property whose question this box
   *  types an answer for. Only ever a `text` target, and only when that question is rendered
   *  in the same form — the card then places the box inside it instead of asking it twice. */
  customAnswerFor?: string
}

/** The longest answer a card accepts: an elicitation asks a question, not for a file. */
const ELICIT_TEXT_CAP = 4096

/** The longest answer a PATTERN is matched against. Backtracking cost grows with the input,
 *  so a screened pattern is only cheap over a short one — and a patterned field asks for a
 *  name or an id, not prose. A longer answer is rejected rather than matched. */
const ELICIT_PATTERN_INPUT_CAP = 256

/** The most quantifiers a screened pattern may carry. The group rule below stops nested
 *  blow-up, but ADJACENT quantifiers backtrack polynomially with no group at all (`a*a*a*b`),
 *  and degree is what the input cap is budgeted against. */
const ELICIT_PATTERN_QUANTIFIER_CAP = 3

/**
 * Compile a schema `pattern` only when a linear-time match is assured, since the expression is
 * agent-authored and JS regexes backtrack: over-long sources and every quantified group whose
 * body itself quantifies or alternates ((a+)+, (a|a)*) are refused. A refused pattern makes the
 * property unrenderable, so the form declines rather than accepting an unchecked answer.
 */
export function safeElicitPattern(src: string): RegExp | null {
  if (src.length > 200) return null
  // Riskiness of the body being scanned, and of every enclosing group, innermost last.
  const enclosing: boolean[] = []
  let risky: boolean = false
  let quantifiers = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '\\') i++
    else if (c === '[') {
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1
    } else if (c === '(') {
      enclosing.push(risky)
      risky = false
      // A group modifier ((?:, (?=, (?!, (?<=, (?<name>) is syntax, not a quantifier.
      if (src[i + 1] === '?') {
        i++
        const kind = src[i + 1]
        if (kind === ':' || kind === '=' || kind === '!') i++
        else if (kind === '<') while (i + 1 < src.length && !'>=!'.includes(src[++i] ?? '')) {}
      }
    } else if (c === ')') {
      const body: boolean = risky
      const parent = enclosing.pop()
      if (parent === undefined) return null
      const quantified = i + 1 < src.length && '*+?{'.includes(src[i + 1]!)
      if (quantified && body) return null
      risky = parent || body || quantified
    } else if (c === '|' || '*+?{'.includes(c)) {
      if (c !== '|' && ++quantifiers > ELICIT_PATTERN_QUANTIFIER_CAP) return null
      risky = true
    }
  }
  if (enclosing.length) return null
  try {
    return new RegExp(src)
  } catch {
    return null
  }
}

/** A schema bound kept only when it is a real finite number. */
function numBound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A string-length bound, kept whenever it is a sane non-negative integer. A bound ABOVE the
 *  cap is never dropped: silently losing a minimum would let an answer the schema forbids
 *  through, so the caller compares it against the effective cap and declines instead. */
function lengthBound(value: unknown): number | undefined {
  return itemBound(value)
}

/** The longest answer a text target can actually take: a pattern is only cheap over a short
 *  input, so a patterned field's ceiling is the pattern cap rather than the answer cap. */
function effectiveTextMax(pattern: string | undefined): number {
  return pattern === undefined ? ELICIT_TEXT_CAP : ELICIT_PATTERN_INPUT_CAP
}

/** The four `format` checks, each strict enough that a value passing it is one the agent asked for. */
const FORMAT_CHECK: Record<ElicitFormat, (value: string) => boolean> = {
  // Deliberately narrow: one @, no spaces, a dotted host — not a full RFC 5322 grammar.
  email: (v) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v),
  uri: (v) => {
    try {
      return !!new URL(v).protocol
    } catch {
      return false
    }
  },
  date: (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
    // `2025-13-01` matches the shape but is not a date: toISOString would THROW on it.
    const d = new Date(`${v}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && v === d.toISOString().slice(0, 10)
  },
  'date-time': (v) =>
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(Date.parse(v))
}

/** The options an array property's `items` offers, plus the `anyOf`/`oneOf` titled form. */
function arrayOptions(prop: Record<string, unknown>): { value: string; label: string }[] {
  const items = prop.items as Record<string, unknown> | undefined
  const choices = (items?.anyOf ?? items?.oneOf) as { const?: unknown; title?: unknown }[] | undefined
  if (Array.isArray(choices))
    // A non-string const would make the accepted list lie about the schema's item type.
    return choices.every((o) => typeof o?.const === 'string')
      ? choices.map((o) => ({ value: String(o.const), label: clampTo(String(o.title ?? o.const), 75) }))
      : []
  const en = items?.enum
  return items?.type === 'string' && Array.isArray(en)
    ? en.map((v) => ({ value: String(v), label: clampTo(String(v), 75) }))
    : []
}

/** A schema bound, kept only when it is a sane non-negative integer. */
function itemBound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** Build the `text` target for a bare string property, or null when a constraint makes it
 *  unrenderable: an unsupported `format`, a pattern we refuse to run, an impossible length. */
function textTarget(name: string, prop: Record<string, unknown>): ElicitTarget | null {
  const format = prop.format
  if (format !== undefined && !ELICIT_FORMATS.includes(format as ElicitFormat)) return null
  const pattern = prop.pattern
  if (pattern !== undefined && (typeof pattern !== 'string' || !safeElicitPattern(pattern))) return null
  const min = lengthBound(prop.minLength)
  const declared = lengthBound(prop.maxLength)
  // The ceiling this surface can actually enforce. A declared minimum above it is
  // unanswerable — dropping it would accept a short answer the schema forbids — and the
  // effective maximum is carried on the target so the browser bounds its own draft by it.
  const ceiling = effectiveTextMax(typeof pattern === 'string' ? pattern : undefined)
  const max = declared === undefined ? ceiling : Math.min(declared, ceiling)
  if (min !== undefined && min > max) return null
  if (max === 0) return null
  return {
    propName: name,
    kind: 'text',
    options: [],
    ...(min !== undefined ? { minLength: min } : {}),
    maxLength: max,
    ...(typeof pattern === 'string' ? { pattern } : {}),
    ...(format !== undefined ? { format: format as ElicitFormat } : {})
  }
}

/** Build the `number` target for a numeric property, or null when its bounds admit nothing. */
function numberTarget(name: string, prop: Record<string, unknown>): ElicitTarget | null {
  const integer = prop.type === 'integer'
  const min = numBound(prop.minimum)
  const max = numBound(prop.maximum)
  if (min !== undefined && max !== undefined && min > max) return null
  // An integer range spanning no integer at all (0.2 … 0.8) is not a question either.
  if (integer && min !== undefined && max !== undefined && Math.ceil(min) > Math.floor(max)) return null
  return {
    propName: name,
    kind: 'number',
    options: [],
    ...(min !== undefined ? { minimum: min } : {}),
    ...(max !== undefined ? { maximum: max } : {}),
    ...(integer ? { integer: true } : {})
  }
}

/** Carry the schema's `default` onto a target, but only where the target itself would accept it —
 *  the spec asks the card to pre-populate, and pre-populating an answer we would then refuse
 *  hands the reader a control that cannot be submitted. */
function withDefault(target: ElicitTarget, raw: unknown): ElicitTarget {
  if (raw === undefined) return target
  const ok =
    target.kind === 'boolean'
      ? typeof raw === 'boolean'
      : target.kind === 'multi-enum'
        ? Array.isArray(raw) && raw.every((v) => typeof v === 'string') && multiSelectAccepts(target, raw)
        : target.kind === 'number'
          ? typeof raw === 'number' && numberAccepts(target, raw)
          : target.kind === 'text'
            ? typeof raw === 'string' && textAccepts(target, raw)
            : typeof raw === 'string' && target.options.some((o) => o.value === raw)
  return ok ? { ...target, defaultValue: raw as ElicitTarget['defaultValue'] } : target
}

/** The form's `required` property names, as the schema spells them — anything that is not a
 *  string is dropped, since it cannot name a property this scan produced. */
export function elicitRequiredProps(params: CreateElicitationRequest): string[] {
  const req = (params as { requestedSchema?: { required?: unknown } }).requestedSchema?.required
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}

/** How a form card names one field: the schema's own `title` when it has one, else the property
 *  name. A control stacked with others and labelled by neither is not answerable. */
export function elicitFieldLabel(params: CreateElicitationRequest, propName: string): string {
  const props = (params as { requestedSchema?: { properties?: Record<string, Record<string, unknown>> } })
    .requestedSchema?.properties
  const title = props?.[propName]?.title
  return clampTo((typeof title === 'string' && title.trim()) || propName, 75)
}

/** How a MULTI-FIELD card names one field. A select question's free-text companion is named for
 *  the question it belongs to ("Branch (Other)") rather than on its own: "Other" beside a stack
 *  of other labels says which words were typed but not what they answer. Pure. */
export function elicitFormFieldLabel(params: CreateElicitationRequest, target: ElicitTarget): string {
  const own = elicitFieldLabel(params, target.propName)
  if (!target.customAnswerFor) return own
  return clampTo(`${elicitFieldLabel(params, target.customAnswerFor)} (${own})`, 75)
}

// ACP's cross-agent marker for a select question's own free-text box, under a namespace-free `_meta` key on purpose.
const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer'

// Codex spells the same box its own way: `request_user_input` writes `_meta.codex.isOtherAnswer`, so both are read.
const CODEX_CUSTOM_ANSWER_META_KEY = 'codex'

/** The longest question text a card carries under a field's label. */
const ELICIT_DESCRIPTION_MAX = 300

/** The marker namespaces above, each with the flag that binds a box inside its question. */
const CUSTOM_ANSWER_MARKERS = [
  [CUSTOM_ANSWER_META_KEY, 'isCustomAnswer'],
  [CODEX_CUSTOM_ANSWER_META_KEY, 'isOtherAnswer']
] as const

/** The question a property's `_meta` claims this free-text box answers, or undefined when it
 *  claims none — an unmarked property is a question in its own right. */
function customAnswerOwner(prop: Record<string, unknown>): string | undefined {
  const meta = prop._meta as Record<string, unknown> | undefined
  for (const [key, flag] of CUSTOM_ANSWER_MARKERS) {
    const marker = meta?.[key] as Record<string, unknown> | undefined
    const owner = marker?.questionId
    if (marker?.[flag] === true && typeof owner === 'string' && owner) return owner
  }
  return undefined
}

/** Whether a property speaks a marker namespace at all, flag or no flag. A producer that speaks
 *  one has already said what the box is, so its silence is a statement and not shape to guess at. */
function speaksCustomAnswerMarker(prop: Record<string, unknown>): boolean {
  const meta = prop._meta as Record<string, unknown> | undefined
  return CUSTOM_ANSWER_MARKERS.some(([key]) => !!meta?.[key])
}

// What a bridge appends to a question's property name when it adds that question's own box:
// `question_0_custom`, `need_type__other`. Read as the marker of LAST resort, so a bridge that
// marks nothing (DeepSeek Harness spells the pair by name alone) still folds its box inside the
// question instead of asking "Other" as a question of its own.
const CUSTOM_ANSWER_SUFFIXES = ['_custom', '_other', '-custom', '-other'] as const

/** The select question this property name is the free-text box OF, by shape alone: another
 *  rendered question's name plus a custom-answer suffix, with a doubled separator (`__other`)
 *  read the same as a single one. Undefined when the name claims no question on this card. */
function suffixedCustomAnswerOwner(propName: string, questions: Set<string>): string | undefined {
  const lower = propName.toLowerCase()
  for (const suffix of CUSTOM_ANSWER_SUFFIXES) {
    if (!lower.endsWith(suffix)) continue
    const stem = propName.slice(0, propName.length - suffix.length)
    for (const owner of [stem, stem.slice(0, -1)]) if (owner && questions.has(owner)) return owner
  }
  return undefined
}

/** A target whose {@link ElicitTarget.defaultValue} still names one of its own options — the
 *  seed of a control that lost an option must not be a value the control cannot show. */
function withoutStaleDefault(target: ElicitTarget): ElicitTarget {
  const values = new Set(target.options.map((o) => o.value))
  const raw = target.defaultValue
  const stale = Array.isArray(raw) ? raw.some((v) => !values.has(v)) : typeof raw === 'string' && !values.has(raw)
  if (!stale) return target
  const { defaultValue: _dropped, ...rest } = target
  return rest
}

/**
 * Every property of the form this surface can render, in schema order: string-enum (`oneOf`
 * titled options or bare `enum`), boolean, string-array multi-select (`items.enum` or
 * `items.anyOf`), free-text string, and number/integer — each only where the CALLING SURFACE
 * declares that kind. At most one target per property, since a property's `type` picks its
 * kind. The shared scan behind {@link elicitTarget} and {@link elicitForm}, so the two can
 * never disagree about what is renderable. Empty for URL-mode and an empty/absent schema.
 */
function elicitCandidates(params: CreateElicitationRequest, surface: ElicitSurface): ElicitTarget[] {
  const p = params as {
    mode?: string
    requestedSchema?: { properties?: Record<string, Record<string, unknown>> }
  }
  if (p.mode !== 'form') return []
  const renderable = surface.kinds
  // A list this surface's control for that kind cannot hold whole is not a renderable field: a
  // card built from part of it would report the reader's pick as their answer to the question.
  const fits = (kind: ElicitKind, options: readonly { value: string }[]) => {
    const limits = surface.optionLimits?.[kind]
    return limits?.maxOptions === undefined || options.length <= limits.maxOptions
  }
  const found: ElicitTarget[] = []
  for (const [name, prop] of Object.entries(p.requestedSchema?.properties ?? {})) {
    const owner = customAnswerOwner(prop)
    // A companion's own description is boilerplate the inline placement already says; the
    // question's is the ask itself, which `title` (a header) does not carry.
    const desc = !owner && typeof prop.description === 'string' ? prop.description.trim() : ''
    const keep = (t: ElicitTarget | null) => {
      if (!t) return
      found.push(
        withDefault(
          {
            ...t,
            ...(desc ? { description: clampTo(desc, ELICIT_DESCRIPTION_MAX) } : {}),
            // Only a typed box can BE a custom answer; a marker on anything else is ignored.
            ...(owner && t.kind === 'text' ? { customAnswerFor: owner } : {})
          },
          prop.default
        )
      )
    }
    if (prop?.type === 'string') {
      const oneOf = prop.oneOf as { const?: unknown; title?: unknown }[] | undefined
      const en = prop.enum as unknown[] | undefined
      const options = Array.isArray(oneOf)
        ? oneOf.map((o) => ({ value: String(o.const), label: clampTo(String(o.title ?? o.const), 75) }))
        : Array.isArray(en)
          ? en.map((v) => ({ value: String(v), label: clampTo(String(v), 75) }))
          : []
      if (options.length && fits('enum', options) && renderable.has('enum'))
        keep({ propName: name, kind: 'enum', options })
      // Free text is the string with nothing to choose from — an enumerated one is a pick,
      // and typing into it would let an unoffered value through.
      if (!options.length && renderable.has('text')) keep(textTarget(name, prop))
    }
    if ((prop?.type === 'number' || prop?.type === 'integer') && renderable.has('number'))
      keep(numberTarget(name, prop))
    if (prop?.type === 'array' && renderable.has('multi-enum')) {
      const options = arrayOptions(prop)
      const min = itemBound(prop.minItems)
      const max = itemBound(prop.maxItems)
      // Bounds that admit only the empty selection, or none at all, are not a question.
      const askable = max === undefined || (max > 0 && max >= (min ?? 0))
      if (options.length && fits('multi-enum', options) && askable)
        keep({
          propName: name,
          kind: 'multi-enum',
          options,
          ...(min !== undefined ? { minItems: min } : {}),
          ...(max !== undefined ? { maxItems: max } : {})
        })
    }
    if (prop?.type === 'boolean' && renderable.has('boolean'))
      keep({
        propName: name,
        kind: 'boolean',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' }
        ]
      })
  }
  // A companion whose question this surface did not render has nothing to sit inside, so it
  // stands as a field of its own rather than pointing at a control that is not on the card.
  const questions = new Set(found.filter((t) => !t.customAnswerFor).map((t) => t.propName))
  // The unmarked pair, read by name off the questions that OFFER options — the shape only says
  // "box for that question" where the question has choices this box is an alternative to.
  const selects = new Set(found.filter((t) => t.kind === 'enum' || t.kind === 'multi-enum').map((t) => t.propName))
  const required = new Set(elicitRequiredProps(params))
  const bound = found.map((t) => {
    if (t.customAnswerFor) return questions.has(t.customAnswerFor) ? t : dropCustomAnswerFor(t)
    // Only where the property claimed no marker namespace of its own, and only where it is
    // OPTIONAL: a companion is an alternative to a pick, so a REQUIRED text property is a
    // question in its own right whatever it is named, and folding it would place a field the
    // answer cannot omit behind a chip that discloses it.
    if (t.kind !== 'text' || required.has(t.propName)) return t
    if (speaksCustomAnswerMarker(p.requestedSchema?.properties?.[t.propName] ?? {})) return t
    const owner = suffixedCustomAnswerOwner(t.propName, selects)
    return owner ? { ...t, customAnswerFor: owner } : t
  })
  // A question whose box the card offers ITSELF must not also offer that box as a choice: a
  // bridge that appends an "Other" option to the enum means "type below", but picking it answers
  // the question with a value the agent reads as no answer at all. Matched against the
  // companion's own label rather than any word, and never down to an empty list of options.
  const companionLabel = new Map<string, string>()
  for (const t of bound)
    if (t.customAnswerFor)
      companionLabel.set(t.customAnswerFor, elicitFieldLabel(params, t.propName).trim().toLowerCase())
  return bound.map((t) => {
    const label = companionLabel.get(t.propName)
    if (label === undefined || !t.options.length) return t
    const options = t.options.filter((o) => o.label.trim().toLowerCase() !== label)
    return options.length && options.length < t.options.length ? withoutStaleDefault({ ...t, options }) : t
  })
}

/** The same target with no owning question — a companion that turned out to point at nothing. */
function dropCustomAnswerFor(target: ElicitTarget): ElicitTarget {
  const { customAnswerFor: _orphan, ...rest } = target
  return rest
}

/** The elicitation's URL-mode target (ACP `ElicitationUrlMode`), or null when this is not a
 *  URL-mode ask. Only `http`/`https` survive: every other scheme — `javascript:`, `data:`,
 *  `file:` — is something a consent card must never hand a browser as an href, and the caller
 *  declines instead. The URL is returned VERBATIM, never re-serialized, because the reader has
 *  to examine the same bytes the agent asked for. Pure. */
export function elicitUrl(params: CreateElicitationRequest): { elicitationId: string; url: string } | null {
  const p = params as { mode?: string; url?: unknown; elicitationId?: unknown }
  if (p.mode !== 'url') return null
  if (typeof p.url !== 'string' || typeof p.elicitationId !== 'string' || !p.elicitationId) return null
  if (p.url.length > 2048) return null
  let parsed: URL
  try {
    parsed = new URL(p.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return { elicitationId: p.elicitationId, url: p.url }
}

/**
 * Resolve the single form field an elicitation card renders: the FIRST renderable property
 * that ALONE satisfies the schema's `required`. Returns null for URL-mode, an empty/absent
 * schema, a form whose fields this surface can't render, or one that requires a property other
 * than the rendered target — the daemon then declines rather than accepting a partial answer.
 * A candidate that fails that check does NOT end the scan: a later property may be the sole
 * required one, and stopping here would decline a form this surface can in fact answer. Pure,
 * and shared by every surface so the option values and their interpretation can't drift.
 */
export function elicitTarget(params: CreateElicitationRequest, surface: ElicitSurface): ElicitTarget | null {
  const required = elicitRequiredProps(params)
  // A required field we can't render is unanswerable: accepting without it would assert a lie.
  return elicitCandidates(params, surface).find((t) => required.every((r) => r === t.propName)) ?? null
}

/**
 * Resolve the WHOLE form a card renders one control per: every renderable property, in schema
 * order. Returns null when the surface can render nothing, when a `required` property is not
 * among the rendered set — {@link elicitTarget}'s rule (#1795) generalised from the one
 * rendered field to the rendered set, and still the difference between an honest `accept` and
 * a lie — or when the form asks more than {@link ELICIT_FORM_FIELD_CAP} QUESTIONS. A select
 * question's free-text companion is not one of them: it rides inside the question it belongs
 * to, so pairing every question with an "Other" box does not halve the form a card can show.
 * A one-field result is exactly what {@link elicitTarget} would return, which is what keeps a
 * single-field card's wire payload unchanged.
 */
export function elicitForm(params: CreateElicitationRequest, surface: ElicitSurface): ElicitTarget[] | null {
  const targets = elicitCandidates(params, surface)
  if (!targets.length || targets.filter((t) => !t.customAnswerFor).length > ELICIT_FORM_FIELD_CAP) return null
  const rendered = new Set(targets.map((t) => t.propName))
  return elicitRequiredProps(params).every((r) => rendered.has(r)) ? targets : null
}

/** Whether one value answers one field: the arity its kind is answered with, then that kind's
 *  own accept check. The single-field card's gate, per field, so a form re-checks every one. */
export function fieldAccepts(target: ElicitTarget, value: string | number | string[]): boolean {
  if (Array.isArray(value)) return multiSelectAccepts(target, value)
  if (typeof value === 'number') return numberAccepts(target, value)
  if (target.kind === 'text') return textAccepts(target, value)
  // An enum or boolean answers with one of the values the card itself offered.
  return (target.kind === 'enum' || target.kind === 'boolean') && target.options.some((o) => o.value === value)
}

/** Whether a form answer is one the card it was posted for can accept: EXACTLY the fields that
 *  card rendered (an extra or misspelled key would inject a property the agent never asked
 *  for), every `required` one present, and each value valid for its own field. An optional
 *  field may simply be absent — legal per the schema, and the reason #1795's rule was narrow.
 *  One bad field refuses the whole answer; the card stays live to be answered again. */
export function elicitFormAccepts(
  targets: readonly ElicitTarget[],
  required: readonly string[],
  answer: Record<string, string | number | string[]>
): boolean {
  const byName = new Map(targets.map((t) => [t.propName, t]))
  for (const name of required) if (!Object.hasOwn(answer, name)) return false
  for (const [name, value] of Object.entries(answer)) {
    const target = byName.get(name)
    if (!target || !fieldAccepts(target, value)) return false
  }
  return true
}

/** The accept content for a form answer: every answered field under its own property name,
 *  each carrying the schema's own type — a boolean field's wire value is its option string,
 *  which becomes a real boolean here for the same reason the single-field card converts it. */
export function elicitFormContent(
  targets: readonly ElicitTarget[],
  answer: Record<string, string | number | string[]>
): Record<string, string | number | boolean | string[]> {
  const boolean = new Set(targets.filter((t) => t.kind === 'boolean').map((t) => t.propName))
  return Object.fromEntries(
    Object.entries(answer).map(([name, value]) => [name, boolean.has(name) ? value === 'true' : value])
  )
}

/** Whether a submitted list is an answer this multi-select target actually offered: every value
 *  is one of its options, no repeats, and the count inside `minItems`/`maxItems`. */
export function multiSelectAccepts(target: ElicitTarget, values: string[]): boolean {
  if (target.kind !== 'multi-enum') return false
  if (new Set(values).size !== values.length) return false
  if (values.length < (target.minItems ?? 0)) return false
  if (target.maxItems !== undefined && values.length > target.maxItems) return false
  return values.every((v) => target.options.some((o) => o.value === v))
}

/** Whether a typed string is an answer this text target's own schema allows: inside the answer
 *  cap and `minLength`/`maxLength`, matching `pattern`, and of the declared `format`. The
 *  browser enforces the same rules to keep the control honest; this is what makes them binding. */
export function textAccepts(target: ElicitTarget, value: string): boolean {
  if (target.kind !== 'text') return false
  if (value.length > ELICIT_TEXT_CAP) return false
  if (value.length < (target.minLength ?? 0)) return false
  if (target.maxLength !== undefined && value.length > target.maxLength) return false
  if (target.format && !FORMAT_CHECK[target.format](value)) return false
  if (target.pattern === undefined) return true
  // maxLength already carries the pattern ceiling, so the expression only ever runs over a
  // short input; this is the belt to that braces, since the target arrives from a caller.
  if (value.length > ELICIT_PATTERN_INPUT_CAP) return false
  const re = safeElicitPattern(target.pattern)
  return !!re && re.test(value)
}

/** Whether a typed number is an answer this number target allows: real and finite, inside
 *  `minimum`/`maximum`, and a whole number where the schema said `integer`. */
export function numberAccepts(target: ElicitTarget, value: number): boolean {
  if (target.kind !== 'number') return false
  if (!Number.isFinite(value)) return false
  if (target.integer && !Number.isInteger(value)) return false
  if (target.minimum !== undefined && value < target.minimum) return false
  return target.maximum === undefined || value <= target.maximum
}

/** How a card names the shape a `format` asks for — plain words, with an example where the shape
 *  is not one, because the reader has to type it from the card alone. */
const FORMAT_EXPECTATION: Record<ElicitFormat, string> = {
  email: 'an email address',
  uri: 'a link',
  date: 'a date, like 2026-09-07',
  'date-time': 'a date and time, like 2026-09-07T09:30:00Z'
}

/** What a typed field asks for, in plain words and never in schema vocabulary — said when an
 *  entry does not fit, so the reader is told the shape rather than the schema keyword. Pure. */
export function elicitFieldExpectation(target: ElicitTarget): string {
  if (target.kind === 'number') {
    const noun = target.integer ? 'a whole number' : 'a number'
    const { minimum: min, maximum: max } = target
    if (min !== undefined && max !== undefined) return `${noun} from ${min} to ${max}`
    if (min !== undefined) return `${noun}, ${min} or more`
    return max !== undefined ? `${noun}, ${max} or less` : noun
  }
  const min = target.minLength
  // Only a bound TIGHTER than the ceilings this surface imposes is the reader's to break: our own
  // 4096/256 answer caps are not news, and a target cannot tell a declared 256 from the pattern one.
  const max =
    target.maxLength !== undefined && target.maxLength < ELICIT_PATTERN_INPUT_CAP ? target.maxLength : undefined
  const length =
    min !== undefined && max !== undefined
      ? `${min} to ${max} characters long`
      : min !== undefined
        ? `at least ${min} characters long`
        : max !== undefined
          ? `at most ${max} characters long`
          : ''
  const parts = [target.format ? FORMAT_EXPECTATION[target.format] : 'some text']
  if (length) parts.push(length)
  if (target.pattern !== undefined) parts.push('in the exact format the question asks for')
  return parts.join(', ')
}

/** The digit shapes a typed number may take. Deliberately narrower than `Number()`, which reads
 *  `0x1f`, `Infinity` and whitespace as numbers a reader plainly did not type. */
const NUMERIC_REPLY_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const BARE_URL_RE = /(?:https?:\/\/|www\.)\S+/gi

/** The agent-authored elicitation `message`, with every link in it defused. A form-mode ask
 *  may not send the reader anywhere — the spec keeps URLs on URL-mode elicitations, whose
 *  consent card is the only place a URL is ever followable — and Slack turns both bare URLs
 *  and `<url|label>` into taps, so the angle-bracket form is escaped and the bare form is
 *  wrapped in a code span, which Slack mrkdwn does not autolink. Pure. */
function elicitCardMessage(params: CreateElicitationRequest): string {
  const raw = (params as { message?: string }).message?.trim() || 'The agent needs your input'
  return escapeSlackMrkdwn(raw).replace(BARE_URL_RE, (m) => `\`${m}\``)
}

/** The three characters Slack mrkdwn reads as markup rather than as themselves. Escaping them is
 *  how a literal `&`, `<` or `>` reaches the reader — Slack unescapes the entities on display. */
function escapeSlackMrkdwn(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Slack's own limit on one section's mrkdwn text. */
const SLACK_SECTION_TEXT_CAP = 3000

/** How much of the agent's question a card carries. Cut only where Slack itself would refuse the
 *  block — the old 400 cut ordinary questions Slack could have shown whole, and {@link clampTo}'s
 *  trailing `…` is the only mark a cut ever gets, so a shorter cap is a quieter one. */
const ELICIT_MESSAGE_CAP = SLACK_SECTION_TEXT_CAP - 200

/** What a multi-select card says its bounds are, so a refused Confirm is not the reader's first
 *  news of them. Slack enforces the maximum itself (`max_selected_items`); the minimum is the
 *  one a reader can break, and the daemon re-validates both either way. Empty when unbounded. */
function selectionHint(target: ElicitTarget): string {
  const { minItems: min, maxItems: max } = target
  if (min !== undefined && max !== undefined) return min === max ? `Select exactly ${min}.` : `Select ${min} to ${max}.`
  if (min !== undefined) return `Select at least ${min}.`
  return max !== undefined ? `Select up to ${max}.` : ''
}

/** The Dismiss button every elicitation card carries — the reader's one explicit `decline`. */
function elicitDismissButton(requestId: string): Record<string, unknown> {
  return {
    type: 'button',
    action_id: ELICIT_DISMISS_ACTION as string,
    text: { type: 'plain_text', text: 'Dismiss', emoji: true },
    value: requestId
  }
}

/** Element types Slack REFUSES inside a block, by block type. Slack rejects the WHOLE message
 *  rather than the offending block, so a card that gets this wrong never posts and its request is
 *  cancelled with no trace in the channel — which is exactly how a `multi_static_select` in an
 *  `actions` block took down a live session. Verified against the live API, not read off the docs:
 *  an `actions` block answers `unsupported element: multiselect` for a multi-select and
 *  `unsupported type` for a typed input, and an `input` block holds no button. */
const SLACK_FORBIDDEN_ELEMENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  actions: new Set([
    'multi_static_select',
    'multi_external_select',
    'multi_users_select',
    'multi_conversations_select',
    'multi_channels_select',
    'plain_text_input',
    'number_input',
    'email_text_input',
    'url_text_input'
  ]),
  input: new Set(['button', 'overflow'])
}

/** How many `options` each element type holds. `checkboxes` and `radio_buttons` answer
 *  `no more than 10 items allowed` past ten, where the select menus take a hundred — which is why
 *  the card picks between them by list length rather than by taste. Verified against the API. */
const SLACK_ELEMENT_MAX_OPTIONS: Readonly<Record<string, number>> = {
  checkboxes: 10,
  radio_buttons: 10,
  static_select: 100,
  multi_static_select: 100,
  overflow: 5
}

/** The elements that HAVE a `max_selected_items`. `checkboxes` does not: Slack answers
 *  `invalid additional property` for it, so a checkbox list's upper bound is said in the block's
 *  hint and enforced when the answer comes back, never by the control. */
const SLACK_MAX_SELECTED_ELEMENTS: ReadonlySet<string> = new Set([
  'multi_static_select',
  'multi_external_select',
  'multi_users_select',
  'multi_conversations_select',
  'multi_channels_select'
])

/** Slack's own caps on one `actions` block's elements, on an option object's `value`, and on an
 *  interactive element's own `value`. Every Slack card carries positions rather than agent-authored
 *  strings ({@link elicitOptionToken}), so nothing we build should reach either value cap — which
 *  is exactly why they are asserted rather than assumed. */
const SLACK_ACTIONS_MAX_ELEMENTS = 25
const SLACK_OPTION_VALUE_CAP = 75
const SLACK_ACTION_VALUE_CAP = 2000

/** Every Slack rule this file has paid for, checked over one card's blocks: the element types a
 *  block type refuses, the per-element option caps, `max_selected_items` only where it exists,
 *  an `input` block's mandatory element, an option value or an element `value` past Slack's own
 *  cap, and block ids unique within the message. Returns the reasons Slack would reject the card,
 *  empty when it would take it. Exported and asserted over every card we build, because our own
 *  JSON looks valid to us right up until Slack sees it — the only reason #1825 shipped. Pure. */
export function slackCardViolations(blocks: readonly unknown[]): string[] {
  const bad: string[] = []
  const seen = new Set<string>()
  for (const [i, raw] of blocks.entries()) {
    const b = raw as SlackBlockShape
    if (typeof b.block_id === 'string') {
      if (seen.has(b.block_id)) bad.push(`blocks/${i}: duplicate block_id "${b.block_id}"`)
      seen.add(b.block_id)
    }
    const forbidden = SLACK_FORBIDDEN_ELEMENTS[b.type ?? ''] ?? new Set<string>()
    if (b.type === 'input' && !b.element?.type) bad.push(`blocks/${i}: input block has no element`)
    if (b.type === 'actions' && (b.elements?.length ?? 0) > SLACK_ACTIONS_MAX_ELEMENTS)
      bad.push(`blocks/${i}: ${b.elements?.length} elements in an actions block, past ${SLACK_ACTIONS_MAX_ELEMENTS}`)
    for (const el of [...(b.elements ?? []), ...(b.element ? [b.element] : [])]) {
      if (!el?.type) continue
      if (forbidden.has(el.type)) bad.push(`blocks/${i}: ${el.type} is not allowed in a ${b.type} block`)
      bad.push(...slackElementViolations(el, `blocks/${i}/${el.type}`))
    }
  }
  return bad
}

/** The shape {@link slackCardViolations} reads a block and its elements through — deliberately
 *  everything-optional, since the point is to inspect JSON that may be wrong. */
interface SlackElementShape {
  type?: string
  value?: unknown
  options?: { value?: unknown }[]
  initial_options?: { value?: unknown }[]
  initial_option?: { value?: unknown }
  max_selected_items?: unknown
}
interface SlackBlockShape {
  type?: string
  block_id?: string
  elements?: SlackElementShape[]
  element?: SlackElementShape
}

/** One element's own rules: its option cap, its option values, and whether it may be told a
 *  maximum selection at all. Pure. */
function slackElementViolations(el: SlackElementShape, at: string): string[] {
  const bad: string[] = []
  const cap = SLACK_ELEMENT_MAX_OPTIONS[el.type ?? '']
  if (cap !== undefined && (el.options?.length ?? 0) > cap)
    bad.push(`${at}: ${el.options?.length} options, past the ${cap} this element holds`)
  if (el.max_selected_items !== undefined && !SLACK_MAX_SELECTED_ELEMENTS.has(el.type ?? ''))
    bad.push(`${at}: max_selected_items is not a property of this element`)
  const values = [
    ...(el.options ?? []),
    ...(el.initial_options ?? []),
    ...(el.initial_option ? [el.initial_option] : [])
  ]
  for (const o of values)
    if (typeof o?.value === 'string' && o.value.length > SLACK_OPTION_VALUE_CAP)
      bad.push(`${at}: an option value is ${o.value.length} characters, past ${SLACK_OPTION_VALUE_CAP}`)
  // A button's own `value` — the cap that silently cost a long consent URL its whole card.
  if (typeof el.value === 'string' && el.value.length > SLACK_ACTION_VALUE_CAP)
    bad.push(`${at}: a value is ${el.value.length} characters, past ${SLACK_ACTION_VALUE_CAP}`)
  return bad
}

/**
 * Build the ONE-TAP elicitation card: the agent's `message` and one actions row carrying EVERY
 * {@link elicitTarget} option as a button, plus Dismiss. The choice rides each option's `value`
 * (`<requestId>|<optionToken>`, see {@link elicitOptionToken}). Only a single-select or a boolean
 * is answered this way — one tap IS the answer there, where every other kind needs something
 * filled in first and takes the
 * `input` blocks of {@link buildElicitationFormCard} ({@link elicitCardShape} decides). Returns
 * null when the form can't be rendered on `surface` (caller declines): a kind or an option list
 * it does not claim, which the reduction has already refused. Nothing here trims a list to fit.
 * Pure.
 */
export function buildElicitationCard(
  requestId: string,
  params: CreateElicitationRequest,
  sessionTarget?: string,
  surface: ElicitSurface = SLACK_ELICIT_SURFACE
): unknown[] | null {
  const target = elicitTarget(params, surface)
  if (!target) return null
  const message = elicitCardMessage(params)
  // A lone question that has to be filled in is its own ONE-FIELD form: nothing tapped in an
  // `actions` block can carry what was typed or selected, so the control is an input block.
  if (elicitCardShape([target]) !== 'buttons')
    return buildElicitationFormCard(requestId, params, [target], sessionTarget)
  const buttons = target.options.map((o, i) => ({
    type: 'button',
    action_id: `${ELICIT_ACTION_PREFIX}:${i}`,
    text: { type: 'plain_text', text: o.label, emoji: true },
    value: encodePermValue(requestId, elicitOptionToken(i))
  }))
  buttons.push(elicitDismissButton(requestId) as (typeof buttons)[number])
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: ${clampTo(message, ELICIT_MESSAGE_CAP)}` } },
    { type: 'actions', ...(sessionTarget ? { block_id: sessionTarget } : {}), elements: buttons }
  ]
}

/** Where a DM sends a reader whose question Slack has no control for. Mirrors the in-channel
 *  decline notice's words, minus its verdict: this ask is still open on the editor path. */
const ELICIT_DM_UNANSWERABLE =
  ":hourglass: This chat can't collect an answer for it — answer it in the session console, via *Open session* above."

/** The stand-in for an approval DM's elicitation card that {@link buildElicitationCard} cannot
 *  build for the DM surface (#1794): the question, and where it CAN be answered. Without it the
 *  DM went out carrying its intro and nothing else — a live request, no controls, and no hint
 *  that the console holds the same ask — until the turn cancelled. The intro above it owns the
 *  `Open session` link this points at, so the URL is never repeated. Pure. */
export function buildElicitDmUnanswerableCard(params: CreateElicitationRequest): unknown[] {
  return buildElicitationResolvedCard(params, ELICIT_DM_UNANSWERABLE)
}

/** Build the RESOLVED elicitation card (buttons removed) that replaces {@link
 *  buildElicitationCard} once answered, dismissed, or cancelled. Pure. */
export function buildElicitationResolvedCard(params: CreateElicitationRequest, decision: string): unknown[] {
  const message = elicitCardMessage(params)
  const text = clampTo(`:speech_balloon: ${clampTo(message, ELICIT_MESSAGE_CAP)}\n${decision}`, SLACK_SECTION_TEXT_CAP)
  return [{ type: 'section', text: { type: 'mrkdwn', text } }]
}

// ── Elicitation form cards (`input` blocks in the message, issue #1794's last Slack item) ────

/** Slack's own cap on a `plain_text_input`'s `min_length`/`max_length`. */
const SLACK_INPUT_LENGTH_CAP = 3000

/** The longest list `checkboxes` and `radio_buttons` hold — past ten Slack answers `no more than
 *  10 items allowed`, so a longer list falls back to the select menu, which holds a hundred. */
const SLACK_CHOICE_MAX_OPTIONS = 10

/** Slack's own cap on an `input` block's hint. */
const SLACK_HINT_TEXT_CAP = 2000

/** The `input` element one form field is answered by: for a pick, the control that fits the list —
 *  `radio_buttons`/`checkboxes` for a short one, which show every option without a second tap, and
 *  a select menu past what those hold — plus a `plain_text_input` for text and a `number_input` for
 *  numbers, each carrying the schema's own bounds so Slack refuses on the card what the daemon
 *  would refuse anyway. A checkbox list gets no `max_selected_items` (Slack has no such property
 *  there): its bounds are said in the block's hint and enforced when the answer comes back, which
 *  is where they were always binding. Null ⇒ this field cannot BE an input block — no options at
 *  all, or a minimum length past what an input holds — and the whole card is then withheld rather
 *  than posted with a field the reader cannot answer honestly. An option's own length is no longer
 *  such a reason: every option carries its POSITION ({@link elicitOptionToken}). Pure. */
function elicitFormInputElement(target: ElicitTarget): Record<string, unknown> | null {
  const action_id = ELICIT_FORM_INPUT_ACTION as string
  if (target.kind === 'text') {
    const min = target.minLength
    if (min !== undefined && min > SLACK_INPUT_LENGTH_CAP) return null
    const max = Math.min(target.maxLength ?? SLACK_INPUT_LENGTH_CAP, SLACK_INPUT_LENGTH_CAP)
    return {
      type: 'plain_text_input',
      action_id,
      ...(min !== undefined ? { min_length: min } : {}),
      max_length: max,
      ...(typeof target.defaultValue === 'string' ? { initial_value: target.defaultValue } : {})
    }
  }
  if (target.kind === 'number') {
    return {
      type: 'number_input',
      action_id,
      is_decimal_allowed: target.integer !== true,
      ...(target.minimum !== undefined ? { min_value: String(target.minimum) } : {}),
      ...(target.maximum !== undefined ? { max_value: String(target.maximum) } : {}),
      ...(typeof target.defaultValue === 'number' ? { initial_value: String(target.defaultValue) } : {})
    }
  }
  const options = target.options.map((o, i) => ({
    text: { type: 'plain_text', text: o.label, emoji: true },
    value: elicitOptionToken(i)
  }))
  if (!options.length) return null
  const short = options.length <= SLACK_CHOICE_MAX_OPTIONS
  if (target.kind === 'multi-enum') {
    const seeded = Array.isArray(target.defaultValue) ? new Set(target.defaultValue) : null
    const initial = seeded ? options.filter((_, i) => seeded.has(target.options[i]!.value)) : []
    if (short)
      return { type: 'checkboxes', action_id, options, ...(initial.length ? { initial_options: initial } : {}) }
    return {
      type: 'multi_static_select',
      action_id,
      placeholder: { type: 'plain_text', text: 'Select options', emoji: true },
      options,
      ...(initial.length ? { initial_options: initial } : {}),
      ...(target.maxItems !== undefined ? { max_selected_items: target.maxItems } : {})
    }
  }
  // A boolean's `default` is a real boolean, so its option value is the string the card spells it with.
  const seed = target.kind === 'boolean' ? String(target.defaultValue) : target.defaultValue
  const seedIndex = target.options.findIndex((o) => o.value === seed)
  const initial = seedIndex < 0 ? undefined : options[seedIndex]
  if (short) return { type: 'radio_buttons', action_id, options, ...(initial ? { initial_option: initial } : {}) }
  return {
    type: 'static_select',
    action_id,
    placeholder: { type: 'plain_text', text: 'Choose one', emoji: true },
    options,
    ...(initial ? { initial_option: initial } : {})
  }
}

/** What one field's block says under its label: the question's own words, plus a multi-select's
 *  bounds, since a checkbox list cannot enforce them itself. Empty when there is nothing to add. */
export function elicitFormFieldHint(target: ElicitTarget): string {
  const parts = [target.description ?? '', target.kind === 'multi-enum' ? selectionHint(target) : '']
  return clampTo(parts.filter(Boolean).join(' '), SLACK_HINT_TEXT_CAP)
}

/**
 * Build the elicitation card whose fields are ANSWERED IN THE MESSAGE: the agent's defused
 * question, then one `input` block per field in schema order — each keyed by {@link
 * elicitFormBlockId}, which is the key its submitted value comes back under — and one actions
 * block carrying Confirm and Dismiss, which share the `block_id` the relay routes on.
 *
 * ONE Confirm for the whole card, never one per question: a message's input values all arrive in
 * `state.values` on any button tap in that message, so a single button submits the lot. That is
 * also why a lone select that needs no typing keeps its row of buttons instead — one tap answers
 * it, and there is nothing to fill in first ({@link elicitCardShape}).
 *
 * Null ⇒ some field cannot be an input block (see {@link elicitFormInputElement}) and the caller
 * declines with a notice rather than posting a card with a field nobody can answer. Pure.
 */
export function buildElicitationFormCard(
  requestId: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[],
  sessionTarget?: string
): unknown[] | null {
  const required = new Set(elicitRequiredProps(params))
  const inputs: Record<string, unknown>[] = []
  for (const [index, target] of form.entries()) {
    const element = elicitFormInputElement(target)
    if (!element) return null
    const hint = elicitFormFieldHint(target)
    inputs.push({
      type: 'input',
      block_id: elicitFormBlockId(index),
      label: { type: 'plain_text', text: elicitFormFieldLabel(params, target), emoji: true },
      // Slack enforces presence itself for a required field; a required multi-select then also
      // needs one selection, which is stricter than `minItems: 0` but never admits less.
      optional: !required.has(target.propName),
      ...(hint ? { hint: { type: 'plain_text', text: hint } } : {}),
      element
    })
  }
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:speech_balloon: ${clampTo(elicitCardMessage(params), ELICIT_MESSAGE_CAP)}` }
    },
    ...inputs,
    {
      type: 'actions',
      ...(sessionTarget ? { block_id: sessionTarget } : {}),
      elements: [
        {
          type: 'button',
          action_id: ELICIT_CONFIRM_ACTION as string,
          text: { type: 'plain_text', text: 'Confirm', emoji: true },
          style: 'primary',
          value: requestId
        },
        elicitDismissButton(requestId)
      ]
    }
  ]
}

/** The two shapes a Slack elicitation card takes, decided by the reduction alone.
 *
 * A card is a row of BUTTONS exactly when ONE TAP CAN ANSWER IT: a single question that is a pure
 * single-select or a boolean. Everything else is INPUT blocks with one Confirm and one Dismiss —
 * a multi-select, a typed box, several questions, and a single question that brought a free-text
 * companion box. A button submits the instant it is tapped, which leaves no moment to fill
 * anything in; that is why a question gains a Confirm exactly when it has something to fill in.
 *
 * The companion case is not a guess about the schema: {@link elicitForm} already marks a companion
 * with {@link ElicitTarget.customAnswerFor} (the `_meta` flag an AskUserQuestion bridge or a Codex
 * `request_user_input` writes), so a question with a box is a reduction of two TARGETS and one
 * QUESTION, where two questions are two of each. Reading the TARGET count is therefore all this
 * needs: either way the card needs its inputs. Pure. */
export type ElicitCardShape = 'buttons' | 'inputs'

export function elicitCardShape(form: readonly ElicitTarget[]): ElicitCardShape {
  const only = form.length === 1 ? form[0]! : null
  return only && (only.kind === 'enum' || only.kind === 'boolean') ? 'buttons' : 'inputs'
}

/** What a refused field's error says, in the same plain words the card would have used — a
 *  reader who has to retype something is told the shape, never the schema keyword. */
function elicitFormFieldError(target: ElicitTarget): string {
  if (target.kind === 'text' || target.kind === 'number') return `Enter ${elicitFieldExpectation(target)}.`
  if (target.kind === 'multi-enum') return selectionHint(target) || 'Select from the options offered.'
  return 'Choose one of the options offered.'
}

/** A form card's answer, or the per-field errors that refuse it. Keyed by BLOCK id, which is what
 *  the submitted state itself is keyed by. */
export interface ElicitFormSubmission {
  answer?: Record<string, string | number | string[]>
  errors?: Record<string, string>
}

/**
 * Decode one Confirm's raw field state into the typed record a form card answers with, re-derived
 * against the FORM THAT WAS RENDERED rather than trusted from the wire (#1815): each value is read
 * under its field's own block id, resolved from the position the card carried it as, given the
 * schema's own type — a real number for `number`/`integer`, a list for a multi-select — and
 * checked by {@link fieldAccepts}. A blank optional
 * input is simply absent; a missing REQUIRED field, a value of the wrong shape, and a value the
 * field does not admit each come back as that field's error, so one bad field refuses the whole
 * answer instead of being silently dropped. Pure.
 */
export function elicitFormSubmission(
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[],
  fields: Readonly<Record<string, string | string[]>>
): ElicitFormSubmission {
  const required = new Set(elicitRequiredProps(params))
  const answer: Record<string, string | number | string[]> = {}
  const errors: Record<string, string> = {}
  for (const [index, target] of form.entries()) {
    const blockId = elicitFormBlockId(index)
    const raw = fields[blockId]
    // Slack sends `[]` for a multi-select nobody touched, so a blank OPTIONAL one is an omission,
    // not an empty answer that then fails its own `minItems`. A required field keeps being checked:
    // there, `[]` is a real selection and its bounds decide. (An emptied REQUIRED select staying an
    // answer is #1801's reading, kept.)
    const blank = raw === undefined || (Array.isArray(raw) && !raw.length && !required.has(target.propName))
    if (blank) {
      if (required.has(target.propName)) errors[blockId] = 'This field is required.'
      continue
    }
    // A Slack card's options carry their POSITION, so the literals come back through the field
    // the card rendered ({@link elicitCardValues}) before anything is checked — that is what lets
    // an option's value be a path, an id or a URL at all (#1794). One carried value naming no
    // option this field offered refuses the field, exactly as an unoffered literal would.
    const carried = elicitCardValues(target, raw)
    if (carried === null) {
      errors[blockId] = elicitFormFieldError(target)
      continue
    }
    const shaped =
      target.kind === 'multi-enum'
        ? Array.isArray(carried)
          ? carried
          : undefined
        : Array.isArray(carried)
          ? undefined
          : target.kind === 'number'
            ? NUMERIC_REPLY_RE.test(carried.trim())
              ? Number(carried.trim())
              : undefined
            : carried
    if (shaped === undefined || !fieldAccepts(target, shaped)) errors[blockId] = elicitFormFieldError(target)
    else answer[target.propName] = shaped
  }
  return Object.keys(errors).length ? { errors } : { answer }
}

/** What ANY refused answer is told on the card's own surface. A refusal drops the answer and
 *  leaves the card live (#1815), which without a line like this one is a button that does nothing:
 *  the reader cannot tell a rejected answer from a broken card. One wording for every transport —
 *  a refusal explained on Slack and silent on webchat is worse than a consistent one. */
export const ELICIT_ANSWER_REFUSED = "That answer wasn't accepted — the question is still open."

/** What a refused Confirm is told IN THE THREAD, since a message card has no modal to return the
 *  errors to: each refused field named as the card names it, with the same plain words a reply-
 *  answered card would use, and the card left live to be answered again. Pure. */
export function elicitFormRefusalNotice(
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[],
  errors: Readonly<Record<string, string>>
): string {
  const parts: string[] = []
  for (const [blockId, message] of Object.entries(errors)) {
    const index = elicitFormBlockIndex(blockId)
    const target = index === null ? undefined : form[index]
    parts.push(target ? `${elicitFormFieldLabel(params, target)}: ${message}` : message)
  }
  return clampTo(`${ELICIT_ANSWER_REFUSED} ${parts.join(' ')}`, ELICIT_MESSAGE_CAP)
}

/** What a consent card shows about its URL: the REAL host, so a lookalike or a userinfo prefix
 *  cannot pass itself off as one, and what to warn about. Both checks are on the host alone — a
 *  lookalike hides there, not in the path — and both are advisory: the card still shows the whole
 *  URL and still opens only on an explicit tap. Null ⇒ nothing a consent card may offer: a scheme
 *  no browser tab should take (the caller's {@link elicitUrl} already refused those, and this
 *  refuses them again rather than trust its caller), or a backtick, which cannot sit inside the
 *  code span that keeps the URL unfollowable without either escaping the span or lying about the
 *  bytes. Pure — it parses the URL and never touches the network. */
function consentUrlParts(url: string): { host: string; warnings: string[] } | null {
  if (url.includes('`')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // Sliced by POSITION, never by searching `parsed.host`: the parser's spelling is not in the original.
  const afterScheme = url.indexOf('//') + 2
  const authorityEnd = url.slice(afterScheme).search(/[/?#]/)
  const shownHost = url.slice(afterScheme, authorityEnd < 0 ? url.length : afterScheme + authorityEnd)
  const warnings: string[] = []
  if (parsed.protocol !== 'https:')
    warnings.push('Not encrypted (http) — anything you type on that page can be read in transit.')
  // Both spellings of one risk: the parser punycodes Unicode, but a homograph is a lookalike ON SCREEN.
  if (/(^|\.)xn--/i.test(parsed.hostname) || /[^\x00-\x7F]/.test(shownHost))
    warnings.push('This host is not plain ASCII, which can disguise a lookalike domain.')
  return { host: parsed.hostname, warnings }
}

/** Build the URL-mode CONSENT card: the agent's defused `message`, the real host, the whole URL in
 *  a code span, any advisory warnings, an Open link button and a Dismiss button. The URL is shown
 *  but deliberately NOT followable as text — Slack autolinks a bare URL, and a reader who left
 *  through that autolink would deliver no interaction, so the card would hang unanswered. The
 *  button's `url` field both opens the page and still sends Slack's interaction, which is what
 *  makes consent observable; its `value` carries the card's ONE option back ({@link
 *  elicitOptionToken}), which the daemon resolves to this same URL, so the answer is re-derived
 *  against the card that offered it. The URL itself never rides the button: Slack caps a `value`
 *  at 2000 and `elicitUrl` admits 2048, so a long OAuth `state` used to lose the card entirely
 *  (#1794). Returns null — the caller then declines with a notice — when this is not a URL-mode
 *  ask or the URL is not one a card may offer. Pure; the daemon never fetches the URL. */
export function buildUrlConsentCard(
  requestId: string,
  params: CreateElicitationRequest,
  sessionTarget?: string
): unknown[] | null {
  const url = elicitUrl(params)
  const parts = url && consentUrlParts(url.url)
  if (!url || !parts) return null
  const value = encodePermValue(requestId, elicitOptionToken(0))
  const detail = [
    'Opens in your browser. This agent never sees that page or anything you type on it.',
    `Host: \`${escapeSlackMrkdwn(parts.host)}\``,
    `\`${escapeSlackMrkdwn(url.url)}\``,
    ...parts.warnings.map((w) => `:warning: ${escapeSlackMrkdwn(w)}`)
  ].join('\n')
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:link: ${clampTo(elicitCardMessage(params), ELICIT_MESSAGE_CAP)}` }
    },
    { type: 'section', text: { type: 'mrkdwn', text: clampTo(detail, SLACK_SECTION_TEXT_CAP) } },
    {
      type: 'actions',
      ...(sessionTarget ? { block_id: sessionTarget } : {}),
      elements: [
        {
          type: 'button',
          action_id: `${ELICIT_ACTION_PREFIX}:0`,
          text: { type: 'plain_text', text: 'Open link', emoji: true },
          style: 'primary',
          url: url.url,
          value
        },
        {
          type: 'button',
          action_id: ELICIT_DISMISS_ACTION as string,
          text: { type: 'plain_text', text: 'Dismiss', emoji: true },
          value: requestId
        }
      ]
    }
  ]
}

/** Build the RESOLVED consent card (buttons removed) that replaces {@link buildUrlConsentCard}
 *  once opened, dismissed, cancelled, or reported complete. It keeps the URL on screen so the
 *  settled card still records what was consented to. Pure. */
export function buildUrlConsentResolvedCard(params: CreateElicitationRequest, decision: string): unknown[] {
  const url = elicitUrl(params)
  const shown = url && !url.url.includes('`') ? `\n\`${escapeSlackMrkdwn(url.url)}\`` : ''
  const text = `:link: ${clampTo(elicitCardMessage(params), ELICIT_MESSAGE_CAP)}${shown}\n${decision}`
  return [{ type: 'section', text: { type: 'mrkdwn', text: clampTo(text, SLACK_SECTION_TEXT_CAP) } }]
}

export interface SharedStatusActions {
  /** Opaque `{agentId,integrationId,sessionKey}` target validated by the relay. */
  sessionTarget: string
  /** Whether the bot is shareable (multi-agent) — gates the "Switch agent" option.
   *  A non-shareable shared bot still routes its overflow via `sessionTarget`, but it
   *  hosts one agent, so there is nothing to switch to. */
  shareable: boolean
}

/** Build the compact in-thread status message. Both dedicated and shared bots use one
 *  overflow accessory so the status stays on a single row; a SHAREABLE (multi-agent) bot
 *  also exposes Switch agent. Interrupting a turn is Slack's own Stop control — the
 *  overflow carries no cancel item. */
export function buildStatusBlocks(
  info: StatusBarInfo,
  sessionKey: string,
  link?: string,
  shared?: SharedStatusActions
): unknown[] {
  const text = `${renderStatusBar(info)}${link ? `  ·  <${link}|View Session>` : ''}`
  const target = shared?.sessionTarget ?? sessionKey
  const option = (label: string, action: 'switch-agent' | 'manage') => ({
    text: { type: 'plain_text', text: label },
    value: encodeSlackStatusOverflowValue(action)
  })
  const options = [
    ...(shared?.shareable ? [option('Switch agent', 'switch-agent')] : []),
    option('Session options', 'manage')
  ]
  return [
    {
      type: 'section',
      block_id: target,
      text: { type: 'mrkdwn', text },
      accessory: {
        type: 'overflow',
        action_id: STATUS_ACTION.more,
        options
      }
    }
  ]
}

/** Match the console's compact count display: 1_240_000 → "1.24M", 92_000 → "92K". */
function fmtCount(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined
  const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
  if (n >= 1_000_000) return trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)) + 'M'
  if (n >= 1_000) return trim((n / 1_000).toFixed(n >= 10_000 ? 0 : 1)) + 'K'
  return String(n)
}

/** Small terminal modal for a shortcut whose selected conversation has no
 * addressable AgentConnect session (or is not visible to the clicking user). */
export function buildStatusUnavailableModal(): Record<string, unknown> {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Session options' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'No AgentConnect session was found for this conversation.'
        }
      }
    ]
  }
}

/**
 * Build the controls modal opened from Configure (a snapshot — Slack modals don't
 * stream). `private_metadata` carries either the direct session key or a shared-bot
 * routing target so the modal's `block_actions` resolve the session. The modal stays
 * compact: identity + View-session share one line, related selectors render two per
 * row, and usage uses label-over-value fields. Interrupting a turn is Slack's own Stop
 * control — the modal carries no cancel button.
 */
export function buildStatusModal(
  info: StatusBarInfo,
  sessionKey: string,
  link?: string,
  privateMetadata = sessionKey,
  identity?: StatusModalIdentity
): Record<string, unknown> {
  const blocks: unknown[] = []
  const controlBlocks: unknown[] = []
  const modelControls: unknown[] = []
  const tuningControls: unknown[] = []
  const outputControls: unknown[] = []
  const models = info.models ?? []
  const compactOption = (label: string, text: string, value: string) => ({
    text: { type: 'plain_text', text: clampTo(`${label} · ${text}`, 75) },
    value
  })

  if (models.length > 0) {
    const opts = info.model && !models.includes(info.model) ? [info.model, ...models] : models
    const option = (m: string) => compactOption('Model', m, m)
    modelControls.push({
      type: 'static_select',
      action_id: STATUS_ACTION.setModel,
      placeholder: { type: 'plain_text', text: 'Model' },
      ...(info.model ? { initial_option: option(info.model) } : {}),
      options: opts.map(option)
    })
  }

  // Effort — a static_select of the runtime's `thought_level` levels (plus synthetic
  // ultracode/max on Claude runtimes). Omitted when the runtime offers no effort selector.
  const efforts = info.efforts ?? []
  if (efforts.length > 0) {
    const opts = info.effort && !efforts.includes(info.effort) ? [info.effort, ...efforts] : efforts
    const option = (e: string) => compactOption('Effort level', e, e)
    tuningControls.push({
      type: 'static_select',
      action_id: STATUS_ACTION.setEffort,
      placeholder: { type: 'plain_text', text: 'Effort level' },
      ...(info.effort ? { initial_option: option(info.effort) } : {}),
      options: opts.map(option)
    })
  }

  // Fast mode — an On/Off static_select, shown only when the selected model advertises a
  // fast toggle (the ACP `model_config` option). `on`/`off` match the daemon's set path.
  if (info.fastModeAvailable) {
    const fastOpt = (v: 'on' | 'off') => compactOption('Fast mode', v === 'on' ? 'On' : 'Off', v)
    const current: 'on' | 'off' = info.fastMode ? 'on' : 'off'
    modelControls.push({
      type: 'static_select',
      action_id: STATUS_ACTION.setFast,
      placeholder: { type: 'plain_text', text: 'Fast mode' },
      initial_option: fastOpt(current),
      options: [fastOpt('on'), fastOpt('off')]
    })
  }

  // Permission follows the model / effort / fast controls, matching the Agent and
  // console session surfaces. Codex Auto travels as one AgentConnect session preset;
  // the daemon decomposes it before calling ACP.
  const permissionModes = info.permissionModes ?? []
  if (permissionModes.length > 0) {
    const opts =
      info.permissionMode && !permissionModes.includes(info.permissionMode)
        ? [info.permissionMode, ...permissionModes]
        : permissionModes
    const option = (m: string) => compactOption('Permission', permissionModeDisplayLabel(m), m)
    tuningControls.push({
      type: 'static_select',
      action_id: STATUS_ACTION.setPermissionMode,
      placeholder: { type: 'plain_text', text: 'Permission' },
      ...(info.permissionMode ? { initial_option: option(info.permissionMode) } : {}),
      options: opts.map(option)
    })
  }

  // Output verbosity — a fixed none/minimal/low/medium/high select controlling how much of the
  // turn (reasoning / tool activity / output) reaches Slack. `none` delivers nothing to the
  // channel (session transcript only). Daemon-side, not ACP; always shown (unlike model/effort/
  // fast, it isn't runtime-gated). Omitted only when unknown.
  if (info.outputMode) {
    const modeOpt = (v: 'none' | 'minimal' | 'low' | 'medium' | 'high') => compactOption('Output mode', v, v)
    outputControls.push({
      type: 'static_select',
      action_id: STATUS_ACTION.setOutput,
      placeholder: { type: 'plain_text', text: 'Output mode' },
      initial_option: modeOpt(info.outputMode),
      options: [modeOpt('none'), modeOpt('minimal'), modeOpt('low'), modeOpt('medium'), modeOpt('high')]
    })
  }

  for (const controls of [modelControls, tuningControls, outputControls]) {
    if (controls.length) controlBlocks.push({ type: 'actions', elements: controls })
  }

  const identityName = identity?.name.replace(/\s+/g, ' ').trim()
  const sessionTitle = identity?.sessionTitle?.replace(/\s+/g, ' ').trim()
  const currentModel = info.model?.replace(/\s+/g, ' ').trim()
  const agentLink = safeSlackLinkUrl(identity?.agentUrl)
  const sessionLink = safeSlackLinkUrl(link)
  const identityLabel = identityName
    ? agentLink
      ? `<${agentLink}|${escapeMrkdwnLabel(clampTo(identityName, 256))}>`
      : escapeMrkdwnLabel(clampTo(identityName, 256))
    : undefined
  const modelLabel = models.length === 0 && currentModel ? escapeMrkdwnLabel(clampTo(currentModel, 256)) : undefined
  const meta = [identityLabel, modelLabel].filter((part): part is string => Boolean(part))
  const identityElements: unknown[] = []
  if (identityName) {
    const iconUrl = safeSlackLinkUrl(identity?.iconUrl)
    if (iconUrl) identityElements.push({ type: 'image', image_url: iconUrl, alt_text: clampTo(identityName, 2_000) })
  }
  if (meta.length) {
    identityElements.push({
      type: 'mrkdwn',
      text: `${meta.join(' · ')}${sessionLink ? ' ·' : ''}`
    })
  }
  if (sessionLink) identityElements.push({ type: 'mrkdwn', text: `<${sessionLink}|View session>` })
  if (identityElements.length) {
    blocks.push({
      type: 'context',
      elements: identityElements
    })
  }
  blocks.push(...controlBlocks)

  // Usage fields keep labels above their values without the old Usage / Token breakdown
  // headers. Slack lays fields out two per row; missing metrics collapse naturally.
  let contextValue: string | undefined
  if (info.contextUsed !== undefined) {
    contextValue =
      info.contextSize && info.contextSize > 0
        ? `${fmtCount(info.contextUsed)} / ${fmtCount(info.contextSize)} (${Math.round(
            (info.contextUsed / info.contextSize) * 100
          )}%)`
        : fmtCount(info.contextUsed)
  }
  let costValue: string | undefined
  if (info.costAmount !== undefined) {
    // Bare `$` for USD (the common case), else an explicit ISO code suffix.
    const cur = info.costCurrency && info.costCurrency !== 'USD' ? ` ${info.costCurrency}` : ''
    const sym = !info.costCurrency || info.costCurrency === 'USD' ? '$' : ''
    costValue = `${sym}${info.costAmount.toFixed(info.costAmount < 1 ? 3 : 2)}${cur}`
  }
  const totalTokensValue = fmtCount(info.totalTokens)
  const field = (label: string, value?: string) =>
    value === undefined ? undefined : { type: 'mrkdwn', text: `*${label}*\n${value}` }
  const pairedField = (...items: Array<[label: string, value: string | undefined]>) => {
    const visible = items.filter((item): item is [string, string] => item[1] !== undefined)
    return visible.length
      ? {
          type: 'mrkdwn',
          text: `${visible.map(([label]) => `*${label}*`).join(' · ')}\n${visible.map(([, value]) => value).join(' · ')}`
        }
      : undefined
  }
  const totalAndCost = [totalTokensValue, costValue].filter((value): value is string => value !== undefined)
  const totalAndCostLabel =
    totalTokensValue !== undefined && costValue !== undefined
      ? 'Total tokens · Cost'
      : totalTokensValue !== undefined
        ? 'Total tokens'
        : 'Cost'
  const cachedReadValue = fmtCount(info.cachedReadTokens)
  const cachedWriteValue = fmtCount(info.cachedWriteTokens)
  const cacheField =
    cachedReadValue !== undefined || cachedWriteValue !== undefined
      ? pairedField(['Cache read', cachedReadValue ?? '—'], ['Cache write', cachedWriteValue ?? '—'])
      : undefined
  const summaryFields = [
    field('Current context', contextValue),
    field(totalAndCostLabel, totalAndCost.length ? totalAndCost.join(' · ') : undefined)
  ].filter(Boolean)
  const breakdownFields = [
    pairedField(['Input', fmtCount(info.inputTokens)], ['Output', fmtCount(info.outputTokens)]),
    cacheField
  ].filter(Boolean)
  if (summaryFields.length || breakdownFields.length) {
    if (blocks.length) blocks.push({ type: 'divider' })
    if (summaryFields.length) blocks.push({ type: 'section', fields: summaryFields })
    if (breakdownFields.length) blocks.push({ type: 'section', fields: breakdownFields })
  }

  return {
    type: 'modal',
    callback_id: STATUS_MODAL_CALLBACK,
    private_metadata: privateMetadata,
    title: {
      type: 'plain_text',
      text: clampTo(sessionTitle ? `Session · ${sessionTitle}` : 'Session', 24)
    },
    close: { type: 'plain_text', text: 'Close' },
    blocks
  }
}

export class OutputConverger {
  private buf = ''
  // Accumulated thinking text (high mode only) and a dirty flag. Reasoning is coalesced
  // onto the daemon's idle-flush timer — never emitted per thought chunk — so a long
  // thinking stream edits its one in-place message at most once per idle window instead
  // of flooding chat.update through the 350ms send-queue.
  private reasoningBuf = ''
  private reasoningDirty = false
  // Last activity label (tool title / "is thinking…") — only for consecutive-collapse:
  // the label is never displayed, a non-empty set-status just keeps the session `processing`.
  private lastActivity = ''
  // Remember each tool's last known title so a title-less tool_call_update reuses it
  // (and is collapsed by consecutive-dedup) instead of surfacing the raw toolCallId.
  private toolTitles = new Map<string, string>()
  // high mode only: latest extracted output per in-flight tool (content is a whole
  // replacement each update, so keep the newest), and the set of tools whose output has
  // already been posted — output is emitted at most once, when the call reaches a
  // terminal status, so it isn't re-posted on every streamed update.
  private toolOutputs = new Map<string, string>()
  private emittedOutput = new Set<string>()
  // `minimal` mode only. `segmentReset` marks that the previous reply segment was closed
  // by a tool boundary, so the next agent_message_chunk starts a fresh segment (the old one
  // is replaced in the single live message). `recordDirty` is true while `buf` holds text
  // not yet written to the transcript — it gates both the transcript record (at each
  // boundary / onFinal) and the idle-flush live update (so an already-recorded segment
  // isn't re-pushed to chat.update every idle window).
  private segmentReset = false
  private recordDirty = false
  // The runtime's own message identity, which is the only boundary a speak-only run offers.
  private readonly messages = new AgentMessageRun()
  // ── Native tool-call chrome (slack-streaming-turn-output.md §3) ──────────────
  // The axis, plus the one stream's card bookkeeping. Nothing here touches the body.
  private streaming = false
  private streamOpened = false
  private streamClosed = false
  // Cards awaiting the next append, keyed by ACP tool call id so a burst of updates for one
  // call collapses to its newest state; `emittedTasks` suppresses an unchanged repeat.
  private pendingTasks = new Map<string, Extract<SlackStreamChunk, { type: 'task_update' }>>()
  private emittedTasks = new Map<string, string>()
  private taskTitles = new Map<string, string>()
  private openTasks = new Set<string>()
  /** Cards whose write-once body has been sent, so a later update cannot append a second. */
  private outputWritten = new Set<string>()
  /** Tool calls ACP reported failed — counted into the closing label, never the model's to
   *  narrate, and deliberately NOT the cards' status (see FAILED_PREFIX). */
  private failedTasks = new Set<string>()
  // A tool call's own one-line label and verbatim command, remembered from whichever update
  // carried `rawInput` — a streamed `tool_call_update` usually carries none.
  private toolDescriptions = new Map<string, string>()
  private toolCommands = new Map<string, string>()
  // The current thinking run: whether one is open, a counter so each gets its own card, and
  // the head of its text until the first line names it.
  private thinkingActive = false
  private thinkingRun = 0
  private thinkingHead = ''
  private thinkingTitle = ''
  private thinkingBody = ''
  private thinkingBodyTruncated = false
  /** The container's label, so an unchanged one is never re-sent, plus the one awaiting the
   *  next append and the legacy `progress` text that append would degrade to. */
  private planTitle = ''
  private pendingPlanTitle = ''
  private pendingProgress = ''

  /**
   * `protectedAddresses` are the COMPOUND mention addresses in this conversation — a
   * shared Slack bot's `<@U_SHARED> reviewer`, where the bot user id names the app and the
   * trailing slug selects the agent (send-message-routing-rework.md §5.3/§8.5).
   *
   * The splitter finds every self-delimiting `<…>` address by itself; it cannot infer that
   * a bare word after a mention is part of the address, because in every other message it
   * is ordinary prose. So the daemon supplies the ones it rendered from its own directory.
   * Splitting between the two halves would address the APP instead of the agent — under
   * §2.1 that silently drops the delivery the mention was making, not just its formatting.
   */
  constructor(
    private mode: 'none' | 'minimal' | 'low' | 'medium' | 'high',
    private protectedAddresses: readonly string[] = [],
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  /** True while body text OR reasoning is pending — the daemon uses this to (re)arm
   *  the ~2s idle-flush timer (§9.1 text-buffer) so a long pure-text stream posts in
   *  steps and streamed thinking updates its in-place block at most once per window. */
  hasBuffered(): boolean {
    // minimal: only the current (unrecorded) segment matters — arm the idle timer while
    // there is fresh streamed text to reflect into the single live message.
    if (this.mode === 'minimal') return this.recordDirty
    return this.buf.trim().length > 0 || this.reasoningDirty
  }

  /**
   * Take the native chrome pipeline for this turn (§3.1). Decided once at turn start from a
   * synchronous capability read; only `medium` and `high` render tool chrome at all, so the
   * other rungs stay byte-identical to today whatever the workspace supports.
   */
  enableStreaming(): void {
    if (this.mode === 'medium' || this.mode === 'high') this.streaming = true
  }

  isStreaming(): boolean {
    return this.streaming
  }

  /** Whether a newer card snapshot is ready for the append timer (§3.5). */
  hasStreamingUpdate(): boolean {
    return this.streaming && !this.streamClosed && (this.pendingTasks.size > 0 || this.pendingPlanTitle !== '')
  }

  /**
   * Drain the dirty cards into ONE append, opening the stream lazily on the first batch that
   * has something to show. A turn that runs no tools therefore never opens a stream and is
   * byte-identical to today.
   */
  streamUpdate(): SlackAction[] {
    if (!this.streaming || this.streamClosed) return []
    const progressText = this.pendingProgress
    const chunks = this.drainStreamChunks()
    if (chunks.length === 0) return []
    this.pendingProgress = ''
    const out: SlackAction[] = []
    if (!this.streamOpened) {
      this.streamOpened = true
      out.push({ kind: 'stream-start' })
    }
    out.push({ kind: 'stream-append', chunks, ...(progressText ? { progressText } : {}) })
    return out
  }

  /**
   * Settle every card to a real terminal status and relabel the container, then stop.
   *
   * Stopping a stream that still has `in_progress` cards makes Slack render the container as
   * "Something went wrong" and flip those cards to `error` (verified live 2026-08-28), so the
   * settle append is not cosmetic — it is what every stop is owed. Idempotent: the second
   * caller of a turn's settle gets nothing.
   */
  settleStream(outcome: 'completed' | 'stopped' | 'failed'): SlackAction[] {
    if (!this.streaming || this.streamClosed) return []
    this.streamClosed = true
    // A tool that started AND finished inside one coalescing window leaves cards pending with
    // no stream open yet. Opening it here is what keeps such a turn from ending with no tool
    // chrome at all; only a genuinely tool-free turn stays silent.
    if (!this.streamOpened && this.emittedTasks.size === 0) return []
    const terminal = outcome === 'completed' ? 'complete' : 'error'
    this.closeThinkingRun(terminal)
    for (const id of [...this.openTasks]) this.queueTask(id, this.taskTitles.get(id) ?? 'tool', terminal)
    // Forced rather than queued: the container must always carry its closing label, even when
    // the working one happens to read the same.
    this.planTitle =
      outcome === 'completed' ? this.planSummary() : outcome === 'stopped' ? STREAM_PLAN_STOPPED : STREAM_PLAN_FAILED
    this.pendingPlanTitle = this.planTitle
    const progressText = this.pendingProgress
    this.pendingProgress = ''
    const settle = this.drainStreamChunks()
    const out: SlackAction[] = []
    if (!this.streamOpened) {
      this.streamOpened = true
      out.push({ kind: 'stream-start' })
    }
    out.push({ kind: 'stream-stop', settle, ...(progressText ? { progressText } : {}) })
    return out
  }

  private drainStreamChunks(): SlackStreamChunk[] {
    const chunks: SlackStreamChunk[] = [...this.pendingTasks.values()]
    this.pendingTasks.clear()
    if (this.pendingPlanTitle) {
      chunks.push({ type: 'plan_update', title: this.pendingPlanTitle })
      this.pendingPlanTitle = ''
    }
    return chunks
  }

  /**
   * Queue one task card, keyed by id so streamed updates edit the same card and an unchanged
   * repeat emits nothing. `title` and `status` may be re-sent freely — Slack REPLACES them per
   * id. The body may not: `details` and `output` both append, so they are written together
   * exactly once, at completion. Callers pass their text RAW — the cap and the code fence
   * belong here, where the wire limit is known. `command` is fenced into a code block;
   * `details` is prose (a thinking run) and takes the same slot unfenced.
   */
  private queueTask(
    id: string,
    title: string,
    status: 'in_progress' | 'complete' | 'error',
    body: { command?: string; details?: string; output?: string } = {}
  ): void {
    const clamped = clampTo(plainCardText(title), MAX_CARD_TITLE) || 'tool'
    const fresh = !this.outputWritten.has(id)
    const above = body.command ? codeSpan(capOutput(body.command), true) : capOutput(body.details ?? '')
    const details = fresh ? above : ''
    const output = fresh && body.output ? capOutput(body.output) : ''
    const chunk: Extract<SlackStreamChunk, { type: 'task_update' }> = {
      type: 'task_update',
      id,
      title: clamped,
      status,
      ...(details ? { details } : {}),
      ...(output ? { output } : {})
    }
    const signature = `${chunk.title} ${chunk.status}`
    if (!details && !output && this.emittedTasks.get(id) === signature) return
    if (details || output) this.outputWritten.add(id)
    this.emittedTasks.set(id, signature)
    this.taskTitles.set(id, clamped)
    if (status === 'in_progress') this.openTasks.add(id)
    else this.openTasks.delete(id)
    this.pendingTasks.set(id, chunk)
    // The container earns its working label the moment it has a card to hold.
    this.queuePlanTitle(STREAM_PLAN_WORKING)
  }

  /** Relabel the container, skipping an unchanged label (§4). */
  private queuePlanTitle(title: string): void {
    const clamped = clampTo(plainCardText(title), MAX_STREAM_TASK)
    if (!clamped || clamped === this.planTitle) return
    this.planTitle = clamped
    this.pendingPlanTitle = clamped
  }

  /** What the container says once the turn is over. Counted, not narrated: no model call, and
   *  a failed step is named rather than folded into a success. */
  private planSummary(): string {
    const total = this.emittedTasks.size
    if (total === 0) return 'Done'
    const steps = `${total} step${total === 1 ? '' : 's'}`
    const failed = this.failedTasks.size
    return failed === 0 ? `Completed ${steps}` : `Completed ${steps} · ${failed} failed`
  }

  private thinkingId(): string {
    return `thinking-${this.thinkingRun}`
  }

  /** Accumulate a run's body under the card-body cap, REMEMBERING that the cap was reached.
   *  Silently slicing to the cap hands `capOutput` a value that already looks whole, so the
   *  card would present a run missing its ending as if that were the ending. */
  private appendThinkingBody(thought: string): void {
    const room = MAX_TOOL_OUTPUT - this.thinkingBody.length
    if (room <= 0 || thought.length > room) this.thinkingBodyTruncated = true
    if (room > 0) this.thinkingBody += thought.slice(0, room)
  }

  /**
   * Title a thinking run from its FIRST LINE. Runtimes open a thought with a short
   * `**heading**` — the same line the web console shows as the step's title — so the card can
   * say what the agent is thinking about instead of the bare word "Thinking". The card opens
   * before that line has arrived, which costs nothing: `title` REPLACES per id, so the
   * placeholder is simply renamed (verified live 2026-08-29).
   *
   * Runs once per run, at the first newline or once the head is title-width, whichever comes
   * first — a runtime that streams one unbroken paragraph still gets a title out of its head.
   */
  private noteThinkingTitle(thought: string): void {
    if (this.thinkingTitle) return
    this.thinkingHead = (this.thinkingHead + thought).slice(0, MAX_THINKING_HEAD)
    const title = this.thinkingTitleFrom(false)
    if (title) this.queueTask(this.thinkingId(), title, 'in_progress')
  }

  /** The run's title, resolved from its head, or '' while the first line could still grow.
   *  `final` takes whatever the head holds — at settle time no more of it is coming, which is
   *  what titles a short last thought that never reached a newline. */
  private thinkingTitleFrom(final: boolean): string {
    if (this.thinkingTitle) return this.thinkingTitle
    // trimStart: a thought can open with blank lines, which must not resolve to a blank title.
    const head = this.thinkingHead.trimStart()
    const nl = head.indexOf('\n')
    if (!final && nl < 0 && head.length < MAX_CARD_TITLE) return ''
    this.thinkingTitle = clampTo(plainCardText(nl < 0 ? head : head.slice(0, nl)), MAX_CARD_TITLE)
    return this.thinkingTitle
  }

  /** A thinking run ends at the next tool call or at turn end — settle its card rather than
   *  leaving a spinner behind. Title and status only: the thought text itself belongs in
   *  high mode's in-place Thinking message, which is where 2,800 characters fit. */
  private closeThinkingRun(status: 'complete' | 'error' = 'complete'): void {
    if (!this.thinkingActive) return
    const title = this.thinkingTitleFrom(true) || THINKING_CARD
    this.queueTask(this.thinkingId(), title, status, { details: this.thinkingRunBody(title) })
    this.thinkingActive = false
    this.thinkingRun += 1
    this.thinkingHead = ''
    this.thinkingTitle = ''
    this.thinkingBody = ''
    this.thinkingBodyTruncated = false
  }

  /**
   * What a settled thinking card shows under its title on `high`: the run, as the web console's
   * work rows show it — de-bolded, and without re-saying a title that was shown whole.
   *
   * The body is dropped only when the TITLE already shows the run whole. "Has no newline" is not
   * that test: a single unbroken line longer than the title clamp would then survive only as its
   * own first 72 characters, and with the reasoning message gone there is nothing else holding
   * the rest. When the title DID show the first line whole, that line is dropped from the body
   * instead — repeating it directly under itself says nothing.
   *
   * Bold markers are stripped: runtimes emit every thought heading as `**heading**`, so a
   * heading-only run rendered as a slab of bold. The headings are the content; the shouting is
   * not. Other markdown is left alone.
   */
  private thinkingRunBody(title: string): string {
    if (this.mode !== 'high') return ''
    let body = stripBoldMarks(this.thinkingBody.trim())
    if (!body || plainCardText(body) === title) return ''
    // Unclamped comparison on purpose: a truncated title differs from its full first line, and
    // a body under a truncated title must keep that line — it is what the title could not show.
    const nl = body.indexOf('\n')
    if (nl >= 0 && plainCardText(body.slice(0, nl)) === title) {
      body = body.slice(nl + 1).trim()
      if (!body) return ''
    }
    return this.thinkingBodyTruncated ? `${body}…` : body
  }

  /** Flush pending output for the idle timer: in high mode one in-place `reasoning` update
   *  carrying the reasoning accumulated since the last flush, THEN the buffered body
   *  (verbatim markdown split into ≤block-limit `post` sections — each a Block Kit
   *  `markdown` block, no mrkdwn conversion). Reasoning is emitted first so its in-place
   *  block is first-posted ABOVE the reply: thinking precedes the answer (§9.1), so the
   *  Thinking block must sit above it, not below.
   *
   *  minimal: no per-window `post`s — just the `live-reply` refresh. */
  flushBuffered(): SlackAction[] {
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flushStreaming()]
  }

  /** Drain everything for a turn that is ending abnormally: the runtime narrated its terminal
   *  error into the message stream and then rejected the prompt, so `onFinal` never runs and
   *  there is no later flush to hold a partial paragraph for. Unlike the idle flush this takes
   *  the whole buffer, paragraph break or not — otherwise the runtime's own error text is
   *  dropped and replaced by the generic failure notice. */
  flushTerminal(): SlackAction[] {
    if (this.mode === 'minimal') return this.liveRefresh(true)
    // A crashed turn settles like a stopped one: whatever was still in flight did not finish
    // BECAUSE the turn died, so those cards are honestly `error` under a "Failed" label — while
    // steps that already finished keep their state, (failed)-prefixed ones included. The ⚠️
    // notice the caller appends still carries the reason in the body.
    return [...this.drainReasoning(), ...this.flush(), ...this.settleStream('failed')]
  }

  /** minimal: refresh the single in-place `live-reply` with the current segment (display only;
   *  the transcript record happens at segment boundaries). */
  private liveRefresh(complete = false): SlackAction[] {
    const trimmed = this.buf.trim()
    // Hold the live reply while the body could still be the bare response-control marker, so a
    // suppressed turn never flashes a partial reply in-place (onFinal drops it entirely).
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    const raw = complete ? this.buf : this.buf.slice(0, referenceBufferStart(this.buf))
    const text = flattenUnsafeLinks(raw, { resolveFileLink: this.resolveFileLink })
    return text.trim() ? [{ kind: 'live-reply', text: this.liveDisplay(text) }] : []
  }

  /** minimal: the single live message can hold one Block Kit `markdown` block (≤12000
   *  chars). If the current segment is longer it's shown head-clamped with a pointer to the
   *  full text in the web session — the untruncated segment always reaches the transcript
   *  via the paired `recordOnly` posts. */
  private liveDisplay(text: string): string {
    const sections = splitIntoSections(text, undefined, this.protectedAddresses)
    return sections.length <= 1 ? text : `${sections[0]}\n\n_…full reply in the web session_`
  }

  /** minimal: close the current reply segment — the full text as `recordOnly` post(s) for the
   *  transcript, plus a live-reply refresh for the channel. Finalization carries the complete
   *  segment so the daemon can split an over-limit answer across Slack messages. Guards on
   *  `recordDirty` so an already-closed segment isn't re-recorded. Always arms the next segment. */
  private closeSegment(final = false): SlackAction[] {
    this.segmentReset = true
    if (!this.recordDirty || !this.buf.trim()) return []
    // Hold while the body may still be / is the bare sentinel — a suppressed reply must not be
    // recorded or shown; onFinal makes the final drop. Non-sentinel bodies close normally.
    if (isNoResponsePrefix(this.buf.trim())) return []
    const text = flattenUnsafeLinks(this.buf, { resolveFileLink: this.resolveFileLink })
    this.recordDirty = false
    if (!text.trim()) return []
    return [
      final ? { kind: 'final-live-reply', text } : { kind: 'live-reply', text: this.liveDisplay(text) },
      ...splitIntoSections(text, undefined, this.protectedAddresses).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as SlackAction
      )
    ]
  }

  /** Drain reasoning buffered since the last flush into a 0-or-1-length action list (only
   *  high mode ever sets `reasoningDirty`). Callers place it before the body flush so the
   *  Thinking block posts above the reply. */
  private drainReasoning(): SlackAction[] {
    // A streaming turn's thinking cards ARE this message — posting it too would repeat every
    // line of it under the container that already holds them.
    if (this.streaming || !this.reasoningDirty) return []
    this.reasoningDirty = false
    const text = flattenUnsafeLinks(this.reasoningBuf, { resolveFileLink: this.resolveFileLink })
    return text.trim() ? [{ kind: 'reasoning', text: renderReasoning(text) }] : []
  }

  private flush(): SlackAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      return []
    }
    // "Not for me" control marker (§no-response): hold the buffer while it could
    // still become the bare marker (it streams token-by-token) so a suppressed
    // turn never leaks a partial post. onFinal drops it entirely; a body that diverges from
    // the sentinel is released and posted normally on the next flush.
    if (isNoResponsePrefix(trimmed)) return []
    const text = this.buf
    this.buf = ''
    return this.emitBody(text)
  }

  /** The idle timer's body flush. Unlike a semantic boundary (tool call / plan / thinking,
   *  where the model really did finish a text block) this fires on a mere pause in the ACP
   *  stream, so it posts only up to the last paragraph break and re-buffers the rest —
   *  otherwise one reply is split across two messages mid-sentence (§stream-boundary). */
  private flushStreaming(): SlackAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    const { ready, tail } = splitAtParagraphBoundary(this.buf)
    if (!ready) return []
    this.buf = tail
    return this.emitBody(ready)
  }

  private emitBody(raw: string): SlackAction[] {
    const text = flattenUnsafeLinks(raw, { resolveFileLink: this.resolveFileLink })
    if (!text.trim()) return []
    // none: record the reply into the transcript WITHOUT sending it — `recordOnly` is handled
    // before the connection check on every platform, so it lands even though replyConn is unset.
    const recordOnly = this.mode === 'none'
    return splitIntoSections(text, undefined, this.protectedAddresses).map(
      (t) => ({ kind: 'post', text: t, ...(recordOnly ? { recordOnly: true } : {}) }) as SlackAction
    )
  }

  /**
   * Record an activity label and build the working-status action. Consecutive repeats
   * collapse to nothing (returns []), which throttles streamed thought chunks down to one
   * status update per thinking run; the connection dedupes the rest at the lifecycle level.
   */
  private pushActivity(raw: string): SlackAction[] {
    // none: nothing reaches the channel, not even the transient working status.
    if (this.mode === 'none') return []
    const label = clampTo(raw, MAX_STATUS)
    if (this.lastActivity === label) return []
    this.lastActivity = label
    return [{ kind: 'set-status', text: label }]
  }

  /** Resolve a tool call's display label, reusing a known title when an update omits it. */
  private toolLabel(update: { toolCallId?: string; title?: string }): string {
    const id = update.toolCallId
    if (update.title) {
      if (id) this.toolTitles.set(id, update.title)
      return update.title
    }
    return (id && this.toolTitles.get(id)) ?? id ?? 'tool'
  }

  /** Remember what a tool call's `rawInput` said about itself. Only some updates carry it — a
   *  streamed `tool_call_update` usually does not — so the first one that does wins. */
  private noteToolInput(update: { toolCallId?: string; rawInput?: unknown }): void {
    const id = update.toolCallId
    if (!id || update.rawInput === undefined) return
    const description = rawInputField(update, 'description')
    const command = rawInputField(update, 'command')
    if (isStepLabel(description) && !this.toolDescriptions.has(id)) this.toolDescriptions.set(id, description)
    if (command && !this.toolCommands.has(id)) this.toolCommands.set(id, command)
  }

  /** A card's one-line step label: the runtime's own description when it gave one, else the
   *  tool title SHAPED. An ACP title for a shell tool IS the command (codex-acp sends no
   *  description at all), which reads as a paragraph of shell on a card — so a command-shaped
   *  fallback is cut at its first shell separator and clamped tighter than a prose title:
   *  `git status --short --branch …` labels the step; the full chain rides the code block. */
  private cardTitle(id: string, label: string): string {
    const description = this.toolDescriptions.get(id)
    if (description) return description
    const head = label.split(SHELL_SEPARATOR, 1)[0] ?? label
    if (head.length < label.length) return `${clampTo(head, MAX_COMMAND_TITLE - 2)} …`
    return clampTo(label, MAX_COMMAND_TITLE)
  }

  /** What the card's code block shows: the verbatim command, or the full title when that is
   *  all the runtime gave. Skipped when the title already shows it whole — an untruncated
   *  one-line label needs no code block repeating it. */
  private cardCommand(id: string, label: string): string {
    const command = this.toolCommands.get(id) || label
    return plainCardText(command) === plainCardText(this.cardTitle(id, label)) ? '' : command
  }

  /** Refresh the newest output for one tool call. content/rawOutput are a whole replacement
   *  when present, so only touch the cache when this update actually carries them: set the
   *  newest text, or clear a stale entry if the replacement is empty / a non-text block. */
  private noteToolOutput(update: { toolCallId?: string; content?: unknown; rawOutput?: unknown }): void {
    const id = update.toolCallId
    if (!id || (update.content === undefined && update.rawOutput === undefined)) return
    const out = extractToolOutput(update)
    if (out) this.toolOutputs.set(id, out)
    else this.toolOutputs.delete(id)
  }

  /** high mode: surface a finished tool's output as a code-block `tool-output` action.
   *  Tracks the latest output across streamed updates and emits it exactly once, when the
   *  call reaches a terminal status (completed/failed) — so partial output isn't posted
   *  early and the final result isn't re-posted. Returns [] when there's nothing to post. */
  private drainToolOutput(update: {
    toolCallId?: string
    status?: string
    content?: unknown
    rawOutput?: unknown
  }): SlackAction[] {
    const id = update.toolCallId
    if (!id) return []
    this.noteToolOutput(update)
    const terminal = update.status === 'completed' || update.status === 'failed'
    if (!terminal || this.emittedOutput.has(id)) return []
    const text = this.toolOutputs.get(id)
    if (!text) return []
    this.emittedOutput.add(id)
    this.toolOutputs.delete(id)
    const icon = update.status === 'failed' ? ':x:' : ':page_facing_up:'
    // Icon on its own line so the fenced code block starts at column 0 — a fence indented
    // by the icon prefix would not be parsed as a code block under CommonMark.
    return [{ kind: 'tool-output', text: `${icon}\n${codeSpan(capOutput(text), true)}` }]
  }

  onUpdate(update: SessionUpdate): SlackAction[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = (update as { content?: { type?: string; text?: string } }).content
        const text = content?.type === 'text' ? (content.text ?? '') : ''
        // A new message closes the one before it exactly as a tool boundary would — same mode
        // semantics, same actions. Without this the two arrive as one post, run together.
        const closed = this.messages.opens(update) ? (this.mode === 'minimal' ? this.closeSegment() : this.flush()) : []
        // minimal: a chunk arriving after a tool boundary opens a new segment that REPLACES
        // the previous one in the single live message (the previous was already recorded).
        if (this.mode === 'minimal' && this.segmentReset && text) {
          this.buf = ''
          this.segmentReset = false
        }
        this.buf += text
        if (this.mode === 'minimal' && text.trim()) this.recordDirty = true
        return closed
      }
      case 'agent_thought_chunk': {
        // high: accumulate the streamed thought into the reasoning buffer and mark it
        // dirty; the actual in-place `reasoning` update is deferred to flushBuffered()
        // (idle timer) / onFinal so a token-by-token stream doesn't flood chat.update.
        // low + medium keep only the transient status — no reasoning in the channel.
        // A STREAMING turn keeps none of this: its cards are the Thinking message (§5).
        const thought = (update as { content?: { text?: string } }).content?.text ?? ''
        if (this.mode === 'high' && thought && !this.streaming) {
          this.reasoningBuf += thought
          // Soft-cap the raw buffer so a very long turn can't grow it unbounded;
          // renderReasoning tail-clamps again for the message body.
          if (this.reasoningBuf.length > MAX_REASONING * 2) {
            this.reasoningBuf = this.reasoningBuf.slice(-MAX_REASONING * 2)
          }
          this.reasoningDirty = true
        }
        // streaming: ONE card per thinking run, opened once and settled once. Its title is the
        // run's own first line and, on high, its body is the rest of the run — so the card IS
        // the Thinking message and the separate one is not posted (§5).
        if (this.streaming && thought) {
          if (!this.thinkingActive) {
            this.thinkingActive = true
            this.queueTask(this.thinkingId(), THINKING_CARD, 'in_progress')
          }
          this.noteThinkingTitle(thought)
          if (this.mode === 'high') this.appendThinkingBody(thought)
        }
        // minimal: keep the streamed reply intact (thinking mid-reply doesn't close a
        // segment) — only surface the transient status.
        if (this.mode === 'minimal') return this.pushActivity(THINKING)
        // Flush any buffered body, then surface the live "is thinking…" status.
        return [...this.flush(), ...this.pushActivity(THINKING)]
      }
      case 'tool_call':
      case 'tool_call_update': {
        const u = update as {
          toolCallId?: string
          title?: string
          status?: string
          content?: unknown
          rawInput?: unknown
          rawOutput?: unknown
        }
        // Minimal deliberately hides the concrete tool label as well as tool cards/output:
        // keep Slack's transient working indicator generic so commands and tool names do
        // not leak into the channel chrome. Thinking remains a distinct thought-chunk state.
        const label = this.mode === 'minimal' ? WORKING : this.toolLabel(u)
        this.noteToolInput(u)
        const status = this.pushActivity(label)
        // minimal: a tool boundary closes the current reply segment (record it + settle the
        // live message); closeSegment marks the next chunk as a fresh segment. No progress/
        // tool-output message — activity lives in the transient status only.
        if (this.mode === 'minimal') return [...status, ...this.closeSegment()]
        // none/low: just record the buffered body — no tool card, no status (none emits none).
        if (this.mode === 'low' || this.mode === 'none') return [...this.flush(), ...status]
        // medium/high: reflect the current tool on the in-place progress message. The
        // label (a command line / tool title) is wrapped in a code span so it renders
        // verbatim in the `markdown` block instead of being parsed as emphasis.
        const progressText = `:hammer_and_wrench: ${codeSpan(label)}`
        const actions: SlackAction[] = [...this.flush(), ...status]
        // streaming: that in-place message becomes one task card on the stream, keyed by
        // toolCallId so streamed updates edit a card instead of stacking (§4). The append
        // still carries the legacy text, so a stream that never opened degrades to it.
        if (this.streaming && u.toolCallId) {
          this.closeThinkingRun()
          const terminal = u.status === 'completed' || u.status === 'failed'
          // A failed TOOL never takes card status `error`: the container icon is derived from
          // the cards (any error card reddens the whole plan, verified live 2026-08-29), so one
          // non-zero exit would present a completed turn as a failed one. The failure is said
          // in words instead — a plain "(failed)" prefix, counted into the closing label —
          // and `error` is reserved for the cancel path, where a red container is the truth.
          const failed = u.status === 'failed'
          if (failed) this.failedTasks.add(u.toolCallId)
          // The card's BODY is HIGH only — medium keeps one line per step, matching the legacy
          // pipeline where tool output is a high-mode rung. The body cannot start collapsed
          // (Slack has no such field), so on medium a step stays a step.
          //
          // Tracked on EVERY update, not just the terminal one: ACP output arrives as deltas, so
          // the text can land while the call is still `in_progress` and the update that finishes
          // it carry nothing but the status. Reading only the last one writes a blank body — and
          // on a streaming turn nothing else would carry that output.
          if (this.mode === 'high') this.noteToolOutput(u)
          const body =
            terminal && this.mode === 'high'
              ? { command: this.cardCommand(u.toolCallId, label), output: this.toolOutputs.get(u.toolCallId) ?? '' }
              : {}
          this.queueTask(
            u.toolCallId,
            (failed ? FAILED_PREFIX : '') + this.cardTitle(u.toolCallId, label),
            terminal ? 'complete' : 'in_progress',
            body
          )
          if (terminal) this.toolOutputs.delete(u.toolCallId)
          this.pendingProgress = progressText
        } else {
          actions.push({ kind: 'progress', text: progressText })
        }
        // high only, and only off the stream: a streaming turn's card already carries the same
        // command and result, so posting the code block too would say everything twice.
        if (this.mode === 'high' && !this.streaming) actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        // `minimal` promises the turn is ONE live reply and `none` sends nothing at all, so
        // both keep planning as transient status. `low` renders it: that rung means "body and
        // result only, activity goes to the status row", and the plan was excluded when its
        // only shape was a six-line emoji block. As a ruled, struck-through list it is neither
        // activity nor noise — it is the shortest statement of what the turn is for — and low
        // is the DEFAULT, so excluding it hid the plan from most agents in the product.
        if (this.mode === 'minimal') return this.pushActivity('planning…')
        if (this.mode === 'none') return [...this.flush(), ...this.pushActivity('planning…')]
        return [...this.flush(), { kind: 'plan', ...renderPlan(entries) }]
      }
      case 'usage_update':
        return [] // dropped (goes to telemetry, not the channel)
      default:
        return []
    }
  }

  /** Turn end (§9.1 stopReason): flush remaining body, clear the loading status, and
   *  append the optional identity/runtime/model/session attribution. */
  onFinal(info?: SlackAttributionInfo): SlackAction[] {
    const clear: SlackAction = { kind: 'set-status', text: '' }
    // A bare response-control marker (or a non-compliant explanation ending in a bare marker
    // line) means this message wasn't for the agent.
    // Suppress everything: clear the "is thinking…" status and post nothing — no body, no
    // reasoning, no attribution footer. The inbound message was still recorded and the thread
    // watermark advanced in SessionManager, so peers keep seeing it as context; this agent
    // just stays silent.
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      this.recordDirty = false
      // The stream is chrome, not the answer: a silent turn that ran tools still owes its
      // cards a terminal status and its container a closing label.
      return [clear, ...this.settleStream('completed')]
    }
    // none: settle the final body into the transcript (recordOnly via flush) and stop — no
    // status clear, no attribution footer; nothing is delivered to the channel this turn.
    if (this.mode === 'none') return this.flush()
    const attribution: SlackAction[] = info ? [{ kind: 'attribution', ...buildAttributionBlocks(info) }] : []
    // minimal: settle the complete final segment (the daemon splits it only when Slack's
    // per-block limit requires multiple messages), record it, clear the status, then attach
    // the attribution footer to the last delivered response message.
    if (this.mode === 'minimal') {
      const footer: SlackAction[] = info
        ? [{ kind: 'attribution', standalone: true, ...buildAttributionBlocks(info) }]
        : []
      return [...this.closeSegment(true), clear, ...footer]
    }
    if (this.mode === 'low') return [...this.markTerminalPost(this.flush()), clear, ...attribution]
    // The daemon cancels the idle-flush timer before onFinal, so drain any reasoning
    // buffered since the last flush here. It goes BEFORE the body flush so the Thinking
    // block posts above the reply — thinking precedes the answer (§9.1), so it must sit
    // above it, not below (only high mode ever has reasoning to drain).
    const reasoning = this.drainReasoning()
    return [
      ...reasoning,
      ...this.markTerminalPost(this.flush()),
      clear,
      ...attribution,
      ...this.settleStream('completed')
    ]
  }

  /** onFinal only: flag the last delivered body section as this response's terminal post,
   *  so the applier can close the response at post time instead of re-editing it (§5.5). */
  private markTerminalPost(actions: SlackAction[]): SlackAction[] {
    for (let i = actions.length - 1; i >= 0; i--) {
      const action = actions[i]
      if (action?.kind === 'post' && !action.recordOnly && action.attributed !== false) {
        action.terminal = true
        break
      }
    }
    return actions
  }
}
