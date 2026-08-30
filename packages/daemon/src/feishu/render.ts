import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { WireFeishuCardActionTarget } from '@agentconnect.md/protocol'
import { AgentMessageRun } from '../messages/message-boundary.js'
import { flattenUnsafeLinks } from '../messages/agent-links.js'
import { renderAttributionMessage, type ReplyAttributionInfo } from '../messages/attribution.js'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'
import { extractToolOutput } from '../session/tool-output.js'

/**
 * The mode-aware ACP→Feishu intermediate representation — the Feishu analog of
 * telegram/render.ts's TelegramAction + TelegramConverger (and discord/render.ts's
 * DiscordAction). The daemon's applyAction resolves these against a live
 * FeishuConnection.
 *
 * The agent reply uses one CardKit entity for the whole turn: `card-start` publishes a
 * streaming card with a Thinking state, `card-stream` replaces one markdown element
 * with the cumulative answer (CardKit renders the diff with its native typewriter
 * effect), and `card-final` replaces the card with the completed answer + optional
 * linked footer. A compact overflow menu keeps View session available throughout the
 * card lifecycle and exposes Cancel run only while the turn is active. Transcript rows
 * remain `post` actions with `recordOnly:true`, so card transport and persistence stay
 * independent. Progress / reasoning / plan / tool-output remain short plain-text chrome
 * messages.
 *
 * Kinds otherwise mirror TelegramAction/DiscordAction so dispatch stays parallel:
 *  - `post`        records the agent's reply into the transcript (`recordOnly:true`).
 *  - `typing`      a transient hint. Feishu has no typing/chat-action API, so the
 *                  applier treats this as a no-op — kept only for dispatch parity.
 *  - `progress`    the SINGLE in-place progress message (medium/high), edited in place.
 *  - `reasoning`   the SINGLE in-place thinking message (high only), edited in place.
 *  - `plan`        the SINGLE in-place plan-summary message (medium/high).
 *  - `tool-output` a finished tool's output as a fenced code block (high only), not recorded.
 *
 * There is deliberately NO separate per-turn `status-bar` action (unlike
 * Slack/Discord). Lark keeps its two compact actions in the reply card's overflow menu;
 * the fuller session state and controls remain available via typed /commands
 * (`/status`, `/stop`, `/cancel`, `/fast` — see commands/commands.ts +
 * daemon.handleCommand). The `/status` reply reuses {@link renderStatusReply}.
 */
export type FeishuAction =
  | { kind: 'card-start' }
  | { kind: 'card-stream'; text: string }
  | { kind: 'card-final'; text: string; attribution?: ReplyAttributionInfo }
  | { kind: 'card-cancel' }
  // CardKit owns visible answer delivery. These rows retain the existing transcript
  // segmentation without also posting duplicate text messages into the chat.
  | { kind: 'post'; text: string; recordOnly?: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'typing' }
  | { kind: 'progress'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; text: string }
  | { kind: 'tool-output'; text: string }

/** Feishu single-text-message chunk cap. Feishu's real limit is generous; we chunk
 *  to a safe cap like Telegram (4096) / Discord (2000). */
export const FEISHU_MESSAGE_LIMIT = 4000

/** Stable CardKit element id targeted by `cardElement.content`. */
export const FEISHU_STREAMING_ELEMENT_ID = 'agentconnect_reply'

/** Stable CardKit overflow identity returned by `card.action.trigger`. */
export const FEISHU_REPLY_ACTIONS_ELEMENT_ID = 'agentconnect_actions'
export const FEISHU_REPLY_ACTION_VALUE = 'agentconnect_reply'
export const FEISHU_REPLY_CANCEL_OPTION = 'cancel'

function cardInlineRow(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
  verticalAlign: 'top' | 'center'
): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    horizontal_align: 'right',
    columns: [
      ...(left
        ? [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: verticalAlign,
              elements: [left]
            }
          ]
        : []),
      ...(right
        ? [
            {
              tag: 'column',
              width: 'auto',
              vertical_align: verticalAlign,
              elements: [right]
            }
          ]
        : [])
    ]
  }
}

/** Initial CardKit 2.0 reply card. `streaming_mode` makes element updates render
 * incrementally in clients that support CardKit streaming. */
