import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import {
  RELAY_COMPUTER_SUBPROTOCOL,
  buildRelayComputerFrame,
  decodeRelayComputerFrame,
  type RcVerifyResult,
  type RelayComputerFrame
} from '@agentconnect.md/protocol'
import { createComputerRelay, type ComputerRelay } from './computer-relay.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

async function start(
  verify: (token: string, computerId: string) => Promise<RcVerifyResult> = async (_t, computerId) => ({
    ok: true,
    computerId
  }),
  requestTimeoutMs = 2_000
): Promise<{ base: string; relay: ComputerRelay }> {
  app = Fastify()
  const relay = createComputerRelay(app, { verify, relayId: () => 'relay-1', log: quiet, requestTimeoutMs })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  return { base: address, relay }
}

// A desktop daemon's end of the wire: attaches, then answers each forwarded request with `answer`.
async function desktop(
  base: string,
  answer: (req: Extract<RelayComputerFrame, { type: 'cr/http' }>) => object | undefined = () => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' },
    body: Buffer.from('{"ok":true}').toString('base64')
  })
): Promise<{ ws: WebSocket; hello: RelayComputerFrame; seen: RelayComputerFrame[] }> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/cr/ws`, [RELAY_COMPUTER_SUBPROTOCOL])
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const seen: RelayComputerFrame[] = []
  const hello = new Promise<RelayComputerFrame>((resolve) => {
    ws.on('message', (data: Buffer) => {
      const decoded = decodeRelayComputerFrame(data.toString())
      if (!decoded.ok) return
      const frame = decoded.frame
      seen.push(frame)
      if (frame.type === 'cr/hello/ok' || frame.type === 'error') resolve(frame)
      if (frame.type === 'cr/http') {
        const res = answer(frame)
        if (res) ws.send(JSON.stringify(buildRelayComputerFrame('cr/http/result', res as never, { corr: frame.id })))
      }
    })
  })
  ws.send(
    JSON.stringify(
      buildRelayComputerFrame('cr/hello', { computerId: COMPUTER, token: 'actk1.a.b', desktopDaemonVersion: '0.1.0' })
    )
  )
  return { ws, hello: await hello, seen }
}

const call = (base: string, init: RequestInit = {}, computerId = COMPUTER) =>
  fetch(`${base}/cr/computers/${computerId}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer actk1.x.y', 'content-type': 'application/json', cookie: 'secret=1' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    ...init
  })

