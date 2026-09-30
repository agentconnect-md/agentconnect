// The agent chat API (shared-bot-relay.md §10.4): one text turn per request under an API key, over the webchat conversation and `rd/*` bridge, streamed back in the route's protocol.
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  AGENT_API_PROTOCOL_FEATURE,
  AGENT_CHAT_ID_MAX_CHARS,
  AGENT_CHAT_KEY_REFUSAL,
  RelayWebchatOp,
  type RdChat
} from '@agentconnect.md/protocol'
import type { WebchatVerdict } from './webchat-verdict-cache.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { ChatSink, WebchatRouter } from './webchat-router.js'
import {
  APPROVAL_TOOL_NAME,
  ASK_TOOL_NAME,
  UiMessageStreamEncoder,
  type ChatAnswer,
  type ChatAnswers,
  type ChatProtocol,
  type ChatStreamEncoder
} from './chat-stream-encoder.js'
import { AG_UI_CHAT_PROTOCOL } from './ag-ui-encoder.js'
import {
  deliverWebchatMsg,
  deliveryFailureDiagnostic,
  resolveWebchatDaemon,
  webchatRdMsg,
  type WebchatDaemonDeps,
  type WebchatDaemonTarget,
  type WebchatParticipant
} from './webchat-daemon-bridge.js'
import type { Logger } from './log.js'

export const RELAY_AI_SDK_CHAT_PATH = '/ai-sdk/agents/:agentId/chat'

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
  /** `rc/verify(agent-chat-key)` through the relay's verdict cache. */
  verify: (apiKey: string, agentId: string, chatId: string) => Promise<WebchatVerdict>
  /** The rd/* server, late-bound because it is created after `listen`. */
  daemons: () => Pick<RelayDaemonServer, 'get' | 'rendezvousCandidate'> | undefined
  router: Pick<WebchatRouter, 'register' | 'unregister' | 'rememberRoster'>
  admission?: ChatTurnAdmission
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

/** The `useChat` chat id, which names the conversation, or undefined when the body has none. */
export function chatIdOf(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.id !== 'string') return undefined
  return body.id.length > 0 && body.id.length <= AGENT_CHAT_ID_MAX_CHARS ? body.id : undefined
}

/** The answers a `useChat` request carries: its last message is the assistant's, holding our tool calls the caller answered. */
export function chatAnswers(body: unknown): ChatAnswers | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
  const last: unknown = body.messages.at(-1)
  if (!isRecord(last) || last.role !== 'assistant' || !Array.isArray(last.parts)) return undefined
  let at: { turnId: string; index: number } | undefined
  const answers: ChatAnswer[] = []
  for (const part of last.parts) {
    if (!isRecord(part) || part.type !== 'dynamic-tool' || typeof part.toolCallId !== 'string') continue
    if (part.toolName !== ASK_TOOL_NAME && part.toolName !== APPROVAL_TOOL_NAME) continue
    const meta = isRecord(part.callProviderMetadata) ? part.callProviderMetadata.agentconnect : undefined
    if (!isRecord(meta) || typeof meta.turnId !== 'string' || !Number.isSafeInteger(meta.index)) continue
    // Every question of the turn the message holds, answered or not, marks how far the caller has read.
    if (at && at.turnId !== meta.turnId) return undefined
    if (!at || (meta.index as number) > at.index) at = { turnId: meta.turnId, index: meta.index as number }
    const requestId = part.toolCallId
    if (part.toolName === ASK_TOOL_NAME) {
      if (part.state === 'output-available')
        answers.push({ kind: 'elicitation', requestId, value: part.output ?? null })
      else if (part.state === 'output-error') answers.push({ kind: 'elicitation', requestId, value: null })
    } else if (isRecord(part.approval) && typeof part.approval.approved === 'boolean') {
      answers.push({ kind: 'permission', requestId, allow: part.approval.approved })
    }
  }
  if (!at || !UUID_RE.test(at.turnId) || answers.length === 0) return undefined
  return { turnId: at.turnId.toLowerCase(), afterIndex: at.index, answers }
}

/** AI SDK UI: the `useChat` chat id names the conversation, and the last user message's text parts are the turn. */
export const AI_SDK_UI_CHAT_PROTOCOL: ChatProtocol = {
  id: 'ai-sdk-ui',
  path: RELAY_AI_SDK_CHAT_PATH,
  chatIdName: 'chat id',
  chatId: chatIdOf,
  text: chatTurnText,
  encoder: (turnId) => new UiMessageStreamEncoder(turnId),
  answers: chatAnswers
}

// Every protocol the relay serves; one admission table spans them, since a key's chat id names the same conversation on each.
export const AGENT_CHAT_PROTOCOLS: readonly ChatProtocol[] = [AI_SDK_UI_CHAT_PROTOCOL, AG_UI_CHAT_PROTOCOL]

