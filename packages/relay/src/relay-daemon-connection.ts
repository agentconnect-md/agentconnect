/**
 * `RelayDaemonConnection` — the per-socket FSM for a daemon dialing the relay over
 * the `rd/*` wire (shared-bot-relay.md §7.2 / §9). The accept-side mirror of the
 * daemon's `RelayClient`.
 *
 * States: AUTHENTICATING (only `rd/hello`) → READY. On hello the relay holds no
 * database, so it DELEGATES the daemon's API key to the CP via `rc/verify` and
 * caches the verdict for the connection's lifetime; on success it echoes its own
 * `relayId` so the daemon can confirm it reached the roster entry it dialed.
 *
 * Once READY the relay bridges browser webchat over this socket (§7.2, PR 3): it
 * SENDS `rd/msg` (a browser op, awaiting the `rd/ack` verdict) and RECEIVES `rd/chat`
 * (the agent's reply stream), which it routes back to the browser by `chatId`.
 *
 * The presented API key is secret material — NEVER logged.
 */
import {
  buildRelayDaemonFrame,
  decodeRelayDaemonFrame,
  type RelayDaemonFrame,
  type RdHello,
  type RdMsg,
  type RdAck,
  type RdAgentMsg,
  type RdAgentMsgFwd,
  type RdAgentMsgAck,
  type RdChat,
  type RdWebchatPost,
  type RcVerifyResult,
  type ErrorCode
} from '@agentconnect.md/protocol'
import { ReqRep, WireError, type Clock, type ServerTransport } from '@agentconnect.md/connection'
import type { Logger } from './log.js'

type State = 'AUTHENTICATING' | 'READY' | 'CLOSED'

// App-defined close codes (mirror the daemon↔CP convention):
const CLOSE_AUTH_FAILED = 4401 // definitively-invalid credential → daemon stops dialing THIS relay
const CLOSE_TRY_LATER = 1013 // relay not ready / transient verify error → daemon backs off + retries
const ACK_TIMEOUT_MS = 5000

export interface RelayDaemonConnDeps {
  /** Delegate a credential check to the CP (`RelayCpClient.verify`). Throws when the
   *  relay↔CP link is not READY or the CP answers an error → treat as transient. */
  verify: (kind: 'daemon-key' | 'daemon-token', credential: string, daemonId?: string) => Promise<RcVerifyResult>
  /** This relay's CP-assigned id (undefined until it has registered with the CP). */
  relayId: () => string | undefined
  clock: Clock
  /** Called once a daemon is authenticated — bind it for routing + `rc/daemon-revoke` teardown. */
  onReady: (daemonId: string, conn: RelayDaemonConnection) => void
  /** Called on close — unbind. */
  onClosed: (daemonId: string, conn: RelayDaemonConnection) => void
  /** Route an inbound `rd/chat` (agent reply chunk) back to the browser for its `chatId`. */
  onChat: (chat: RdChat) => void
  /** Route an inbound `rd/webchat-post` (a participant's completed reply post) to the
   *  conversation's browser connection, which renders it and fans the context copies
   *  to the other participants' daemons (webchat-multi-agents.md §5.2). The socket's
   *  AUTHENTICATED `daemonId` is passed in — like `onAgentMsg`, and for the same
   *  reason: the frame's authorship fields are a daemon-supplied claim, and since a
   *  context copy can now carry the activation-capable depth stamp (§5.2a), the
   *  fan-out must first bind that claim to the daemon that actually sent the frame. */
  onWebchatPost: (fromDaemonId: string, post: RdWebchatPost) => void
  /** Route an inbound cross-daemon `rd/agentmsg` (agent-collaboration §2.3/§6.2). The
   *  socket's AUTHENTICATED `daemonId` is passed in (NOT the frame's untrusted
   *  `claimedFromAgentId`) — the router binds the request to it, validates/authorizes
   *  via the collaboration snapshot, and forwards to the target daemon. Resolves with
   *  the typed admission verdict to ack back to the source. */
  onAgentMsg: (fromDaemonId: string, msg: RdAgentMsg) => Promise<RdAgentMsgAck>
  log: Logger
}

export class RelayDaemonConnection {
  state: State = 'AUTHENTICATING'
  daemonId = ''
  /** Which verified credential authenticated this socket. `daemon-token` is a TokenReviewed
   *  install-wide pool identity — duty-governed, so it can rendezvous a webchat trigger.
   *  `daemon-key` is an org-scoped standalone daemon that would answer `no_agent` instead. */
  credentialKind?: 'daemon-key' | 'daemon-token'

  /** Optional behaviors this daemon advertised at hello (§8.4). Populated only after a
   *  successful handshake, so a caller that reads it on a non-READY socket correctly
   *  sees nothing. An older daemon sends no `capabilities` at all, which is why the
   *  default is EMPTY rather than "assume supported" — {@link supports} then fails
   *  closed and the relay refuses the delivery instead of degrading it. */
  private capabilities: ReadonlySet<string> = new Set()

