// Mattermost turn output (§7.3): block-scoped streaming via POST /api/v4/posts + throttled (>=1s) PUT /api/v4/posts/{id}/patch with markdown overflow splitting.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { nativeMessageId } from '@agentconnect.md/message'
import type { FileUploader, MessageFile, SendIdentity, UploadAnchor, UploadOutcome } from '../../mcp/ops/context.js'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { renderAttributionMessage, type ReplyAttributionInfo } from '../../messages/attribution.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import { splitMarkdown, utf16Units } from '../../messages/split-markdown-bytes.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import { extractToolOutput } from '../../session/tool-output.js'
import type { TurnOutputContext } from '../turn-output.js'
import { clampMattermostText, MATTERMOST_DM_THREAD, safeMattermostCardUrl } from './module.js'

/** Minimum interval between edits of the same live post on Mattermost. */
export const MATTERMOST_EDIT_INTERVAL_MS = 1_000
/** Minimum interval between Mattermost user_typing frames emitted by turn updates. */
export const MATTERMOST_TYPING_INTERVAL_MS = 4_000
/** Fallback when `maxPostSize` is not reported by `/api/v4/config/client`. */
export const MATTERMOST_DEFAULT_POST_SIZE = 4_000

const MAX_LABEL = 100
const MAX_REASONING = 2_800
const MAX_TOOL_OUTPUT = 2_800

type PlanEntry = { content?: string; status?: 'pending' | 'in_progress' | 'completed' }

export type MattermostOutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export type MattermostAction =
  | { kind: 'mattermost-stream'; text: string }
  | { kind: 'post'; text: string; recordOnly?: boolean; attribution?: ReplyAttributionInfo }
  | { kind: 'notice'; text: string }
  | { kind: 'typing' }
  | { kind: 'progress'; text: string }
  | { kind: 'plan'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-output'; text: string }

function clampText(s: string, max: number): string {
  return clampMattermostText(s, max)
}

function clampToolOutput(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  if (t.startsWith('```') && max >= 10) {
    const close = '\n```'
    const bodyBudget = max - close.length
    const cut = clampText(t, bodyBudget)
    return `${cut}${close}`
  }
  return clampText(t, max)
}

function mdCode(s: string): string {
  return `\`${s.replace(/`/g, 'ˋ').replace(/\s+/g, ' ').trim()}\``
}

function mdPre(s: string): string {
  return '```\n' + s.replace(/```/g, '\u200b`\u200b`\u200b`') + '\n```'
}

function capOutput(s: string): string {
  return clampMattermostText(s, MAX_TOOL_OUTPUT)
}

function planIcon(status?: string): string {
  if (status === 'completed') return '✅'
  if (status === 'in_progress') return '⏳'
  return '⬜'
}

function renderPlan(entries: PlanEntry[]): string {
  const lines = entries.map((e) => `${planIcon(e.status)} ${clampText(e.content ?? '', MAX_LABEL)}`)
  return ['📋 **Plan**', ...lines].join('\n')
}

function renderReasoning(buf: string): string {
  const trimmed = buf.trim()
  if (trimmed.length <= MAX_REASONING) return `💭 **Thinking**\n${trimmed}`
  let start = trimmed.length - MAX_REASONING
  const code = trimmed.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return `💭 **Thinking**\n…${trimmed.slice(start)}`
}

function escapeFooterText(value: string): string {
  return clampMattermostText(value.replace(/\s+/g, ' ').trim(), 200).replace(/([\\`*_[\]~<>])/g, '\\$1')
}

function safeFooterUrl(value: string): string | undefined {
  return safeMattermostCardUrl(value)
}

/** Render the closing Mattermost Markdown attribution + `open in session` link when `showFooter` is active. */
export function mattermostAttributionFooter(info: ReplyAttributionInfo): string {
  const botName = escapeFooterText(info.botName) || 'unknown agent'
  const botUrl = safeFooterUrl(info.botUrl)
  const sessionUrl = safeFooterUrl(info.sessionUrl)
  const body = renderAttributionMessage({
    agent: botUrl ? `[${botName}](${botUrl})` : botName,
    runtime: escapeFooterText(info.runtime),
    model: escapeFooterText(info.model),
    renderSession: sessionUrl ? (label) => `[${escapeFooterText(label)}](${sessionUrl})` : undefined,
    notice: info.notice ? escapeFooterText(info.notice) : undefined
  })
  return body ? `_${body}_` : ''
}

