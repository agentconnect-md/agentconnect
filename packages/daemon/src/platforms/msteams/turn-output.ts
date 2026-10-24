// Teams' Layer-2 turn output (teams-integration.md §4.3): one message per text block, posted once and edited in place as it streams.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import type { TurnAcknowledgement, TurnAcknowledgementEnd, TurnOutputContext } from '../turn-output.js'
import { MsTeamsApiError, type MsTeamsTarget } from './api.js'
import { msTeamsTargetOf, splitMsTeamsText, type MsTeamsEgressPort, type MsTeamsReplyPort } from './connection.js'

/** Minimum spacing between edits of one streaming message (§4.3). */
export const MSTEAMS_EDIT_INTERVAL_MS = 2_000
/** How long a turn may show nothing before its acknowledgement is posted. */
export const MSTEAMS_PLACEHOLDER_DELAY_MS = 2_000
/** The acknowledgement itself, which the answer's first text replaces. */
export const MSTEAMS_PLACEHOLDER_TEXT = '⏳ Working on it…'
/** What the acknowledgement becomes when its turn ends with no text and without the no-response marker. */
export const MSTEAMS_NO_REPLY_TEXT = 'Finished without a reply.'

export type MsTeamsOutputMode = 'none' | 'minimal' | 'low' | 'medium' | 'high'

export type MsTeamsAction =
  // The open text block's current text; the stream coalesces it into at most one edit per interval.
  | { kind: 'msteams-stream'; text: string }
  // A completed block; `recordOnly` writes the transcript without sending (mode `none`).
  | { kind: 'post'; text: string; recordOnly?: boolean; attributed?: boolean }
  // The turn ends silently on purpose (the no-response marker), so its acknowledgement is withdrawn.
  | { kind: 'msteams-silent' }
  // A core notice (an approval waiting on an Agent editor): its own message, never part of the reply's stream.
  | { kind: 'notice'; text: string }

/** Streams every mode but `none` the same way: no native streaming, so each block is one message edited in place. */
export class MsTeamsConverger {
  private buf = ''
  private finalized = false
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()

