/**
 * `createRelayBrowserServer` end-to-end over a REAL http upgrade + a real `ws` browser
 * client (shared-bot-relay.md §7.2 / §10). Proves the security gate (token verify BEFORE
 * the handshake completes) and the bidirectional bridge: a browser `{text}` becomes an
 * `rd/msg(turn)` on the target daemon, and a daemon `rd/chat` (via the router) comes back
 * as `{type:'output'|'done'}`. The daemon side is faked — the daemon-facing wire has its
 * own suites (`relay-daemon-*.test.ts`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { RcVerifyResult, RdAck, RdMsgWebchat } from '@agentconnect.md/protocol'
import { createRelayBrowserServer, RELAY_WEBCHAT_WS_PATH } from './relay-browser-server.js'
import { WebchatRouter } from './webchat-router.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { Logger } from './log.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const DAEMON = '22222222-2222-4222-8222-222222222222'
const RESUME = '33333333-3333-4333-8333-333333333333'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let http: Server | undefined
let wss: ReturnType<typeof createRelayBrowserServer> | undefined

afterEach(async () => {
  for (const ws of wss?.clients ?? []) ws.terminate()
  wss?.close()
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()))
  http = undefined
  wss = undefined
})

interface Harness {
  base: string
  router: WebchatRouter
  sendMsg: ReturnType<typeof vi.fn>
  sent: RdMsgWebchat[]
}

async function start(
  opts: {
    verify?: (kind: 'webchat-token', token: string) => Promise<RcVerifyResult>
    daemon?: RelayDaemonConnection | undefined
    ack?: RdAck
  } = {}
): Promise<Harness> {
  http = createServer()
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', () => r()))
  const router = new WebchatRouter()
  const sent: RdMsgWebchat[] = []
  const sendMsg = vi.fn(async (m: RdMsgWebchat): Promise<RdAck> => {
    sent.push(m)
    return opts.ack ?? { msgId: m.msgId, accepted: true }
  })
  const daemon = 'daemon' in opts ? opts.daemon : ({ sendMsg } as unknown as RelayDaemonConnection)
  const daemons = { get: (id: string) => (id === DAEMON ? daemon : undefined) } as unknown as RelayDaemonServer
  const verify =
    opts.verify ?? (async () => ({ ok: true, agentId: AGENT, daemonId: DAEMON, user: 'ada' }) as RcVerifyResult)
  wss = createRelayBrowserServer({ server: http } as unknown as FastifyInstance, {
    verify,
    daemons,
    router,
    log: silentLog
  })
  const port = (http.address() as AddressInfo).port
  return { base: `ws://127.0.0.1:${port}`, router, sendMsg, sent }
}

type Frame = Record<string, unknown>
interface BufferedWs extends WebSocket {
  frames: Frame[]
}

/**
 * Dial the /webchat path; resolves the open socket or rejects with the HTTP status on
 * refuse. The server sends `ready` UNPROMPTED right after the 101, so a `message`
 * listener attached only after `open` could miss it — buffer every frame from dial time.
 */
function dial(base: string, query: string): Promise<BufferedWs> {
  const ws = new WebSocket(`${base}${RELAY_WEBCHAT_WS_PATH}${query}`) as BufferedWs
  ws.frames = []
  ws.on('message', (d: Buffer) => ws.frames.push(JSON.parse(d.toString()) as Frame))
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status:${res.statusCode}`)))
    ws.once('error', (e) => reject(e))
  })
}
/** Resolve the first buffered frame of `type` (consuming it), polling until it arrives. */
async function nextFrame(ws: BufferedWs, type: string): Promise<Frame> {
  const deadline = Date.now() + 2000
  for (;;) {
    const i = ws.frames.findIndex((f) => f.type === type)
    if (i >= 0) return ws.frames.splice(i, 1)[0]!
    if (Date.now() > deadline) throw new Error(`no ${type} frame within 2s`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('createRelayBrowserServer (browser webchat edge)', () => {
  it('refuses a dial with no token (401) — never completes the handshake', async () => {
    const { base } = await start()
    await expect(dial(base, '')).rejects.toThrow('status:401')
  })

  it('refuses a token the CP rejects (401)', async () => {
    const { base } = await start({ verify: async () => ({ ok: false, reason: 'expired' }) })
    await expect(dial(base, '?token=bad')).rejects.toThrow('status:401')
  })

  it('refuses (503, retryable) when the relay↔CP verify link is down', async () => {
    const { base } = await start({
      verify: async () => {
        throw new Error('link down')
      }
    })
    await expect(dial(base, '?token=t')).rejects.toThrow('status:503')
  })

  it('refuses when the token verifies but resolves no live placement (401)', async () => {
    const { base } = await start({ verify: async () => ({ ok: true, agentId: AGENT }) }) // no daemonId
    await expect(dial(base, '?token=t')).rejects.toThrow('status:401')
  })

  it('accepts a valid token and greets with a ready frame carrying a fresh conversation id', async () => {
    const { base } = await start()
    const ws = await dial(base, '?token=good')
    const ready = await nextFrame(ws, 'ready')
    expect(ready.agentId).toBe(AGENT)
    expect(UUID_RE.test(String(ready.conversationId))).toBe(true)
    ws.close()
  })

  it('honors ?conversation_id= to resume (ready echoes the same id)', async () => {
    const { base } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    const ready = await nextFrame(ws, 'ready')
    expect(ready.conversationId).toBe(RESUME)
    ws.close()
  })

  it('bridges a browser turn to rd/msg and streams the daemon reply back as output/done', async () => {
    const { base, router, sent } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    await nextFrame(ws, 'ready')

    ws.send(JSON.stringify({ text: 'hello agent' }))
    const ack = await nextFrame(ws, 'ack')
    expect(ack).toEqual({ type: 'ack', ack: { accepted: true } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      source: 'webchat',
      agentId: AGENT,
      chatId: RESUME,
      payload: { op: 'turn', text: 'hello agent' }
    })

    // The daemon streams a reply chunk then a done — the router forwards to this browser.
    router.deliver({
      chatId: RESUME,
      seq: 0,
      event: {
        kind: 'output',
        output: { conversationId: RESUME, turnId: AGENT, index: 0, status: { model: 'claude' } }
      }
    })
    router.deliver({ chatId: RESUME, seq: 1, event: { kind: 'done', done: { conversationId: RESUME, turnId: AGENT } } })
    expect((await nextFrame(ws, 'output')).output).toMatchObject({ conversationId: RESUME })
    expect((await nextFrame(ws, 'done')).done).toMatchObject({ conversationId: RESUME })
    ws.close()
  })

  it('unregisters from the router on browser close', async () => {
    const { base, router } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    await nextFrame(ws, 'ready')
    expect(router.size()).toBe(1)
    ws.close()
    await tick()
    expect(router.size()).toBe(0)
  })
})
