// The console viewer through a relay (computer-use.md §7, §10): view tokens, watch-only members, and the TURN gate.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { signComputerChannelToken, type ComputerChannelTokenClaims } from '@agentconnect.md/protocol/computer'
import { Computer } from './computer.js'
import { authenticate, issueClientToken } from './config.js'
import { createRelayedMcpHandler, viewerAuthenticator, viewerPrincipal } from './mcp-access.js'
import { FakeDriver, testConfig } from './testing.js'
import { createComputerMcpServer } from './tools.js'
import { createViewer } from './viewer.js'
import { ChannelAuthority } from './cp/authority.js'
import type { RtcSessions } from './stream/rtc.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const key = randomBytes(32)
const keyId = '1760000000000'
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

const ice = [{ urls: ['turn:turn.example.com:3478'], username: '1:computer', credential: 'c' }]

function viewToken(over: Partial<ComputerChannelTokenClaims> = {}, signWith = key): string {
  const now = Date.now()
  return signComputerChannelToken(
    { aud: 'view', cmp: COMPUTER, kid: keyId, iat: now, exp: now + 120_000, usr: 'user-1', mode: 'control', ...over },
    signWith
  )
}

function harness() {
  const driver = new FakeDriver()
  const issued = issueClientToken(testConfig({ actionScreenshot: false }), 'local')
  const config = issued.config
  const computer = new Computer({ driver, config })
  const authority = new ChannelAuthority({ registered: true })
  stops.push(() => authority.close())
  authority.syncClock(new Date().toISOString())
  authority.accept({
    keyId,
    key: key.toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString()
  })
  const offers: unknown[] = []
  const trickled: unknown[] = []
  const rtc = {
    offer: async (principal: unknown, options: unknown) => {
      offers.push({ principal, options })
      return { id: 'rtc-1', sdp: 'v=0' }
    },
    answer: async () => undefined,
    addCandidate: async (client: string, id: string, candidate: unknown) =>
      void trickled.push({ client, id, candidate }),
    candidates: (_client: string, _id: string, after: number) => ({
      candidates: [{ candidate: 'candidate:1 1 udp 1 203.0.113.9 5000 typ srflx', sdpMid: '0' }].slice(after),
      done: true
    }),
    stop: () => undefined,
    closeAll: () => undefined
  } as unknown as RtcSessions
  const viewer = createViewer({
    computer,
    // The desktop's own wiring: view tokens anywhere, the local client token only on the local port.
    authenticate: viewerAuthenticator(
      (header) => viewerPrincipal(header, authority, () => COMPUTER),
      (header) => authenticate(config, header)
    ),
    log: () => undefined,
    rtc,
    refusal: () => authority.refusal()
  })
  stops.push(() => viewer.close())
  const handle = createRelayedMcpHandler({
    authenticate: () => undefined,
    createMcpServer: ({ client }) => createComputerMcpServer({ computer, client }),
    log: () => undefined,
    viewer: (request) => viewer.api(request)
  })
  const call = async (path: string, token: string | undefined, body?: unknown) => {
    const res = await handle({
      method: body === undefined ? 'GET' : 'POST',
      path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)).toString('base64') })
    })
    const text = res.body ? Buffer.from(res.body, 'base64') : Buffer.alloc(0)
    return { status: res.status, headers: res.headers, body: text }
  }
  const json = async (path: string, token: string | undefined, body?: unknown) => {
    const res = await call(path, token, body)
    return { status: res.status, json: JSON.parse(res.body.toString() || 'null') as Record<string, unknown> }
  }
  return { computer, authority, viewer, offers, trickled, call, json, localToken: issued.token }
}