/** Narrow port for Mattermost turn streaming and uploads; satisfied by {@link MattermostConnection}. */
export interface MattermostTurnPort {
  readonly maxPostSize: number
  createPost(
    channel: string,
    text: string,
    opts?: {
      rootId?: string
      fileIds?: string[]
      props?: Record<string, unknown>
      identity?: SendIdentity
    }
  ): Promise<{ id: string }>
  patchPost(
    postId: string,
    text: string,
    opts?: {
      fileIds?: string[]
      props?: Record<string, unknown>
      identity?: SendIdentity
    }
  ): Promise<{ id: string }>
  sendTyping?(channel: string, parentId?: string): Promise<void>
  uploadFile(
    channel: string,
    file: MessageFile,
    comment?: string,
    anchor?: UploadAnchor,
    identity?: SendIdentity
  ): Promise<UploadOutcome>
}

const STREAM_SYNTAX_CHAR_RE = /[\[\]():\r\n<>`\\!~*_-]/
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/

function hasOpenCodeFence(text: string): boolean {
  if (!text.includes('```') && !text.includes('~~~')) return false
  let openMarker: '`' | '~' | undefined
  let openLen = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!openMarker) {
      const m = FENCE_LINE_RE.exec(line)
      if (!m) continue
      const fence = m[1]!
      const marker = fence[0] as '`' | '~'
      const info = m[2] ?? ''
      if (marker === '`' && info.includes('`')) continue
      openMarker = marker
      openLen = fence.length
    } else {
      const trimmed = line.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '')
      if (trimmed.length >= openLen && [...trimmed].every((ch) => ch === openMarker)) {
        openMarker = undefined
        openLen = 0
      }
    }
  }
  return openMarker !== undefined
}

export class MattermostConverger {
  private buf = ''
  private reasoningBuf = ''
  private reasoningDirty = false
  private finalized = false
  private emittedPost = false
  private settledLen = 0
  private settledOut = ''
  private cachedHoldChunkLen = -1
  private cachedHoldPreview: MattermostAction[] | undefined
  private lastTailPreview: string | undefined
  private readonly toolTitles = new Map<string, string>()
  private readonly toolOutputs = new Map<string, string>()
  private readonly emittedOutput = new Set<string>()
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()

