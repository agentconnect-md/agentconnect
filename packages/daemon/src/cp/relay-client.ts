/**
 * `RelayClient` — the daemon's dial-out client to ONE relay over the `rd/*` wire
 * (shared-bot-relay.md §11 / §7.2). The daemon holds one to every relay in its
 * roster; {@link RelayManager} set-converges them.
 *
 * Milestone A2 establishes the connection: dial → `rd/hello` (presenting the
 * daemon's existing CP API key, which the relay delegates to the CP via
 * `rc/verify`) → `rd/hello/ok`, whose echoed `relayId` MUST match the roster entry
 * dialed (a mismatch = a pool LB in front of the daemon dial path → close +
 * backoff, never continue on the wrong instance, §5). Content (`rd/msg`) flows in
 * PR 3. Built on the shared `@agentconnect.md/connection` primitives — the first
 * daemon consumer of that package.
 */
import {
  buildRelayDaemonFrame,
  decodeRelayDaemonFrame,
  RD_HEADLESS_AGENT_DELIVERY_V1,
  RD_AGENT_IMPLICIT_ROUTING_V1,
  RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
  type RelayDaemonFrame,
  type RdHelloOk,
  type RdMsg,
  type RdAck,
  type RdAgentMsg,
  type RdAgentMsgFwd,
  type RdAgentMsgAck,
  type RdChatEvent,
  type RdWebchatPost,
  GITLAB_COM_V1_FEATURE
} from '@agentconnect.md/protocol'
import { Backoff, ReqRep, WireError, type Clock, type TimerHandle, type Transport } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'

const ACK_TIMEOUT_MS = 5000
/** rd/hello definitively rejected (bad/revoked key, daemonId mismatch) → stop dialing THIS relay. */
const CLOSE_AUTH_FAILED = 4401

/**
 * Optional `rd/*` behaviors THIS daemon build supports, advertised on every
 * `rd/hello` (send-message-routing-rework.md §8.4). A relay refuses a delivery that
 * needs a capability the daemon did not list, rather than degrading it — so a
 * capability belongs here only once the corresponding behavior actually ships.
 */
const DAEMON_RD_CAPABILITIES: readonly string[] = [
  RD_HEADLESS_AGENT_DELIVERY_V1,
  RD_AGENT_IMPLICIT_ROUTING_V1,
  RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
  // The relay gates gitlab rd/msg dispatch on this capability.
  GITLAB_COM_V1_FEATURE
]

export type RelayClientState = 'CONNECTING' | 'HELLO' | 'READY' | 'CLOSED' | 'DEGRADED'

/** The per-client deps, shared across every relay a daemon dials. */
export interface RelayClientDeps {
  /** The daemon's existing CP API key (presented on `rd/hello`); empty when it has none. */
  apiKey: () => string
  /** This pod's projected ServiceAccount token, re-read per connect because the kubelet
   *  rotates it. Present ⇒ it is the credential and the API key is not sent. */
  clusterIdentityToken?: () => string | undefined
  /** The daemon's adopted id (undefined until `auth/ok`; `rd/hello.daemonId` needs it). */
  daemonId: () => string | undefined
  clock: Clock
  /** Dial factory — prod passes `ClientTransport.dial(url, { subprotocol, path })`; tests fake it. */
  connect: (url: string) => Promise<Transport>
  log: Logger
  /** Backoff jitter in [0,1); defaults to Math.random. Injected as `() => 0` in tests. */
  jitter?: () => number
  /**
   * Handle one inbound item from the relay (`rd/msg` — a webchat op or a hook
   * fire): dispatch it (explicit-agent, same engine as the retired CP path) and
   * return the `rd/ack` verdict. Hook admission may be asynchronous because
   * its ACK is a durability barrier; webchat/IM handlers remain synchronous.
   * The `chat` callback streams a
   * webchat reply back over THIS relay's socket (`rd/chat`); for a hook fire it
   * is a no-op — the turn's outcome goes to the CP as `hook/report` instead.
   * The optional `post` callback (webchat only) sends a completed reply as a
   * canonical conversation post (`rd/webchat-post`) over the same socket so the
   * relay can fan it to the other participants' daemons as context.
   */
  onRelayMsg: (
    msg: RdMsg,
    chat: (event: RdChatEvent) => void,
    post?: (p: RdWebchatPost) => void
  ) => RdAck | Promise<RdAck>
  /**
   * Handle a forwarded cross-daemon agent-call (`rd/agentmsg/fwd`, agent-collaboration
   * P2): the relay validated the caller and minted a TRUSTED claim. The daemon
   * terminal-verifies + dispatches, returning the typed admission verdict (ACK/NAK on
   * durable admission, NOT the model turn — §6.4). Async so the terminal verify can
   * consult local state.
   */
  onRelayAgentMsg: (msg: RdAgentMsgFwd) => Promise<RdAgentMsgAck>
}

