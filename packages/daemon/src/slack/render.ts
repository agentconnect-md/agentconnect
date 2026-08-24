import type { CreateElicitationRequest, RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import {
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  SLACK_STATUS_ACTION,
  encodePermValue,
  encodeSlackStatusOverflowValue
} from '@agentconnect.md/protocol'
export {
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  decodePermValue,
  encodePermValue
} from '@agentconnect.md/protocol'
import { renderAttributionMessage, type ReplyAttributionInfo } from '../messages/attribution.js'
import { splitAtParagraphBoundary } from '../messages/stream-boundary.js'
import { permissionModeDisplayLabel } from '../acp/permission-modes.js'
import { splitIntoSections } from './formatter.js'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'

/**
 * The mode-aware ACP→Slack intermediate representation (§9.1). The daemon's
 * applyAction resolves these against a live SlackConnection:
 *  - `post`        a finalized body/result section → chat.postMessage in the thread.
 *  - `notice`      a system line (e.g. the done footer) posted to the thread but not recorded.
 *  - `set-status`  the transient assistant status bar (assistant.threads.setStatus).
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
  | { kind: 'post'; text: string; attributed?: boolean; recordOnly?: boolean }
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
  | { kind: 'set-status'; text: string; loadingMessages?: string[] }
  | { kind: 'set-title'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; text: string }
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

/** Dynamic identity shown under the last reply section. All Slack integration modes use
 *  the same compact `context` footer so shared-bot attribution never looks like body text
 *  or causes its console links to sprout rich previews. */
export type SlackAttributionInfo = ReplyAttributionInfo

const THINKING = 'is thinking…'
const WORKING = 'is working…'
// Bound the rolling activity window fed to Slack `loading_messages` and clamp each
// label — assistant.threads.setStatus caps loading_messages at 10 entries and
// rejects any entry ≥ 51 chars ("must be less than 51 characters"), so status
// labels get a tighter clamp than body text.
const MAX_ACTIVITY = 10
const MAX_LABEL = 100
const MAX_STATUS = 50
// A deliberately compact cap for the reasoning block (well under Slack's markdown-block
// limit) — it's a live "current thinking" view, not the main content, so keep only the
// newest tail and mark a drop with a leading ellipsis. The raw buffer is soft-capped at
// 2× so it can't grow unbounded across a long turn.
const MAX_REASONING = 2800

function clampTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
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

/** Pull human-readable output text out of an ACP tool_call/_update. Prefers the `content[]`
 *  text blocks (the tool's reported output); falls back to a string `rawOutput`. diff /
 *  terminal blocks and non-string rawOutput are skipped — they have no compact inline text. */
function extractToolOutput(update: { content?: unknown; rawOutput?: unknown }): string {
  const content = update.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      if ((item as { type?: string }).type !== 'content') continue
      const block = (item as { content?: { type?: string; text?: string } }).content
      if (block?.type === 'text' && block.text) parts.push(block.text)
    }
    if (parts.length) return parts.join('\n').trim()
  }
  return typeof update.rawOutput === 'string' ? update.rawOutput.trim() : ''
}

type PlanEntry = { content?: string; status?: 'pending' | 'in_progress' | 'completed' }

function planIcon(status?: string): string {
  if (status === 'completed') return ':white_check_mark:'
  if (status === 'in_progress') return ':hourglass_flowing_sand:'
  return ':white_large_square:'
}

/** Render an ACP plan (full entry list, resent on every update) as a compact summary.
 *  Posted as a `markdown` block, so emphasis is CommonMark (`**bold**`), not mrkdwn. */
function renderPlan(entries: PlanEntry[]): string {
  const lines = entries.map((e) => `${planIcon(e.status)} ${clampLabel(e.content ?? '')}`)
  return [':clipboard: **Plan**', ...lines].join('\n')
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

/** The one form field an elicitation card renders as buttons. */
export interface ElicitTarget {
  /** Property name in the form schema — the key the accepted value is returned under. */
  propName: string
  kind: 'enum' | 'boolean'
  /** Selectable options: `value` is the wire value returned in the accept content,
   *  `label` is the human button text. */
  options: { value: string; label: string }[]
}

/**
 * Resolve the single form field an elicitation card renders (v1): the FIRST string-enum
 * (`oneOf` titled options or bare `enum`) or boolean property in the requested schema.
 * Returns null for URL-mode, an empty/absent schema, or a form whose fields we can't
 * render inline (free text, numbers, multi-field) — the daemon then declines. Pure, and
 * shared by {@link buildElicitationCard} and the daemon's click handler so the button
 * values and their interpretation can't drift.
 */
export function elicitTarget(params: CreateElicitationRequest): ElicitTarget | null {
  const p = params as {
    mode?: string
    requestedSchema?: { properties?: Record<string, Record<string, unknown>> }
  }
  if (p.mode !== 'form') return null
  const props = p.requestedSchema?.properties ?? {}
  for (const [name, prop] of Object.entries(props)) {
    if (prop?.type === 'string') {
      const oneOf = prop.oneOf as { const?: unknown; title?: unknown }[] | undefined
      const en = prop.enum as unknown[] | undefined
      const options = Array.isArray(oneOf)
        ? oneOf.map((o) => ({ value: String(o.const), label: clampTo(String(o.title ?? o.const), 75) }))
        : Array.isArray(en)
          ? en.map((v) => ({ value: String(v), label: clampTo(String(v), 75) }))
          : []
      if (options.length) return { propName: name, kind: 'enum', options }
    }
    if (prop?.type === 'boolean') {
      return {
        propName: name,
        kind: 'boolean',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' }
        ]
      }
    }
  }
  return null
}

