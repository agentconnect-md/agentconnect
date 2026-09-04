/**
 * `RelayBrowserConnection` — the per-socket actor for a browser playground webchat
 * conversation (shared-bot-relay.md §7.2 / §10, webchat-multi-agents.md §5/§6).
 * One socket == one conversation, which may have SEVERAL participant agents on
 * different daemons.
 *
 * It speaks the browser-facing, type-tagged webchat envelope. The browser sends
 * `{text, turnId, mentions?, targets?, attachments?, runtime?}` (a turn) or
 * `{type:'resume'|'attach'|'set_model'|'set_effort'|'set_permission_mode'|'set_fast'|'cancel'}`,
 * and the relay sends `{type:'ready'|'output'|'done'|'ack'|'resumed'|'attached'|'post'|'error'}`.
 * A turn fans out as one pre-addressed `rd/msg(webchat)` per targeted agent's
 * daemon (targets are validated against the verified roster) plus a transcript-only
 * `context` copy to every other participant's daemon; each `rd/chat` chunk a daemon
 * streams back is translated to `{type:'output'|'done'}` (agent-attributed).
 *
 * Daemon placements are resolved once at connect (the token's verified roster); if a
 * participant's daemon has no live rd/* socket on THIS relay its target fails with a
 * per-agent nack.
 */