describe('console viewer through the relay', () => {
  it('serves status, frames and takeover to a member holding a view token', async () => {
    const { computer, call, json } = harness()
    const token = viewToken({ ice })
    const status = await json('/view/api/status', token)
    expect(status).toMatchObject({
      status: 200,
      json: { you: 'console:user-1', mode: 'control', inControl: false, webrtc: { turn: true } }
    })
    const frame = await call('/view/api/frame', token)
    expect(frame.status).toBe(200)
    expect(frame.headers['content-type']).toBe('image/png')
    expect((await json('/view/api/control', token, { action: 'take' })).json).toMatchObject({ inControl: true })
    expect(computer.controlledBy('console:user-1')).toBe(true)
    expect((await json('/view/api/input', token, { type: 'type', text: 'hi' })).status).toBe(200)
    await json('/view/api/control', token, { action: 'release' })
    expect(computer.controlledBy('console:user-1')).toBe(false)
  })

  it('lets a view-mode member watch but never take control or send input', async () => {
    const { json, viewer } = harness()
    const token = viewToken({ mode: 'view' })
    expect((await json('/view/api/status', token)).json).toMatchObject({ mode: 'view', webrtc: { turn: false } })
    expect((await json('/view/api/control', token, { action: 'take' })).status).toBe(403)
    expect((await json('/view/api/input', token, { type: 'type', text: 'hi' })).status).toBe(403)
    await expect(
      viewer.channelMessage({ client: 'console:user-1', control: false }, { input: { type: 'type', text: 'x' } })
    ).rejects.toThrow(/watch/)
  })

  it('refuses a forged, foreign, expired, agent or missing token', async () => {
    const { json } = harness()
    const now = Date.now()
    const agentToken = signComputerChannelToken(
      {
        aud: 'mcp',
        cmp: COMPUTER,
        kid: keyId,
        iat: now,
        exp: now + 60_000,
        ses: 's',
        agt: '00000000-0000-4000-8000-0000000000bb',
        mode: 'control'
      },
      key
    )
    for (const token of [
      viewToken({}, randomBytes(32)),
      viewToken({ cmp: '00000000-0000-4000-8000-000000000002' }),
      viewToken({ iat: now - 200_000, exp: now - 100_000 }),
      agentToken,
      undefined
    ]) {
      expect((await json('/view/api/status', token)).status).toBe(401)
    }
  })

  it('refuses a local client token through the relay, which still works on the local port', async () => {
    const { computer, json, viewer, localToken } = harness()
    expect((await json('/view/api/status', localToken)).status).toBe(401)
    expect((await json('/view/api/control', localToken, { action: 'take' })).status).toBe(401)
    expect((await json('/view/api/input', localToken, { type: 'type', text: 'hi' })).status).toBe(401)
    expect(computer.controlledBy('local')).toBe(false)
    const local = await viewer.api({
      method: 'GET',
      path: '/view/api/status',
      authorization: `Bearer ${localToken}`,
      via: 'local'
    })
    expect(local.status).toBe(200)
  })

  it('offers TURN only when the token carries TURN servers, and passes the transport to WebRTC', async () => {
    const { json, offers } = harness()
    expect((await json('/view/api/rtc/offer', viewToken(), { transport: 'turn' })).status).toBe(409)
    expect((await json('/view/api/rtc/offer', viewToken({ ice }), { transport: 'turn' })).status).toBe(200)
    expect((await json('/view/api/rtc/offer', viewToken(), {})).status).toBe(200)
    expect(offers).toMatchObject([
      { principal: { client: 'console:user-1', iceServers: ice }, options: { transport: 'turn' } },
      { options: { transport: 'direct' } }
    ])
  })

  it('offers hole punching only when the token names STUN servers, and trickles candidates both ways', async () => {
    const { json, offers, trickled } = harness()
    const stun = ['stun:stun-0.example.com:3478']
    expect((await json('/view/api/status', viewToken({ stun }))).json).toMatchObject({ webrtc: { stun: true } })
    expect((await json('/view/api/status', viewToken())).json).toMatchObject({ webrtc: { stun: false } })
    const refused = await json('/view/api/rtc/offer', viewToken(), { transport: 'stun' })
    expect(refused).toMatchObject({ status: 409, json: { error: 'stun_unavailable' } })
    expect((await json('/view/api/rtc/offer', viewToken({ stun }), { transport: 'stun' })).status).toBe(200)
    expect(offers).toMatchObject([{ principal: { stunUrls: stun }, options: { transport: 'stun' } }])
    const candidate = { candidate: 'candidate:2 1 udp 1 198.51.100.4 6000 typ srflx', sdpMid: '0', sdpMLineIndex: 0 }
    expect((await json('/view/api/rtc/candidate', viewToken({ stun }), { id: 'rtc-1', candidate })).status).toBe(200)
    expect((await json('/view/api/rtc/candidate', viewToken({ stun }), { id: 'rtc-1', candidate: null })).status).toBe(
      200
    )
    expect(trickled).toEqual([
      { client: 'console:user-1', id: 'rtc-1', candidate },
      { client: 'console:user-1', id: 'rtc-1', candidate: null }
    ])
    expect((await json('/view/api/rtc/candidates', viewToken({ stun }), { id: 'rtc-1' })).json).toMatchObject({
      candidates: [{ sdpMid: '0' }],
      done: true
    })
    expect((await json('/view/api/rtc/candidate', viewToken({ stun }), { id: 'rtc-1' })).status).toBe(400)
  })

  it('stops serving frames once the channel key is gone, and the token stops holding', async () => {
    const { authority, json } = harness()
    const token = viewToken()
    authority.revoke('test')
    expect((await json('/view/api/frame', token)).status).toBe(401)
  })
})