/**
 * Build the interactive elicitation card: the agent's `message`, an optional field title,
 * and an actions row of option buttons (one per {@link elicitTarget} option, capped at 5)
 * plus a Dismiss button. The choice rides each button `value` (`<requestId>|<optionValue>`).
 * Returns null when the form can't be rendered inline (caller declines). Pure.
 */
export function buildElicitationCard(
  requestId: string,
  params: CreateElicitationRequest,
  sessionTarget?: string
): unknown[] | null {
  const target = elicitTarget(params)
  if (!target) return null
  const message = (params as { message?: string }).message?.trim() || 'The agent needs your input'
  const buttons = target.options.slice(0, 5).map((o, i) => ({
    type: 'button',
    action_id: `${ELICIT_ACTION_PREFIX}:${i}`,
    text: { type: 'plain_text', text: o.label, emoji: true },
    value: encodePermValue(requestId, o.value)
  }))
  buttons.push({
    type: 'button',
    action_id: ELICIT_DISMISS_ACTION as string,
    text: { type: 'plain_text', text: 'Dismiss', emoji: true },
    value: requestId
  } as (typeof buttons)[number])
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: ${clampTo(message, 400)}` } },
    { type: 'actions', ...(sessionTarget ? { block_id: sessionTarget } : {}), elements: buttons }
  ]
}

/** Build the RESOLVED elicitation card (buttons removed) that replaces {@link
 *  buildElicitationCard} once answered, dismissed, or cancelled. Pure. */
export function buildElicitationResolvedCard(params: CreateElicitationRequest, decision: string): unknown[] {
  const message = (params as { message?: string }).message?.trim() || 'The agent needs your input'
  return [{ type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: ${clampTo(message, 400)}\n${decision}` } }]
}

export interface SharedStatusActions {
  /** Opaque `{agentId,integrationId,sessionKey}` target validated by the relay. */
  sessionTarget: string
  /** Whether the bot is shareable (multi-agent) — gates the "Switch agent" option.
   *  A non-shareable shared bot still routes its overflow via `sessionTarget`, but it
   *  hosts one agent, so there is nothing to switch to. */
  shareable: boolean
}

/** Build the compact in-thread status message. Both dedicated and shared bots use
 *  one overflow accessory so the status stays on a single row. A SHAREABLE (multi-agent)
 *  bot also exposes Switch agent; Cancel run is present only while the current turn can
 *  still be interrupted. */