  constructor(
    private readonly mode: MsTeamsOutputMode,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): MsTeamsAction[] {
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

  hasBuffered(): boolean {
    return this.buf.trim().length > 0
  }

  /** Idle flush: refresh the live message with the block so far, never a second message. */
  flushBuffered(): MsTeamsAction[] {
    return this.preview()
  }

  /** A turn ending abnormally posts the whole block, so a runtime's narrated error is not lost. */
  flushTerminal(): MsTeamsAction[] {
    return this.closeBlock()
  }

  onFinal(_attribution?: unknown): MsTeamsAction[] {
    if (this.finalized) return []
    this.finalized = true
    // A bare response-control marker means this message was not for the agent: post nothing.
    if (isNoResponseBody(this.buf.trim())) {
      this.buf = ''
      return [{ kind: 'msteams-silent' }]
    }
    return this.closeBlock()
  }

  private rendered(raw: string): string {
    return flattenUnsafeLinks(raw, { resolveFileLink: this.resolveFileLink })
  }

  private preview(): MsTeamsAction[] {
    if (this.mode === 'none') return []
    const trimmed = this.buf.trim()
    if (!trimmed || isNoResponsePrefix(trimmed)) return []
    // A late link definition must not rewrite an already shown prefix: hold from the first candidate.
    const hold = referenceBufferStart(this.buf)
    const text = this.rendered(hold === undefined ? this.buf : this.buf.slice(0, hold))
    return text.trim() ? [{ kind: 'msteams-stream', text }] : []
  }

  private closeBlock(): MsTeamsAction[] {
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

/** One message on the wire: the activity ID Teams assigned and the text it now shows. */
export interface MsTeamsSentSegment {
  id: string
  text: string
}

export interface MsTeamsStreamOptions {
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

function apiError(err: unknown): MsTeamsApiError {
  return err instanceof MsTeamsApiError ? err : new MsTeamsApiError((err as Error).message, 'ambiguous')
}

/** The failure as the log names it: its category and status, never a credential. */
function describe(err: unknown): string {
  const e = apiError(err)
  return `${e.kind}: ${e.message}`
}

/** One text block's live message(s): a pending snapshot, one timer, and the segments already on the wire. */
export class MsTeamsStream {
  private readonly sent: { id: string; text?: string }[] = []
  private pending: string | undefined
  private timer: unknown
  private flight: Promise<void> = Promise.resolve()
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private failure: MsTeamsApiError | undefined
  private stopped = false
  private readonly interval: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly port: MsTeamsEgressPort,
    private readonly target: MsTeamsTarget,
    /** The acknowledgement's activity, which the first segment edits rather than posting beside it. */
    private adopt?: () => Promise<string | undefined>,
    opts: MsTeamsStreamOptions = {}
  ) {
    this.interval = opts.minEditIntervalMs ?? MSTEAMS_EDIT_INTERVAL_MS
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Note the block's newest text; at most one write reaches the wire per interval. */
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
  async finish(text: string): Promise<MsTeamsSentSegment[]> {
    this.stop()
    this.pending = undefined
    await this.flight
    if (!this.failure) await this.reconcile(text)
    if (this.failure) throw this.failure
    return this.sent.map((s) => ({ id: s.id, text: s.text! }))
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

  /** Bring the wire to `text`: a missing segment is posted, one showing other text edited, in order; the first refusal ends the block. */
  private async reconcile(text: string): Promise<void> {
    const parts = splitMsTeamsText(text)
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!
      let sent = this.sent[i]
      if (sent?.text === part) continue
      try {
        if (!sent) {
          const adopt = this.adopt
          this.adopt = undefined
          const adopted = adopt ? await adopt() : undefined
          if (adopted) sent = { id: adopted }
          else {
            sent = { id: await this.port.post(this.target, part), text: part }
            this.lastWriteAt = this.now()
          }
          this.sent[i] = sent
        }
        if (sent.text !== part) {
          await this.port.update(this.target, sent.id, part)
          sent.text = part
          this.lastWriteAt = this.now()
        }
      } catch (err) {
        this.failure = apiError(err)
        return
      }
    }
  }
}

export interface MsTeamsPlaceholderOptions {
  /** Whether the turn was interrupted since it started; an acknowledgement not yet posted then never is. */
  interrupted?: () => boolean
  warn?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** A turn's acknowledgement: posted once if no text arrives first, then taken over by the answer's first message. */
export class MsTeamsPlaceholder implements TurnAcknowledgement {
  private timer: unknown
  private posting: Promise<void> | undefined
  /** The activity on the wire, once a send answered. */
  private id: string | undefined
  /** The answer or a failure notice took the acknowledgement's place. */
  private taken = false
  private silent = false
  private closed = false
  private readonly interrupted: () => boolean
  private readonly warn: (message: string) => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly port: MsTeamsEgressPort,
    private readonly target: MsTeamsTarget,
    opts: MsTeamsPlaceholderOptions = {}
  ) {
    this.interrupted = opts.interrupted ?? (() => false)
    this.warn = opts.warn ?? (() => {})
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Post after `delayMs` unless text, an interrupt, or the end comes first. */
  arm(delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined
      if (this.closed || this.taken || this.interrupted()) return
      this.posting = this.post()
    }, delayMs)
  }

  /** The turn's first visible text: answers the posted activity for it to edit, once; undefined when none was posted. */
  take(): Promise<string | undefined> {
    if (this.taken) return Promise.resolve(undefined)
    this.taken = true
    this.cancel()
    return (this.posting ?? Promise.resolve()).then(() => this.id)
  }

  /** The turn ended silently on purpose (the no-response marker). */
  silence(): void {
    this.silent = true
  }

  async replace(notice: string): Promise<boolean> {
    if (this.closed) return false
    this.cancel()
    await this.posting
    if (this.closed || this.taken || !this.id) return false
    this.taken = true
    try {
      await this.port.update(this.target, this.id, notice)
      return true
    } catch (err) {
      // Not shown, so the caller posts the notice and the end withdraws the acknowledgement.
      this.taken = false
      this.warn(`msteams: acknowledgement kept its text (${describe(err)})`)
      return false
    }
  }

  async end(end: TurnAcknowledgementEnd): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancel()
    await this.posting
    if (!this.id || this.taken) return
    try {
      // A send is not idempotent, so a rerun cannot adopt this one: it is withdrawn like an interrupted turn's.
      if (end === 'completed' && !this.silent) await this.port.update(this.target, this.id, MSTEAMS_NO_REPLY_TEXT)
      else await this.port.remove(this.target, this.id)
    } catch (err) {
      this.warn(`msteams: acknowledgement not settled (${describe(err)})`)
    }
  }

  private cancel(): void {
    if (this.timer === undefined) return
    this.clearTimer(this.timer)
    this.timer = undefined
  }

  private async post(): Promise<void> {
    try {
      this.id = await this.port.post(this.target, MSTEAMS_PLACEHOLDER_TEXT)
    } catch (err) {
      this.warn(`msteams: acknowledgement not posted (${describe(err)})`)
    }
  }
}

/** The core turn, as Teams' applier sees it; `Pending` satisfies it structurally. */
export interface MsTeamsTurn {
  plan: { transcriptChannel: string; statusThread: string; agentId: string; sessionKey: string }
}

/** What the applier needs from core: the transcript, which is not platform-shaped, and a warning line. */
export interface MsTeamsTurnHost<TTurn> {
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

/** Teams' opaque per-turn state (§7.3): the leased egress, the conversation's write target, and the open block. */
export interface MsTeamsTurnState {
  /** The egress transport captured at turn start and held by the turn's lease; absent for a headless turn, which records but never posts. */
  conn?: MsTeamsEgressPort
  /** Read from the triggering activity, else from the conversation's latest; absent ⇒ the reply is kept in the transcript only. */
  target?: MsTeamsTarget
  stream?: MsTeamsStream
  streamOptions?: MsTeamsStreamOptions
  /** The acknowledgement armed at turn start; the first visible text takes it over. */
  acknowledgement?: MsTeamsPlaceholder
}

/** The conversation a turn writes into: the triggering activity's own coordinates, else the conversation's recorded ones. */
export function msTeamsTurnTarget(
  message: NormalizedMessage,
  conn: Pick<MsTeamsReplyPort, 'targetFor'> | undefined
): MsTeamsTarget | undefined {
  return msTeamsTargetOf(message) ?? conn?.targetFor(message.channel, message.thread)
}

export function initialMsTeamsTurnState(ctx: TurnOutputContext<NormalizedMessage>): MsTeamsTurnState {
  const conn = ctx.egress && !ctx.message.headless ? (ctx.egress as MsTeamsReplyPort) : undefined
  const target = conn ? msTeamsTurnTarget(ctx.message, conn) : undefined
  return {
    ...(conn ? { conn } : {}),
    ...(target ? { target } : {}),
    ...(ctx.acknowledgement instanceof MsTeamsPlaceholder ? { acknowledgement: ctx.acknowledgement } : {})
  }
}

/** Arm a user turn's acknowledgement; a mode that posts nothing shows none. */
export function acknowledgeMsTeamsTurn(
  ctx: TurnOutputContext<NormalizedMessage>,
  turn: { rerun: boolean; interrupted: () => boolean },
  opts: Omit<MsTeamsPlaceholderOptions, 'interrupted'> & { delayMs?: number } = {}
): TurnAcknowledgement | undefined {
  const port = ctx.egress as MsTeamsReplyPort | undefined
  if (!port || ctx.message.source !== 'user' || ctx.message.headless || ctx.mode === 'none') return undefined
  const target = msTeamsTurnTarget(ctx.message, port)
  if (!target) return undefined
  const { delayMs, ...timers } = opts
  const placeholder = new MsTeamsPlaceholder(port, target, { ...timers, interrupted: turn.interrupted })
  placeholder.arm(delayMs ?? MSTEAMS_PLACEHOLDER_DELAY_MS)
  return placeholder
}

function openStream(state: MsTeamsTurnState, port: MsTeamsEgressPort, target: MsTeamsTarget): MsTeamsStream {
  // The first visible text takes the acknowledgement over: its first segment edits that activity.
  const adopted = state.acknowledgement?.take()
  return new MsTeamsStream(port, target, adopted ? () => adopted : undefined, state.streamOptions)
}

/** Apply one converger action: previews feed the block's stream, a post settles it and records each activity it landed as. */
export async function applyMsTeamsAction<TTurn extends MsTeamsTurn>(
  host: MsTeamsTurnHost<TTurn>,
  turn: TTurn,
  state: MsTeamsTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean }
): Promise<void> {
  if (action.kind === 'msteams-silent') {
    state.acknowledgement?.silence()
    return
  }
  if (!action.text) return
  const { conn, target } = state
  if (action.kind === 'notice') {
    if (!conn || !target) return
    await conn
      .post(target, action.text)
      .then(() => undefined)
      .catch((err: unknown) => host.warn(`msteams: a notice was not posted (${describe(err)})`))
    return
  }
  if (action.kind === 'msteams-stream') {
    if (!conn || !target) return
    state.stream ??= openStream(state, conn, target)
    state.stream.update(action.text)
    return
  }
  if (action.kind !== 'post') return
  if (action.recordOnly || !conn || !target) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  const stream = state.stream ?? openStream(state, conn, target)
  state.stream = undefined
  let sent: MsTeamsSentSegment[]
  try {
    sent = await stream.finish(action.text)
  } catch (err) {
    // The answer stays in the transcript whatever Teams refused: an uninstalled bot, blocked writes, a rejected secret.
    host.warn(`msteams: delivery failed (${describe(err)}); the reply is kept in the transcript`)
    await host.recordReplySegment(turn, action.text)
    return
  }
  for (const segment of sent) {
    await host.appendTranscript({
      channel: turn.plan.transcriptChannel,
      thread: turn.plan.statusThread,
      admission: { agentId: turn.plan.agentId, sessionKey: turn.plan.sessionKey },
      // Keyed by the activity ID the send returned, which a quote of this message names (§4.1).
      ts: segment.id,
      eventTimeUs: host.nowUs(),
      sender: turn.plan.agentId,
      kind: 'text',
      text: segment.text
    })
  }
  if (sent.length === 0) await host.recordReplySegment(turn, action.text)
}
