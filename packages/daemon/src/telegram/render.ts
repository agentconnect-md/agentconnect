import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { splitIntoSections } from '../messages/split-sections.js'
import { splitAtParagraphBoundary } from '../messages/stream-boundary.js'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'
import { extractToolOutput } from '../session/tool-output.js'

/**
 * The mode-aware ACP→Telegram intermediate representation — the Telegram analog of
 * slack/render.ts's SlackAction + OutputConverger. The daemon's applyAction
 * resolves these against a live TelegramConnection.
 *
 * FORMATTING: the agent's own reply (`post`) is sent as PLAIN text (no parse_mode)
 * — robust against arbitrary markdown, no 400s from malformed MarkdownV2. Daemon
 * "chrome" (progress / reasoning / plan / tool-output / status) uses parse_mode
 * HTML, which only requires escaping `& < >` (see escapeHtml) — far safer than
 * MarkdownV2. Slack emoji shortcodes are replaced with real Unicode emoji, which
 * Telegram renders natively.
 *
 * Kinds mirror SlackAction so the daemon's dispatch stays parallel:
 *  - `post`        the agent's reply (recorded into the transcript).
 *  - `notice`      a system line posted but NOT recorded (e.g. the done footer).
 *  - `typing`      a transient chat action (sendChatAction 'typing') — Telegram's
 *                  closest analog to Slack's assistant status bar. No text.
 *  - `progress`    the SINGLE in-place progress message (medium/high), edited in place.
 *  - `reasoning`   the SINGLE in-place thinking message (high only), edited in place.
 *  - `plan`        the SINGLE in-place plan-summary message (medium/high).
 *  - `tool-output` a finished tool's output as an HTML <pre> block (high only), not recorded.
 *
 * There is deliberately NO per-turn `status-bar` action (unlike Slack): Telegram
 * has no compact interactive chrome that fits a chat well, so session state and
 * controls are exposed on demand via slash commands instead (`/status`, `/stop`,
 * `/cancel`, `/resume`, `/fast` — see commands/commands.ts + daemon.handleCommand). The
 * `/status` reply reuses {@link renderStatusText}.
 */
export type TelegramAction =
  // `recordOnly: true` writes to the transcript without sending — minimal mode keeps the
  // full audit trail while the chat shows only the single `live-reply` message.
  // `hint` is the continue-the-topic footer line: appended to the SENT text only, never to
  // the recorded transcript text (it is chrome, not the agent's words).
  | { kind: 'post'; text: string; recordOnly?: boolean; hint?: string }
  // `live-reply` is minimal mode's single, in-place agent reply (post-once/edit-thereafter,
  // like `progress`) — display only, NOT recorded. Plain text, like `post`.
  | { kind: 'live-reply'; text: string }
  // Append the continue-the-topic line to the body message ALREADY sent this turn (an
  // in-place edit). Emitted at turn end when the last reply body was flushed earlier — by
  // the idle timer or a tool/plan boundary — so nothing remains for a `post` to carry the
  // hint on. Display only: the transcript keeps the agent's words as recorded.
  | { kind: 'continue-hint'; hint: string }
  | { kind: 'notice'; text: string; parseMode?: 'HTML' }
  | { kind: 'typing' }
  | { kind: 'progress'; text: string; parseMode: 'HTML' }
  | { kind: 'reasoning'; text: string; parseMode: 'HTML' }
  | { kind: 'plan'; text: string; parseMode: 'HTML' }
  | { kind: 'tool-output'; text: string; parseMode: 'HTML' }

/** Telegram single-message hard cap (4096 chars) — vs Slack's 12000-char block. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

/**
 * The continue-the-topic footer appended to the last message of an agent turn.
 *
 * Telegram has no threads outside forum topics, so session continuity in a group runs
 * off the reply chain: a reply to a recorded bot message resolves back to the session
 * that message was posted in (LocalStore.telegramThreadForMessage). The line makes that
 * invisible rule visible. Plain text, because the agent's reply is sent without a
 * parse_mode (see the header note) — the leading ↩️ carries the "small print" weight.
 */