export function buildStatusBlocks(
  info: StatusBarInfo,
  sessionKey: string,
  link?: string,
  shared?: SharedStatusActions,
  cancellable = false
): unknown[] {
  const text = `${renderStatusBar(info)}${link ? `  ·  <${link}|View Session>` : ''}`
  const target = shared?.sessionTarget ?? sessionKey
  const option = (label: string, action: 'switch-agent' | 'manage' | 'cancel') => ({
    text: { type: 'plain_text', text: label },
    value: encodeSlackStatusOverflowValue(action)
  })
  const options = [
    ...(shared?.shareable ? [option('Switch agent', 'switch-agent')] : []),
    option('Session options', 'manage'),
    ...(cancellable ? [option('Cancel run', 'cancel')] : [])
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
 * row, and usage uses label-over-value fields. Cancel appears only while the turn is active.
 */
export function buildStatusModal(
  info: StatusBarInfo,
  sessionKey: string,
  link?: string,
  privateMetadata = sessionKey,
  cancellable = false,
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

  if (cancellable) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: STATUS_ACTION.cancel,
          text: { type: 'plain_text', text: 'Cancel turn' },
          style: 'danger',
          value: sessionKey
        }
      ]
    })
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
  // Rolling window of recent activity labels (tool titles / "is thinking…"). Fed to
  // Slack `loading_messages` (which Slack rotates); the status text is the latest entry.
  private activity: string[] = []
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
    private protectedAddresses: readonly string[] = []
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
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flush()]
  }

  /** minimal: refresh the single in-place `live-reply` with the current segment (display only;
   *  the transcript record happens at segment boundaries). */
  private liveRefresh(): SlackAction[] {
    const trimmed = this.buf.trim()
    // Hold the live reply while the body could still be the bare response-control marker, so a
    // suppressed turn never flashes a partial reply in-place (onFinal drops it entirely).
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    return [{ kind: 'live-reply', text: this.liveDisplay(this.buf) }]
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
    const text = this.buf
    this.recordDirty = false
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
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    return [{ kind: 'reasoning', text: renderReasoning(this.reasoningBuf) }]
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

  private emitBody(text: string): SlackAction[] {
    // none: record the reply into the transcript WITHOUT sending it — `recordOnly` is handled
    // before the connection check on every platform, so it lands even though replyConn is unset.
    const recordOnly = this.mode === 'none'
    return splitIntoSections(text, undefined, this.protectedAddresses).map(
      (t) => ({ kind: 'post', text: t, ...(recordOnly ? { recordOnly: true } : {}) }) as SlackAction
    )
  }

  /**
   * Record an activity label and build the loading-status action carrying the rolling
   * window as `loading_messages`. Consecutive repeats collapse to nothing (returns []),
   * which throttles streamed thought chunks down to one status update per thinking run.
   */
  private pushActivity(raw: string): SlackAction[] {
    // none: nothing reaches the channel, not even the transient loading status.
    if (this.mode === 'none') return []
    const label = clampTo(raw, MAX_STATUS)
    if (this.activity[this.activity.length - 1] === label) return []
    this.activity.push(label)
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift()
    return [{ kind: 'set-status', text: label, loadingMessages: [...this.activity] }]
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
    // content/rawOutput are a whole replacement when present, so only touch the cache when
    // this update actually carries them: set the newest text, or clear a stale entry if the
    // replacement is empty / a non-text block (so we don't post output that was overwritten).
    if (update.content !== undefined || update.rawOutput !== undefined) {
      const out = extractToolOutput(update)
      if (out) this.toolOutputs.set(id, out)
      else this.toolOutputs.delete(id)
    }
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
        // minimal: a chunk arriving after a tool boundary opens a new segment that REPLACES
        // the previous one in the single live message (the previous was already recorded).
        if (this.mode === 'minimal' && this.segmentReset && text) {
          this.buf = ''
          this.segmentReset = false
        }
        this.buf += text
        if (this.mode === 'minimal' && text.trim()) this.recordDirty = true
        return []
      }
      case 'agent_thought_chunk': {
        // high: accumulate the streamed thought into the reasoning buffer and mark it
        // dirty; the actual in-place `reasoning` update is deferred to flushBuffered()
        // (idle timer) / onFinal so a token-by-token stream doesn't flood chat.update.
        // low + medium keep only the transient status — no reasoning in the channel.
        if (this.mode === 'high') {
          const text = (update as { content?: { text?: string } }).content?.text ?? ''
          if (text) {
            this.reasoningBuf += text
            // Soft-cap the raw buffer so a very long turn can't grow it unbounded;
            // renderReasoning tail-clamps again for the message body.
            if (this.reasoningBuf.length > MAX_REASONING * 2) {
              this.reasoningBuf = this.reasoningBuf.slice(-MAX_REASONING * 2)
            }
            this.reasoningDirty = true
          }
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
          rawOutput?: unknown
        }
        // Minimal deliberately hides the concrete tool label as well as tool cards/output:
        // keep Slack's transient working indicator generic so commands and tool names do
        // not leak into the channel chrome. Thinking remains a distinct thought-chunk state.
        const label = this.mode === 'minimal' ? WORKING : this.toolLabel(u)
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
        const actions: SlackAction[] = [
          ...this.flush(),
          ...status,
          { kind: 'progress', text: `:hammer_and_wrench: ${codeSpan(label)}` }
        ]
        // high only: once the tool finishes, post its output as a code block.
        if (this.mode === 'high') actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        // minimal keeps the reply intact and shows planning only as transient status.
        if (this.mode === 'minimal') return this.pushActivity('planning…')
        if (this.mode === 'low' || this.mode === 'none') return [...this.flush(), ...this.pushActivity('planning…')]
        return [...this.flush(), { kind: 'plan', text: renderPlan(entries) }]
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
      return [clear]
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
    if (this.mode === 'low') return [...this.flush(), clear, ...attribution]
    // The daemon cancels the idle-flush timer before onFinal, so drain any reasoning
    // buffered since the last flush here. It goes BEFORE the body flush so the Thinking
    // block posts above the reply — thinking precedes the answer (§9.1), so it must sit
    // above it, not below (only high mode ever has reasoning to drain).
    const reasoning = this.drainReasoning()
    return [...reasoning, ...this.flush(), clear, ...attribution]
  }
}
