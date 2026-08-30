import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { permissionModeDisplayLabel } from '../acp/permission-modes.js'
import { flattenUnsafeLinks } from '../messages/agent-links.js'
import { AgentMessageRun } from '../messages/message-boundary.js'
import { splitAtParagraphBoundary } from '../messages/stream-boundary.js'
import { isNoResponseBody, isNoResponsePrefix } from '../session/no-response.js'
import { extractToolOutput } from '../session/tool-output.js'

/**
 * The mode-aware ACP→Discord intermediate representation — the Discord analog of
 * telegram/render.ts's TelegramAction + TelegramConverger. The daemon's
 * applyAction resolves these against a live DiscordConnection.
 *
 * FORMATTING: Discord message content is already CommonMark-ish (`**bold**`,
 * `*italic*`, `` `code` ``, `> quote`, ```` ```fenced``` ````), so BOTH the
 * agent's reply (`post`) and daemon "chrome" (progress / reasoning / plan /
 * tool-output / status) are sent verbatim as markdown — no HTML/MarkdownV2
 * conversion and no escaping (unlike Telegram, which needs an HTML parse_mode).
 * The only hard constraint is the 2000-character message cap, so long output is
 * chunked (see chunkForDiscord). Slack emoji shortcodes render natively.
 *
 * Kinds mirror TelegramAction so the daemon's dispatch stays parallel:
 *  - `post`        the agent's reply (recorded into the transcript).
 *  - `notice`      a system line posted but NOT recorded (e.g. the done footer).
 *  - `typing`      a transient typing indicator (channel.sendTyping) — Discord's
 *                  closest analog to Slack's assistant status bar. No text.
 *  - `progress`    the SINGLE in-place progress message (medium/high), edited in place.
 *  - `reasoning`   the SINGLE in-place thinking message (high only), edited in place.
 *  - `plan`        the SINGLE in-place plan-summary message (medium/high).
 *  - `tool-output` a finished tool's output as a fenced code block (high only), not recorded.
 *  - `status-bar`  the per-turn status line + button row (Cancel / Fast / View),
 *                  posted once then edited in place; not recorded.
 */
export type DiscordAction =
  // `recordOnly: true` writes to the transcript without sending — minimal mode keeps the
  // full audit trail while the channel shows only the single `live-reply` message.
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
  | { kind: 'status-bar'; text: string; keyboard: DiscordComponents }

/** A single Discord message component button (message-component API JSON).
 *  style: 1 Primary · 2 Secondary · 3 Success · 4 Danger · 5 Link (needs `url`). */
export interface DiscordButton {
  type: 2
  style: 1 | 2 | 3 | 4 | 5
  label: string
  custom_id?: string
  url?: string
}

/** A Discord action row (type 1) holding up to five buttons. */
export interface DiscordActionRow {
  type: 1
  components: DiscordButton[]
}

/** A Discord message `components` payload — the analog of TelegramInlineKeyboard. */
export type DiscordComponents = DiscordActionRow[]

/** Discord single-message hard cap (2000 chars) — vs Telegram's 4096, Slack's 12000-char block. */
export const DISCORD_MESSAGE_LIMIT = 2000

const MAX_LABEL = 100
const MAX_REASONING = 2800
const MAX_TOOL_OUTPUT = 2800

function clampTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Split `text` into chunks that each fit within `limit` characters, preferring to
 * break on paragraph, then line, then whitespace boundaries so markdown/code
 * blocks are not sliced mid-token where avoidable. A single token longer than
 * `limit` is hard-split. Returns at least one chunk (empty in → empty out) so
 * callers can always post something. Discord's analog of slack/formatter's
 * splitIntoSections — kept local since Discord needs no mrkdwn conversion.
 */
export function chunkForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
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

/** A markdown inline code span (monospace, verbatim). Discord needs no escaping. */
function mdCode(s: string): string {
  return `\`${s.replace(/`/g, 'ˋ')}\``
}

/** A markdown fenced code block (monospace, multi-line). Backticks inside are
 *  neutralized so the fence can't be closed early. */
