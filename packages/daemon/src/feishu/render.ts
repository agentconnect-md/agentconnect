import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'

/**
 * The mode-aware ACP→Feishu intermediate representation — the Feishu analog of
 * telegram/render.ts's TelegramAction + TelegramConverger (and discord/render.ts's
 * DiscordAction). The daemon's applyAction resolves these against a live
 * FeishuConnection.
 *
 * FORMATTING: Feishu v1 is TEXT-ONLY. A text message (`msg_type:'text'`) has no
 * HTML/MarkdownV2 parse mode and no interactive cards or buttons — markup renders
 * literally — so BOTH the agent's reply (`post`) and daemon "chrome" (progress /
 * reasoning / plan / tool-output) are emitted as PLAIN text with no escaping and no
 * parse_mode (unlike Telegram's HTML). The only hard constraint is a per-message
 * length cap, so long output is chunked (see chunkForFeishu). Fenced code blocks
 * (```) are kept for tool output — they render harmlessly as literal fences.
 *
 * Kinds mirror TelegramAction/DiscordAction so the daemon's dispatch stays parallel:
 *  - `post`        the agent's reply (recorded into the transcript).
 *  - `notice`      a system line posted but NOT recorded (e.g. the done footer).
 *  - `typing`      a transient hint. Feishu has no typing/chat-action API, so the
 *                  applier treats this as a no-op — kept only for dispatch parity.
 *  - `progress`    the SINGLE in-place progress message (medium/high), edited in place.
 *  - `reasoning`   the SINGLE in-place thinking message (high only), edited in place.
 *  - `plan`        the SINGLE in-place plan-summary message (medium/high).
 *  - `tool-output` a finished tool's output as a fenced code block (high only), not recorded.
 *
 * There is deliberately NO per-turn `status-bar` action (unlike Slack/Discord):
 * Feishu v1 has no interactive cards, so session state and controls are exposed on
 * demand via typed /commands instead (`/status`, `/stop`, `/cancel`, `/fast` — see
 * commands/commands.ts + daemon.handleCommand). The `/status` reply reuses
 * {@link renderStatusReply}.
 */
export type FeishuAction =
  // `recordOnly: true` writes to the transcript without sending — minimal mode keeps the
  // full audit trail while the chat shows only the single `live-reply` message.
  | { kind: 'post'; text: string; recordOnly?: boolean }
  // `live-reply` is minimal mode's single, in-place agent reply (post-once/edit-thereafter,
  // like `progress`) — display only, NOT recorded.
  | { kind: 'live-reply'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'typing' }
  | { kind: 'progress'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; text: string }
  | { kind: 'tool-output'; text: string }

/** Feishu single-text-message chunk cap. Feishu's real limit is generous; we chunk
 *  to a safe cap like Telegram (4096) / Discord (2000). */
export const FEISHU_MESSAGE_LIMIT = 4000

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