/** How a refused key reads: the status, its message, and a machine reason where a caller acts on it. */
function keyRefusal(reason: string | undefined): [status: number, message: string, reason?: string] {
  switch (reason) {
    case AGENT_CHAT_KEY_REFUSAL.invalidKey:
      return [401, 'invalid or revoked API key']
    case AGENT_CHAT_KEY_REFUSAL.notPermitted:
      return [403, 'this API key cannot chat with agents']
    case AGENT_CHAT_KEY_REFUSAL.agentNotFound:
      return [404, 'agent not found']
    case AGENT_CHAT_KEY_REFUSAL.agentMoved:
      return [409, 'the agent moved since this conversation ran', 'agent_moved']
    case AGENT_CHAT_KEY_REFUSAL.agentUnavailable:
      return [503, 'the agent daemon is offline', 'no_agent']
    default:
      return [403, 'this API key cannot reach the agent']
  }
}

/** The HTTP status for a daemon's turn refusal, answered before any stream starts. */
export function chatRefusalStatus(reason: string | undefined): number {
  switch (reason) {
    case 'busy':
      return 409
    case 'declined':
      return 422
    case 'no_agent':
    case 'paused':
    case 'draining':
    case 'integration_offline':
    case 'not_holder':
    case 'unsupported':
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
  422: 'Unprocessable Content',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
}

function refuse(reply: FastifyReply, status: number, message: string, reason?: string): FastifyReply {
  return reply
    .code(status)
    .send({ error: STATUS_TEXT[status] ?? 'Error', statusCode: status, message, ...(reason ? { reason } : {}) })
}

function bearerCredential(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return match?.[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The daemon ops a request's answers become, or undefined when one does not parse as an answer. */
function answerOpsOf(answering: ChatAnswers, verdict: WebchatVerdict): RelayWebchatOp[] | undefined {
  const ops: RelayWebchatOp[] = []
  for (const answer of answering.answers) {
    const parsed = RelayWebchatOp.safeParse(
      answer.kind === 'elicitation'
        ? { op: 'elicitation_choice', requestId: answer.requestId, value: answer.value }
        : {
            op: 'permission_choice',
            requestId: answer.requestId,
            allow: answer.allow,
            mayAllow: verdict.callerApproves === true,
            ...(verdict.user ? { user: verdict.user } : {}),
            ...(verdict.userId ? { userId: verdict.userId } : {})
          }
    )
    if (!parsed.success) return undefined
    ops.push(parsed.data)
  }
  return ops
}

/** Rebind the parked turn's stream past what the caller has read, then deliver the answers; false when the turn is gone. */
async function resumeWithAnswers(
  send: (op: RelayWebchatOp) => Promise<{ ack: { accepted: boolean; turnId?: string; generation?: number } }>,
  answering: ChatAnswers,
  ops: RelayWebchatOp[]
): Promise<boolean> {
  const probed = (await send({ op: 'attach' })).ack
  if (!probed.accepted || probed.turnId?.toLowerCase() !== answering.turnId || probed.generation === undefined)
    return false
  const { ack } = await send({
    op: 'resume',
    turnId: answering.turnId,
    generation: probed.generation + 1,
    afterIndex: answering.afterIndex
  })
  if (!ack.accepted) return false
  for (const op of ops) await send(op)
  return true
}

interface ChatTurnOptions {
  conversationId: string
  router: ChatRouteDeps['router']
  release: () => void
  encoder: (turnId: string) => ChatStreamEncoder
  keepaliveMs: number
  idleTimeoutMs: number
  log: Logger
  onSettled: (turn: ChatTurn) => void
  /** Ask the daemon to cancel the turn, so one the relay gave up on does not keep the conversation busy. */
  cancel: () => void
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
    if (ev.kind === 'output') {
      this.write(this.encoder!.output(ev.output))
      // The caller holds a question now; the turn waits on the daemon for its answer in the next request.
      if (this.encoder!.awaitingCaller) this.settle('', 'handed the caller a question')
    } else this.settle(this.encoder!.done(ev.done), `done (${ev.done.error ? 'error' : (ev.done.stopReason ?? 'end')})`)
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
  stream(
    turnId: string,
    res: ServerResponse,
    daemon: Pick<RelayDaemonConnection, 'onceClosed'>,
    afterIndex = -1
  ): void {
    this.turnId = turnId
    this.lastIndex = afterIndex
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
    this.idleTimer = setTimeout(() => {
      this.fail('the agent stopped responding', 'idle timeout')
      this.o.cancel()
    }, this.o.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = undefined
  }
}

/** Mount each protocol's chat route over one admission table and one set of live turns. */
export function registerAgentChatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps,
  protocols: readonly ChatProtocol[] = AGENT_CHAT_PROTOCOLS
): ChatRoute {
  const admission = deps.admission ?? new ChatTurnAdmission()
  const live = new Set<ChatTurn>()
  const log = deps.log

  for (const protocol of protocols) {
    // The daemon feature this protocol's turns need, checked on each daemon the delivery tries.
    const capability = AGENT_API_PROTOCOL_FEATURE[protocol.id]
    app.post<{ Params: { agentId: string } }>(
      protocol.path,
      { bodyLimit: CHAT_BODY_LIMIT_BYTES },
      async (req, reply) => {
        const apiKey = bearerCredential(req.headers.authorization)
        if (!apiKey) return refuse(reply, 401, 'missing API key')
        const pathAgentId = req.params.agentId.toLowerCase()
        if (!UUID_RE.test(pathAgentId)) return refuse(reply, 404, 'agent not found')
        const chatId = protocol.chatId(req.body)
        if (chatId === undefined) {
          return refuse(
            reply,
            400,
            `the request needs a ${protocol.chatIdName} of 1 to ${AGENT_CHAT_ID_MAX_CHARS} characters`
          )
        }
        let verdict: WebchatVerdict
        try {
          verdict = await deps.verify(apiKey, pathAgentId, chatId)
        } catch {
          return refuse(reply, 503, 'key verification unavailable')
        }
        if (!verdict.ok) {
          const [status, message, reason] = keyRefusal(verdict.reason)
          log.warn(`chat: refused request ${status} — ${verdict.reason ?? 'unverified'}`)
          return refuse(reply, status, message, reason)
        }
        const agentId = verdict.agentId
        const rawConversationId = verdict.conversationId
        if (agentId !== pathAgentId || !rawConversationId || !UUID_RE.test(rawConversationId)) {
          log.warn('chat: refused request 503 — incomplete verification')
          return refuse(reply, 503, 'key verification unavailable')
        }
        if (!verdict.apiProtocols?.includes(protocol.id)) {
          return refuse(reply, 403, 'this agent does not accept API calls', 'api_disabled')
        }
        const conversationId = rawConversationId.toLowerCase()
        // A request whose last message answers the turn's questions resumes that turn instead of starting one.
        const answering = protocol.answers?.(req.body)
        const answerOps = answering ? answerOpsOf(answering, verdict) : undefined
        if (answering && !answerOps) return refuse(reply, 400, 'an answer does not fit the question it answers')
        const text = answering ? '' : protocol.text(req.body)
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

        const binding = {
          chatId: conversationId,
          ...(verdict.targetSessionId ? { targetSessionId: verdict.targetSessionId } : {})
        }
        // The daemon that took the last op, so every later op of this request reaches the same one.
        let link: WebchatDaemonTarget = target
        const send = async (op: RelayWebchatOp) => {
          const delivered = await deliverWebchatMsg(
            bridge,
            link,
            webchatRdMsg(binding, agentId, participant, op),
            participant,
            capability
          )
          link = { daemonId: delivered.daemonId, conn: delivered.conn }
          return delivered
        }
        const turn = new ChatTurn({
          conversationId,
          router: deps.router,
          release,
          encoder: (turnId) => protocol.encoder(turnId, req.body),
          keepaliveMs: deps.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
          idleTimeoutMs: deps.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS,
          log,
          onSettled: (t) => live.delete(t),
          cancel: () =>
            void send({ op: 'cancel', agentId }).catch((error) =>
              log.warn(`chat: cancelling an idle turn in ${conversationId} failed ${deliveryFailureDiagnostic(error)}`)
            )
        })
        live.add(turn)
        // Subscribed before the send, so output that races the ack is not lost.
        deps.router.register(conversationId, turn)

        if (answering && answerOps) {
          let resumed: Awaited<ReturnType<typeof resumeWithAnswers>>
          try {
            resumed = await resumeWithAnswers(send, answering, answerOps)
          } catch (error) {
            turn.abandon()
            log.warn(`chat: answer delivery failed ${deliveryFailureDiagnostic(error)}`)
            return refuse(reply, 503, 'the answer could not be delivered to the agent', 'no_agent')
          }
          if (!resumed) {
            turn.abandon()
            log.info(`chat: answer for turn ${answering.turnId} in ${conversationId} found the turn ended`)
            return refuse(reply, 409, 'the turn these answers belong to has ended', 'turn_ended')
          }
          log.info(
            `chat: turn ${answering.turnId} resumed with ${answering.answers.length} answer(s) in ${conversationId}`
          )
          reply.hijack()
          turn.stream(answering.turnId, reply.raw, link.conn, answering.afterIndex)
          return reply
        }

        // A text turn only: no targets, mentions, runtime overrides, attachments, or delegated MCP entitlement.
        const turnId = randomUUID()
        const op: RelayWebchatOp = {
          op: 'turn',
          text,
          user: verdict.user ?? 'webchat',
          ...(verdict.userId ? { userId: verdict.userId } : {}),
          ...(verdict.userPicture ? { userPicture: verdict.userPicture } : {}),
          turnId,
          // The daemon evaluates this API's Decision gate before admitting the turn.
          origin: protocol.id
        }
        let delivered: Awaited<ReturnType<typeof deliverWebchatMsg>>
        try {
          delivered = await send(op)
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
  }

  return {
    closeAll(reason: string): void {
      for (const turn of [...live]) turn.fail(reason, reason)
    }
  }
}
