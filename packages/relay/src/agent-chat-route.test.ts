// The agent chat routes over real HTTP, each read with its protocol's own client (`ai`, `@ag-ui/client`); the daemon and the CP verdict are faked.
import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { HttpAgent } from '@ag-ui/client'
import {
  API_AG_UI_V1_FEATURE,
  AGENT_CHAT_ID_MAX_CHARS,
  AGENT_CHAT_KEY_REFUSAL,
  type RcVerifyResult,
  type RdAck,
  type RdMsgWebchat,
  type WebchatEvent
} from '@agentconnect.md/protocol'
import {
  registerAgentChatRoutes,
  chatTurnText,
  chatRefusalStatus,
  RELAY_AI_SDK_CHAT_PATH,
  type ChatRoute
} from './agent-chat-route.js'
import { RELAY_AG_UI_CHAT_PATH } from './ag-ui-encoder.js'
import { APPROVAL_TOOL_NAME, ASK_TOOL_NAME } from './chat-stream-encoder.js'
import { WebchatRouter } from './webchat-router.js'
import { WebchatVerdictCache } from './webchat-verdict-cache.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'
const DAEMON = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'
const FOREIGN_TURN = '44444444-4444-4444-8444-444444444444'
const T0 = 1_800_000_000_000

const KEY = 'test-api-key'
const CHAT_ID = 'client-chat-id'
const VERDICT_TTL_MS = 60_000

const VERDICT: RcVerifyResult = {
  ok: true,
  agentId: AGENT,
  daemonId: DAEMON,
  conversationId: CONV,
  userId: 'user-1',
  user: 'Ada',
  participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }],
  apiProtocols: ['ai-sdk-ui', 'ag-ui'],
  remoteMcp: {
    authorityId: '66666666-6666-4666-8666-666666666666',
    authorityGeneration: 1,
    expiresAt: '2027-01-01T00:00:00.000Z'
  }
}

class FakeDaemon {
  readonly sent: RdMsgWebchat[] = []
  ack: (m: RdMsgWebchat) => RdAck = (m) => ({
    msgId: m.msgId,
    accepted: true,
    ...(m.payload.op === 'turn' && m.payload.turnId ? { turnId: m.payload.turnId } : {})
  })
  beforeAck?: (m: RdMsgWebchat) => void
  readonly capabilities = new Set<string>([API_AG_UI_V1_FEATURE])
  private readonly closeListeners = new Set<() => void>()

  supports(capability: string): boolean {
    return this.capabilities.has(capability)
  }

  async sendMsg(m: RdMsgWebchat): Promise<RdAck> {
    this.sent.push(m)
    this.beforeAck?.(m)
    return this.ack(m)
  }

  onceClosed(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  drop(): void {
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const l of listeners) l()
  }

  turns(): string[] {
    return this.sent.flatMap((m) => (m.payload.op === 'turn' && m.payload.turnId ? [m.payload.turnId] : []))
  }
}

type Verify = (apiKey: string, agentId: string, chatId: string) => Promise<RcVerifyResult>

interface Harness {
  base: string
  daemon: FakeDaemon
  router: WebchatRouter
  verify: ReturnType<typeof vi.fn<Verify>>
  info: ReturnType<typeof vi.fn<(m: string) => void>>
  setNow: (ms: number) => void
}

let app: FastifyInstance | undefined
let route: ChatRoute | undefined

afterEach(async () => {
  route?.closeAll('test over')
  await app?.close()
  app = undefined
  route = undefined
})