export class RelayClient {
  state: RelayClientState = 'CLOSED'

  private transport?: Transport
  private readonly correlator: ReqRep<RelayDaemonFrame>
  private readonly backoff: Backoff
  private stopped = false
  private fatal = false // 4401 — never redial this relay
  private reconnectTimer?: TimerHandle
  private readonly seqByChat = new Map<string, number>() // per-chat monotonic rd/chat seq

  constructor(
    readonly relayId: string,
    readonly url: string,
    private readonly deps: RelayClientDeps
  ) {
    this.correlator = new ReqRep<RelayDaemonFrame>(deps.clock, ACK_TIMEOUT_MS)
    this.backoff = new Backoff(deps.jitter ? { jitter: deps.jitter } : {})
  }

  start(): void {
    this.stopped = false
    this.fatal = false
    void this.attemptConnect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      this.deps.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.correlator.rejectAll(new Error('stopping'))
    this.transport?.close(1000, 'shutdown')
    this.state = 'CLOSED'
  }

  isReady(): boolean {
    return this.state === 'READY'
  }

  /**
   * Send a cross-daemon agent-call to the relay (`rd/agentmsg` REQ, agent-collaboration
   * §2.3/§6.4) and resolve with the relay's admission verdict. `claimedFromAgentId` is
   * this daemon's trusted caller — the relay re-validates it against the socket's
   * authenticated daemonId. Rejects (retryable) if the socket isn't READY.
   */
  async sendAgentMsg(payload: RdAgentMsg): Promise<RdAgentMsgAck> {
    if (this.state !== 'READY') throw new WireError('INTERNAL', `rd link not ready (${this.state})`, true)
    const rep = await this.sendRequest(buildRelayDaemonFrame('rd/agentmsg', payload))
    if (rep.type !== 'rd/agentmsg/ack') {
      throw new WireError('INTERNAL', `expected rd/agentmsg/ack, got ${rep.type}`, false)
    }
    return rep.payload
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped || this.fatal) return
    const daemonId = this.deps.daemonId()
    if (!daemonId) {
      // Id not adopted yet (token onboarding). Back off and retry — auth/ok normally
      // sets it before the roster ever converges, so this is a rare defensive path.
      this.state = 'DEGRADED'
      this.scheduleReconnect()
      return
    }
    this.state = 'CONNECTING'
    try {
      const t = await this.deps.connect(this.url)
      if (this.stopped || this.fatal) {
        t.close(1000, 'shutdown')
        return
      }
      this.transport = t
      t.onMessage((txt) => void this.onText(txt))
      t.onClose((c, r) => this.onClose(c, r))
      await this.handshake(daemonId)
      this.backoff.reset()
    } catch (err) {
      this.deps.log.warn(`relay(${this.relayId}): connect/hello failed: ${(err as Error).message}`)
      this.transport?.close(1011, 'handshake failed')
      this.transport = undefined
      this.scheduleReconnect()
    }
  }

  private async handshake(daemonId: string): Promise<void> {
    this.state = 'HELLO'
    // Read per connect, never cached — the same credential and the same reason as the CP socket.
    const identityToken = this.deps.clusterIdentityToken?.()
    const apiKey = this.deps.apiKey()
    const rep = await this.sendRequest(
      buildRelayDaemonFrame('rd/hello', {
        ...(identityToken ? { serviceAccountToken: identityToken } : apiKey ? { apiKey } : {}),
        daemonId,
        capabilities: [...DAEMON_RD_CAPABILITIES]
      })
    )
    if (rep.type !== 'rd/hello/ok') {
      throw new WireError('INTERNAL', `expected rd/hello/ok, got ${rep.type}`, false)
    }
    const ok = rep.payload as RdHelloOk
    if (ok.relayId !== this.relayId) {
      // Misroute: dialed relay A, reached relay B ⇒ a pool LB is in the daemon dial
      // path. Deployment error — retry (the operator must fix per-instance routing).
      throw new WireError('INTERNAL', `relay misroute: dialed ${this.relayId}, reached ${ok.relayId}`, true)
    }
    this.state = 'READY'
    this.deps.log.info(`relay(${this.relayId}): rd/* connected`)
  }

  private sendRequest(frame: RelayDaemonFrame): Promise<RelayDaemonFrame> {
    return this.correlator.request(frame, (e) => this.transport!.send(e))
  }

  private async onText(text: string): Promise<void> {
    const decoded = decodeRelayDaemonFrame(text)
    if (!decoded.ok) {
      if (decoded.corr) {
        const code =
          decoded.msg === 'FRAME_TOO_LARGE'
            ? 'FRAME_TOO_LARGE'
            : decoded.msg === 'UNKNOWN_FRAME'
              ? 'UNKNOWN_FRAME'
              : 'BAD_PAYLOAD'
        this.correlator.reject(decoded.corr, new WireError(code, `invalid correlated reply: ${decoded.msg}`, false))
      }
      return
    }
    const frame = decoded.frame
    if (frame.corr && this.correlator.settle(frame)) return
    if (frame.type === 'rd/msg') {
      await this.handleMsg(frame.id, frame.payload)
      return
    }
    if (frame.type === 'rd/agentmsg/fwd') {
      void this.handleAgentMsgFwd(frame.id, frame.payload)
      return
    }
    this.deps.log.debug(`relay(${this.relayId}): ignoring ${frame.type}`)
  }

  /** An inbound rd/msg: dispatch it, reply `rd/ack`; only a webchat op streams
   *  `rd/chat` back over this socket. A shared-bot `im` replies out-of-band via the
   *  daemon's own Slack send, and a hook fire has no reply stream — both get a noop. */
  private async handleMsg(reqId: string, msg: RdMsg): Promise<void> {
    const chat =
      msg.source === 'webchat' ? (event: RdChatEvent) => this.sendChat(msg.chatId, event) : (): void => undefined
    const post = msg.source === 'webchat' ? (p: RdWebchatPost) => this.sendWebchatPost(p) : undefined
    const ack = await this.deps.onRelayMsg(msg, chat, post)
    this.transport?.send(JSON.stringify(buildRelayDaemonFrame('rd/ack', ack, { corr: reqId })))
  }

  /** A forwarded cross-daemon agent-call: terminal-verify + dispatch, reply the typed
   *  admission verdict (`rd/agentmsg/ack`, corr = the relay's fwd id). */
  private async handleAgentMsgFwd(reqId: string, msg: RdAgentMsgFwd): Promise<void> {
    let ack: RdAgentMsgAck
    try {
      ack = await this.deps.onRelayAgentMsg(msg)
    } catch (err) {
      this.deps.log.error(`relay(${this.relayId}): rd/agentmsg/fwd handler threw: ${(err as Error).message}`)
      ack = { deliveryId: msg.deliveryId, delivered: false, reason: 'offline' }
    }
    this.transport?.send(JSON.stringify(buildRelayDaemonFrame('rd/agentmsg/ack', ack, { corr: reqId })))
  }
  /** One completed conversation post (fire-and-forget EVT) — either on the socket the
   *  triggering turn arrived on, or (agent-initiated turns, #753) broadcast by
   *  {@link RelayManager.sendWebchatPost} to every relay this daemon holds, since none
   *  of them is "the" socket for a wake with no browser turn of its own. A dead
   *  transport drops it — bounded loss, the transcript row already exists on the
   *  authoring daemon. */
  sendWebchatPost(post: RdWebchatPost): void {
    this.transport?.send(JSON.stringify(buildRelayDaemonFrame('rd/webchat-post', post)))
  }

  private sendChat(chatId: string, event: RdChatEvent): void {
    const seq = (this.seqByChat.get(chatId) ?? 0) + 1
    this.seqByChat.set(chatId, seq)
    this.transport?.send(JSON.stringify(buildRelayDaemonFrame('rd/chat', { chatId, seq, event })))
    // A turn's terminal `done` ends this chat's stream — drop the counter so the map
    // doesn't accumulate one permanent entry per lifetime conversation. The next turn of
    // the same conversation restarts seq at 1 (seq is per-stream for assembly, not global).
    if (event.kind === 'done') this.seqByChat.delete(chatId)
  }

  private onClose(code: number, _reason: string): void {
    this.transport = undefined
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (code === CLOSE_AUTH_FAILED) {
      this.fatal = true
      this.state = 'CLOSED'
      this.deps.log.warn(`relay(${this.relayId}): rd/hello rejected (4401) — not redialing`)
      return
    }
    if (this.stopped) {
      this.state = 'CLOSED'
      return
    }
    this.state = 'DEGRADED'
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal) return
    if (this.reconnectTimer !== undefined) return
    const delay = this.backoff.next()
    this.reconnectTimer = this.deps.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.attemptConnect()
    }, delay)
  }
}
