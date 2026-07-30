/**
 * `RelayBrowserConnection` — the per-socket actor for a browser playground webchat
 * session (shared-bot-relay.md §7.2 / §10). One socket == one conversation.
 *
 * It speaks the browser-facing, type-tagged webchat envelope. The browser sends
 * `{text, turnId, attachments?, runtime?}` (a turn with at most one bounded inline image) or
 * `{type:'resume'|'set_model'|'set_effort'|'set_permission_mode'|'set_fast'|'cancel'}`,
 * and the relay sends `{type:'ready'|'output'|'done'|'ack'|'resumed'|'error'}`. Internally each inbound
 * op becomes an `rd/msg(webchat)` bridged onto the target daemon's rd/* socket, and
 * each `rd/chat` chunk the daemon streams back is translated to `{type:'output'|'done'}`.
 *
 * The daemon target is resolved once at connect (the token's current placement); if the
 * daemon has no live rd/* socket on THIS relay the op fails with an error frame.
 */
import { randomUUID } from 'node:crypto'
import {
  ErrorCode,
  RelayWebchatOp,
  type RdChat,
  type RdMsgWebchat,
  type WebchatMcpDelegationReference
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

/**
 * Preserve actionable delivery telemetry without ever copying error messages or
 * details: both may contain the exact rd/msg, including browser content and the
 * opaque delegation reference.
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

export interface RelayBrowserConnDeps {
  /** The conversation id (== chatId == sessionKey); fresh or resumed. */
  chatId: string
  agentId: string
  /** Display handle for the transcript author line (from the verified token). */
  user: string
  /** Opaque MCP authority reference from the verified CP result, never browser input. */
  delegation?: WebchatMcpDelegationReference
  /** Resolve a live rd/* connection to the target daemon (may be absent if it dropped). */
  daemonConn: () => RelayDaemonConnection | undefined
  register: (chatId: string, sink: ChatSink) => void
  unregister: (chatId: string, sink: ChatSink) => void
  log: Logger
}

/** Parse a browser envelope into a webchat op, or null if unrecognized. */
export function parseBrowserFrame(msg: unknown, user: string): RelayWebchatOp | null {
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  // A bare message envelope (no type) or {type:'message', ...} is a turn.
  if ((m.type === undefined || m.type === 'message') && (typeof m.text === 'string' || Array.isArray(m.attachments))) {
    const parsed = RelayWebchatOp.safeParse({
      op: 'turn',
      text: typeof m.text === 'string' ? m.text : '',
      user,
      ...(m.turnId !== undefined ? { turnId: m.turnId } : {}),
      ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
      ...(m.runtime !== undefined ? { runtime: m.runtime } : {})
    })
    return parsed.success && parsed.data.op === 'turn' ? parsed.data : null
  }
  switch (m.type) {
    case 'resume':
      return Number.isInteger(m.afterIndex) &&
        (m.afterIndex as number) >= -1 &&
        typeof m.turnId === 'string' &&
        Number.isSafeInteger(m.generation) &&
        (m.generation as number) >= 1
        ? {
            op: 'resume',
            turnId: m.turnId,
            generation: m.generation as number,
            afterIndex: m.afterIndex as number
          }
        : null
    case 'set_model':
      return typeof m.model === 'string' ? { op: 'set_model', model: m.model } : null
    case 'set_effort':
      return typeof m.effort === 'string' ? { op: 'set_effort', effort: m.effort } : null
    case 'set_permission_mode':
      return typeof m.permissionMode === 'string'
        ? { op: 'set_permission_mode', permissionMode: m.permissionMode }
        : null
    case 'set_fast':
      return typeof m.fastMode === 'boolean' ? { op: 'set_fast', fastMode: m.fastMode } : null
    case 'cancel':
      return { op: 'cancel' }
    default:
      return null
  }
}

export class RelayBrowserConnection implements ChatSink {
  private closed = false
  private readonly delegation?: Readonly<WebchatMcpDelegationReference>

  constructor(
    private readonly transport: ServerTransport,
    private readonly deps: RelayBrowserConnDeps
  ) {
    // Snapshot the verified server-side verdict once. Its fields are primitives, so a
    // frozen shallow copy is a complete immutable binding for this browser transport.
    this.delegation = deps.delegation
      ? Object.freeze({
          id: deps.delegation.id,
          generation: deps.delegation.generation,
          expiresAt: deps.delegation.expiresAt
        })
      : undefined
  }

  start(): void {
    this.deps.register(this.deps.chatId, this)
    // The client correlates its session on this frame (matches the old gateway).
    this.send({ type: 'ready', conversationId: this.deps.chatId, agentId: this.deps.agentId })
    this.transport.onMessage((t) => this.onText(t))
    this.transport.onClose(() => this.onClose())
  }

  /** A reply chunk arrived from the daemon (routed here by chatId) → forward to the browser. */
  onChat(chat: RdChat): void {
    if (chat.event.kind === 'output') this.send({ type: 'output', output: chat.event.output })
    else this.send({ type: 'done', done: chat.event.done })
  }

  private onText(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.send({ type: 'error', message: 'invalid frame' })
      return
    }
    const op = parseBrowserFrame(parsed, this.deps.user)
    if (!op) {
      this.send({ type: 'error', message: 'unrecognized frame' })
      return
    }
    void this.sendOp(op)
  }

  private async sendOp(op: RelayWebchatOp): Promise<void> {
    const daemon = this.deps.daemonConn()
    if (!daemon) {
      this.send({ type: 'error', message: 'agent daemon offline' })
      return
    }
    const rdMsg: RdMsgWebchat = {
      source: 'webchat',
      agentId: this.deps.agentId,
      sessionKey: this.deps.chatId,
      msgId: randomUUID(),
      chatId: this.deps.chatId,
      ...(this.delegation ? { delegation: this.delegation } : {}),
      payload: op
    }
    try {
      const ack = await daemon.sendMsg(rdMsg)
      const browserAck = {
        accepted: ack.accepted,
        ...(ack.turnId ? { turnId: ack.turnId } : {}),
        ...(ack.reason ? { reason: ack.reason } : {})
      }
      if (op.op === 'turn') {
        this.send({ type: 'ack', ack: browserAck })
      } else if (op.op === 'resume') {
        this.send({ type: 'resumed', ack: browserAck })
      }
    } catch (error) {
      // Lower layers may include the outbound frame in an error. Do not let the opaque
      // delegation reference become log content.
      this.deps.log.warn(`relay: webchat op delivery failed ${deliveryFailureDiagnostic(error)}`)
      this.send({ type: 'error', message: 'delivery failed' })
    }
  }

  private send(obj: unknown): void {
    if (this.closed) return
    this.transport.send(JSON.stringify(obj))
  }

  private onClose(): void {
    this.closed = true
    this.deps.unregister(this.deps.chatId, this)
    // Best-effort: tell the daemon that the browser conversation closed.
    const daemon = this.deps.daemonConn()
    if (daemon) void this.forwardClose(daemon)
  }

  private async forwardClose(daemon: RelayDaemonConnection): Promise<void> {
    try {
      await daemon.sendMsg({
        source: 'webchat',
        agentId: this.deps.agentId,
        sessionKey: this.deps.chatId,
        msgId: randomUUID(),
        chatId: this.deps.chatId,
        ...(this.delegation ? { delegation: this.delegation } : {}),
        payload: { op: 'close' }
      })
    } catch {
      // daemon gone / racing — the daemon reaps idle webchat sessions anyway.
    }
  }
}