async function start(opts: { verdict?: Verify; online?: boolean; idleMs?: number } = {}): Promise<Harness> {
  let now = T0
  const daemon = new FakeDaemon()
  const router = new WebchatRouter()
  const verify = vi.fn<Verify>(opts.verdict ?? (async () => VERDICT))
  const cache = new WebchatVerdictCache<[string, string, string]>(
    verify,
    () => now,
    (_args, verifiedAtMs) => verifiedAtMs + VERDICT_TTL_MS
  )
  const info = vi.fn<(m: string) => void>()
  const log: Logger = { debug: () => {}, info, warn: () => {}, error: () => {} }
  app = Fastify({ logger: false, forceCloseConnections: true })
  route = registerAgentChatRoutes(app, {
    verify: (apiKey, agentId, chatId) => cache.verify(apiKey, agentId, chatId),
    daemons: () => ({
      get: (id: string) =>
        opts.online !== false && id === DAEMON ? (daemon as unknown as RelayDaemonConnection) : undefined,
      rendezvousCandidate: () => undefined
    }),
    router,
    keepaliveMs: 60_000,
    ...(opts.idleMs ? { turnIdleTimeoutMs: opts.idleMs } : {}),
    log
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, daemon, router, verify, info, setNow: (ms) => (now = ms) }
}

const userMessage = (id: string, ...texts: string[]): UIMessage => ({
  id,
  role: 'user',
  parts: texts.map((text) => ({ type: 'text' as const, text }))
})

/** Send one `useChat` turn through the AI SDK's own transport; resolves once the response headers arrive. */
async function chat(
  h: Harness,
  messages: UIMessage[] = [userMessage('u1', 'hello')],
  opts: { key?: string; signal?: AbortSignal; agentId?: string; chatId?: string } = {}
): Promise<{ stream: ReadableStream<UIMessageChunk>; headers: Headers }> {
  let headers: Headers | undefined
  const transport = new DefaultChatTransport<UIMessage>({
    api: chatUrl(h, opts.agentId),
    headers: { Authorization: `Bearer ${opts.key ?? KEY}` },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await fetch(input, init)
      headers = res.headers
      return res
    }) as typeof fetch
  })
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: opts.chatId ?? CHAT_ID,
    messageId: undefined,
    messages,
    abortSignal: opts.signal
  })
  return { stream, headers: headers! }
}

async function read(stream: ReadableStream<UIMessageChunk>): Promise<{ message: UIMessage; errors: string[] }> {
  const errors: string[] = []
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({
    stream,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e))
  })) {
    message = m
  }
  return { message: message!, errors }
}

const chatUrl = (h: Harness, agentId = AGENT): string =>
  `${h.base}${RELAY_AI_SDK_CHAT_PATH.replace(':agentId', agentId)}`

