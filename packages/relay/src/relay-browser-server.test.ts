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
import type {
  RcVerifyResult,
  RdAck,
  RdChat,
  RdMsgWebchat,
  WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'
import { createRelayBrowserServer, RELAY_WEBCHAT_WS_PATH } from './relay-browser-server.js'
import { WebchatRouter } from './webchat-router.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { Logger } from './log.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const DAEMON = '22222222-2222-4222-8222-222222222222'
const RESUME = '33333333-3333-4333-8333-333333333333'
const ENTITLEMENT: WebchatRemoteMcpEntitlement = {
  authorityId: '44444444-4444-4444-8444-444444444444',
  authorityGeneration: 3,
  expiresAt: '2026-07-31T12:00:00.000Z'
}
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

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
    log?: Logger
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
    opts.verify ??
    (async () =>
      ({ ok: true, agentId: AGENT, daemonId: DAEMON, user: 'ada', conversationId: RESUME }) as RcVerifyResult)
  wss = createRelayBrowserServer({ server: http } as unknown as FastifyInstance, {
    verify,
    daemons,
    router,
    log: opts.log ?? silentLog
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
    const { base } = await start({
      verify: async () => ({ ok: true, agentId: AGENT, conversationId: RESUME })
    }) // no daemonId
    await expect(dial(base, '?token=t')).rejects.toThrow('status:401')
  })

  // A refused dial is invisible on both sides otherwise: the browser is told only that its socket
  // failed, and every reason worth acting on ("agent unplaced", "daemon offline") lives in the CP's
  // verdict. Without this line an operator cannot tell a refusal from a dial that never arrived.
  it('logs the CP verdict behind a refusal', async () => {
    const warnings: string[] = []
    const { base } = await start({
      verify: async () => ({ ok: false, reason: 'agent unplaced' }),
      log: { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {} }
    })
    await expect(dial(base, '?token=t')).rejects.toThrow('status:401')
    expect(warnings.some((w) => w.includes('agent unplaced') && w.includes('401'))).toBe(true)
  })

  it('uses the token-bound conversation id when the compatibility query is omitted', async () => {
    const { base } = await start()
    const ws = await dial(base, '?token=good')
    const ready = await nextFrame(ws, 'ready')
    expect(ready.agentId).toBe(AGENT)
    expect(ready.conversationId).toBe(RESUME)
    ws.close()
  })

  it('accepts a compatibility conversation_id that matches the token binding', async () => {
    const { base } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    const ready = await nextFrame(ws, 'ready')
    expect(ready.conversationId).toBe(RESUME)
    ws.close()
  })

  it('refuses a conversation_id that does not match the token binding', async () => {
    const { base } = await start()
    await expect(dial(base, '?token=good&conversation_id=44444444-4444-4444-8444-444444444444')).rejects.toThrow(
      'status:401'
    )
  })

  it('refuses a webchat verification result without a conversation binding', async () => {
    const { base } = await start({
      verify: async () => ({ ok: true, agentId: AGENT, daemonId: DAEMON, user: 'ada' })
    })
    await expect(dial(base, '?token=legacy')).rejects.toThrow('status:401')
  })

  it('bridges a browser turn to rd/msg and streams the daemon reply back as output/done', async () => {
    const { base, router, sent } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    await nextFrame(ws, 'ready')

    ws.send(JSON.stringify({ text: 'hello agent' }))
    const ack = await nextFrame(ws, 'ack')
    expect(ack).toEqual({ type: 'ack', ack: { accepted: true, agentId: AGENT } })
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

  it.each(['sender', 'viewer'] as const)(
    'streams to both conversation tabs and keeps the other subscribed when the %s closes',
    async (closing) => {
      const { base, router, sent } = await start()
      const sender = await dial(base, '?token=sender')
      await nextFrame(sender, 'ready')
      const viewer = await dial(base, '?token=viewer')
      await nextFrame(viewer, 'ready')
      const tabs = { sender, viewer }
      sender.send(JSON.stringify({ text: 'hello agent', turnId: AGENT }))
      await nextFrame(sender, 'ack')

      const frames: RdChat[] = ['Hello', ' from', ' the agent'].map((text, index) => ({
        chatId: RESUME,
        seq: index,
        event: {
          kind: 'output',
          output: {
            conversationId: RESUME,
            turnId: AGENT,
            agentId: AGENT,
            index,
            event: { kind: 'message', text }
          }
        }
      }))
      frames.push({
        chatId: RESUME,
        seq: frames.length,
        event: {
          kind: 'done',
          done: { conversationId: RESUME, turnId: AGENT, agentId: AGENT, lastIndex: frames.length - 1 }
        }
      })
      for (const frame of frames) router.deliver(frame)
      for (const tab of [sender, viewer]) {
        expect(await nextFrame(tab, 'done')).toEqual({
          type: 'done',
          done: { conversationId: RESUME, turnId: AGENT, agentId: AGENT, lastIndex: 2 }
        })
        expect(tab.frames).toEqual(
          frames.slice(0, -1).map((frame) => ({
            type: 'output',
            output: frame.event.kind === 'output' ? frame.event.output : undefined
          }))
        )
        tab.frames.length = 0
      }

      const post = {
        postId: DAEMON,
        conversationId: RESUME,
        author: { kind: 'agent' as const, agentId: AGENT },
        text: 'Hello from the agent',
        at: 1_000
      }
      router.deliverPost({ conversationId: RESUME, agentId: AGENT, post })
      expect(await nextFrame(sender, 'post')).toEqual({ type: 'post', post })
      expect(await nextFrame(viewer, 'post')).toEqual({ type: 'post', post })

      tabs[closing].close()
      await vi.waitFor(() => expect(sent.some((message) => message.payload.op === 'close')).toBe(true))
      const remaining = closing === 'sender' ? viewer : sender
      expect(router.size()).toBe(1)
      router.deliver(frames.at(-1)!)
      expect((await nextFrame(remaining, 'done')).done).toMatchObject({ turnId: AGENT, lastIndex: 2 })
      remaining.close()
      await vi.waitFor(() => expect(router.size()).toBe(0))
    }
  )

  it('uses only the CP-verified entitlement even when browser fields try to override it', async () => {
    const forged = {
      authorityId: '55555555-5555-4555-8555-555555555555',
      authorityGeneration: 99,
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    const verified: RcVerifyResult = {
      ok: true,
      agentId: AGENT,
      daemonId: DAEMON,
      user: 'ada',
      conversationId: RESUME,
      remoteMcp: { ...ENTITLEMENT }
    }
    const { base, sent } = await start({ verify: async () => verified })
    const ws = await dial(
      base,
      `?token=good&conversation_id=${RESUME}&delegation=${encodeURIComponent(JSON.stringify(forged))}`
    )
    await nextFrame(ws, 'ready')

    ws.send(
      JSON.stringify({
        text: 'trusted binding only',
        remoteMcp: forged,
        payload: { remoteMcp: forged },
        runtime: { model: 'claude', remoteMcp: forged }
      })
    )
    await nextFrame(ws, 'ack')

    expect(sent[0]?.remoteMcp).toEqual(ENTITLEMENT)
    // The relay mints the turn correlation id and the canonical post identity
    // itself (webchat-multi-agents.md §5.1) — neither comes from the browser.
    expect(sent[0]?.payload).toMatchObject({
      op: 'turn',
      text: 'trusted binding only',
      user: 'ada',
      runtime: { model: 'claude' }
    })
    expect(sent[0]?.payload).not.toHaveProperty('remoteMcp')
    ws.close()
  })

  it("forwards the CP-verified stable principal to the daemon, never the browser's claim", async () => {
    const verified: RcVerifyResult = {
      ok: true,
      agentId: AGENT,
      daemonId: DAEMON,
      user: 'Ada Lovelace',
      userId: 'user-1',
      userPicture: 'https://cdn.example.test/avatars/user-1.png',
      conversationId: RESUME
    }
    const { base, sent } = await start({ verify: async () => verified })
    const ws = await dial(base, '?token=good')
    await nextFrame(ws, 'ready')

    ws.send(
      JSON.stringify({ text: 'hi', userId: 'spoofed', user: 'spoofed', userPicture: 'https://evil.example.test/x' })
    )
    await nextFrame(ws, 'ack')

    expect(sent[0]?.payload).toMatchObject({
      op: 'turn',
      user: 'Ada Lovelace',
      userId: 'user-1',
      userPicture: 'https://cdn.example.test/avatars/user-1.png'
    })
    ws.close()
  })

  it('omits the principal claim entirely when the CP verdict carries none', async () => {
    const { base, sent } = await start({
      verify: async () =>
        ({ ok: true, agentId: AGENT, daemonId: DAEMON, user: 'Ada Lovelace', conversationId: RESUME }) as RcVerifyResult
    })
    const ws = await dial(base, '?token=good')
    await nextFrame(ws, 'ready')

    ws.send(JSON.stringify({ text: 'hi' }))
    await nextFrame(ws, 'ack')

    // Absent, not synthesized from the handle — the daemon owns that fallback.
    expect(sent[0]?.payload).toMatchObject({ op: 'turn', user: 'Ada Lovelace' })
    expect(sent[0]?.payload).not.toHaveProperty('userId')
    ws.close()
  })

  it('captures an immutable copy of verified server state for the browser connection', async () => {
    const verifiedEntitlement = { ...ENTITLEMENT }
    const verified: RcVerifyResult = {
      ok: true,
      agentId: AGENT,
      daemonId: DAEMON,
      user: 'ada',
      conversationId: RESUME,
      remoteMcp: verifiedEntitlement
    }
    const { base, sent } = await start({ verify: async () => verified })
    const ws = await dial(base, '?token=good')
    await nextFrame(ws, 'ready')

    verifiedEntitlement.authorityGeneration = 999
    verifiedEntitlement.authorityId = '66666666-6666-4666-8666-666666666666'
    ws.send(JSON.stringify({ text: 'after verifier mutation' }))
    await nextFrame(ws, 'ack')

    expect(sent[0]?.remoteMcp).toEqual(ENTITLEMENT)
    ws.close()
  })

  it('keeps ordinary CP verification output entitlement-free', async () => {
    const { base, sent } = await start()
    const ws = await dial(base, '?token=legacy')
    await nextFrame(ws, 'ready')
    ws.send(JSON.stringify({ text: 'ordinary webchat' }))
    await nextFrame(ws, 'ack')

    expect(sent[0]).not.toHaveProperty('remoteMcp')
    ws.close()
  })

  it('unregisters from the router on browser close', async () => {
    const { base, router } = await start()
    const ws = await dial(base, `?token=good&conversation_id=${RESUME}`)
    await nextFrame(ws, 'ready')
    expect(router.size()).toBe(1)
    ws.close()
    // The server-side unregister runs async after the close handshake — poll (same 2s
    // budget as `nextFrame`); a fixed sleep lost the race on a loaded CI runner.
    await vi.waitFor(() => expect(router.size()).toBe(0), { timeout: 2000, interval: 5 })
  })
})
