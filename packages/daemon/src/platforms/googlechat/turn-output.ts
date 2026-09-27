// Google Chat's Layer-2 turn output (google-chat-integration.md §5): one Markdown message per text block, edited in place while it streams.
import { createHash } from 'node:crypto'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import { stableMessageId, type NormalizedMessage } from '../../messages/normalized.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import type { TurnOutputContext } from '../turn-output.js'
import { GoogleChatApiError, type GoogleChatMessageRef } from './connection.js'
import { renderGoogleChatMarkdown, splitGoogleChatText } from './render.js'

/** Minimum spacing between edits of one streaming message (§5). */
export const GOOGLE_CHAT_EDIT_INTERVAL_MS = 2_000

export type GoogleChatOutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export type GoogleChatAction =
  // The open text block's current text; the stream coalesces it into at most one edit per interval.
  | { kind: 'gchat-stream'; text: string }
  // A completed block or a notice; `recordOnly` writes the transcript without sending (mode `none`).
  | { kind: 'post'; text: string; recordOnly?: boolean; attributed?: boolean }

/** `client-` plus 48 lowercase hex chars: inside Google's alphabet and 63-char cap, and distinct per (delivery, block, segment). */
export function googleChatClientId(deliveryId: string, block: number, segment: number): string {
  const digest = createHash('sha256').update(`${deliveryId}\u001f${block}\u001f${segment}`).digest('hex')
  return `client-${digest.slice(0, 48)}`
}

/** Streams every mode but `none` the same way: Google Chat has no chrome to spend a richer mode on (§5). */
export class GoogleChatConverger {
  private buf = ''
  private finalized = false
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()

  constructor(
    private readonly mode: GoogleChatOutputMode,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): GoogleChatAction[] {
    if (this.finalized) return []
    // New work (a tool, a thought, a plan) ends the text block, exactly as a new message would.
    if (this.work.opens(update)) return this.closeBlock()
    if (update.sessionUpdate !== 'agent_message_chunk') return []
    const content = (update as { content?: { type?: string; text?: string } }).content
    const text = content?.type === 'text' ? (content.text ?? '') : ''
    const closed = this.messages.opens(update) ? this.closeBlock() : []
    this.buf += text
    return [...closed, ...this.preview()]
  }

  /** True while the open block has text; the daemon re-arms its idle flush on it. */
  hasBuffered(): boolean {
    return this.buf.trim().length > 0
  }

  /** Idle flush: refresh the live message with the block so far, never a second message. */
  flushBuffered(): GoogleChatAction[] {
    return this.preview()
  }

  /** A turn ending abnormally posts the whole block, so a runtime's narrated error is not lost. */
  flushTerminal(): GoogleChatAction[] {
    return this.closeBlock()
  }

  onFinal(_attribution?: unknown): GoogleChatAction[] {
    if (this.finalized) return []
    this.finalized = true
    // A bare response-control marker means this message was not for the agent: post nothing.
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      return []
    }
    return this.closeBlock()
  }

  private rendered(raw: string): string {
    return renderGoogleChatMarkdown(flattenUnsafeLinks(raw, { resolveFileLink: this.resolveFileLink }))
  }

  private preview(): GoogleChatAction[] {
    if (this.mode === 'none') return []
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    // A late link definition must not rewrite an already shown prefix: hold from the first candidate.
    const hold = referenceBufferStart(this.buf)
    const text = this.rendered(hold === undefined ? this.buf : this.buf.slice(0, hold))
    return text.trim() ? [{ kind: 'gchat-stream', text }] : []
  }

  private closeBlock(): GoogleChatAction[] {
    const trimmed = this.buf.trim()
    if (!trimmed) {
      this.buf = ''
      return []
    }
    // Hold while the body could still be the bare marker; onFinal makes the drop.
    if (isNoResponsePrefix(trimmed)) return []
    const text = this.rendered(this.buf)
    this.buf = ''
    if (!text.trim()) return []
    return [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
  }
}

/** What the stream needs from the connection: idempotent creates by client id and owned-message patches. */
export interface GoogleChatEgressPort {
  createMessage(input: {
    space: string
    thread?: string
    clientId: string
    text: string
  }): Promise<GoogleChatMessageRef>
  patchMessage(name: string, text: string): Promise<void>
}

/** One message on the wire: the id the daemon chose, the name Google answered, and the text it currently shows. */
export interface GoogleChatSentSegment {
  clientId: string
  name: string
  text: string
}

export interface GoogleChatStreamOptions {
  minEditIntervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return t
}