/** A raw POST, for the answers that come before any stream. */
async function post(h: Harness, body: unknown, key: string | null = KEY, agentId = AGENT): Promise<Response> {
  return fetch(chatUrl(h, agentId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}
const turnBody = (text = 'hello', id = CHAT_ID) => ({
  id,
  messages: [userMessage('u1', text)],
  trigger: 'submit-message'
})

let seq = 0
function emit(h: Harness, turnId: string, event: WebchatEvent): void {
  const index = seq++
  h.router.deliver({
    chatId: CONV,
    seq: index,
    event: { kind: 'output', output: { conversationId: CONV, turnId, index, event } }
  })
}
function finish(h: Harness, turnId: string, over: { stopReason?: string; error?: string } = {}): void {
  h.router.deliver({
    chatId: CONV,
    seq: seq++,
    event: { kind: 'done', done: { conversationId: CONV, turnId, ...over } }
  })
}

describe('POST /ai-sdk/agents/:agentId/chat', () => {
  it('streams one turn as a UI message: text, reasoning, data parts, metadata, finish', async () => {
    const h = await start()
    const { stream, headers } = await chat(h, [
      userMessage('u0', 'an earlier question'),
      { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'an earlier answer' }] },
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'first line' },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
          { type: 'text', text: 'second line' }
        ]
      }
    ])
    expect(headers.get('content-type')).toBe('text/event-stream')
    expect(headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')

    // The daemon got a text turn and nothing else: no targets, mentions, overrides, or delegated MCP entitlement.
    expect(h.daemon.sent).toHaveLength(1)
    const sent = h.daemon.sent[0]!
    const turnId = h.daemon.turns()[0]!
    expect(sent).toMatchObject({ source: 'webchat', agentId: AGENT, sessionKey: CONV, chatId: CONV })
    expect(sent.remoteMcp).toBeUndefined()
    expect(sent.payload).toEqual({
      op: 'turn',
      text: 'first line\nsecond line',
      user: 'Ada',
      userId: 'user-1',
      turnId,
      origin: 'ai-sdk-ui'
    })

    emit(h, turnId, { kind: 'thinking', text: 'looking' })
    emit(h, turnId, { kind: 'message', text: 'Here ' })
    emit(h, turnId, { kind: 'message', text: 'it is.' })
    emit(h, turnId, { kind: 'tool_call', toolCallId: 'call-1', title: 'Search docs', status: 'in_progress' })
    emit(h, turnId, { kind: 'tool_update', toolCallId: 'call-1', status: 'completed' })
    emit(h, turnId, { kind: 'plan', entries: [{ content: 'answer', status: 'completed' }] })
    emit(h, turnId, { kind: 'session_info', title: 'Docs help' })
    finish(h, turnId, { stopReason: 'end_turn' })

    const { message, errors } = await read(stream)
    expect(errors).toEqual([])
    expect(message.id).toBe(turnId)
    expect(message.metadata).toEqual({ title: 'Docs help' })
    expect(message.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'reasoning', text: 'looking', state: 'done' },
      { type: 'text', text: 'Here it is.', state: 'done' },
      { type: 'data-tool', id: 'call-1', data: { title: 'Search docs', status: 'completed' } },
      { type: 'data-plan', data: { entries: [{ content: 'answer', status: 'completed' }] } }
    ])
  })

  it('answers 409 to a second turn while one is in flight, without forwarding it', async () => {
    const h = await start()
    const first = await chat(h)
    const res = await post(h, turnBody('again'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'busy' })
    expect(h.daemon.sent).toHaveLength(1)
    finish(h, h.daemon.turns()[0]!)
    await read(first.stream)
  })

  it("holds the slot through a client abort until the turn's own done, and sends no cancel", async () => {
    const h = await start()
    const abort = new AbortController()
    const { stream } = await chat(h, undefined, { signal: abort.signal })
    const turnId = h.daemon.turns()[0]!
    abort.abort()
    await stream.cancel().catch(() => {})
    await vi.waitFor(() => expect(h.info).toHaveBeenCalledWith(expect.stringContaining('client left turn')))

    // Output after the abort goes nowhere, and the slot is still held.
    emit(h, turnId, { kind: 'message', text: 'still answering' })
    expect((await post(h, turnBody('too soon'))).status).toBe(409)

    finish(h, turnId)
    const next = await chat(h, [userMessage('u2', 'now')])
    expect(h.daemon.sent.map((m) => m.payload.op)).toEqual(['turn', 'turn'])
    finish(h, h.daemon.turns()[1]!)
    expect((await read(next.stream)).errors).toEqual([])
  })

  it('forwards only the admitted turn, not another participant’s on the same conversation', async () => {
    const h = await start()
    const { stream } = await chat(h)
    const turnId = h.daemon.turns()[0]!
    emit(h, FOREIGN_TURN, { kind: 'message', text: 'from the browser socket' })
    emit(h, turnId, { kind: 'message', text: 'mine' })
    finish(h, FOREIGN_TURN)
    emit(h, turnId, { kind: 'message', text: ' only' })
    finish(h, turnId)
    const { message } = await read(stream)
    expect(message.parts.filter((p) => p.type === 'text')).toMatchObject([{ text: 'mine only' }])
  })

  it('streams an output once when a watcher resuming through this relay makes the daemon send it twice', async () => {
    const h = await start()
    const { stream } = await chat(h)
    const turnId = h.daemon.turns()[0]!
    const twice = (index: number, text: string) => {
      for (let copy = 0; copy < 2; copy++) {
        h.router.deliver({
          chatId: CONV,
          seq: seq++,
          event: {
            kind: 'output',
            output: { conversationId: CONV, turnId, index, event: { kind: 'message', text } }
          }
        })
      }
    }
    twice(0, 'once')
    twice(1, ' each')
    finish(h, turnId)
    finish(h, turnId)
    const { message, errors } = await read(stream)
    expect(errors).toEqual([])
    expect(message.parts.filter((p) => p.type === 'text')).toMatchObject([{ text: 'once each' }])
  })

  it('streams output that races the ack', async () => {
    const h = await start()
    h.daemon.beforeAck = (m) => {
      if (m.payload.op === 'turn') emit(h, m.payload.turnId!, { kind: 'message', text: 'early' })
    }
    const { stream } = await chat(h)
    finish(h, h.daemon.turns()[0]!)
    const { message } = await read(stream)
    expect(message.parts.filter((p) => p.type === 'text')).toMatchObject([{ text: 'early' }])
  })

  it('answers a refused turn with a status before any stream, and frees the slot', async () => {
    const h = await start()
    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: false, reason: 'busy' })
    const busy = await post(h, turnBody())
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ reason: 'busy' })

    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: false, reason: 'start_failed', detail: 'the runtime exited' })
    const failed = await post(h, turnBody())
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ reason: 'start_failed', message: 'the runtime exited' })

    // The agent's Decision gate answered no.
    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: false, reason: 'declined' })
    const declined = await post(h, turnBody())
    expect(declined.status).toBe(422)
    expect(await declined.json()).toMatchObject({ reason: 'declined' })

    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: true, turnId: (m.payload as { turnId: string }).turnId })
    const { stream } = await chat(h)
    finish(h, h.daemon.turns()[3]!)
    expect((await read(stream)).errors).toEqual([])
  })

  it('names the chat API as the turn’s origin, so the daemon applies its Decision gate', async () => {
    const h = await start()
    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: false, reason: 'busy' })
    await post(h, turnBody())
    expect(h.daemon.sent[0]!.payload).toMatchObject({ op: 'turn', origin: 'ai-sdk-ui' })
  })

  it('answers 503 when the agent daemon is not connected to this relay', async () => {
    const h = await start({ online: false })
    const res = await post(h, turnBody())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ reason: 'no_agent' })
  })

  it('ends the stream with an error and frees the slot when the daemon link drops', async () => {
    const h = await start()
    const { stream } = await chat(h)
    emit(h, h.daemon.turns()[0]!, { kind: 'message', text: 'partial' })
    h.daemon.drop()
    const { message, errors } = await read(stream)
    expect(errors).toEqual(['the agent daemon disconnected'])
    expect(message.parts.filter((p) => p.type === 'text')).toMatchObject([{ text: 'partial' }])
    const next = await chat(h)
    finish(h, h.daemon.turns()[1]!)
    await read(next.stream)
  })

  it('verifies a key once per agent and chat id for a minute, then asks the CP again', async () => {
    const h = await start()
    for (const text of ['one', 'two']) {
      const { stream } = await chat(h, [userMessage('u', text)])
      finish(h, h.daemon.turns().at(-1)!)
      await read(stream)
    }
    expect(h.verify.mock.calls).toEqual([[KEY, AGENT, CHAT_ID]])

    h.verify.mockImplementation(async () => ({ ok: false, reason: AGENT_CHAT_KEY_REFUSAL.invalidKey }))
    h.setNow(T0 + VERDICT_TTL_MS)
    expect((await post(h, turnBody())).status).toBe(401)
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(h.daemon.sent).toHaveLength(2)
  })

  it('refuses a path without an agent id and a body without a usable chat id, before verifying', async () => {
    const h = await start()
    expect((await post(h, turnBody(), KEY, 'not-a-uuid')).status).toBe(404)
    const { id: _id, ...noId } = turnBody()
    expect((await post(h, noId)).status).toBe(400)
    expect((await post(h, turnBody('hello', ''))).status).toBe(400)
    expect((await post(h, turnBody('hello', 'x'.repeat(AGENT_CHAT_ID_MAX_CHARS + 1)))).status).toBe(400)
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('answers each key refusal with its own status', async () => {
    const h = await start()
    expect((await post(h, turnBody(), null)).status).toBe(401)
    const cases: Array<[string, number, string?]> = [
      [AGENT_CHAT_KEY_REFUSAL.invalidKey, 401],
      [AGENT_CHAT_KEY_REFUSAL.notPermitted, 403],
      [AGENT_CHAT_KEY_REFUSAL.agentNotFound, 404],
      [AGENT_CHAT_KEY_REFUSAL.agentMoved, 409, 'agent_moved'],
      [AGENT_CHAT_KEY_REFUSAL.agentUnavailable, 503, 'no_agent']
    ]
    for (const [reason, status, machine] of cases) {
      h.verify.mockImplementationOnce(async () => ({ ok: false, reason }))
      const res = await post(h, turnBody())
      expect(res.status).toBe(status)
      expect(((await res.json()) as { reason?: string }).reason).toBe(machine)
    }
    // A verdict for another agent than the path names is not an answer for this request.
    h.verify.mockImplementationOnce(async () => ({ ...VERDICT, agentId: OTHER_AGENT }))
    expect((await post(h, turnBody())).status).toBe(503)
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('refuses with 403 an agent that has not added the AI SDK UI API', async () => {
    const without = { ...VERDICT, apiProtocols: [] }
    const h = await start({ verdict: async () => without })
    const res = await post(h, turnBody())
    expect(res.status).toBe(403)
    expect(((await res.json()) as { reason?: string }).reason).toBe('api_disabled')
    // A CP that names no protocols at all refuses the same way.
    const { apiProtocols: _omitted, ...bare } = VERDICT
    h.verify.mockImplementation(async () => bare)
    expect((await post(h, turnBody('hello', 'another-chat'))).status).toBe(403)
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('refuses a body without a user message with 400', async () => {
    const h = await start()
    expect((await post(h, { messages: [] })).status).toBe(400)
    expect((await post(h, { messages: 'hello' })).status).toBe(400)
    expect(
      (await post(h, { messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }] })).status
    ).toBe(400)
    expect(
      (await post(h, { messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '  ' }] }] })).status
    ).toBe(400)
    expect((await post(h, '{not json')).status).toBe(400)
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('refuses a turn whose text exceeds the frame budget with 413', async () => {
    const h = await start()
    expect((await post(h, turnBody('x'.repeat(128 * 1024 + 1)))).status).toBe(413)
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('keeps a roster verified since the cached verdict, such as a browser reconnect after a join', async () => {
    const h = await start()
    const first = await chat(h)
    finish(h, h.daemon.turns()[0]!)
    await read(first.stream)
    expect(h.router.rosterOf(CONV)).toEqual([{ agentId: AGENT, daemonId: DAEMON }])

    // A browser reconnects with a fresh mint after a join; its verdict is newer than the cached one.
    const joined = [
      { agentId: AGENT, daemonId: DAEMON },
      { agentId: OTHER_AGENT, daemonId: DAEMON }
    ]
    h.router.rememberRoster(CONV, joined, T0 + 10_000)
    h.setNow(T0 + 30_000)
    const second = await chat(h, [userMessage('u2', 'again')])
    expect(h.verify).toHaveBeenCalledTimes(1) // served from the cache, verified at T0
    finish(h, h.daemon.turns()[1]!)
    await read(second.stream)
    expect(h.router.rosterOf(CONV)).toEqual(joined)
  })

  it('addresses the path’s agent alone in a multi-participant conversation', async () => {
    const h = await start({
      verdict: async () => ({
        ...VERDICT,
        participants: [
          { agentId: AGENT, daemonId: DAEMON, primary: true },
          { agentId: OTHER_AGENT, daemonId: DAEMON }
        ]
      })
    })
    const { stream } = await chat(h)
    expect(h.daemon.sent.map((m) => m.agentId)).toEqual([AGENT])
    finish(h, h.daemon.turns()[0]!)
    await read(stream)
  })
})

describe("an AI SDK turn's questions", () => {
  /** A daemon that names `turnId` as the conversation's live stream and takes its resume. */
  function parked(h: Harness, turnId: string, live = true): void {
    const base = h.daemon.ack
    h.daemon.ack = (m) =>
      m.payload.op === 'attach'
        ? live
          ? { msgId: m.msgId, accepted: true, turnId, generation: 2 }
          : { msgId: m.msgId, accepted: false, reason: 'stream_not_found' }
        : base(m)
  }
  /** The assistant message as `useChat` holds it once the caller answered its tool call. */
  const answered = (message: UIMessage, answer: Record<string, unknown>): UIMessage => ({
    ...message,
    parts: message.parts.map((p) => (p.type === 'dynamic-tool' ? ({ ...p, ...answer } as typeof p) : p))
  })

  it('hands the caller a question as a tool call, then resumes the turn with the answer from the next request', async () => {
    const h = await start()
    const first = await chat(h)
    const turnId = h.daemon.turns()[0]!
    emit(h, turnId, { kind: 'message', text: 'Let me check.' })
    const index = seq
    emit(h, turnId, {
      kind: 'elicitation',
      requestId: 'elicit-1',
      message: 'Which branch?',
      options: [
        { value: 'main', label: 'main' },
        { value: 'dev', label: 'dev' }
      ]
    })
    const { message, errors } = await read(first.stream)
    expect(errors).toEqual([])
    expect(message.parts.at(-1)).toMatchObject({
      type: 'dynamic-tool',
      toolName: ASK_TOOL_NAME,
      toolCallId: 'elicit-1',
      state: 'input-available',
      input: { message: 'Which branch?', options: [{ value: 'main' }, { value: 'dev' }] },
      callProviderMetadata: { agentconnect: { turnId, index } }
    })

    // The stream ended and freed the conversation; the turn waits on the daemon for the answer.
    parked(h, turnId)
    const next = await chat(h, [
      userMessage('u1', 'hello'),
      answered(message, { state: 'output-available', output: 'dev' })
    ])
    expect(h.daemon.sent.map((m) => m.payload)).toEqual([
      expect.objectContaining({ op: 'turn' }),
      { op: 'attach' },
      { op: 'resume', turnId, generation: 3, afterIndex: index },
      { op: 'elicitation_choice', requestId: 'elicit-1', value: 'dev' }
    ])
    emit(h, turnId, { kind: 'elicitation_resolved', requestId: 'elicit-1', outcome: 'accepted', label: 'dev' })
    emit(h, turnId, { kind: 'message', text: 'Using dev.' })
    finish(h, turnId)
    const resumed = await read(next.stream)
    expect(resumed.errors).toEqual([])
    expect(resumed.message.id).toBe(turnId)
    expect(resumed.message.parts.filter((p) => p.type === 'text')).toMatchObject([{ text: 'Using dev.' }])
  })

  it("hands the caller a runtime approval, and forwards its verdict with whether the key's owner may allow it", async () => {
    const h = await start({ verdict: async () => ({ ...VERDICT, callerApproves: true }) })
    const first = await chat(h)
    const turnId = h.daemon.turns()[0]!
    const requestId = '77777777-7777-4777-8777-777777777777'
    emit(h, turnId, { kind: 'permission', requestId, tool: 'Bash', detail: 'rm -rf build' })
    const { message } = await read(first.stream)
    expect(message.parts.at(-1)).toMatchObject({
      type: 'dynamic-tool',
      toolName: APPROVAL_TOOL_NAME,
      toolCallId: requestId,
      state: 'approval-requested',
      input: { tool: 'Bash', detail: 'rm -rf build' },
      approval: { id: requestId }
    })

    parked(h, turnId)
    const next = await chat(h, [
      userMessage('u1', 'hello'),
      answered(message, { state: 'approval-responded', approval: { id: requestId, approved: false } })
    ])
    expect(h.daemon.sent.at(-1)!.payload).toEqual({
      op: 'permission_choice',
      requestId,
      allow: false,
      mayAllow: true,
      user: 'Ada',
      userId: 'user-1'
    })
    finish(h, turnId)
    expect((await read(next.stream)).errors).toEqual([])
  })

  it('answers 409 turn_ended to an answer whose turn is over, delivering nothing', async () => {
    const h = await start()
    const first = await chat(h)
    const turnId = h.daemon.turns()[0]!
    emit(h, turnId, { kind: 'elicitation', requestId: 'elicit-1', message: 'Which branch?', options: [] })
    const { message } = await read(first.stream)
    parked(h, turnId, false)
    const res = await post(h, {
      id: CHAT_ID,
      messages: [answered(message, { state: 'output-available', output: 'main' })],
      trigger: 'submit-message'
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'turn_ended' })
    expect(h.daemon.sent.map((m) => m.payload.op)).toEqual(['turn', 'attach'])
    // The conversation is free again.
    const again = await chat(h, [userMessage('u2', 'start over')])
    finish(h, h.daemon.turns()[1]!)
    await read(again.stream)
  })

  it('cancels a turn it gave up on for silence, so the conversation is not left busy', async () => {
    const h = await start({ idleMs: 50 })
    const { stream } = await chat(h)
    expect((await read(stream)).errors).toEqual(['the agent stopped responding'])
    await vi.waitFor(() => expect(h.daemon.sent.at(-1)!.payload).toEqual({ op: 'cancel', agentId: AGENT }))
  })
})

describe('POST /ag-ui/agents/:agentId/chat', () => {
  const agUiUrl = (h: Harness, agentId = AGENT): string =>
    `${h.base}${RELAY_AG_UI_CHAT_PATH.replace(':agentId', agentId)}`

  /** One run through `@ag-ui/client`'s own HttpAgent; `done` settles when the run ends either way. */
  function agUiRun(h: Harness, text = 'hello') {
    const agent = new HttpAgent({ url: agUiUrl(h), headers: { Authorization: `Bearer ${KEY}` }, threadId: CHAT_ID })
    agent.addMessage({ id: 'u1', role: 'user', content: text })
    const started: Array<{ threadId: string; runId: string }> = []
    const errors: string[] = []
    const done = agent
      .runAgent(
        { runId: 'run-1' },
        {
          onRunStartedEvent: ({ event }) => void started.push({ threadId: event.threadId, runId: event.runId }),
          onRunErrorEvent: ({ event }) => void errors.push(event.message)
        }
      )
      .then(
        () => undefined,
        (e: unknown) => void errors.push(e instanceof Error ? e.message : String(e))
      )
    return { agent, started, errors, done }
  }

  const agUiBody = (threadId?: string) => ({
    ...(threadId !== undefined ? { threadId } : {}),
    runId: 'run-1',
    messages: [{ id: 'u1', role: 'user', content: 'hello' }],
    tools: [],
    context: []
  })
  const postAgUi = (h: Harness, body: unknown): Promise<Response> =>
    fetch(agUiUrl(h), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body)
    })

  it('streams one turn as a run, its threadId naming the conversation and its runId echoed', async () => {
    const h = await start()
    const run = agUiRun(h, 'hello there')
    await vi.waitFor(() => expect(h.daemon.turns()).toHaveLength(1))
    const turnId = h.daemon.turns()[0]!
    expect(h.verify.mock.calls).toEqual([[KEY, AGENT, CHAT_ID]])
    expect(h.daemon.sent[0]!.payload).toEqual({
      op: 'turn',
      text: 'hello there',
      user: 'Ada',
      userId: 'user-1',
      turnId,
      origin: 'ag-ui'
    })

    emit(h, turnId, { kind: 'thinking', text: 'looking' })
    emit(h, turnId, { kind: 'message', text: 'Here it is.' })
    emit(h, turnId, { kind: 'tool_call', toolCallId: 'call-1', title: 'Search docs', status: 'completed' })
    finish(h, turnId, { stopReason: 'end_turn' })
    await run.done

    expect(run.errors).toEqual([])
    expect(run.started).toEqual([{ threadId: CHAT_ID, runId: 'run-1' }])
    expect(run.agent.messages.filter((m) => m.role !== 'user')).toMatchObject([
      { role: 'reasoning', content: 'looking' },
      { role: 'assistant', content: 'Here it is.' },
      { role: 'activity', activityType: 'tool', content: { title: 'Search docs', status: 'completed' } }
    ])
  })

  it('refuses a body without a usable threadId with 400, before verifying', async () => {
    const h = await start()
    const res = await postAgUi(h, agUiBody())
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('threadId')
    expect((await postAgUi(h, agUiBody('x'.repeat(AGENT_CHAT_ID_MAX_CHARS + 1)))).status).toBe(400)
    expect(h.verify).not.toHaveBeenCalled()
  })

  it('refuses with 403 an agent that has added only the AI SDK UI API', async () => {
    const h = await start({ verdict: async () => ({ ...VERDICT, apiProtocols: ['ai-sdk-ui'] }) })
    const res = await postAgUi(h, agUiBody(CHAT_ID))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { reason?: string }).reason).toBe('api_disabled')
    expect(h.daemon.sent).toHaveLength(0)
  })

  it('answers 503 without sending when the agent daemon cannot take AG-UI, and frees the slot', async () => {
    const h = await start()
    h.daemon.capabilities.clear()
    const res = await postAgUi(h, agUiBody(CHAT_ID))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('upgraded') })
    expect(h.daemon.sent).toHaveLength(0)

    h.daemon.capabilities.add(API_AG_UI_V1_FEATURE)
    const run = agUiRun(h)
    await vi.waitFor(() => expect(h.daemon.turns()).toHaveLength(1))
    finish(h, h.daemon.turns()[0]!)
    await run.done
    expect(run.errors).toEqual([])
  })

  it('shares one turn per conversation with the AI SDK route', async () => {
    const h = await start()
    const first = await chat(h)
    const res = await postAgUi(h, agUiBody(CHAT_ID))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'busy' })
    expect(h.daemon.sent).toHaveLength(1)
    finish(h, h.daemon.turns()[0]!)
    await read(first.stream)
  })

  it('ends the run with RUN_ERROR when the daemon link drops', async () => {
    const h = await start()
    const run = agUiRun(h)
    await vi.waitFor(() => expect(h.daemon.turns()).toHaveLength(1))
    emit(h, h.daemon.turns()[0]!, { kind: 'message', text: 'partial' })
    await vi.waitFor(() => expect(run.agent.messages.some((m) => m.role === 'assistant')).toBe(true))
    h.daemon.drop()
    await run.done
    expect(run.errors[0]).toBe('the agent daemon disconnected')
    expect(run.agent.messages.filter((m) => m.role === 'assistant')).toMatchObject([{ content: 'partial' }])
  })
})

describe('chatTurnText', () => {
  it('reads the last user message, joining its text parts', () => {
    expect(
      chatTurnText({
        messages: [
          userMessage('u0', 'old'),
          userMessage('u1', 'a', 'b'),
          { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] }
        ]
      })
    ).toBe('a\nb')
    expect(
      chatTurnText({ messages: [{ id: 'u', role: 'user', parts: [{ type: 'data-x', data: 1 }] }] })
    ).toBeUndefined()
    expect(chatTurnText(null)).toBeUndefined()
  })
})

describe('chatRefusalStatus', () => {
  it('maps daemon refusals to statuses', () => {
    expect(chatRefusalStatus('busy')).toBe(409)
    expect(chatRefusalStatus('declined')).toBe(422)
    expect(chatRefusalStatus('paused')).toBe(503)
    expect(chatRefusalStatus('no_agent')).toBe(503)
    expect(chatRefusalStatus('unsupported')).toBe(503)
    expect(chatRefusalStatus('start_failed')).toBe(502)
    expect(chatRefusalStatus(undefined)).toBe(502)
  })
})