  private readonly correlator: ReqRep<RelayDaemonFrame>

  constructor(
    private readonly transport: ServerTransport,
    private readonly deps: RelayDaemonConnDeps
  ) {
    this.correlator = new ReqRep<RelayDaemonFrame>(deps.clock, ACK_TIMEOUT_MS)
  }

  start(): void {
    this.transport.onMessage((t) => void this.onText(t))
    this.transport.onClose(() => this.onClose())
  }

  /** Did this daemon advertise `capability` at hello? Fails closed for an older daemon
   *  that advertised nothing — the caller must then refuse a delivery that needs it
   *  (§8.4), never forward it and hope. */
  supports(capability: string): boolean {
    return this.capabilities.has(capability)
  }

  /**
   * Send one inbound item to the daemon (`rd/msg` REQ) and resolve with the
   * `rd/ack` verdict — a browser webchat op, a shared-bot `im` message, or a hook
   * fire. Rejects (retryable {@link WireError}) if the socket isn't READY.
   */
  async sendMsg(payload: RdMsg): Promise<RdAck> {
    if (this.state !== 'READY') throw new WireError('INTERNAL', `rd link not ready (${this.state})`, true)
    const frame = buildRelayDaemonFrame('rd/msg', payload)
    let bytes = 0
    let rep: RelayDaemonFrame
    try {
      rep = await this.correlator.request(frame, (e) => {
        bytes = Buffer.byteLength(e)
        this.transport.send(e)
      })
    } catch (err) {
      // The daemon drops an undecodable or oversized frame without a reply, so the size is the one
      // fact the sender can add to a timeout.
      if (err instanceof WireError) throw new WireError(err.code, `${err.message} (${bytes} bytes)`, err.retryable)
      throw err
    }
    if (rep.type !== 'rd/ack') throw new WireError('INTERNAL', `expected rd/ack, got ${rep.type}`, false)
    return rep.payload
  }

  /**
   * Forward a validated cross-daemon agent-call to the TARGET's owning daemon
   * (`rd/agentmsg/fwd` REQ) and resolve with its admission verdict — mirrors
   * {@link sendMsg}, but the payload carries the relay's minted TRUSTED caller claim
   * (agent-collaboration §2.5/§6.4). The `rd/agentmsg/ack` is returned after the target
   * daemon durably admits/enqueues the turn (P4-gate), NOT after the model turn.
   */
  async forwardAgentMsg(payload: RdAgentMsgFwd): Promise<RdAgentMsgAck> {
    if (this.state !== 'READY') throw new WireError('INTERNAL', `rd link not ready (${this.state})`, true)
    const frame = buildRelayDaemonFrame('rd/agentmsg/fwd', payload)
    const rep = await this.correlator.request(frame, (e) => this.transport.send(e))
    if (rep.type !== 'rd/agentmsg/ack') {
      throw new WireError('INTERNAL', `expected rd/agentmsg/ack, got ${rep.type}`, false)
    }
    return rep.payload
  }