export const TELEGRAM_CONTINUE_HINT = '↩️ To continue this topic, please reply to this message.'

/** Exactly what a hinted message carries beyond its body — the blank-line separator plus
 *  the hint. `length` is UTF-16 code units, which is also how Telegram counts a message. */
export const TELEGRAM_CONTINUE_HINT_SUFFIX = `\n\n${TELEGRAM_CONTINUE_HINT}`

const THINKING = 'is thinking…'
const MAX_LABEL = 100
const MAX_REASONING = 2800
const MAX_TOOL_OUTPUT = 2800

function clampTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Escape the three characters Telegram's HTML parse_mode is sensitive to. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** An HTML inline code span (monospace, verbatim). */
function htmlCode(s: string): string {
  return `<code>${escapeHtml(s)}</code>`
}

/** An HTML preformatted block (monospace, multi-line). */
function htmlPre(s: string): string {
  return `<pre>${escapeHtml(s)}</pre>`
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

/** Render an ACP plan (full entry list, resent each update) as a compact HTML summary. */
function renderPlan(entries: PlanEntry[]): string {
  const lines = entries.map((e) => `${planIcon(e.status)} ${escapeHtml(clampTo(e.content ?? '', MAX_LABEL))}`)
  return ['📋 <b>Plan</b>', ...lines].join('\n')
}

/** Render the accumulated reasoning trace (high mode) tail-clamped, as HTML. */
function renderReasoning(buf: string): string {
  const trimmed = buf.trim()
  const tail = trimmed.length > MAX_REASONING ? `…${trimmed.slice(-MAX_REASONING)}` : trimmed
  return `💭 <b>Thinking</b>\n${escapeHtml(tail)}`
}

/** Status inputs — the subset {@link renderStatusText} renders for the `/status`
 *  reply. Structurally a subset of slack/render.ts's StatusBarInfo, so the daemon
 *  feeds the same object to both. */
export interface TelegramStatusInfo {
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

/** The compact status line (HTML), e.g. `📊 <b>opus-4.8</b> · fast · ctx 120k/200k (60%) · 45.2k tok`. */
export function renderStatusText(info: TelegramStatusInfo): string {
  const parts: string[] = []
  if (info.model) parts.push(`<b>${escapeHtml(info.model)}</b>`)
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
 * The `/status` command reply (HTML): the compact status line, plus a View-session
 * link line when a deep link is known. Sent as Telegram chrome (parse_mode HTML),
 * so the link renders as a tappable anchor. Pure — unit-testable.
 */
export function renderStatusReply(info: TelegramStatusInfo, link?: string): string {
  const line = renderStatusText(info)
  return link ? `${line}\n🔗 <a href="${escapeHtml(link)}">View session</a>` : line
}

export class TelegramConverger {
  private buf = ''
  private reasoningBuf = ''
  private reasoningDirty = false
  private toolTitles = new Map<string, string>()
  private toolOutputs = new Map<string, string>()
  private emittedOutput = new Set<string>()
  // minimal mode only — see the OutputConverger (Slack) for the segment/record contract.
  private segmentReset = false
  private recordDirty = false
  /** Whether this turn has already SENT a body post — the message a turn-end
   *  `continue-hint` edit would land on when no body is left to flush. */
  private postedBody = false
  private readonly hintEnabled: boolean
  /** Body budget per message. With the hint on, every body post reserves room for the
   *  suffix, because ANY of them can end up being the one that carries it (the last flush
   *  appends it directly; an earlier one gets it by edit). Reserving only at the moment of
   *  appending would let a maximal 4096-char section grow past the cap, and Telegram
   *  rejects the whole message — losing the reply AND the transcript row the reply chain
   *  needs. 58 units off 4096 is a cost worth paying for that. */
  private readonly bodyLimit: number

  /** `continueHint`: append {@link TELEGRAM_CONTINUE_HINT} to the turn's last sent reply.
   *  Only honored in the modes whose reply is a real recorded `post` (low/medium/high) —
   *  `none` sends nothing, and minimal's `live-reply` message id is never recorded, so a
   *  reply to it could not resolve back to this session (the hint would be a lie there). */
  constructor(
    private mode: 'none' | 'minimal' | 'low' | 'medium' | 'high',
    opts: { continueHint?: boolean } = {}
  ) {
    this.hintEnabled = opts.continueHint === true && (mode === 'low' || mode === 'medium' || mode === 'high')
    this.bodyLimit = this.hintEnabled
      ? TELEGRAM_MESSAGE_LIMIT - TELEGRAM_CONTINUE_HINT_SUFFIX.length
      : TELEGRAM_MESSAGE_LIMIT
  }

  /** True while body text OR reasoning is pending — the daemon (re)arms the idle-flush timer on it. */
  hasBuffered(): boolean {
    if (this.mode === 'minimal') return this.recordDirty
    return this.buf.trim().length > 0 || this.reasoningDirty
  }

  /** Idle-timer flush: one in-place reasoning update (high) placed ABOVE the body, then the body.
   *  minimal: just refresh the single in-place `live-reply` with the current segment. */
  flushBuffered(): TelegramAction[] {
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flushStreaming()]
  }

  /** Drain everything for a turn that is ending abnormally: the runtime narrated its terminal
   *  error into the message stream and then rejected the prompt, so `onFinal` never runs and
   *  there is no later flush to hold a partial paragraph for. Unlike the idle flush this takes
   *  the whole buffer, paragraph break or not — otherwise the runtime's own error text is
   *  dropped and replaced by the generic failure notice. */
  flushTerminal(): TelegramAction[] {
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flush()]
  }

  /** minimal: refresh the single in-place `live-reply` with the current segment. */
  private liveRefresh(): TelegramAction[] {
    const trimmed = this.buf.trim()
    // Hold the live reply while the body could still be the bare response-control marker, so a
    // suppressed turn never flashes a partial reply in-place (onFinal drops it entirely).
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    return [{ kind: 'live-reply', text: this.liveDisplay(this.buf) }]
  }

  /** minimal: a Telegram message caps at 4096 chars; head-clamp the live view when longer
   *  (the full segment still reaches the transcript via the paired `recordOnly` posts). */
  private liveDisplay(text: string): string {
    const sections = splitIntoSections(text, TELEGRAM_MESSAGE_LIMIT)
    return sections.length <= 1 ? text : `${sections[0]}\n\n…full reply in the web session`
  }

  /** minimal: close the current reply segment — full text as `recordOnly` post(s) for the
   *  transcript plus the single `live-reply` refresh for the chat. Guards on `recordDirty` so a
   *  segment already closed by an earlier boundary isn't re-recorded. */
  private closeSegment(): TelegramAction[] {
    this.segmentReset = true
    if (!this.recordDirty || !this.buf.trim()) return []
    // Hold while the body may still be / is the bare sentinel — a suppressed reply must not be
    // recorded or shown; onFinal makes the final drop. Non-sentinel bodies close normally.
    if (isNoResponsePrefix(this.buf.trim())) return []
    const text = this.buf
    this.recordDirty = false
    return [
      { kind: 'live-reply', text: this.liveDisplay(text) },
      ...splitIntoSections(text, TELEGRAM_MESSAGE_LIMIT).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as TelegramAction
      )
    ]
  }

  private drainReasoning(): TelegramAction[] {
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    return [{ kind: 'reasoning', text: renderReasoning(this.reasoningBuf), parseMode: 'HTML' }]
  }

  /** `final` marks the turn-closing flush: its LAST post carries the continue hint (so a
   *  multi-message reply is annotated once, on the message users would reply to). */
  private flush(final = false): TelegramAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      return []
    }
    // "Not for me" control marker (§no-response): hold while the body could still
    // be the bare marker so a suppressed turn never leaks a partial post; onFinal
    // drops it. A body that diverges from the sentinel is released and posted normally.
    if (isNoResponsePrefix(trimmed)) return []
    const text = this.buf
    this.buf = ''
    return this.emitBody(text, final)
  }

  /** The idle timer's body flush. Unlike a semantic boundary (tool call / plan / thinking,
   *  where the model really did finish a text block) this fires on a mere pause in the ACP
   *  stream, so it posts only up to the last paragraph break and re-buffers the rest —
   *  otherwise one reply is split across two messages mid-sentence (§stream-boundary). */
  private flushStreaming(): TelegramAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    const { ready, tail } = splitAtParagraphBoundary(this.buf)
    if (!ready) return []
    this.buf = tail
    return this.emitBody(ready, false)
  }

  private emitBody(text: string, final: boolean): TelegramAction[] {
    // none: record the reply into the transcript WITHOUT sending it — `recordOnly` runs before
    // the connection check, so it lands even though replyConn is unset for this mode.
    const recordOnly = this.mode === 'none'
    const sections = splitIntoSections(text, this.bodyLimit)
    const hintOn = final && this.hintEnabled
    if (!recordOnly) this.postedBody = true
    return sections.map(
      (t, i) =>
        ({
          kind: 'post',
          text: t,
          ...(recordOnly ? { recordOnly: true } : {}),
          ...(hintOn && i === sections.length - 1 ? { hint: TELEGRAM_CONTINUE_HINT } : {})
        }) as TelegramAction
    )
  }

  /** The turn's hint, once the body is settled: carried by the final `post` when that flush
   *  produced one, otherwise edited onto the body message already sent. Empty when the hint
   *  is off, or when this turn never sent a body for it to belong to. */
  private trailingHint(finalPosts: TelegramAction[]): TelegramAction[] {
    if (!this.hintEnabled || finalPosts.length > 0 || !this.postedBody) return []
    return [{ kind: 'continue-hint', hint: TELEGRAM_CONTINUE_HINT }]
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
  }): TelegramAction[] {
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
    return [{ kind: 'tool-output', text: `${icon}\n${htmlPre(capOutput(text))}`, parseMode: 'HTML' }]
  }

  onUpdate(update: SessionUpdate): TelegramAction[] {
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
        const actions: TelegramAction[] = [
          ...this.flush(),
          { kind: 'typing' },
          { kind: 'progress', text: `🔨 ${htmlCode(label)}`, parseMode: 'HTML' }
        ]
        if (this.mode === 'high') actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        if (this.mode === 'none') return this.flush()
        if (this.mode === 'low') return [...this.flush(), { kind: 'typing' }]
        return [...this.flush(), { kind: 'plan', text: renderPlan(entries), parseMode: 'HTML' }]
      }
      default:
        return []
    }
  }

  /** Turn end: flush remaining body; in medium/high append a done footer with the deep link. */
  onFinal(link?: string, notice?: string): TelegramAction[] {
    // A bare response-control marker (or a non-compliant explanation ending in a bare marker
    // line) means this message wasn't for the agent:
    // suppress everything across all modes (body, reasoning, footer, and minimal mode's
    // live-reply + record). Typing self-expires, so nothing to clear.
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      this.recordDirty = false
      return []
    }
    // minimal: settle the single live message on the final segment (and record it). No footer.
    if (this.mode === 'minimal') return this.closeSegment()
    // none: record the final body only; nothing is sent to the chat.
    if (this.mode === 'none') return this.flush()
    if (this.mode === 'low') {
      const posts = this.flush(true)
      return [...posts, ...this.trailingHint(posts)]
    }
    const reasoning = this.drainReasoning()
    const footer: TelegramAction[] = link
      ? [
          {
            kind: 'notice',
            text: `✅ done — <a href="${escapeHtml(link)}">details</a>${notice ? ` · ${escapeHtml(notice)}` : ''}`,
            parseMode: 'HTML'
          }
        ]
      : []
    const posts = this.flush(true)
    return [...reasoning, ...posts, ...this.trailingHint(posts), ...footer]
  }
}