/** Pull human-readable output text out of an ACP tool_call/_update (content[] text
 *  blocks preferred; string rawOutput fallback). Mirrors telegram/discord render's extractor. */
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
  private reasoningBuf = ''
  private reasoningDirty = false
  private toolTitles = new Map<string, string>()
  private toolOutputs = new Map<string, string>()
  private emittedOutput = new Set<string>()
  // minimal mode only — see the OutputConverger (Slack) for the segment/record contract.
  private segmentReset = false
  private recordDirty = false

  constructor(private mode: 'none' | 'minimal' | 'low' | 'medium' | 'high') {}

  /** True while body text OR reasoning is pending — the daemon (re)arms the idle-flush timer on it. */
  hasBuffered(): boolean {
    if (this.mode === 'minimal') return this.recordDirty
    return this.buf.trim().length > 0 || this.reasoningDirty
  }

  /** Idle-timer flush: one in-place reasoning update (high) placed ABOVE the body, then the body.
   *  minimal: just refresh the single in-place `live-reply` with the current segment. */
  flushBuffered(): FeishuAction[] {
    if (this.mode === 'minimal') {
      const trimmed = this.buf.trim()
      if (!trimmed || isNoResponsePrefix(trimmed)) return []
      return [{ kind: 'live-reply', text: this.liveDisplay(this.buf) }]
    }
    return [...this.drainReasoning(), ...this.flush()]
  }

  /** minimal: a Feishu text message caps at FEISHU_MESSAGE_LIMIT; head-clamp the live view
   *  when longer (the full segment still reaches the transcript via the paired `recordOnly` posts). */
  private liveDisplay(text: string): string {
    const chunks = chunkForFeishu(text, FEISHU_MESSAGE_LIMIT)
    return chunks.length <= 1 ? text : `${chunks[0]}\n\n…full reply in the web session`
  }

  /** minimal: close the current reply segment — full text as `recordOnly` post(s) for the
   *  transcript plus the single `live-reply` refresh for the chat. Guards on `recordDirty` so a
   *  segment already closed by an earlier boundary isn't re-recorded. */
  private closeSegment(): FeishuAction[] {
    this.segmentReset = true
    if (!this.recordDirty || !this.buf.trim()) return []
    if (isNoResponsePrefix(this.buf.trim())) return []
    const text = this.buf
    this.recordDirty = false
    return [
      { kind: 'live-reply', text: this.liveDisplay(text) },
      ...chunkForFeishu(text, FEISHU_MESSAGE_LIMIT).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as FeishuAction
      )
    ]
  }

  private drainReasoning(): FeishuAction[] {
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    return [{ kind: 'reasoning', text: renderReasoning(this.reasoningBuf) }]
  }

  private flush(): FeishuAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      return []
    }
    if (isNoResponsePrefix(trimmed)) return []
    const text = this.buf
    this.buf = ''
    // none: record the reply into the transcript WITHOUT sending it — `recordOnly` runs before
    // the connection check, so it lands even though replyConn is unset for this mode.
    const recordOnly = this.mode === 'none'
    return chunkForFeishu(text, FEISHU_MESSAGE_LIMIT).map(
      (t) => ({ kind: 'post', text: t, ...(recordOnly ? { recordOnly: true } : {}) }) as FeishuAction
    )
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
        if (this.mode === 'minimal' && this.segmentReset && text) {
          this.buf = ''
          this.segmentReset = false
        }
        this.buf += text
        if (this.mode === 'minimal' && text.trim()) this.recordDirty = true
        return []
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
        if (this.mode === 'none') return this.flush()
        return [...this.flush(), { kind: 'typing' }]
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
        // minimal: close the segment (record + settle live message); activity = typing only.
        if (this.mode === 'minimal') return [{ kind: 'typing' }, ...this.closeSegment()]
        if (this.mode === 'none') return this.flush()
        if (this.mode === 'low') return [...this.flush(), { kind: 'typing' }]
        const actions: FeishuAction[] = [...this.flush(), { kind: 'typing' }, { kind: 'progress', text: `🔨 ${label}` }]
        if (this.mode === 'high') actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        if (this.mode === 'none') return this.flush()
        if (this.mode === 'low') return [...this.flush(), { kind: 'typing' }]
        return [...this.flush(), { kind: 'plan', text: renderPlan(entries) }]
      }
      default:
        return []
    }
  }

  /** Turn end: flush remaining body; in medium/high append a done footer with the deep link. */
  onFinal(link?: string): FeishuAction[] {
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      this.recordDirty = false
      return []
    }
    // minimal: settle the single live message on the final segment (and record it). No footer.
    if (this.mode === 'minimal') return this.closeSegment()
    // none: record the final body only; nothing is sent to the chat.
    if (this.mode === 'none') return this.flush()
    if (this.mode === 'low') return [...this.flush()]
    const reasoning = this.drainReasoning()
    const footer: FeishuAction[] = link ? [{ kind: 'notice', text: `✅ done — ${link}` }] : []
    return [...reasoning, ...this.flush(), ...footer]
  }
}
