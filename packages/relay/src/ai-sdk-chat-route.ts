// `POST /ai-sdk/chat/:conversationId` (shared-bot-relay.md §10.4): one text turn per request over the webchat token and `rd/*` bridge, streamed back as the AI SDK UI message stream.
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { RdChat, RelayWebchatOp } from '@agentconnect.md/protocol'
import type { WebchatVerdict } from './webchat-verdict-cache.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { ChatSink, WebchatRouter } from './webchat-router.js'
import { UiMessageStreamEncoder, type ChatStreamEncoder, type ChatStreamEncoderFactory } from './chat-stream-encoder.js'
import {
  deliverWebchatMsg,
  deliveryFailureDiagnostic,
  resolveWebchatDaemon,
  webchatRdMsg,
  type WebchatDaemonDeps,
  type WebchatParticipant
} from './webchat-daemon-bridge.js'
import type { Logger } from './log.js'

export const RELAY_AI_SDK_CHAT_PATH = '/ai-sdk/chat/:conversationId'

// `useChat` resends the whole history every turn; only its last user message is read.
const CHAT_BODY_LIMIT_BYTES = 4 * 1024 * 1024
// One turn's text, leaving the rest of the rd/* frame ceiling for its envelope.
export const CHAT_TEXT_MAX_BYTES = 128 * 1024
const DEFAULT_KEEPALIVE_MS = 15_000
// Last resort only: the slot is released on `done` or on the daemon link dropping, this covers a daemon that goes silent.
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One turn in flight per conversation on this instance: the daemon steers or refuses a second, so it must not reach it. */
export class ChatTurnAdmission {
  private readonly inFlight = new Set<string>()

  /** The slot's idempotent release, or undefined while a turn holds it. */
  tryAcquire(conversationId: string): (() => void) | undefined {
    if (this.inFlight.has(conversationId)) return undefined
    this.inFlight.add(conversationId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight.delete(conversationId)
    }
  }

  holds(conversationId: string): boolean {
    return this.inFlight.has(conversationId)
  }
}

export interface ChatRouteDeps {
  /** `rc/verify(webchat-token)` through the per-token verdict cache. */
  verify: (token: string) => Promise<WebchatVerdict>
  /** The rd/* server, late-bound because it is created after `listen`. */
  daemons: () => Pick<RelayDaemonServer, 'get' | 'rendezvousCandidate'> | undefined
  router: Pick<WebchatRouter, 'register' | 'unregister' | 'rememberRoster'>
  admission?: ChatTurnAdmission
  encoder?: ChatStreamEncoderFactory
  keepaliveMs?: number
  turnIdleTimeoutMs?: number
  log: Logger
}

export interface ChatRoute {
  /** End every open stream with an error and release its slot (process shutdown). */
  closeAll(reason: string): void
}

/** The turn's text: the last user message's text parts joined by newlines, or undefined when there is none. */
export function chatTurnText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message: unknown = body.messages[i]
    if (!isRecord(message) || message.role !== 'user') continue
    if (!Array.isArray(message.parts)) return undefined
    const text = message.parts
      .filter(
        (p): p is { type: 'text'; text: string } => isRecord(p) && p.type === 'text' && typeof p.text === 'string'
      )
      .map((p) => p.text)
      .join('\n')
    return text.trim() === '' ? undefined : text
  }
  return undefined
}