  constructor(
    private readonly mode: MattermostOutputMode,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): MattermostAction[] {
    if (this.finalized) return []
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        if (this.mode === 'high') {
          const text = (update as { content?: { text?: string } }).content?.text ?? ''
          if (text) {
            this.reasoningBuf += text
            if (this.reasoningBuf.length > MAX_REASONING * 2) {
              this.reasoningBuf = this.reasoningBuf.slice(-MAX_REASONING * 2)
            }
            this.reasoningDirty = true
          }
        }
        if (this.mode === 'none') return []
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        return [...this.closeBlock(false), { kind: 'typing' }]
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
        const opens = this.work.opens(update)
        const label = this.toolLabel(u)
        if (this.mode === 'none') return opens ? this.closeBlock(false) : []
        if (this.mode === 'minimal') return opens ? [...this.closeMinimalSegment(), { kind: 'typing' }] : []
        if (this.mode === 'low') return opens ? [...this.closeBlock(false), { kind: 'typing' }] : []
        const actions: MattermostAction[] = [
          ...(opens ? [...this.drainReasoning(), ...this.closeBlock(false)] : this.drainReasoning()),
          { kind: 'typing' },
          { kind: 'progress', text: `🔨 ${mdCode(label)}` }
        ]
        if (this.mode === 'high') actions.push(...this.drainToolOutput(u))
        return actions
      }
      case 'plan': {
        const entries = (update as { entries?: PlanEntry[] }).entries ?? []
        if (this.mode === 'minimal') return [{ kind: 'typing' }]
        if (this.mode === 'none') return this.closeBlock(false)
        if (entries.length === 0) return this.closeBlock(false)
        return [...this.drainReasoning(), ...this.closeBlock(false), { kind: 'plan', text: renderPlan(entries) }]
      }
      case 'agent_message_chunk': {
        const content = (update as { content?: { type?: string; text?: string } }).content
        const text = content?.type === 'text' ? (content.text ?? '') : ''
        const opens = this.messages.opens(update)
        if (opens) {
          this.buf = this.messages.withoutClosedSentinel(this.buf)
          this.resetPreviewCache()
        }
        const closed = opens ? (this.mode === 'minimal' ? this.closeMinimalSegment() : this.closeBlock(false)) : []
        this.buf += text
        const preview = this.preview(text)
        const reasoning = this.mode === 'high' && preview.length > 0 ? this.drainReasoning() : []
        return [...reasoning, ...closed, ...preview]
      }
      default: {
        if (!this.work.opens(update)) return []
        if (this.mode === 'none') return this.closeBlock(false)
        if (this.mode === 'minimal') return [...this.closeMinimalSegment(), { kind: 'typing' }]
        return [...this.closeBlock(false), { kind: 'typing' }]
      }
    }
  }

  hasBuffered(): boolean {
    return this.buf.trim().length > 0 || (this.mode === 'high' && this.reasoningDirty)
  }

  flushBuffered(): MattermostAction[] {
    const preview = this.preview()
    const reasoning = this.mode === 'high' && !isNoResponsePrefix(this.buf.trim()) ? this.drainReasoning() : []
    return [...reasoning, ...preview]
  }

  flushTerminal(): MattermostAction[] {
    const reasoning = this.mode === 'high' && !isNoResponseBody(this.buf.trim()) ? this.drainReasoning() : []
    return [...reasoning, ...this.closeBlock(true)]
  }

  onFinal(attribution?: ReplyAttributionInfo): MattermostAction[] {
    if (this.finalized) return []
    this.finalized = true
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      this.reasoningBuf = ''
      this.reasoningDirty = false
      return []
    }
    const reasoning = this.mode === 'high' ? this.drainReasoning() : []
    const closed = this.closeBlock(true, attribution)
    if (closed.length > 0) return [...reasoning, ...closed]
    if (this.emittedPost && attribution && this.mode !== 'none' && this.mode !== 'minimal') {
      const footer = mattermostAttributionFooter(attribution)
      if (footer) return [...reasoning, { kind: 'notice', text: footer }]
    }
    return reasoning
  }

  private toolLabel(update: { toolCallId?: string; title?: string }): string {
    const id = update.toolCallId
    if (update.title) {
      if (id) this.toolTitles.set(id, update.title)
      return update.title
    }
    return (id && this.toolTitles.get(id)) ?? id ?? 'tool'
  }

  private drainReasoning(): MattermostAction[] {
    if (this.mode !== 'high' || !this.reasoningDirty) return []
    this.reasoningDirty = false
    const text = flattenUnsafeLinks(this.reasoningBuf, { resolveFileLink: this.resolveFileLink })
    return text.trim() ? [{ kind: 'reasoning', text: renderReasoning(text) }] : []
  }

  private drainToolOutput(update: {
    toolCallId?: string
    status?: string
    content?: unknown
    rawOutput?: unknown
  }): MattermostAction[] {
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

  private resetPreviewCache(): void {
    this.settledLen = 0
    this.settledOut = ''
    this.cachedHoldChunkLen = -1
    this.cachedHoldPreview = undefined
    this.lastTailPreview = undefined
  }

  private rendered(raw: string): string {
    return flattenUnsafeLinks(raw, { resolveFileLink: this.resolveFileLink })
  }

  private preview(added?: string): MattermostAction[] {
    if (this.mode === 'none') return []
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []

    const noPathRewrite = !this.resolveFileLink?.rewriteSessionPaths
    if (added !== undefined && this.cachedHoldChunkLen >= 0 && noPathRewrite && !STREAM_SYNTAX_CHAR_RE.test(added)) {
      return this.cachedHoldPreview!
    }
    if (
      added !== undefined &&
      this.cachedHoldChunkLen === -1 &&
      this.lastTailPreview !== undefined &&
      noPathRewrite &&
      !STREAM_SYNTAX_CHAR_RE.test(added)
    ) {
      this.lastTailPreview += added
      const out = this.settledOut + this.lastTailPreview
      return out.trim() ? [{ kind: 'mattermost-stream', text: out }] : []
    }

    let tail = this.buf.slice(this.settledLen)
    const hold = noPathRewrite && !tail.includes('[') ? undefined : referenceBufferStart(tail)
    if (hold !== undefined) {
      const prefixOut = this.settledOut + this.rendered(tail.slice(0, hold))
      this.cachedHoldChunkLen = this.buf.length
      this.cachedHoldPreview = prefixOut.trim() ? [{ kind: 'mattermost-stream', text: prefixOut }] : []
      this.lastTailPreview = undefined
      return this.cachedHoldPreview
    }

    this.cachedHoldChunkLen = -1
    this.cachedHoldPreview = undefined

    const lastBreak = tail.lastIndexOf('\n\n')
    if (lastBreak !== -1) {
      const candidateRaw = tail.slice(0, lastBreak + 2)
      if (noPathRewrite && !candidateRaw.includes(']:') && !hasOpenCodeFence(candidateRaw)) {
        this.settledOut += this.rendered(candidateRaw)
        this.settledLen += candidateRaw.length
        tail = this.buf.slice(this.settledLen)
      }
    }

    const renderedTail = !tail.includes('[') && !tail.includes('<') && noPathRewrite ? tail : this.rendered(tail)
    this.lastTailPreview = renderedTail
    const text = this.settledOut + renderedTail
    return text.trim() ? [{ kind: 'mattermost-stream', text }] : []
  }

  private closeBlock(final: boolean, attribution?: ReplyAttributionInfo): MattermostAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      this.resetPreviewCache()
      return []
    }
    if (!final && isNoResponsePrefix(trimmed)) return []
    if (isNoResponseBody(trimmed)) {
      this.buf = ''
      this.resetPreviewCache()
      return []
    }
    const text = this.rendered(this.buf.replace(/\s+$/, ''))
    this.buf = ''
    this.resetPreviewCache()
    if (!text.trim() || isNoResponseBody(text.trim())) return []
    const recordOnly = this.mode === 'none'
    if (!recordOnly) this.emittedPost = true
    const includeFooter = final && attribution && this.mode !== 'none' && this.mode !== 'minimal'
    return [
      {
        kind: 'post',
        text,
        ...(recordOnly ? { recordOnly: true } : {}),
        ...(includeFooter ? { attribution } : {})
      }
    ]
  }

  private closeMinimalSegment(): MattermostAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      this.resetPreviewCache()
      return []
    }
    if (isNoResponsePrefix(trimmed)) return []
    if (isNoResponseBody(trimmed)) {
      this.buf = ''
      this.resetPreviewCache()
      return []
    }
    const text = this.rendered(this.buf.replace(/\s+$/, ''))
    this.buf = ''
    this.resetPreviewCache()
    if (!text.trim() || isNoResponseBody(text.trim())) return []
    return [{ kind: 'post', text, recordOnly: true }]
  }
}