export function buildStreamingReplyCard(
  sessionUrl?: string,
  target?: WireFeishuCardActionTarget
): Record<string, unknown> {
  const menu = cardSessionMenu(sessionUrl, true, target)
  const content = {
    tag: 'markdown',
    element_id: FEISHU_STREAMING_ELEMENT_ID,
    content: 'Thinking…'
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: '[Generating…]' },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast'
      }
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [menu ? cardInlineRow(content, menu, 'top') : content]
    }
  }
}

function cardSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>[\]()~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, 120) || 'Completed'
}

function escapeFooterText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replace(/([\\`*_[\]~<>])/g, '\\$1')
}

function cardLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const normalized = url.toString()
    if (normalized.length > 2_048) return undefined
    return normalized.replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

function cardSessionMenu(
  sessionUrl: string | undefined,
  cancellable: boolean,
  target?: WireFeishuCardActionTarget
): Record<string, unknown> | undefined {
  const url = sessionUrl ? cardLink(sessionUrl) : undefined
  const options = [
    ...(cancellable
      ? [
          {
            text: { tag: 'plain_text', content: 'Cancel run' },
            value: FEISHU_REPLY_CANCEL_OPTION
          }
        ]
      : []),
    ...(url
      ? [
          {
            text: { tag: 'plain_text', content: 'View session' },
            value: 'session',
            multi_url: { url }
          }
        ]
      : [])
  ]
  if (options.length === 0) return undefined
  return {
    tag: 'overflow',
    element_id: FEISHU_REPLY_ACTIONS_ELEMENT_ID,
    width: 'default',
    options,
    value: { action: FEISHU_REPLY_ACTION_VALUE, ...(target ? { target } : {}) }
  }
}

/** Reuse the canonical Slack/GitHub attribution sentence while applying CardKit
 * markdown links and escaping at this platform boundary. */
function attributionFooter(info: ReplyAttributionInfo): string {
  const botName = escapeFooterText(info.botName) || 'unknown agent'
  const botUrl = cardLink(info.botUrl)
  const sessionUrl = cardLink(info.sessionUrl)
  return renderAttributionMessage({
    agent: botUrl ? `[${botName}](${botUrl})` : botName,
    runtime: escapeFooterText(info.runtime),
    model: escapeFooterText(info.model),
    renderSession: sessionUrl ? (label) => `[${escapeFooterText(label)}](${sessionUrl})` : undefined,
    notice: info.notice ? escapeFooterText(info.notice) : undefined
  })
}

/** Completed CardKit 2.0 reply. The footer is intentionally part of the card rather
 * than a second message, so the answer has one stable visual surface. */
export function buildCompletedReplyCard(
  text: string,
  attribution?: ReplyAttributionInfo,
  sessionUrl = attribution?.sessionUrl
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: text }]
  const footer = attribution
    ? {
        tag: 'markdown',
        text_size: 'notation',
        content: attributionFooter(attribution)
      }
    : undefined
  const menu = cardSessionMenu(sessionUrl, false)
  if (footer || menu) {
    elements.push({ tag: 'hr' })
    elements.push(cardInlineRow(footer, menu, 'center'))
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: cardSummary(text) }
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements
    }
  }
}

/** Static JSON 2.0 card used only for platform permission/configuration failures.
 * The button opens app settings directly, so no card callback or public endpoint is
 * required. It is separate from the streaming reply lifecycle above. */
export function buildPermissionUpdateCard(
  updateUrl: string,
  description: string,
  buttonLabel = 'Update permissions'
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: description },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: buttonLabel },
          type: 'primary',
          width: 'default',
          size: 'medium',
          behaviors: [{ type: 'open_url', default_url: updateUrl }],
          margin: '8px 0px 0px 0px'
        }
      ]
    },
    header: {
      title: { tag: 'plain_text', content: '⚠️ Permissions update required' },
      template: 'orange',
      padding: '12px 12px 12px 12px'
    }
  }
}

const MAX_LABEL = 100
const MAX_REASONING = 2800
const MAX_TOOL_OUTPUT = 2800

function clampTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Split `text` into chunks that each fit within `limit` characters, preferring to
 * break on paragraph, then line, then whitespace boundaries so text is not sliced
 * mid-token where avoidable. A single token longer than `limit` is hard-split.
 * Returns at least one chunk (empty in → empty out) so callers can always post
 * something. Feishu's analog of discord/render's chunkForDiscord — kept local
 * since Feishu needs no mrkdwn conversion.
 */
export function chunkForFeishu(text: string, limit = FEISHU_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // Prefer the last paragraph break, then line break, then whitespace, inside the window.
    const para = window.lastIndexOf('\n\n')
    const line = window.lastIndexOf('\n')
    const space = window.lastIndexOf(' ')
    const cut = para >= limit * 0.5 ? para : line >= limit * 0.5 ? line : space >= limit * 0.5 ? space : limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length) chunks.push(rest)
  return chunks
}

/** A fenced code block (monospace, multi-line). Backticks inside are neutralized so
 *  the fence can't be closed early. Feishu text renders this as literal fences —
 *  harmless, and preserves the verbatim shape of tool output. */
function fencedPre(s: string): string {
  return '```\n' + s.replace(/```/g, '​`​`​`') + '\n```'
}

/** Head-clamp a finished tool's output (kept under the message cap so the whole
 *  block posts as one message); head-kept since the start is usually most useful. */
function capOutput(s: string): string {
  const t = s.trim()
  return t.length > MAX_TOOL_OUTPUT ? `${t.slice(0, MAX_TOOL_OUTPUT - 1)}…` : t
}

type PlanEntry = { content?: string; status?: 'pending' | 'in_progress' | 'completed' }

function planIcon(status?: string): string {
  if (status === 'completed') return '✅'
  if (status === 'in_progress') return '⏳'
  return '⬜'
}

/** Render an ACP plan (full entry list, resent each update) as a compact plain-text summary. */
function renderPlan(entries: PlanEntry[]): string {
  const lines = entries.map((e) => `${planIcon(e.status)} ${clampTo(e.content ?? '', MAX_LABEL)}`)
  return ['📋 Plan', ...lines].join('\n')
}

/** Render the accumulated reasoning trace (high mode) tail-clamped, as plain text. */
function renderReasoning(buf: string): string {
  const trimmed = buf.trim()
  const tail = trimmed.length > MAX_REASONING ? `…${trimmed.slice(-MAX_REASONING)}` : trimmed
  return `💭 Thinking\n${tail}`
}

/** Status inputs — the subset {@link renderStatusText} renders for the `/status`
 *  reply. Structurally a subset of slack/render.ts's StatusBarInfo (and identical to
 *  TelegramStatusInfo), so the daemon feeds the same object to all platforms. */
export interface FeishuStatusInfo {
  model?: string
  fastMode?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The compact status line (PLAIN text), e.g. `📊 opus-4.8 · fast · ctx 120k/200k (60%) · 45.2k tok`.
 *  No bold markup — Feishu text messages render markup literally. */
export function renderStatusText(info: FeishuStatusInfo): string {
  const parts: string[] = []
  if (info.model) parts.push(info.model)
  if (info.fastMode) parts.push('fast')
  if (info.contextUsed !== undefined && info.contextSize !== undefined && info.contextSize > 0) {
    const pct = Math.round((info.contextUsed / info.contextSize) * 100)
    parts.push(`ctx ${compactCount(info.contextUsed)}/${compactCount(info.contextSize)} (${pct}%)`)
  } else if (info.contextUsed !== undefined) {
    parts.push(`ctx ${compactCount(info.contextUsed)}`)
  }
  if (info.totalTokens !== undefined) parts.push(`${compactCount(info.totalTokens)} tok`)
  return `📊 ${parts.length ? parts.join(' · ') : '—'}`
}

/**
 * The `/status` command reply (PLAIN text): the compact status line, plus a
 * `🔗 <url>` line when a deep link is known. Feishu v1 has no link buttons, so the
 * URL is emitted verbatim (Feishu auto-links bare URLs in text messages). Pure —
 * unit-testable.
 */
export function renderStatusReply(info: FeishuStatusInfo, link?: string): string {
  const line = renderStatusText(info)
  return link ? `${line}\n🔗 ${link}` : line
}

export class FeishuConverger {
  private buf = ''
  /** Visible card content. Non-minimal modes accumulate the whole turn; minimal
   * keeps only the current answer segment while earlier segments remain transcript-only. */
  private cardText = ''
  private lastStreamText = ''
  private cardBoundary = false
  private reasoningBuf = ''
  private reasoningDirty = false
  private toolTitles = new Map<string, string>()
  private toolOutputs = new Map<string, string>()
  private emittedOutput = new Set<string>()
  // minimal mode only — see OutputConverger (Slack) for the segment/record contract.
  private segmentReset = false
  private recordDirty = false
  // The runtime's own message identity, which is the only boundary a speak-only run offers.
  private readonly messages = new AgentMessageRun()

  constructor(private mode: 'none' | 'minimal' | 'low' | 'medium' | 'high') {}

  onStart(): FeishuAction[] {
    return this.mode === 'none' ? [] : [{ kind: 'card-start' }]
  }

  /** True while body text OR reasoning is pending — the daemon (re)arms the idle-flush timer on it. */
  hasBuffered(): boolean {
    if (this.mode === 'minimal') return this.recordDirty
    return this.buf.trim().length > 0 || this.reasoningDirty
  }

  /** Whether a newer safe answer snapshot is ready for the periodic CardKit stream timer. */
  hasStreamingUpdate(): boolean {
    const trimmed = this.cardText.trim()
    return (
      this.mode !== 'none' &&
      trimmed.length > 0 &&
      !isNoResponsePrefix(trimmed) &&
      this.cardText !== this.lastStreamText
    )
  }

  /** Return one cumulative CardKit element update and mark that snapshot as emitted. */
  streamUpdate(): FeishuAction[] {
    if (!this.hasStreamingUpdate()) return []
    this.lastStreamText = this.cardText
    return [{ kind: 'card-stream', text: flattenUnsafeLinks(this.cardText) }]
  }

  /** Idle-timer flush: update the answer card, record the buffered body, and drain
   * high-mode reasoning. Minimal mode only refreshes the current card segment here;
   * its transcript segment closes at a semantic boundary or turn end. */
  flushBuffered(): FeishuAction[] {
    if (this.mode === 'minimal') return this.streamUpdate()
    return [...this.drainReasoning(), ...this.flush(false)]
  }

  /** Minimal mode: close the current reply segment into the transcript. The card itself
   * stays one message and is replaced with the next answer segment after a tool boundary. */
  private closeSegment(includeStream = true): FeishuAction[] {
    this.segmentReset = true
    const stream = includeStream ? this.streamUpdate() : []
    if (!this.recordDirty || !this.buf.trim()) return stream
    if (isNoResponsePrefix(this.buf.trim())) return []
    const text = flattenUnsafeLinks(this.buf)
    this.recordDirty = false
    return [
      ...stream,
      ...chunkForFeishu(text, FEISHU_MESSAGE_LIMIT).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as FeishuAction
      )
    ]
  }

  private drainReasoning(): FeishuAction[] {
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    return [{ kind: 'reasoning', text: renderReasoning(flattenUnsafeLinks(this.reasoningBuf)) }]
  }

  /** Record one non-minimal body window. A semantic boundary starts the next answer
   * chunk on a fresh paragraph inside the same card; an idle flush does not. */
  private flush(boundary: boolean, includeStream = true): FeishuAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      if (!this.cardText.trim()) this.cardText = ''
      if (boundary && this.cardText.trim()) this.cardBoundary = true
      return includeStream ? this.streamUpdate() : []
    }
    if (isNoResponsePrefix(trimmed)) return []
    const text = flattenUnsafeLinks(this.buf)
    this.buf = ''
    if (boundary) this.cardBoundary = true
    return [
      ...(includeStream ? this.streamUpdate() : []),
      ...chunkForFeishu(text, FEISHU_MESSAGE_LIMIT).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as FeishuAction
      )
    ]
  }

  private toolLabel(update: { toolCallId?: string; title?: string }): string {
    const id = update.toolCallId
    if (update.title) {
      if (id) this.toolTitles.set(id, update.title)
      return update.title
    }
    return (id && this.toolTitles.get(id)) ?? id ?? 'tool'
  }

  private drainToolOutput(update: {
    toolCallId?: string
    status?: string
    content?: unknown
    rawOutput?: unknown
  }): FeishuAction[] {
    const id = update.toolCallId
    if (!id) return []
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
    const icon = update.status === 'failed' ? '❌' : '📄'
    return [{ kind: 'tool-output', text: `${icon}\n${fencedPre(capOutput(text))}` }]
  }

  onUpdate(update: SessionUpdate): FeishuAction[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = (update as { content?: { type?: string; text?: string } }).content
        const text = content?.type === 'text' ? (content.text ?? '') : ''
        // A new message closes the one before it exactly as a tool boundary would — same mode
        // semantics, same actions. Without this the two arrive as one post, run together.
        const closed = this.messages.opens(update)
          ? this.mode === 'minimal'
            ? this.closeSegment()
            : this.flush(true)
          : []
        if (this.mode === 'minimal' && this.segmentReset && text) {
          this.buf = ''
          this.cardText = ''
          this.segmentReset = false
        } else if (this.mode !== 'minimal' && this.cardBoundary && text) {
          if (this.cardText && !this.cardText.endsWith('\n') && !text.startsWith('\n')) this.cardText += '\n\n'
          this.cardBoundary = false
        }
        this.buf += text
        this.cardText += text
        if (this.mode === 'minimal' && text.trim()) this.recordDirty = true
        return closed
      }
      case 'agent_thought_chunk': {
        if (this.mode === 'high') {
          const text = (update as { content?: { text?: string } }).content?.text ?? ''
          if (text) {
            this.reasoningBuf += text
            if (this.reasoningBuf.length > MAX_REASONING * 2)
              this.reasoningBuf = this.reasoningBuf.slice(-MAX_REASONING * 2)
            this.reasoningDirty = true
          }
        }
        // minimal keeps the reply intact (no body flush) — just show typing.
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        // none: record the buffered body, send nothing (no typing indicator either).
        if (this.mode === 'none') return this.flush(true)
        return [...this.flush(true), { kind: 'typing' }]
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
        const label = this.toolLabel(u)
        // minimal: close the transcript segment; activity remains generic.
        if (this.mode === 'minimal') return [{ kind: 'typing' }, ...this.closeSegment()]
        if (this.mode === 'none') return this.flush(true)
        if (this.mode === 'low') return [...this.flush(true), { kind: 'typing' }]
        const actions: FeishuAction[] = [
          ...this.flush(true),
          { kind: 'typing' },
          { kind: 'progress', text: `🔨 ${label}` }
        ]
        if (this.mode === 'high') actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        // `low` posts the plan, like every other integration of the same agent: output mode is
        // ONE agent-level setting, so the plan cannot be a channel message on one platform and
        // a typing hint on another. `minimal` (one live-updating reply) and `none` (nothing
        // reaches the channel) still withhold it.
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        if (this.mode === 'none') return this.flush(true)
        return [...this.flush(true), { kind: 'plan', text: renderPlan(entries) }]
      }
      default:
        return []
    }
  }

  /** Turn end: persist the last body window and replace the streaming entity with the
   * completed answer. Optional shared attribution stays inside that same final card. */
  onFinal(attribution?: ReplyAttributionInfo): FeishuAction[] {
    this.cardText = flattenUnsafeLinks(this.cardText)
    const display = this.cardText.trim()
    if (isNoResponseBody(display)) {
      this.buf = ''
      this.cardText = ''
      this.recordDirty = false
      return this.mode === 'none' ? [] : [{ kind: 'card-cancel' }]
    }
    const actions =
      this.mode === 'minimal' ? this.closeSegment(false) : [...this.drainReasoning(), ...this.flush(false, false)]
    if (this.mode === 'none') return actions
    if (!display) return [...actions, { kind: 'card-cancel' }]
    this.cardText = display
    this.lastStreamText = display
    return [...actions, { kind: 'card-final', text: display, ...(attribution ? { attribution } : {}) }]
  }

  /** Prompt failure after the card has started: preserve any useful runtime-authored
   * error text, otherwise append one concise failure line, then close the card. */
  onFailure(reason: string, attribution?: ReplyAttributionInfo): FeishuAction[] {
    this.cardText = flattenUnsafeLinks(this.cardText)
    const display = this.cardText.trim()
    if (isNoResponseBody(display)) {
      this.buf = ''
      this.cardText = ''
      this.recordDirty = false
      return this.mode === 'none' ? [] : [{ kind: 'card-cancel' }]
    }
    const notice = `⚠️ Agent failed to respond: ${reason}`
    const covered = display.includes(reason)
    const finalText = covered ? this.cardText : display ? `${this.cardText}\n\n${notice}` : notice
    const actions =
      this.mode === 'minimal' ? this.closeSegment(false) : [...this.drainReasoning(), ...this.flush(false, false)]
    if (!covered) actions.push({ kind: 'post', text: notice, recordOnly: true })
    if (this.mode === 'none') return actions
    this.cardText = finalText
    this.lastStreamText = finalText
    actions.push({ kind: 'card-final', text: finalText, ...(attribution ? { attribution } : {}) })
    return actions
  }
}