/** The HTTP status for a daemon's turn refusal, answered before any stream starts. */
export function chatRefusalStatus(reason: string | undefined): number {
  switch (reason) {
    case 'busy':
      return 409
    case 'no_agent':
    case 'paused':
    case 'draining':
    case 'integration_offline':
    case 'not_holder':
      return 503
    case 'not_found':
    case 'not_participant':
      return 404
    default:
      return 502
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
}

function refuse(reply: FastifyReply, status: number, message: string, reason?: string): FastifyReply {
  return reply
    .code(status)
    .send({ error: STATUS_TEXT[status] ?? 'Error', statusCode: status, message, ...(reason ? { reason } : {}) })
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return match?.[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ChatTurnOptions {
  conversationId: string
  router: ChatRouteDeps['router']
  release: () => void
  encoder: ChatStreamEncoderFactory
  keepaliveMs: number
  idleTimeoutMs: number
  log: Logger
  onSettled: (turn: ChatTurn) => void
}

/** One admitted turn: holds the slot until its own `done`, and streams to the response while the client stays. */
class ChatTurn implements ChatSink {
  private turnId?: string
  // Output that races the ack is held until the admitted turnId is known.
  private pending: RdChat[] = []
  private encoder?: ChatStreamEncoder
  private res?: ServerResponse
  private settled = false
  private idleTimer?: NodeJS.Timeout
  private keepaliveTimer?: NodeJS.Timeout
  private unwatchDaemon?: () => void
  // A watcher resuming through this relay makes the daemon send each output twice; the index drops the copy.
  private lastIndex = -1

  constructor(private readonly o: ChatTurnOptions) {}

  onChat(chat: RdChat): void {
    if (this.settled) return
    if (this.turnId === undefined) {
      this.pending.push(chat)
      return
    }
    const ev = chat.event
    const turnId = ev.kind === 'output' ? ev.output.turnId : ev.done.turnId
    if (turnId !== this.turnId) return // another participant's turn on this conversation
    if (ev.kind === 'output') {
      if (ev.output.index <= this.lastIndex) return
      this.lastIndex = ev.output.index
    }
    this.armIdle()
    if (ev.kind === 'output') this.write(this.encoder!.output(ev.output))
    else this.settle(this.encoder!.done(ev.done), `done (${ev.done.error ? 'error' : (ev.done.stopReason ?? 'end')})`)
  }

  /** The turn never started (refused or undeliverable): free the slot, nothing was streamed. */
  abandon(): void {
    this.settled = true
    this.pending = []
    this.o.router.unregister(this.o.conversationId, this)
    this.o.release()
    this.o.onSettled(this)
  }

  /** The daemon admitted `turnId`: open the stream and replay whatever arrived first. */
  stream(turnId: string, res: ServerResponse, daemon: Pick<RelayDaemonConnection, 'onceClosed'>): void {
    this.turnId = turnId
    const encoder = this.o.encoder(turnId)
    this.encoder = encoder
    this.res = res
    res.on('error', () => {})
    // A closed response detaches the client only; the turn runs on into the transcript and keeps the slot.
    res.on('close', () => {
      if (this.settled || this.res !== res) return
      this.res = undefined
      this.stopKeepalive()
      this.o.log.info(`chat: client left turn ${turnId} in ${this.o.conversationId}; the turn continues`)
    })
    res.writeHead(200, encoder.headers)
    this.write(encoder.open())
    this.unwatchDaemon = daemon.onceClosed(() => this.fail('the agent daemon disconnected', 'daemon link closed'))
    this.keepaliveTimer = setInterval(() => this.write(encoder.keepalive()), this.o.keepaliveMs)
    this.keepaliveTimer.unref()
    this.armIdle()
    const pending = this.pending
    this.pending = []
    for (const chat of pending) this.onChat(chat)
  }

  fail(message: string, why: string): void {
    if (this.settled || !this.encoder) return
    this.settle(this.encoder.fail(message), why)
  }

  private settle(text: string, why: string): void {
    if (this.settled) return
    this.settled = true
    this.write(text)
    this.res?.end()
    this.res = undefined
    this.stopKeepalive()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.unwatchDaemon?.()
    this.o.router.unregister(this.o.conversationId, this)
    this.o.release()
    this.o.onSettled(this)
    this.o.log.info(`chat: turn ${this.turnId} in ${this.o.conversationId} settled: ${why}`)
  }

  private write(text: string): void {
    const res = this.res
    if (text === '' || !res || res.destroyed || res.writableEnded) return
    res.write(text)
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.fail('the agent stopped responding', 'idle timeout'), this.o.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = undefined
  }
}

export function registerAiSdkChatRoute(app: FastifyInstance, deps: ChatRouteDeps): ChatRoute {
  const admission = deps.admission ?? new ChatTurnAdmission()
  const encoder = deps.encoder ?? ((turnId: string) => new UiMessageStreamEncoder(turnId))
  const live = new Set<ChatTurn>()
  const log = deps.log

  app.post<{ Params: { conversationId: string } }>(
    RELAY_AI_SDK_CHAT_PATH,
    { bodyLimit: CHAT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const token = bearerToken(req.headers.authorization)
      if (!token) return refuse(reply, 401, 'missing bearer token')
      let verdict: WebchatVerdict
      try {
        verdict = await deps.verify(token)
      } catch {
        return refuse(reply, 503, 'token verification unavailable')
      }
      const agentId = verdict.agentId
      const rawConversationId = verdict.conversationId
      if (!verdict.ok || !agentId || !rawConversationId || !UUID_RE.test(rawConversationId)) {
        log.warn(
          `chat: refused request 401 — ${verdict.reason ?? (verdict.ok ? 'incomplete verification' : 'unverified')}`
        )
        return refuse(reply, 401, 'invalid or expired token')
      }
      if (!verdict.apiProtocols?.includes('ai-sdk-ui')) {
        return refuse(reply, 403, 'this agent does not accept API calls', 'api_disabled')
      }
      const conversationId = rawConversationId.toLowerCase()
      // The path names the conversation and the token proves authority over it; any other id reads as absent.
      if (req.params.conversationId.toLowerCase() !== conversationId) {
        return refuse(reply, 404, 'conversation not found')
      }
      const text = chatTurnText(req.body)
      if (text === undefined) return refuse(reply, 400, 'the request has no user message with text')
      if (Buffer.byteLength(text, 'utf8') > CHAT_TEXT_MAX_BYTES) {
        return refuse(reply, 413, `a turn's text is limited to ${CHAT_TEXT_MAX_BYTES} bytes`)
      }
      const release = admission.tryAcquire(conversationId)
      if (!release) return refuse(reply, 409, 'a turn is already in flight for this conversation', 'busy')

      const roster = verdict.participants?.length
        ? verdict.participants
        : [{ agentId, ...(verdict.daemonId ? { daemonId: verdict.daemonId } : {}), primary: true }]
      // Dated by its verification, so a reused token's cached verdict cannot replace a roster verified since (a join).
      deps.router.rememberRoster(
        conversationId,
        roster.map((p) => ({
          agentId: p.agentId,
          ...(p.daemonId ? { daemonId: p.daemonId } : {}),
          ...(p.recordedDaemonId ? { recordedDaemonId: p.recordedDaemonId } : {})
        })),
        verdict.verifiedAtMs
      )
      // A copy: a placement healed by this delivery must not leak into the cached verdict.
      const verified = roster.find((p) => p.agentId === agentId)
      const participant: WebchatParticipant = verified
        ? { ...verified }
        : { agentId, ...(verdict.daemonId ? { daemonId: verdict.daemonId } : {}) }
      const daemons = deps.daemons()
      const bridge: WebchatDaemonDeps = {
        daemonConnFor: (id) => daemons?.get(id),
        rendezvousDaemonConn: () => daemons?.rendezvousCandidate(),
        log
      }
      const target = resolveWebchatDaemon(bridge, participant, agentId)
      if (!target) {
        release()
        log.info(`chat: no live daemon for ${agentId} in ${conversationId}`)
        return refuse(reply, 503, 'the agent daemon is offline', 'no_agent')
      }

      const turn = new ChatTurn({
        conversationId,
        router: deps.router,
        release,
        encoder,
        keepaliveMs: deps.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
        idleTimeoutMs: deps.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS,
        log,
        onSettled: (t) => live.delete(t)
      })
      live.add(turn)
      // Subscribed before the send, so output that races the ack is not lost.
      deps.router.register(conversationId, turn)

      // A text turn only: no targets, mentions, runtime overrides, attachments, or delegated MCP entitlement.
      const turnId = randomUUID()
      const op: RelayWebchatOp = {
        op: 'turn',
        text,
        user: verdict.user ?? 'webchat',
        ...(verdict.userId ? { userId: verdict.userId } : {}),
        ...(verdict.userPicture ? { userPicture: verdict.userPicture } : {}),
        turnId
      }
      const binding = {
        chatId: conversationId,
        ...(verdict.targetSessionId ? { targetSessionId: verdict.targetSessionId } : {})
      }
      let delivered: Awaited<ReturnType<typeof deliverWebchatMsg>>
      try {
        delivered = await deliverWebchatMsg(
          bridge,
          target,
          webchatRdMsg(binding, agentId, participant, op),
          participant
        )
      } catch (error) {
        turn.abandon()
        log.warn(`chat: turn delivery failed ${deliveryFailureDiagnostic(error)}`)
        return refuse(reply, 503, 'the turn could not be delivered to the agent', 'no_agent')
      }
      const { ack } = delivered
      if (!ack.accepted) {
        turn.abandon()
        log.info(
          `chat: turn ${turnId} in ${conversationId} refused by ${delivered.daemonId}: ${ack.reason ?? 'unspecified'}`
        )
        const reason = ack.reason ?? 'refused'
        return refuse(
          reply,
          chatRefusalStatus(ack.reason),
          ack.detail ?? `the agent refused the turn: ${reason}`,
          reason
        )
      }
      log.info(`chat: turn ${ack.turnId ?? turnId} admitted in ${conversationId} by ${delivered.daemonId}`)
      reply.hijack()
      turn.stream(ack.turnId ?? turnId, reply.raw, delivered.conn)
      return reply
    }
  )

  return {
    closeAll(reason: string): void {
      for (const turn of [...live]) turn.fail(reason, reason)
    }
  }
}