export interface MattermostSentSegment {
  id: string
  text: string
}

export interface MattermostStreamOptions {
  minEditIntervalMs?: number
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  streamingIdentity?: SendIdentity
}

const defaultSetTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return handle
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Split text within Mattermost's post limit without breaking UTF-16 code units or markdown fences. */
export function splitMattermostPostText(text: string, maxPostSize: number): string[] {
  const budget = Math.max(1, maxPostSize || MATTERMOST_DEFAULT_POST_SIZE)
  return splitMarkdown(text, budget, utf16Units)
}

/**
 * Throttled live stream for one Mattermost reply block:
 * creates the first post on arrival (`POST /api/v4/posts`), patches it at most
 * once per `minEditIntervalMs` (`>= 1000 ms`, `PUT /api/v4/posts/{id}/patch`),
 * coalesces chunks arriving during an active write, and creates follow-up posts
 * in the same thread if the block exceeds `maxPostSize`.
 */
export class MattermostTurnStream {
  private readonly sent: { id: string; text?: string; finalStamped?: boolean }[] = []
  private pending: string | undefined
  private timer: unknown
  private inFlight = false
  private flight: Promise<void> = Promise.resolve()
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private failure: unknown
  private stopped = false
  private readonly interval: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly port: MattermostTurnPort,
    private readonly channel: string,
    private readonly rootId: string | undefined,
    private readonly maxPostSize: number,
    private readonly opts: MattermostStreamOptions = {}
  ) {
    this.interval = Math.max(1, opts.minEditIntervalMs ?? MATTERMOST_EDIT_INTERVAL_MS)
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  update(text: string): void {
    if (this.stopped || this.failure) return
    this.pending = text
    if (this.inFlight || this.timer !== undefined) return
    this.scheduleNext()
  }

  suppress(): void {
    this.stopped = true
    this.pending = undefined
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  async close(): Promise<void> {
    this.suppress()
    await this.flight
  }

  async finish(text: string, finalIdentity?: SendIdentity): Promise<MattermostSentSegment[]> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    this.pending = undefined
    await this.flight
    if (!this.stopped && !this.failure) {
      await this.reconcile(text, finalIdentity)
    }
    if (this.failure) throw this.failure
    return this.sent.map((s) => ({ id: s.id, text: s.text! }))
  }

  private scheduleNext(): void {
    if (this.pending === undefined || this.stopped || this.failure || this.inFlight || this.timer !== undefined) return
    const wait = this.interval - (this.now() - this.lastWriteAt)
    if (wait <= 0) {
      this.kick()
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.kick()
    }, wait)
  }

  private kick(): void {
    if (this.inFlight) return
    const next = this.pending
    this.pending = undefined
    if (next === undefined || this.stopped || this.failure) return
    this.inFlight = true
    this.flight = this.flight.then(() => {
      if (this.stopped || this.failure) {
        this.inFlight = false
        return
      }
      return this.reconcile(next, undefined, false)
    })
  }

  private async reconcile(text: string, finalIdentity?: SendIdentity, isFinal = true): Promise<void> {
    try {
      const parts = splitMattermostPostText(text, this.maxPostSize)
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!
        const isLast = i === parts.length - 1
        const identity = isLast && finalIdentity ? finalIdentity : this.opts.streamingIdentity
        const wantsFinalStamp = Boolean(isLast && finalIdentity?.response?.deliveryState === 'final')
        let sent = this.sent[i]
        if (sent?.text === part && (!wantsFinalStamp || sent.finalStamped)) continue
        if (!sent) {
          const created = await this.port.createPost(this.channel, part, {
            ...(this.rootId ? { rootId: this.rootId } : {}),
            ...(identity ? { identity } : {})
          })
          this.lastWriteAt = this.now()
          sent = { id: created.id, text: part, ...(wantsFinalStamp ? { finalStamped: true } : {}) }
          this.sent[i] = sent
          continue
        }
        try {
          await this.port.patchPost(sent.id, part, {
            ...(identity ? { identity } : {})
          })
          this.lastWriteAt = this.now()
          sent.text = part
          if (wantsFinalStamp) sent.finalStamped = true
        } catch (patchErr) {
          const status = (patchErr as { status?: number } | undefined)?.status
          if (isFinal && status === 404) {
            const recreated = await this.port.createPost(this.channel, part, {
              ...(this.rootId ? { rootId: this.rootId } : {}),
              ...(identity ? { identity } : {})
            })
            this.lastWriteAt = this.now()
            this.sent[i] = {
              id: recreated.id,
              text: part,
              ...(wantsFinalStamp ? { finalStamped: true } : {})
            }
          } else {
            throw patchErr
          }
        }
      }
    } catch (err) {
      if (!isFinal) {
        // Transient mid-stream write errors must not abort later preview flushes or final delivery.
        this.lastWriteAt = this.now()
        return
      }
      this.failure = err
    } finally {
      if (!isFinal) {
        this.inFlight = false
        if (this.pending !== undefined && !this.stopped && !this.failure) {
          this.scheduleNext()
        }
      }
    }
  }
}

