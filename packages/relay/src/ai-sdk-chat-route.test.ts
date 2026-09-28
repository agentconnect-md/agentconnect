// `POST /ai-sdk/chat/:conversationId` over real HTTP, read with the `ai` package's own client; the daemon and the CP verdict are faked.
import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { RcVerifyResult, RdAck, RdMsgWebchat, WebchatEvent } from '@agentconnect.md/protocol'
import {
  registerAiSdkChatRoute,
  chatTurnText,
  chatRefusalStatus,
  RELAY_AI_SDK_CHAT_PATH,
  type ChatRoute
} from './ai-sdk-chat-route.js'
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

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
const tokenFor = (expSec: number, nonce = 'a'): string =>
  `${b64({ alg: 'HS256' })}.${b64({ sub: 'user-1', nonce, exp: expSec })}.sig`
const TOKEN = tokenFor(T0 / 1000 + 300)

const VERDICT: RcVerifyResult = {
  ok: true,
  agentId: AGENT,
  daemonId: DAEMON,
  conversationId: CONV,
  userId: 'user-1',
  user: 'Ada',
  participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }],
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
  private readonly closeListeners = new Set<() => void>()

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

interface Harness {
  base: string
  daemon: FakeDaemon
  router: WebchatRouter
  verify: ReturnType<typeof vi.fn<(token: string) => Promise<RcVerifyResult>>>
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

async function start(
  opts: { verdict?: (token: string) => Promise<RcVerifyResult>; online?: boolean } = {}
): Promise<Harness> {
  let now = T0
  const daemon = new FakeDaemon()
  const router = new WebchatRouter()
  const verify = vi.fn(opts.verdict ?? (async () => VERDICT))
  const cache = new WebchatVerdictCache(verify, () => now)
  const info = vi.fn<(m: string) => void>()
  const log: Logger = { debug: () => {}, info, warn: () => {}, error: () => {} }
  app = Fastify({ logger: false, forceCloseConnections: true })
  route = registerAiSdkChatRoute(app, {
    verify: (token) => cache.verify(token),
    daemons: () => ({
      get: (id: string) =>
        opts.online !== false && id === DAEMON ? (daemon as unknown as RelayDaemonConnection) : undefined,
      rendezvousCandidate: () => undefined
    }),
    router,
    keepaliveMs: 60_000,
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
  opts: { token?: string; signal?: AbortSignal; conversationId?: string } = {}
): Promise<{ stream: ReadableStream<UIMessageChunk>; headers: Headers }> {
  let headers: Headers | undefined
  const transport = new DefaultChatTransport<UIMessage>({
    api: chatUrl(h, opts.conversationId),
    headers: { Authorization: `Bearer ${opts.token ?? TOKEN}` },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await fetch(input, init)
      headers = res.headers
      return res
    }) as typeof fetch
  })
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'client-chat-id',
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

const chatUrl = (h: Harness, conversationId = CONV): string =>
  `${h.base}${RELAY_AI_SDK_CHAT_PATH.replace(':conversationId', conversationId)}`

/** A raw POST, for the answers that come before any stream. */
async function post(h: Harness, body: unknown, token: string | null = TOKEN, conversationId = CONV): Promise<Response> {
  return fetch(chatUrl(h, conversationId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}
const turnBody = (text = 'hello') => ({
  id: 'client-chat-id',
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

describe('POST /ai-sdk/chat/:conversationId', () => {
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
    expect(sent.payload).toEqual({ op: 'turn', text: 'first line\nsecond line', user: 'Ada', userId: 'user-1', turnId })

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

    h.daemon.ack = (m) => ({ msgId: m.msgId, accepted: true, turnId: (m.payload as { turnId: string }).turnId })
    const { stream } = await chat(h)
    finish(h, h.daemon.turns()[2]!)
    expect((await read(stream)).errors).toEqual([])
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

  it('verifies a token once per instance until its exp, and refuses it after', async () => {
    const h = await start({
      verdict: async (token) =>
        token === TOKEN && h.verify.mock.calls.length > 1 ? { ok: false, reason: 'expired' } : VERDICT
    })
    for (const text of ['one', 'two']) {
      const { stream } = await chat(h, [userMessage('u', text)])
      finish(h, h.daemon.turns().at(-1)!)
      await read(stream)
    }
    expect(h.verify).toHaveBeenCalledTimes(1)

    h.setNow(T0 + 300_000)
    const expired = await post(h, turnBody())
    expect(expired.status).toBe(401)
    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(h.daemon.sent).toHaveLength(2)
  })

  it("answers 404 when the path names a conversation other than the token's, and matches it case-insensitively", async () => {
    const h = await start()
    expect((await post(h, turnBody(), TOKEN, FOREIGN_TURN)).status).toBe(404)
    expect((await post(h, turnBody(), TOKEN, 'not-a-uuid')).status).toBe(404)
    expect(h.daemon.sent).toHaveLength(0)

    const { stream } = await chat(h, undefined, { conversationId: CONV.toUpperCase() })
    expect(h.daemon.sent.map((m) => m.chatId)).toEqual([CONV])
    finish(h, h.daemon.turns()[0]!)
    expect((await read(stream)).errors).toEqual([])
  })

  it('refuses a missing or unverifiable token with 401', async () => {
    const h = await start({ verdict: async () => ({ ok: false, reason: 'bad signature' }) })
    expect((await post(h, turnBody(), null)).status).toBe(401)
    expect((await post(h, turnBody())).status).toBe(401)
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
    h.router.rememberRoster(CONV, joined, T0 + 60_000)
    h.setNow(T0 + 120_000)
    const second = await chat(h, [userMessage('u2', 'again')])
    expect(h.verify).toHaveBeenCalledTimes(1) // served from the cache, verified at T0
    finish(h, h.daemon.turns()[1]!)
    await read(second.stream)
    expect(h.router.rosterOf(CONV)).toEqual(joined)
  })

  it('addresses the token’s agent alone in a multi-participant conversation', async () => {
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
    expect(chatRefusalStatus('paused')).toBe(503)
    expect(chatRefusalStatus('no_agent')).toBe(503)
    expect(chatRefusalStatus('start_failed')).toBe(502)
    expect(chatRefusalStatus(undefined)).toBe(502)
  })
})