import { randomUUID } from 'node:crypto'
import { selectTurnTargets } from '@agentconnect.md/activation-policy'
import {
  ErrorCode,
  RelayWebchatOp,
  RD_ACK_NOT_HOLDER,
  RD_WEBCHAT_ATTACH_V1,
  type RdChat,
  type RdMsgWebchat,
  type RdWebchatPost,
  type WebchatPost,
  type WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'
import { WireError, type ServerTransport } from '@agentconnect.md/connection'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { ChatSink } from './webchat-router.js'
import type { Logger } from './log.js'

const ACK_TIMEOUT_MESSAGE =
  /^no ack after [1-9]\d* tries for [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_PROTOCOL_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_FRAME',
  'FRAME_TOO_LARGE',
  'PROTOCOL_STATE',
  'BAD_PAYLOAD'
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Preserve actionable delivery telemetry without ever copying error messages or
 * details: both may contain the exact rd/msg, including browser content and the
 * non-secret remote-MCP entitlement.
 */
function deliveryFailureDiagnostic(error: unknown): string {
  if (!(error instanceof WireError)) return 'kind=unknown_error'

  const parsedCode = ErrorCode.safeParse(error.code)
  if (!parsedCode.success) return 'kind=unknown_wire_error'

  const code = parsedCode.data
  let kind = 'wire_error'
  if (code === 'INTERNAL' && error.retryable && ACK_TIMEOUT_MESSAGE.test(error.message)) {
    kind = 'ack_timeout'
  } else if (code === 'INTERNAL' && error.retryable && error.message === 'connection closed') {
    kind = 'connection_closed'
  } else if (REMOTE_PROTOCOL_CODES.has(code)) {
    kind = 'remote_protocol'
  }
  return `kind=${kind} code=${code} retryable=${error.retryable}`
}

/** One conversation participant, as verified by the CP at connect. */
export interface BrowserConnParticipant {
  agentId: string
  /** Current placement; absent ⇒ unplaced / daemon not READY at verify (turns
   *  targeting it are refused with `no_agent`). */
  daemonId?: string
  primary?: boolean
}

export interface RelayBrowserConnDeps {
  /** The conversation id (== chatId == sessionKey); fresh or resumed. */
  chatId: string
  /** The primary participant (the token's compatibility agent). */
  agentId: string
  /** The conversation's full verified roster (always includes the primary). */
  participants: BrowserConnParticipant[]
  /** Display handle for the transcript author line (from the verified token). */
  user: string
  /** The author's stable CP principal (from the same verdict). Recipients record it as
   *  the transcript sender, so `user` staying mutable costs nothing. */
  userId?: string
  /** The author's public avatar URL (from the same verdict); a Slack mirror posts under it. */
  userPicture?: string
  /** Session-targeted continuation: the CP-verified target ACP session id from
   *  the verdict, stamped verbatim onto every rd/msg. Never browser input. */
  targetSessionId?: string
  /** Non-secret MCP entitlement from the verified CP result, never browser input. */
  remoteMcp?: WebchatRemoteMcpEntitlement
  /** Resolve a live rd/* connection to a participant's daemon (absent if it dropped). */
  daemonConnFor: (daemonId: string) => RelayDaemonConnection | undefined
  /** Any live duty-governed pool connection, tried when the recorded daemon is gone (a rollout
   *  replaced it): the member claims the duty on receipt or names the holder (§4.4). */
  rendezvousDaemonConn?: () => { daemonId: string; conn: RelayDaemonConnection } | undefined
  register: (chatId: string, sink: ChatSink) => void
  unregister: (chatId: string, sink: ChatSink) => void
  log: Logger
}

/** A parsed browser op plus the relay-level targeting the envelope carried. */
export interface ParsedBrowserOp {
  op: RelayWebchatOp
  /** `turn` only: the agents this turn activates (composer-computed ladder,
   *  webchat-multi-agents.md §4.2). Validated against the roster before fan-out. */
  targets?: string[]
}

function uuidArray(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) return undefined
    const id = entry.toLowerCase()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** Parse a browser envelope into a webchat op (+ targeting), or null if unrecognized. */
export function parseBrowserFrame(
  msg: unknown,
  user: string,
  userId?: string,
  userPicture?: string
): ParsedBrowserOp | null {
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  // A bare message envelope (no type) or {type:'message', ...} is a turn.
  if ((m.type === undefined || m.type === 'message') && (typeof m.text === 'string' || Array.isArray(m.attachments))) {
    const mentions = m.mentions !== undefined ? uuidArray(m.mentions, 16) : undefined
    const parsed = RelayWebchatOp.safeParse({
      op: 'turn',
      text: typeof m.text === 'string' ? m.text : '',
      user,
      ...(userId ? { userId } : {}),
      ...(userPicture ? { userPicture } : {}),
      ...(m.turnId !== undefined ? { turnId: m.turnId } : {}),
      ...(mentions ? { mentions } : {}),
      ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
      ...(m.runtime !== undefined ? { runtime: m.runtime } : {}),
      ...(m.worktree !== undefined ? { worktree: m.worktree } : {})
    })
    if (!parsed.success || parsed.data.op !== 'turn') return null
    const targets = m.targets !== undefined ? uuidArray(m.targets, 16) : undefined
    return { op: parsed.data, ...(targets ? { targets } : {}) }
  }
  switch (m.type) {
    case 'resume':
      return Number.isInteger(m.afterIndex) &&
        (m.afterIndex as number) >= -1 &&
        typeof m.turnId === 'string' &&
        Number.isSafeInteger(m.generation) &&
        (m.generation as number) >= 1 &&
        (m.agentId === undefined || (typeof m.agentId === 'string' && UUID_RE.test(m.agentId)))
        ? {
            op: {
              op: 'resume',
              turnId: m.turnId,
              ...(typeof m.agentId === 'string' ? { agentId: m.agentId.toLowerCase() } : {}),
              generation: m.generation as number,
              afterIndex: m.afterIndex as number
            }
          }
        : null
    case 'attach':
      // Cold-load probe: name the live stream for (conversation, agent) so a reloaded
      // browser can resume it. `agentId` defaults to the primary at dispatch.
      return m.agentId === undefined || (typeof m.agentId === 'string' && UUID_RE.test(m.agentId))
        ? { op: { op: 'attach', ...(typeof m.agentId === 'string' ? { agentId: m.agentId.toLowerCase() } : {}) } }
        : null
    case 'set_model':
      return typeof m.model === 'string' ? { op: { op: 'set_model', model: m.model } } : null
    case 'set_effort':
      return typeof m.effort === 'string' ? { op: { op: 'set_effort', effort: m.effort } } : null
    case 'set_permission_mode':
      return typeof m.permissionMode === 'string'
        ? { op: { op: 'set_permission_mode', permissionMode: m.permissionMode } }
        : null
    case 'set_fast':
      return typeof m.fastMode === 'boolean' ? { op: { op: 'set_fast', fastMode: m.fastMode } } : null
    case 'cancel':
      return m.agentId === undefined || (typeof m.agentId === 'string' && UUID_RE.test(m.agentId))
        ? { op: { op: 'cancel', ...(typeof m.agentId === 'string' ? { agentId: m.agentId.toLowerCase() } : {}) } }
        : null
    case 'elicitation_choice': {
      // The answer to an in-band elicitation card. `value: null` is Dismiss, an array is a
      // multi-select's chosen list, a number answers a numeric field, and a string is a picked
      // option or typed text; the daemon matches the requestId against its own pending card and
      // re-checks the value against the constraints that card carried.
      const listed = Array.isArray(m.value) && m.value.every((v) => typeof v === 'string')
      const scalar = typeof m.value === 'string' || (typeof m.value === 'number' && Number.isFinite(m.value))
      // A multi-field form card answers with one value per field, keyed by property name; the
      // daemon checks the keys against the card it posted, and each value against that field.
      // An EMPTY record is a real answer — every field optional and left alone — so it is not
      // filtered out here; the zod parse below still bounds how large one may be.
      const record = !!m.value && typeof m.value === 'object' && !Array.isArray(m.value)
      if (typeof m.requestId !== 'string' || (!scalar && !record && m.value !== null && !listed)) return null
      if (m.agentId !== undefined && !(typeof m.agentId === 'string' && UUID_RE.test(m.agentId))) return null
      const parsed = RelayWebchatOp.safeParse({
        op: 'elicitation_choice',
        requestId: m.requestId,
        value: m.value,
        ...(typeof m.agentId === 'string' ? { agentId: m.agentId.toLowerCase() } : {})
      })
      return parsed.success ? { op: parsed.data } : null
    }
    default:
      return null
  }
}

/**
 * Which participants one user turn ACTIVATES: since the webchat fold-in this
 * is `@agentconnect.md/activation-policy`'s `selectTurnTargets` — the
 * roster/standing-mention semantics are package-owned policy alongside the
 * platform ladder, and this module is the thin adapter supplying the relay's
 * context (the verified roster and the turn's mentions/targets). Re-exported
 * here so existing consumers (the activation parity suite exercises this
 * exact production seam) keep their import path, mirroring the daemon's
 * `router/routing-table.ts` adapter.
 */
export { selectTurnTargets }

export class RelayBrowserConnection implements ChatSink {
  private closed = false
  private readonly remoteMcp?: Readonly<WebchatRemoteMcpEntitlement>
  private readonly byAgentId = new Map<string, BrowserConnParticipant>()
  /** Canonical post timestamps for user turns — minted ONCE here (the origin) and
   *  strictly increasing per conversation so every participant copy of a turn
   *  shares one transcript ts (webchat-multi-agents.md §5.1). */
  private lastPostAt = 0

  constructor(
    private readonly transport: ServerTransport,
    private readonly deps: RelayBrowserConnDeps
  ) {
    // Snapshot the verified server-side verdict once. Its fields are primitives, so a
    // frozen shallow copy is a complete immutable binding for this browser transport.
    this.remoteMcp = deps.remoteMcp
      ? Object.freeze({
          authorityId: deps.remoteMcp.authorityId,
          authorityGeneration: deps.remoteMcp.authorityGeneration,
          expiresAt: deps.remoteMcp.expiresAt
        })
      : undefined
    for (const p of deps.participants) this.byAgentId.set(p.agentId, p)
    // The primary is always addressable even on a pre-roster CP verdict.
    if (!this.byAgentId.has(deps.agentId)) {
      this.byAgentId.set(deps.agentId, { agentId: deps.agentId, primary: true })
    }
  }

  start(): void {
    this.deps.register(this.deps.chatId, this)
    this.deps.log.info(
      `webchat: browser joined conversation ${this.deps.chatId} (${this.byAgentId.size} participant(s)` +
        `${this.deps.targetSessionId ? `, continuing session ${this.deps.targetSessionId}` : ''})`
    )
    // The client correlates its session on this frame (matches the old gateway).
    // `participants` is the verified roster, primary first.
    this.send({
      type: 'ready',
      conversationId: this.deps.chatId,
      agentId: this.deps.agentId,
      participants: this.deps.participants.map((p) => ({
        agentId: p.agentId,
        ...(p.primary ? { primary: true } : {})
      }))
    })
    this.transport.onMessage((t) => this.onText(t))
    this.transport.onClose((code, reason) => this.onClose(code, reason))
  }

  /** A reply chunk arrived from the daemon (routed here by chatId) → forward to the browser. */
  onChat(chat: RdChat): void {
    if (chat.event.kind === 'output') this.send({ type: 'output', output: chat.event.output })
    else this.send({ type: 'done', done: chat.event.done })
  }

  /**
   * A participant's completed reply post (`rd/webchat-post`, routed here by
   * conversationId): forward the canonical record to the browser. Peer-daemon
   * context fan-out happens at the router level from the cached roster — NOT
   * here — so it survives the browser closing mid-turn
   * (webchat-multi-agents.md §5.2).
   */
  onPost(p: RdWebchatPost): void {
    if (p.conversationId !== this.deps.chatId) return
    this.send({ type: 'post', post: p.post, ...(p.initiator ? { initiator: p.initiator } : {}) })
  }

  private onText(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.send({ type: 'error', message: 'invalid frame' })
      return
    }
    const op = parseBrowserFrame(parsed, this.deps.user, this.deps.userId, this.deps.userPicture)
    if (!op) {
      this.send({ type: 'error', message: 'unrecognized frame' })
      return
    }
    void this.sendOp(op)
  }

  private async sendOp(parsed: ParsedBrowserOp): Promise<void> {
    const op = parsed.op
    if (op.op === 'turn') return this.sendTurn(op, parsed.targets)
    if (op.op === 'cancel' && op.agentId === undefined && this.byAgentId.size > 1) {
      // Conversation-wide cancel fans to every participant's daemon.
      for (const p of this.byAgentId.values()) void this.sendToParticipant(p.agentId, { op: 'cancel' }, 'cancel')
      return
    }
    // Single-daemon ops: resume/attach/cancel/elicitation_choice go to the named
    // participant, everything else (set_*) to the primary — multi-agent conversations
    // expose no runtime override (webchat-multi-agents.md §9.3), so set_* is single-agent.
    const targetAgent =
      op.op === 'resume' || op.op === 'attach' || op.op === 'cancel' || op.op === 'elicitation_choice'
        ? (op.agentId ?? this.deps.agentId)
        : this.deps.agentId
    await this.sendToParticipant(targetAgent, op, op.op)
  }

  /** Fan one user turn out to its targeted participants + context to the rest. */
  private async sendTurn(op: Extract<RelayWebchatOp, { op: 'turn' }>, requestedTargets?: string[]): Promise<void> {
    const { valid, invalid } = selectTurnTargets([...this.byAgentId.keys()], {
      ...(op.mentions !== undefined ? { mentions: op.mentions } : {}),
      ...(requestedTargets !== undefined ? { requestedTargets } : {})
    })
    const turnId = op.turnId ?? randomUUID()
    this.lastPostAt = Math.max(Date.now(), this.lastPostAt + 1)
    const post = { postId: randomUUID(), at: this.lastPostAt }
    for (const t of invalid) {
      this.send({ type: 'ack', ack: { accepted: false, turnId, agentId: t, reason: 'not_participant' } })
    }
    if (valid.length === 0) return

    const turn: RelayWebchatOp = { ...op, turnId, post }
    await Promise.all(valid.map((agentId) => this.sendToParticipant(agentId, turn, 'turn')))

    // Context copies for the non-targeted participants, so the whole roster sees
    // the conversation at its next activation. Fire-and-forget with postId dedup.
    const contextPost: WebchatPost = {
      postId: post.postId,
      conversationId: this.deps.chatId,
      author: { kind: 'user', user: this.deps.user, ...(this.deps.userId ? { userId: this.deps.userId } : {}) },
      text: op.text,
      at: post.at,
      ...(op.attachments?.length ? { attachments: op.attachments } : {})
    }
    for (const p of this.byAgentId.values()) {
      if (valid.includes(p.agentId) || !p.daemonId) continue
      const conn = this.deps.daemonConnFor(p.daemonId)
      if (!conn) continue
      void conn
        .sendMsg({
          source: 'webchat',
          agentId: p.agentId,
          sessionKey: this.deps.chatId,
          msgId: randomUUID(),
          chatId: this.deps.chatId,
          ...(this.deps.targetSessionId ? { targetSessionId: this.deps.targetSessionId } : {}),
          payload: { op: 'context', post: contextPost }
        })
        .catch((error) => {
          this.deps.log.warn(`relay: webchat context fan-out failed ${deliveryFailureDiagnostic(error)}`)
        })
    }
  }

  /** Send one op to one participant's daemon, translating the verdict for the browser. */
  private async sendToParticipant(agentId: string, op: RelayWebchatOp, kind: RelayWebchatOp['op']): Promise<void> {
    const participant = this.byAgentId.get(agentId)
    let daemonId = participant?.daemonId
    let daemon = daemonId ? this.deps.daemonConnFor(daemonId) : undefined
    if (!daemon) {
      // A gone recorded member is not a gone agent: a rollout replaced the daemon under the
      // conversation. Any live same-org member claims the duty on receipt or names the holder.
      const fallback = this.deps.rendezvousDaemonConn?.()
      if (fallback) {
        this.deps.log.info(`webchat: recorded daemon for ${agentId} is gone — rendezvousing via ${fallback.daemonId}`)
        daemonId = fallback.daemonId
        daemon = fallback.conn
      }
    }
    if (!daemon) {
      // The attach probe is background discovery — always a quiet per-agent
      // refusal, never the legacy error frame.
      if (kind === 'attach') {
        this.send({ type: 'attached', ack: { accepted: false, agentId, reason: 'no_agent' } })
        return
      }
      // A single-participant conversation keeps the legacy error frame; a
      // multi-agent one degrades per agent so the other targets still run.
      if (this.byAgentId.size === 1) {
        this.send({ type: 'error', message: 'agent daemon offline' })
      } else if (kind === 'turn') {
        this.send({
          type: 'ack',
          ack: {
            accepted: false,
            ...(op.op === 'turn' && op.turnId ? { turnId: op.turnId } : {}),
            agentId,
            reason: 'no_agent'
          }
        })
      } else if (kind === 'resume') {
        this.deps.log.warn(`webchat: resume for ${agentId} in ${this.deps.chatId} has no live daemon to reach`)
        this.send({ type: 'resumed', ack: { accepted: false, agentId, reason: 'no_agent' } })
      }
      return
    }
    // Fail closed on an older daemon that cannot parse the probe op — refusing
    // here degrades to the pre-attach behavior (the reload recovers at turn end).
    if (kind === 'attach' && !daemon.supports(RD_WEBCHAT_ATTACH_V1)) {
      this.send({ type: 'attached', ack: { accepted: false, agentId, reason: 'unsupported' } })
      return
    }
    const rdMsg: RdMsgWebchat = {
      source: 'webchat',
      agentId,
      sessionKey: this.deps.chatId,
      msgId: randomUUID(),
      chatId: this.deps.chatId,
      ...(this.deps.targetSessionId ? { targetSessionId: this.deps.targetSessionId } : {}),
      ...(this.remoteMcp ? { remoteMcp: this.remoteMcp } : {}),
      payload: op
    }
    try {
      let ack = await daemon.sendMsg(rdMsg)
      // Activation rendezvous (design §4.4): the participant's recorded daemon
      // may no longer hold its duty. Re-send the SAME msgId to the named holder
      // once — its own dedup covers a double delivery, and a second refusal
      // falls through to the browser as an ordinary rejection.
      if (!ack.accepted && ack.reason === RD_ACK_NOT_HOLDER && ack.holderDaemonId) {
        const holder = this.deps.daemonConnFor(ack.holderDaemonId)
        if (holder) {
          this.deps.log.info(`webchat: re-routing ${agentId} to duty holder ${ack.holderDaemonId}`)
          daemonId = ack.holderDaemonId
          ack = await holder.sendMsg(rdMsg)
        }
      }
      // The member that answered the verdict is serving the agent now — heal the roster entry
      // so the next op goes direct instead of repeating the rendezvous or the holder hop.
      if (participant && daemonId && ack.reason !== RD_ACK_NOT_HOLDER && participant.daemonId !== daemonId) {
        participant.daemonId = daemonId
      }
      const browserAck = {
        accepted: ack.accepted,
        ...(ack.turnId ? { turnId: ack.turnId } : {}),
        agentId,
        ...(ack.reason ? { reason: ack.reason } : {}),
        ...(ack.detail ? { detail: ack.detail } : {}),
        ...(ack.generation !== undefined ? { generation: ack.generation } : {})
      }
      // A refusal is the whole story of a stream that "never came back" — name it, and who
      // refused. Attach misses are the normal idle answer, not worth a line.
      if (!ack.accepted && (op.op === 'turn' || op.op === 'resume')) {
        this.deps.log.info(
          `webchat: ${op.op} ${op.turnId ?? '?'} for ${agentId} in ${this.deps.chatId} refused by ${daemonId}: ${ack.reason ?? 'unspecified'}`
        )
      }
      if (kind === 'turn') {
        this.send({ type: 'ack', ack: browserAck })
      } else if (kind === 'resume') {
        this.send({ type: 'resumed', ack: browserAck })
      } else if (kind === 'attach') {
        this.send({ type: 'attached', ack: browserAck })
      }
    } catch (error) {
      // Lower layers may include the outbound frame in an error. Do not let the opaque
      // remote-MCP entitlement become log content.
      this.deps.log.warn(`relay: webchat op delivery failed ${deliveryFailureDiagnostic(error)}`)
      if (kind === 'attach') {
        this.send({ type: 'attached', ack: { accepted: false, agentId, reason: 'no_agent' } })
      } else if (this.byAgentId.size > 1 && kind === 'turn') {
        this.send({
          type: 'ack',
          ack: {
            accepted: false,
            ...(op.op === 'turn' && op.turnId ? { turnId: op.turnId } : {}),
            agentId,
            reason: 'no_agent'
          }
        })
      } else {
        this.send({ type: 'error', message: 'delivery failed' })
      }
    }
  }

  private send(obj: unknown): void {
    if (this.closed) return
    this.transport.send(JSON.stringify(obj))
  }

  private onClose(code?: number, reason?: string): void {
    this.closed = true
    // The close code is the one fact a "my stream never came back" report needs and nothing else records.
    this.deps.log.info(
      `webchat: browser left conversation ${this.deps.chatId} (close ${code ?? '?'}${reason ? ` ${reason}` : ''})`
    )
    this.deps.unregister(this.deps.chatId, this)
    // Best-effort: tell every participant's daemon that the browser conversation closed.
    for (const p of this.byAgentId.values()) {
      if (!p.daemonId) continue
      const daemon = this.deps.daemonConnFor(p.daemonId)
      if (daemon) void this.forwardClose(daemon, p.agentId)
    }
  }

  private async forwardClose(daemon: RelayDaemonConnection, agentId: string): Promise<void> {
    try {
      await daemon.sendMsg({
        source: 'webchat',
        agentId,
        sessionKey: this.deps.chatId,
        msgId: randomUUID(),
        chatId: this.deps.chatId,
        ...(this.deps.targetSessionId ? { targetSessionId: this.deps.targetSessionId } : {}),
        ...(this.remoteMcp ? { remoteMcp: this.remoteMcp } : {}),
        payload: { op: 'close' }
      })
    } catch {
      // daemon gone / racing — the daemon reaps idle webchat sessions anyway.
    }
  }
}