export interface MattermostChromeSlot {
  id?: string
  text?: string
  attempted?: boolean
}

export interface MattermostTurnState {
  conn?: MattermostTurnPort
  channel: string
  rootId?: string
  replyThread?: string
  isDm: boolean
  identity?: SendIdentity
  stream?: MattermostTurnStream
  streamOptions?: MattermostStreamOptions
  lastTypingAt?: number
  chrome?: {
    progress?: MattermostChromeSlot
    plan?: MattermostChromeSlot
    reasoning?: MattermostChromeSlot
  }
}

export interface MattermostTurn {
  conn?: unknown
  plan: {
    transcriptChannel: string
    statusThread: string
    agentId: string
    sessionKey: string
    channel: string
    thread?: string
  }
}

export interface MattermostTurnHost<TTurn> {
  recordReplySegment(turn: TTurn, text: string): Promise<void>
  appendTranscript(row: {
    channel: string
    thread: string
    admission: { agentId: string; sessionKey: string }
    ts: string
    eventTimeUs: number
    sender: string
    kind: 'text'
    text: string
  }): Promise<void>
  nowUs(): number
  warn(message: string): void
  sendIdentity?(turn: TTurn): SendIdentity | undefined
  finalIdentity?(turn: TTurn): SendIdentity | undefined
  recordPublishedPost?(turn: TTurn, post: { channel: string; ts: string; text: string; finalStamped?: boolean }): void
}