describe('computer relay', () => {
  it("forwards an agent's MCP request to the attached desktop and its answer back, minus other headers", async () => {
    const { base, relay } = await start()
    const { hello, seen, ws } = await desktop(base)
    expect(hello).toMatchObject({ type: 'cr/hello/ok', payload: { relayId: 'relay-1' } })
    expect(relay.attached(COMPUTER)).toBe(true)
    const res = await call(base)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toBeNull()
    const forwarded = seen.find((f) => f.type === 'cr/http')
    expect(forwarded?.payload).toMatchObject({
      method: 'POST',
      path: '/mcp',
      headers: { authorization: 'Bearer actk1.x.y', 'content-type': 'application/json' }
    })
    expect((forwarded?.payload as { headers: Record<string, string> }).headers.cookie).toBeUndefined()
    expect(Buffer.from((forwarded?.payload as { body: string }).body, 'base64').toString()).toContain('tools/list')
    ws.close()
  })

  it('answers 503 for a Computer not attached here, 401 without a bearer and 405 to a GET, never reaching a desktop', async () => {
    const { base } = await start()
    const { seen, ws } = await desktop(base)
    const missing = await call(base, {}, '00000000-0000-4000-8000-000000000002')
    expect(missing.status).toBe(503)
    expect(await missing.json()).toEqual({ error: 'computer_not_attached' })
    const anonymous = await call(base, { headers: { 'content-type': 'application/json' } })
    expect(anonymous.status).toBe(401)
    // A buffered relay carries no standalone SSE stream, so a GET never takes a slot.
    const stream = await call(base, {
      method: 'GET',
      headers: { authorization: 'Bearer actk1.x.y', accept: 'text/event-stream' },
      body: null
    })
    expect(stream.status).toBe(405)
    expect(stream.headers.get('allow')).toBe('POST, DELETE')
    expect(seen.filter((f) => f.type === 'cr/http')).toEqual([])
    ws.close()
  })

  it("forwards a console viewer's API call with CORS, only its bearer and content type, and the frame headers back", async () => {
    const { base } = await start()
    const { seen, ws } = await desktop(base, (frame) => ({
      status: 200,
      headers: { 'content-type': 'image/png', 'x-frame-width': '1280', 'x-frame-height': '720', 'set-cookie': 'x=1' },
      body: Buffer.from(frame.payload.path).toString('base64')
    }))
    const view = `${base}/cr/computers/${COMPUTER}/view/api`
    const preflight = await fetch(`${view}/rtc/offer`, {
      method: 'OPTIONS',
      headers: { origin: 'https://console.example.com', 'access-control-request-method': 'POST' }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const frame = await fetch(`${view}/frame`, { headers: { authorization: 'Bearer actk1.v.w', cookie: 'secret=1' } })
    expect(frame.status).toBe(200)
    expect(frame.headers.get('access-control-allow-origin')).toBe('*')
    expect(frame.headers.get('x-frame-width')).toBe('1280')
    expect(frame.headers.get('set-cookie')).toBeNull()
    expect(await frame.text()).toBe('/view/api/frame')
    const offer = await fetch(`${view}/rtc/offer`, {
      method: 'POST',
      headers: { authorization: 'Bearer actk1.v.w', 'content-type': 'application/json' },
      body: '{"transport":"turn"}'
    })
    expect(offer.status).toBe(200)
    const forwarded = seen
      .filter((f) => f.type === 'cr/http')
      .map((f) => f.payload as { path: string; headers: object })
    expect(forwarded.map((f) => f.path)).toEqual(['/view/api/frame', '/view/api/rtc/offer'])
    expect(forwarded[0]?.headers).toEqual({ authorization: 'Bearer actk1.v.w' })
    // No bearer, a path outside the viewer API, or a Computer not attached here never reach a desktop.
    expect((await fetch(`${view}/status`)).status).toBe(401)
    const auth = { headers: { authorization: 'Bearer actk1.v.w' } }
    expect((await fetch(`${view}/a%2F..%2F..%2Fmcp`, auth)).status).toBe(404)
    const other = await fetch(`${base}/cr/computers/00000000-0000-4000-8000-000000000002/view/api/status`, auth)
    expect(other.status).toBe(503)
    expect(other.headers.get('access-control-allow-origin')).toBe('*')
    expect(seen.filter((f) => f.type === 'cr/http')).toHaveLength(2)
    ws.close()
  })

  it('refuses a desktop whose token the CP does not accept', async () => {
    const { base, relay } = await start(async () => ({ ok: false, reason: 'invalid credential' }))
    const { hello, ws } = await desktop(base)
    expect(hello).toMatchObject({ type: 'error', payload: { code: 'AUTH_FAILED' } })
    const code = await new Promise<number>((resolve) => ws.once('close', resolve))
    expect(code).toBe(4401)
    expect(relay.attached(COMPUTER)).toBe(false)
  })

  it('times out a desktop that never answers and keeps the newest link for a Computer', async () => {
    const { base, relay } = await start(undefined, 200)
    const first = await desktop(base, () => undefined)
    const res = await call(base)
    expect(res.status).toBe(504)
    const closed = new Promise<number>((resolve) => first.ws.once('close', resolve))
    const second = await desktop(base)
    expect(await closed).toBe(1012)
    expect(relay.size()).toBe(1)
    expect((await call(base)).status).toBe(200)
    second.ws.close()
  })
})