  private async onText(text: string): Promise<void> {
    const decoded = decodeRelayDaemonFrame(text)
    if (!decoded.ok) {
      const code = this.decodeErrorCode(decoded.msg)
      this.sendError(decoded.id, code, decoded.msg)
      if (decoded.corr) {
        this.correlator.reject(decoded.corr, new WireError(code, `invalid correlated reply: ${decoded.msg}`, false))
      }
      return
    }
    const frame = decoded.frame
    // A correlated rd/ack settles a relay-issued rd/msg.
    if (frame.corr && this.correlator.settle(frame)) return
    if (!this.isLegalInState(frame.type)) {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`)
      return
    }
    try {
      switch (frame.type) {
        case 'rd/hello':
          await this.handleHello(frame, frame.payload)
          return
        case 'rd/chat':
          // Agent reply chunk → route to the browser owning this chatId.
          this.deps.onChat(frame.payload)
          return
        case 'rd/webchat-post':
          // Completed reply post → browser render + context fan-out. Bound to the
          // AUTHENTICATED daemonId (never the frame's own authorship claim).
          this.deps.onWebchatPost(this.daemonId, frame.payload)
          return
        case 'rd/agentmsg': {
          // Cross-daemon agent-call REQ (§2.3/§6.2). Bind to the AUTHENTICATED daemonId —
          // NEVER the frame's untrusted claimedFromAgentId. The router validates +
          // authorizes + forwards, then we ack the typed verdict back to the source.
          const msg = frame.payload
          void this.deps
            .onAgentMsg(this.daemonId, msg)
            .then((ack) => this.replyAgentAck(frame, ack))
            .catch((err) => {
              this.deps.log.warn(`relay: rd/agentmsg routing failed: ${(err as Error).message}`)
              this.replyAgentAck(frame, { deliveryId: msg.deliveryId, delivered: false, reason: 'offline' })
            })
          return
        }
        default:
          this.sendError(frame.id, 'PROTOCOL_STATE', `unsupported: ${frame.type}`)
      }
    } catch (err) {
      this.deps.log.warn(`relay: rd connection handler error: ${(err as Error).message}`)
      if (this.state !== 'CLOSED') this.close(1011, 'SERVER_INTERNAL')
    }
  }

  private isLegalInState(type: string): boolean {
    switch (this.state) {
      case 'AUTHENTICATING':
        return type === 'rd/hello'
      case 'READY':
        // rd/ack + rd/agentmsg/ack settle above
        return type === 'rd/chat' || type === 'rd/webchat-post' || type === 'rd/agentmsg'
      default:
        return false
    }
  }

  private async handleHello(frame: RelayDaemonFrame, hello: RdHello): Promise<void> {
    const relayId = this.deps.relayId()
    if (!relayId) {
      // Not registered with the CP yet ⇒ can't verify or echo an id. Ask the daemon to retry.
      this.sendError(frame.id, 'PROTOCOL_STATE', 'relay not ready', true)
      this.close(CLOSE_TRY_LATER, 'relay not registered')
      return
    }

    // The projected token wins where a daemon has one: an in-cluster daemon carries no key
    // at all, and a stale key must never pick a different identity than the CP socket did.
    const presented: { kind: 'daemon-key' | 'daemon-token'; credential: string } | undefined = hello.serviceAccountToken
      ? { kind: 'daemon-token', credential: hello.serviceAccountToken }
      : hello.apiKey
        ? { kind: 'daemon-key', credential: hello.apiKey }
        : undefined
    if (!presented) {
      this.sendError(frame.id, 'AUTH_FAILED', 'no daemon credential presented')
      this.close(CLOSE_AUTH_FAILED, 'auth failed')
      return
    }
    let result: RcVerifyResult
    try {
      // CP verifies the untrusted echoed id against the reviewed pool member Pod UID.
      result = await this.deps.verify(presented.kind, presented.credential, hello.daemonId)
    } catch {
      // Link not READY / CP error → transient; the daemon backs off and retries.
      this.sendError(frame.id, 'INTERNAL', 'verify unavailable', true)
      this.close(CLOSE_TRY_LATER, 'verify unavailable')
      return
    }
    // The socket may have closed during the verify RTT. onClose ran with daemonId
    // still '' (so it skipped onClosed) — if we now proceeded to onReady we would
    // register a DEAD connection in the server's byDaemon map that never gets
    // removed. Bail: no reply, no onReady.
    if (this.state === 'CLOSED') return

    if (!result.ok || !result.daemonId) {
      // Definitively invalid (revoked / expired / unknown / not a daemon key).
      this.sendError(frame.id, 'AUTH_FAILED', 'invalid daemon credential')
      this.close(CLOSE_AUTH_FAILED, 'auth failed')
      return
    }
    if (result.daemonId !== hello.daemonId) {
      // The daemon claimed an id its key does not resolve to — trust the CP's id.
      this.sendError(frame.id, 'AUTH_FAILED', 'daemonId mismatch')
      this.close(CLOSE_AUTH_FAILED, 'daemonId mismatch')
      return
    }

    this.daemonId = result.daemonId
    this.credentialKind = presented.kind
    this.capabilities = new Set(hello.capabilities ?? [])
    this.state = 'READY'
    this.reply(frame, 'rd/hello/ok', { relayId })
    this.deps.onReady(this.daemonId, this)
  }

  private reply(req: RelayDaemonFrame, type: 'rd/hello/ok', payload: { relayId: string }): void {
    this.transport.send(JSON.stringify(buildRelayDaemonFrame(type, payload, { corr: req.id })))
  }

  /** Ack an inbound `rd/agentmsg` (corr = the source's REQ id) with the typed verdict. */
  private replyAgentAck(req: RelayDaemonFrame, ack: RdAgentMsgAck): void {
    if (this.state === 'CLOSED') return
    this.transport.send(JSON.stringify(buildRelayDaemonFrame('rd/agentmsg/ack', ack, { corr: req.id })))
  }

  private sendError(corr: string, code: ErrorCode, message: string, retryable = false): void {
    this.transport.send(JSON.stringify(buildRelayDaemonFrame('error', { code, message, retryable }, { corr })))
  }

  private decodeErrorCode(msg: string): ErrorCode {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  close(code: number, reason: string): void {
    this.state = 'CLOSED'
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    this.transport.close(code, reason)
  }

  private onClose(): void {
    this.state = 'CLOSED'
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (this.daemonId) this.deps.onClosed(this.daemonId, this)
  }
}