const MATTERMOST_POST_ID_RE = /^[a-z0-9]{26}$/

export function mattermostRootIdForMessage(
  msg: Pick<NormalizedMessage, 'isDm' | 'replyThread' | 'thread' | 'msgId'>
): string | undefined {
  const candidate = msg.isDm
    ? msg.replyThread
    : msg.thread && msg.thread !== MATTERMOST_DM_THREAD
      ? msg.thread
      : nativeMessageId(msg.msgId)
  return candidate && MATTERMOST_POST_ID_RE.test(candidate) ? candidate : undefined
}

export function initialMattermostTurnState(ctx: TurnOutputContext<NormalizedMessage>): MattermostTurnState {
  const conn = ctx.egress && !ctx.message.headless ? (ctx.egress as MattermostTurnPort) : undefined
  return {
    ...(conn ? { conn } : {}),
    channel: ctx.message.channel,
    rootId: mattermostRootIdForMessage(ctx.message),
    ...(ctx.message.replyThread ? { replyThread: ctx.message.replyThread } : {}),
    isDm: ctx.isDm
  }
}

export function mattermostFileUploader(state: MattermostTurnState): FileUploader | undefined {
  const conn = state.conn
  if (!conn) return undefined
  return (file, caption) =>
    conn.uploadFile(state.channel, file, caption, state.rootId ? { thread: state.rootId } : undefined, state.identity)
}

function openStream<TTurn extends MattermostTurn>(
  host: MattermostTurnHost<TTurn>,
  turn: TTurn,
  state: MattermostTurnState,
  conn: MattermostTurnPort
): MattermostTurnStream {
  const streamingIdentity = state.identity ?? host.sendIdentity?.(turn)
  state.identity = streamingIdentity
  return new MattermostTurnStream(conn, state.channel, state.rootId, conn.maxPostSize, {
    ...state.streamOptions,
    ...(streamingIdentity ? { streamingIdentity } : {})
  })
}

function stripAttributionFromSegment(segmentText: string, footer: string): string {
  if (!footer) return segmentText
  if (segmentText === footer) return ''
  const suffix = `\n\n${footer}`
  if (segmentText.endsWith(suffix)) return segmentText.slice(0, -suffix.length)
  if (segmentText.endsWith(footer)) return segmentText.slice(0, -footer.length).replace(/\s+$/, '')
  return segmentText
}