function mdPre(s: string): string {
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

/** Render an ACP plan (full entry list, resent each update) as a compact markdown summary. */
function renderPlan(entries: PlanEntry[]): string {
  const lines = entries.map((e) => `${planIcon(e.status)} ${clampTo(e.content ?? '', MAX_LABEL)}`)
  return ['📋 **Plan**', ...lines].join('\n')
}

/** Render the accumulated reasoning trace (high mode) tail-clamped, as markdown. */
function renderReasoning(buf: string): string {
  const trimmed = buf.trim()
  const tail = trimmed.length > MAX_REASONING ? `…${trimmed.slice(-MAX_REASONING)}` : trimmed
  return `💭 **Thinking**\n${tail}`
}

/** Status-bar inputs — the subset DiscordConverger/buildStatusComponents render.
 *  Structurally a subset of slack/render.ts's StatusBarInfo (and identical to
 *  TelegramStatusInfo), so the daemon feeds the same object to all three. */
export interface DiscordStatusInfo {
  model?: string
  fastMode?: boolean
  fastModeAvailable?: boolean
  contextUsed?: number
  contextSize?: number
  totalTokens?: number
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The compact status line (markdown), e.g. `📊 **opus-4.8** · fast · ctx 120k/200k (60%) · 45.2k tok`. */
export function renderStatusText(info: DiscordStatusInfo): string {
  const parts: string[] = []
  if (info.model) parts.push(`**${info.model}**`)
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

/** custom_id verbs for the status button row. Discord caps custom_id at 100 chars
 *  but we keep the verb STATELESS (mirroring Telegram's callback_data) — the
 *  connection maps the button's message (channel+message_id) back to its session
 *  key, so a full session key never has to ride in the custom_id. */
export const DISCORD_CALLBACK = { cancel: 'ac_cancel', fastOn: 'ac_fast_on', fastOff: 'ac_fast_off' } as const

/** Parse a status-button custom_id verb into a status action (null if unknown).
 *  The Discord analog of parseTelegramCallback. */
export function parseDiscordCallback(
  data: string
): { kind: 'cancel' } | { kind: 'set-fast'; fastMode: boolean } | null {
  if (data === DISCORD_CALLBACK.cancel) return { kind: 'cancel' }
  if (data === DISCORD_CALLBACK.fastOn) return { kind: 'set-fast', fastMode: true }
  if (data === DISCORD_CALLBACK.fastOff) return { kind: 'set-fast', fastMode: false }
  return null
}

/** Select kinds offered as tappable cards (`/models` `/effort` `/permission`). */
export type DiscordSelectKind = 'model' | 'effort' | 'permission'
/** One-char code ↔ kind for the compact select custom_id (`ac_sel:<code>:<index>`). */
export const DISCORD_SELECT_CODE = { model: 'm', effort: 'e', permission: 'p' } as const
const SELECT_CODE_KIND: Record<string, DiscordSelectKind> = { m: 'model', e: 'effort', p: 'permission' }
const SELECT_PREFIX = 'ac_sel'

/** Discord caps a button label at 80 chars and an action row at 5 buttons / a message
 *  at 5 rows → 25 options fit as a card; past that the daemon falls back to a text list. */
const MAX_BUTTON_LABEL = 80
const MAX_BUTTONS_PER_ROW = 5
const MAX_SELECT_OPTIONS = MAX_BUTTONS_PER_ROW * 5

function clampLabel(s: string): string {
  return s.length > MAX_BUTTON_LABEL ? `${s.slice(0, MAX_BUTTON_LABEL - 1)}…` : s
}

/** Parse a select-button custom_id (`ac_sel:<code>:<index>`) into a kind + option index
 *  (null if it isn't one). Stateless like the status verbs — the connection maps the
 *  button's message back to its session key (see parseDiscordCallback's note). */
export function parseDiscordSelect(data: string): { kind: DiscordSelectKind; index: number } | null {
  const m = new RegExp(`^${SELECT_PREFIX}:([mep]):(\\d+)$`).exec(data)
  if (!m) return null
  const kind = SELECT_CODE_KIND[m[1]!]
  const index = Number(m[2])
  if (!kind || !Number.isInteger(index)) return null
  return { kind, index }
}

/**
 * Build a `/models` `/effort` `/permission` select as tappable button rows — one button
 * per option (the current flagged ✅, styled Success), custom_id = `ac_sel:<code>:<index>`.
 * The Discord analog of the daemon's buildSelectCard (Telegram inline keyboard). Returns
 * null when there are no options or too many to fit Discord's 25-button ceiling, so the
 * caller falls back to a numbered text list.
 */
export function buildDiscordSelectComponents(
  kind: DiscordSelectKind,
  current: string | undefined,
  options: string[]
): DiscordComponents | null {
  if (options.length === 0 || options.length > MAX_SELECT_OPTIONS) return null
  const code = DISCORD_SELECT_CODE[kind]
  const rows: DiscordComponents = []
  for (let i = 0; i < options.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push({
      type: 1,
      components: options.slice(i, i + MAX_BUTTONS_PER_ROW).map((o, j) => {
        const isCurrent = o === current
        const shown = kind === 'permission' ? permissionModeDisplayLabel(o) : o
        return {
          type: 2,
          style: isCurrent ? 3 : 2,
          label: clampLabel(`${isCurrent ? '✅ ' : ''}${shown}`),
          custom_id: `${SELECT_PREFIX}:${code}:${i + j}`
        }
      })
    })
  }
  return rows
}

/** A lone "View session" link-button row (Discord style-5). Used by `/status`, where a
 *  raw Slack `<url|text>` link would render as literal text on Discord. */
export function buildLinkComponents(link: string, label = '🔗 View session'): DiscordComponents {
  return [{ type: 1, components: [{ type: 2, style: 5, label, url: link }] }]
}

/** A bot-install warning shown after Discord rejects an API call for missing access,
 * permissions, or OAuth scope. Link buttons open directly and need no interaction
 * callback. Keep the body as plain content (not an embed) so the warning can still
 * send when the missing permission is Embed Links. */
export function buildPermissionUpdateNotice(updateUrl: string): {
  content: string
  components: DiscordComponents
} {
  return {
    content:
      '⚠️ **Permissions update required.** Please re-authorize this Discord app to grant the required server ' +
      "permissions. If the bot is restricted only in this channel, update the channel's permission overrides instead.",
    components: buildLinkComponents(updateUrl, 'Update permissions')
  }
}

/**
 * Build the per-turn status button row: a Cancel button, an optional Fast on/off
 * toggle (when the model advertises one), and a View-session Link button when a
 * deep link is known. The Discord analog of buildStatusKeyboard — Discord
 * components can't do dropdowns either, so model/effort selection isn't offered.
 * Pure — unit-testable.
 */
export function buildStatusComponents(info: DiscordStatusInfo, link?: string): DiscordComponents {
  const buttons: DiscordButton[] = [{ type: 2, style: 4, label: '🛑 Cancel', custom_id: DISCORD_CALLBACK.cancel }]
  if (info.fastModeAvailable) {
    buttons.push(
      info.fastMode
        ? { type: 2, style: 2, label: '⚡ Fast: on', custom_id: DISCORD_CALLBACK.fastOff }
        : { type: 2, style: 2, label: '⚡ Fast: off', custom_id: DISCORD_CALLBACK.fastOn }
    )
  }
  if (link) buttons.push({ type: 2, style: 5, label: '🔗 View session', url: link })
  return [{ type: 1, components: buttons }]
}

export class DiscordConverger {
  private buf = ''
  private reasoningBuf = ''
  private reasoningDirty = false
  private toolTitles = new Map<string, string>()
  private toolOutputs = new Map<string, string>()
  private emittedOutput = new Set<string>()
  // minimal mode only — see the OutputConverger (Slack) for the segment/record contract.
  private segmentReset = false
  private recordDirty = false
  // The runtime's own message identity, which is the only boundary a speak-only run offers.
  private readonly messages = new AgentMessageRun()

  constructor(private mode: 'none' | 'minimal' | 'low' | 'medium' | 'high') {}

  /** True while body text OR reasoning is pending — the daemon (re)arms the idle-flush timer on it. */
  hasBuffered(): boolean {
    if (this.mode === 'minimal') return this.recordDirty
    return this.buf.trim().length > 0 || this.reasoningDirty
  }

  /** Idle-timer flush: one in-place reasoning update (high) placed ABOVE the body, then the body.
   *  minimal: just refresh the single in-place `live-reply` with the current segment. */
  flushBuffered(): DiscordAction[] {
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flushStreaming()]
  }

  /** Drain everything for a turn that is ending abnormally: the runtime narrated its terminal
   *  error into the message stream and then rejected the prompt, so `onFinal` never runs and
   *  there is no later flush to hold a partial paragraph for. Unlike the idle flush this takes
   *  the whole buffer, paragraph break or not — otherwise the runtime's own error text is
   *  dropped and replaced by the generic failure notice. */
  flushTerminal(): DiscordAction[] {
    if (this.mode === 'minimal') return this.liveRefresh()
    return [...this.drainReasoning(), ...this.flush()]
  }

  /** minimal: refresh the single in-place `live-reply` with the current segment. */
  private liveRefresh(): DiscordAction[] {
    const trimmed = this.buf.trim()
    // Hold the live reply while the body could still be the bare response-control marker, so a
    // suppressed turn never flashes a partial reply in-place (onFinal drops it entirely).
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    return [{ kind: 'live-reply', text: this.liveDisplay(this.buf) }]
  }

  /** minimal: a Discord message caps at 2000 chars; head-clamp the live view when longer
   *  (the full segment still reaches the transcript via the paired `recordOnly` posts). */
  private liveDisplay(text: string): string {
    const chunks = chunkForDiscord(text, DISCORD_MESSAGE_LIMIT)
    return chunks.length <= 1 ? text : `${chunks[0]}\n\n…full reply in the web session`
  }

  /** minimal: close the current reply segment — full text as `recordOnly` post(s) for the
   *  transcript plus the single `live-reply` refresh for the channel. Guards on `recordDirty` so a
   *  segment already closed by an earlier boundary isn't re-recorded. */
  private closeSegment(): DiscordAction[] {
    this.segmentReset = true
    if (!this.recordDirty || !this.buf.trim()) return []
    // Hold while the body may still be / is the bare sentinel — a suppressed reply must not be
    // recorded or shown; onFinal makes the final drop. Non-sentinel bodies close normally.
    if (isNoResponsePrefix(this.buf.trim())) return []
    const text = flattenUnsafeLinks(this.buf)
    this.recordDirty = false
    return [
      { kind: 'live-reply', text: this.liveDisplay(text) },
      ...chunkForDiscord(text, DISCORD_MESSAGE_LIMIT).map(
        (t) => ({ kind: 'post', text: t, recordOnly: true }) as DiscordAction
      )
    ]
  }

  private drainReasoning(): DiscordAction[] {
    if (!this.reasoningDirty) return []
    this.reasoningDirty = false
    return [{ kind: 'reasoning', text: renderReasoning(flattenUnsafeLinks(this.reasoningBuf)) }]
  }

  private flush(): DiscordAction[] {
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
    return this.emitBody(text)
  }

  /** The idle timer's body flush. Unlike a semantic boundary (tool call / plan / thinking,
   *  where the model really did finish a text block) this fires on a mere pause in the ACP
   *  stream, so it posts only up to the last paragraph break and re-buffers the rest —
   *  otherwise one reply is split across two messages mid-sentence (§stream-boundary). */
  private flushStreaming(): DiscordAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    const { ready, tail } = splitAtParagraphBoundary(this.buf)
    if (!ready) return []
    this.buf = tail
    return this.emitBody(ready)
  }

  private emitBody(raw: string): DiscordAction[] {
    const text = flattenUnsafeLinks(raw)
    // none: record the reply into the transcript WITHOUT sending it — `recordOnly` runs before
    // the connection check, so it lands even though replyConn is unset for this mode.
    const recordOnly = this.mode === 'none'
    return chunkForDiscord(text, DISCORD_MESSAGE_LIMIT).map(
      (t) => ({ kind: 'post', text: t, ...(recordOnly ? { recordOnly: true } : {}) }) as DiscordAction
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
  }): DiscordAction[] {
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
    return [{ kind: 'tool-output', text: `${icon}\n${mdPre(capOutput(text))}` }]
  }

  onUpdate(update: SessionUpdate): DiscordAction[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = (update as { content?: { type?: string; text?: string } }).content
        const text = content?.type === 'text' ? (content.text ?? '') : ''
        // A new message closes the one before it exactly as a tool boundary would — same mode
        // semantics, same actions. Without this the two arrive as one post, run together.
        const closed = this.messages.opens(update) ? (this.mode === 'minimal' ? this.closeSegment() : this.flush()) : []
        if (this.mode === 'minimal' && this.segmentReset && text) {
          this.buf = ''
          this.segmentReset = false
        }
        this.buf += text
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
        const actions: DiscordAction[] = [
          ...this.flush(),
          { kind: 'typing' },
          { kind: 'progress', text: `🔨 ${mdCode(label)}` }
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
        if (this.mode === 'none') return this.flush()
        return [...this.flush(), { kind: 'plan', text: renderPlan(entries) }]
      }
      default:
        return []
    }
  }

  /** Turn end: flush remaining body; in medium/high append a done footer with the deep link. */
  onFinal(link?: string, notice?: string): DiscordAction[] {
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
    // none: record the final body only; nothing is sent to the channel.
    if (this.mode === 'none') return this.flush()
    if (this.mode === 'low') return [...this.flush()]
    const reasoning = this.drainReasoning()
    const footer: DiscordAction[] = link
      ? [{ kind: 'notice', text: `✅ done — [details](${link})${notice ? ` · ${notice}` : ''}` }]
      : []
    return [...reasoning, ...this.flush(), ...footer]
  }
}