/** One text block's live message(s): a pending snapshot, one timer, and the segments already on the wire. */
export class GoogleChatStream {
  private readonly sent: GoogleChatSentSegment[] = []
  private pending: string | undefined
  private timer: unknown
  private flight: Promise<void> = Promise.resolve()
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private failure: GoogleChatApiError | undefined
  private stopped = false
  private readonly interval: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly port: GoogleChatEgressPort,
    private readonly target: { space: string; thread?: string },
    private readonly clientId: (segment: number) => string,
    opts: GoogleChatStreamOptions = {}
  ) {
    this.interval = opts.minEditIntervalMs ?? GOOGLE_CHAT_EDIT_INTERVAL_MS
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Note the block's newest text; at most one write batch per interval reaches the wire. */
  update(text: string): void {
    if (this.stopped || this.failure) return
    this.pending = text
    if (this.timer !== undefined) return
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

  /** The block's final text replaces whatever edit was pending; resolves with the wire state or throws the delivery failure. */
  async finish(text: string): Promise<GoogleChatSentSegment[]> {
    this.stop()
    this.pending = undefined
    await this.flight
    if (!this.failure) await this.reconcile(text)
    if (this.failure) throw this.failure
    return [...this.sent]
  }

  /** Suppression: nothing pending reaches the wire. */
  suppress(): void {
    this.stop()
    this.pending = undefined
  }

  /** Settlement without a final: flush the pending snapshot so the live message is not left stale. */
  async close(): Promise<void> {
    this.stop()
    await this.flight
    if (this.failure || this.pending === undefined) return
    const text = this.pending
    this.pending = undefined
    await this.reconcile(text)
  }

  private stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  private kick(): void {
    this.flight = this.flight.then(async () => {
      if (this.failure || this.pending === undefined) return
      const text = this.pending
      this.pending = undefined
      await this.reconcile(text)
    })
  }

  /** Bring the wire to `text`: a missing segment is created, a changed one patched, in order; the first refusal ends the block. */
  private async reconcile(text: string): Promise<void> {
    const parts = splitGoogleChatText(text)
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!
      const sent = this.sent[i]
      if (sent && sent.text === part) continue
      try {
        if (!sent) {
          const clientId = this.clientId(i)
          const created = await this.port.createMessage({
            space: this.target.space,
            ...(this.target.thread ? { thread: this.target.thread } : {}),
            clientId,
            text: part
          })
          this.sent[i] = { clientId, name: created.name, text: part }
        } else {
          await this.port.patchMessage(sent.name, part)
          sent.text = part
        }
        this.lastWriteAt = this.now()
      } catch (err) {
        this.failure =
          err instanceof GoogleChatApiError ? err : new GoogleChatApiError((err as Error).message, 'ambiguous')
        return
      }
    }
  }
}

/** The core turn, as Google Chat's applier sees it; `Pending` satisfies it structurally. */
export interface GoogleChatTurn {
  plan: {
    transcriptChannel: string
    statusThread: string
    agentId: string
    sessionKey: string
  }
}

/** What the applier needs from core: the transcript, which is not platform-shaped, and a warning line. */
export interface GoogleChatTurnHost<TTurn> {
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
}

/** Google Chat's opaque per-turn state (§7.3): the reply target, the delivery the client ids derive from, and the open block. */
export interface GoogleChatTurnState {
  /** The egress transport captured at turn start and held by the turn's lease. */
  conn?: GoogleChatEgressPort
  space: string
  /** The named Space's thread; absent in a DM, whose create carries no thread option (§5). */
  thread?: string
  deliveryId: string
  /** Text blocks this turn has closed so far; each block's messages take their own client ids. */
  block: number
  stream?: GoogleChatStream
  streamOptions?: GoogleChatStreamOptions
}

export function initialGoogleChatTurnState(ctx: TurnOutputContext<NormalizedMessage>): GoogleChatTurnState {
  return {
    ...(ctx.egress ? { conn: ctx.egress as GoogleChatEgressPort } : {}),
    space: ctx.message.channel,
    ...(ctx.isDm || ctx.message.thread === undefined ? {} : { thread: ctx.message.thread }),
    deliveryId: stableMessageId(ctx.message),
    block: 0
  }
}

function openStream(state: GoogleChatTurnState, port: GoogleChatEgressPort): GoogleChatStream {
  const block = state.block
  return new GoogleChatStream(
    port,
    { space: state.space, ...(state.thread ? { thread: state.thread } : {}) },
    (segment) => googleChatClientId(state.deliveryId, block, segment),
    state.streamOptions
  )
}

/** The failure as the log names it: its category and Google's bounded detail, never a credential. */
function describeFailure(err: unknown): string {
  return err instanceof GoogleChatApiError ? `${err.kind}: ${err.message}` : (err as Error).message
}

/** Apply one converger action: previews feed the block's stream, a post settles it and records what landed. */
export async function applyGoogleChatAction<TTurn extends GoogleChatTurn>(
  host: GoogleChatTurnHost<TTurn>,
  turn: TTurn,
  state: GoogleChatTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean }
): Promise<void> {
  if (!action.text) return
  if (action.kind === 'gchat-stream') {
    if (!state.conn) return
    state.stream ??= openStream(state, state.conn)
    state.stream.update(action.text)
    return
  }
  if (action.kind !== 'post') return
  if (action.recordOnly || !state.conn) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  const stream = state.stream ?? openStream(state, state.conn)
  state.stream = undefined
  state.block += 1
  let sent: GoogleChatSentSegment[]
  try {
    sent = await stream.finish(action.text)
  } catch (err) {
    // The answer stays in the transcript whatever Google refused: a missing thread, a deleted message, a rejected key.
    host.warn(
      `googlechat: delivery into ${state.space} failed (${describeFailure(err)}); the reply is kept in the transcript`
    )
    await host.recordReplySegment(turn, action.text)
    return
  }
  for (const segment of sent) {
    await host.appendTranscript({
      channel: turn.plan.transcriptChannel,
      thread: turn.plan.statusThread,
      admission: { agentId: turn.plan.agentId, sessionKey: turn.plan.sessionKey },
      // The row is keyed by the message's own resource name, so a later edit lands on the same row.
      ts: segment.name,
      eventTimeUs: host.nowUs(),
      sender: turn.plan.agentId,
      kind: 'text',
      text: segment.text
    })
  }
  if (sent.length === 0) await host.recordReplySegment(turn, action.text)
}