async function upsertChromePost(
  host: Pick<MattermostTurnHost<unknown>, 'warn'>,
  conn: MattermostTurnPort,
  state: MattermostTurnState,
  slotName: 'progress' | 'plan' | 'reasoning',
  rawText: string
): Promise<void> {
  const limit = Math.max(1, conn.maxPostSize || MATTERMOST_DEFAULT_POST_SIZE)
  const text = clampText(rawText, limit)
  if (!text) return
  const chrome = (state.chrome ??= {})
  const slot: MattermostChromeSlot = (chrome[slotName] ??= {})
  if (slot.text === text) return
  slot.text = text
  if (slot.id) {
    await conn
      .patchPost(slot.id, text)
      .then(() => undefined)
      .catch((err) => host.warn(`mattermost: ${slotName} patch failed (${errorMessage(err)})`))
    return
  }
  if (slot.attempted) return
  slot.attempted = true
  try {
    const created = await conn.createPost(state.channel, text, state.rootId ? { rootId: state.rootId } : undefined)
    if (created?.id) slot.id = created.id
  } catch (err) {
    host.warn(`mattermost: ${slotName} post failed (${errorMessage(err)})`)
  }
}

export async function applyMattermostAction<TTurn extends MattermostTurn>(
  host: MattermostTurnHost<TTurn>,
  turn: TTurn,
  state: MattermostTurnState,
  action: MattermostAction
): Promise<void> {
  if (action.kind === 'typing') {
    const conn = state.conn
    if (!conn?.sendTyping) return
    const nowMs = host.nowUs() / 1_000
    if (state.lastTypingAt !== undefined && nowMs - state.lastTypingAt < MATTERMOST_TYPING_INTERVAL_MS) return
    state.lastTypingAt = nowMs
    await conn.sendTyping(state.channel, state.rootId).catch(() => undefined)
    return
  }
  if (!action.text) return
  const conn = state.conn
  if (action.kind === 'progress' || action.kind === 'plan' || action.kind === 'reasoning') {
    if (!conn) return
    await upsertChromePost(host, conn, state, action.kind, action.text)
    return
  }
  if (action.kind === 'tool-output') {
    if (!conn) return
    const limit = Math.max(1, conn.maxPostSize || MATTERMOST_DEFAULT_POST_SIZE)
    const text = clampToolOutput(action.text, limit)
    if (!text) return
    await conn
      .createPost(state.channel, text, state.rootId ? { rootId: state.rootId } : undefined)
      .then(() => undefined)
      .catch((err) => host.warn(`mattermost: tool-output post failed (${errorMessage(err)})`))
    return
  }
  if (action.kind === 'notice') {
    if (!conn) return
    await conn
      .createPost(state.channel, action.text, state.rootId ? { rootId: state.rootId } : undefined)
      .then(() => undefined)
      .catch((err) => host.warn(`mattermost: notice failed (${errorMessage(err)})`))
    return
  }
  if (action.kind === 'mattermost-stream') {
    if (!conn) return
    state.stream ??= openStream(host, turn, state, conn)
    state.stream.update(action.text)
    return
  }
  if (action.kind !== 'post') return
  if (action.recordOnly || !conn) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  const stream = state.stream ?? openStream(host, turn, state, conn)
  state.stream = undefined
  const finalIdentity = host.finalIdentity?.(turn)
  const footer = action.attribution ? mattermostAttributionFooter(action.attribution) : ''
  const deliveredText = footer ? `${action.text}\n\n${footer}` : action.text
  let sent: MattermostSentSegment[]
  try {
    sent = await stream.finish(deliveredText, finalIdentity)
  } catch (err) {
    host.warn(`mattermost: delivery failed (${errorMessage(err)}); keeping reply in transcript`)
    await host.recordReplySegment(turn, action.text)
    return
  }
  if (sent.length === 0) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  for (const segment of sent) {
    const transcriptText = stripAttributionFromSegment(segment.text, footer)
    if (turn.plan.transcriptChannel && turn.plan.statusThread && transcriptText) {
      await host.appendTranscript({
        channel: turn.plan.transcriptChannel,
        thread: turn.plan.statusThread,
        admission: { agentId: turn.plan.agentId, sessionKey: turn.plan.sessionKey },
        ts: segment.id,
        eventTimeUs: host.nowUs(),
        sender: turn.plan.agentId,
        kind: 'text',
        text: transcriptText
      })
    }
    host.recordPublishedPost?.(turn, {
      channel: state.channel,
      ts: segment.id,
      text: segment.text,
      ...(finalIdentity?.response?.deliveryState === 'final' ? { finalStamped: true } : {})
    })
  }
}
