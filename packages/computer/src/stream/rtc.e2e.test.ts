// WebRTC between the desktop's RtcSessions and a werift peer standing in for the browser: direct, hole-punched, and through TURN.
import { createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import type { ComputerIceServer } from '@agentconnect.md/protocol/computer'
import { startStunServer } from '../../../relay/src/stun-server.js'
import { TurnServer } from '../../../relay/src/turn/server.js'
import { startTurnListeners } from '../../../relay/src/turn/listeners.js'
import { RtcSessions } from './rtc.js'
import type { ScreenStream } from './screen-stream.js'
import type { ViewerPrincipal } from '../viewer.js'

// A coturn with `use-auth-secret` to test the relay path against, e.g. `turn:127.0.0.1:3478` and its static-auth-secret.
const TURN_URL = process.env.COMPUTER_TEST_TURN_URL
const TURN_SECRET = process.env.COMPUTER_TEST_TURN_SECRET

const stream = { subscribe: () => () => undefined } as unknown as ScreenStream
const opened: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of opened.splice(0)) await close()
})

function sessions(reauthorize?: (token: string) => ViewerPrincipal | undefined) {
  const messages: unknown[] = []
  const rtc = new RtcSessions({
    stream,
    log: () => undefined,
    onMessage: async (principal, message) => {
      messages.push({ client: principal.client, message })
      return 'applied'
    },
    ...(reauthorize ? { reauthorize } : {})
  })
  opened.push(() => rtc.stop())
  return { rtc, messages }
}

// The browser's side: answer the desktop's offer, gather fully (no trickle), and wait for the input channel.
async function browser(
  rtc: RtcSessions,
  principal: ViewerPrincipal,
  options: Parameters<RtcSessions['offer']>[1],
  iceServers: ComputerIceServer[] = []
): Promise<{ pc: RTCPeerConnection; channel: RTCDataChannel; request: (m: object) => Promise<unknown> }> {
  const offer = await rtc.offer(principal, options)
  const pc = new RTCPeerConnection({
    iceServers,
    ...(options?.transport === 'turn' ? { iceTransportPolicy: 'relay' as const } : {}),
    iceUseIpv6: false
  })
  opened.push(() => pc.close())
  const channel = new Promise<RTCDataChannel>((resolve) => pc.onDataChannel.subscribe(resolve))
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
  await pc.setLocalDescription(await pc.createAnswer())
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) =>
      pc.iceGatheringStateChange.subscribe((state) => (state === 'complete' ? resolve() : undefined))
    )
  }
  await rtc.answer(principal.client, offer.id, pc.localDescription!.sdp)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not connected: ${pc.connectionState}`)), 20_000)
    if (pc.connectionState === 'connected') return resolve()
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const open = await channel
  if (open.readyState !== 'open') await new Promise((resolve) => open.stateChanged.subscribe(resolve))
  let seq = 0
  const request = (message: object) =>
    new Promise<unknown>((resolve) => {
      const id = ++seq
      const sub = open.onMessage.subscribe((data) => {
        const reply = JSON.parse(data.toString()) as { seq: number }
        if (reply.seq !== id) return
        sub.unSubscribe()
        resolve(reply)
      })
      open.send(JSON.stringify({ seq: id, ...message }))
    })
  return { pc, channel: open, request }
}

// The browser's side of the `stun` path: answer at once, then trickle candidates both ways over the signaling calls.
async function trickleBrowser(
  rtc: RtcSessions,
  principal: ViewerPrincipal,
  stunUrls: string[]
): Promise<{ offerSdp: string; pc: RTCPeerConnection; channel: RTCDataChannel }> {
  const offer = await rtc.offer(principal, { transport: 'stun' })
  const pc = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })), iceUseIpv6: false })
  opened.push(() => pc.close())
  const channel = new Promise<RTCDataChannel>((resolve) => pc.onDataChannel.subscribe(resolve))
  let sent = Promise.resolve()
  pc.onIceCandidate.subscribe((candidate) => {
    const init = candidate ? candidate.toJSON() : null
    sent = sent.then(() => rtc.addCandidate(principal.client, offer.id, init))
  })
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
  const answer = await pc.createAnswer()
  sent = sent.then(() => rtc.answer(principal.client, offer.id, answer.sdp))
  await pc.setLocalDescription(answer)
  let after = 0
  const poll = setInterval(() => {
    const late = rtc.candidates(principal.client, offer.id, after)
    after += late.candidates.length
    for (const candidate of late.candidates) {
      void pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined
      })
    }
  }, 200)
  opened.push(() => clearInterval(poll))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not connected: ${pc.connectionState}`)), 20_000)
    if (pc.connectionState === 'connected') return resolve()
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await sent
  return { offerSdp: offer.sdp, pc, channel: await channel }
}

describe('viewer WebRTC', () => {
  it('connects directly with ICE-lite host candidates and carries input over the DataChannel', async () => {
    const { rtc, messages } = sessions()
    const { request } = await browser(rtc, { client: 'console:u1', control: true }, { hostAddress: '127.0.0.1' })
    expect(await request({ input: { type: 'key', keys: ['escape'] } })).toMatchObject({ ok: true, result: 'applied' })
    expect(messages).toEqual([{ client: 'console:u1', message: expect.objectContaining({ input: expect.anything() }) }])
    expect(rtc.size()).toBe(1)
  }, 30_000)

  it('renews a session only with a token for the same viewer', async () => {
    let valid = true
    const principal: ViewerPrincipal = { client: 'console:u1', control: true, valid: () => valid }
    const { rtc } = sessions((token) =>
      token === 'fresh'
        ? { client: 'console:u1', control: true, valid: () => true }
        : { client: 'console:u2', control: true }
    )
    const { request } = await browser(rtc, principal, { hostAddress: '127.0.0.1' })
    expect(await request({ type: 'auth', token: 'other' })).toMatchObject({ ok: false, error: 'viewer token refused' })
    valid = false
    expect(await request({ type: 'auth', token: 'fresh' })).toMatchObject({ ok: true })
    // The renewed token holds, so the reaper keeps the session past the old one's lapse.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(rtc.size()).toBe(1)
  }, 30_000)

  it('closes a session whose token lapsed without renewal', async () => {
    let valid = true
    const { rtc } = sessions()
    await browser(rtc, { client: 'console:u1', control: true, valid: () => valid }, { hostAddress: '127.0.0.1' })
    valid = false
    await expect.poll(() => rtc.size(), { timeout: 5000 }).toBe(0)
  }, 30_000)

  it('hole-punches with full ICE through a STUN server, trickling candidates both ways', async () => {
    const stun = await startStunServer({
      host: '127.0.0.1',
      port: 0,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    })
    opened.push(() => stun.close())
    const stunUrls = [`stun:127.0.0.1:${stun.port}`]
    const { rtc, messages } = sessions()
    const principal: ViewerPrincipal = { client: 'console:u1', control: true, stunUrls }
    const { offerSdp, channel, pc } = await trickleBrowser(rtc, principal, stunUrls)
    // Full ICE, not ICE-lite: the desktop runs its own connectivity checks.
    expect(offerSdp).not.toMatch(/a=ice-lite/)
    // The desktop's server-reflexive address reaches the browser by trickle, after the desktop has sent to the browser.
    expect(offerSdp).not.toMatch(/typ srflx/)
    expect(offerSdp).not.toMatch(/a=end-of-candidates/)
    // …and the browser takes it, rather than dropping it as arriving after the end of candidates.
    await expect
      .poll(() => pc.iceTransports[0]?.connection.remoteCandidates.map((c) => c.type), { timeout: 5000 })
      .toContain('srflx')
    if (channel.readyState !== 'open') await new Promise((resolve) => channel.stateChanged.subscribe(resolve))
    const reply = new Promise((resolve) => channel.onMessage.subscribe((data) => resolve(JSON.parse(data.toString()))))
    channel.send(JSON.stringify({ seq: 1, input: { type: 'key', keys: ['escape'] } }))
    expect(await reply).toMatchObject({ seq: 1, ok: true, result: 'applied' })
    expect(messages).toHaveLength(1)
  }, 30_000)

  it('withholds the desktop’s server-reflexive candidate until the browser has none left to send', async () => {
    const stun = await startStunServer({
      host: '127.0.0.1',
      port: 0,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    })
    opened.push(() => stun.close())
    const stunUrls = [`stun:127.0.0.1:${stun.port}`]
    const { rtc } = sessions()
    const principal: ViewerPrincipal = { client: 'console:u1', control: true, stunUrls }
    const offer = await rtc.offer(principal, { transport: 'stun' })
    const types = () =>
      rtc.candidates(principal.client, offer.id, 0).candidates.map((c) => / typ (\w+)/.exec(c.candidate)?.[1])
    expect(offer.sdp).not.toMatch(/typ srflx/)
    expect(types()).not.toContain('srflx')
    expect(rtc.candidates(principal.client, offer.id, 0).done).toBe(false)
    // The browser's end of gathering without a public candidate releases it: there is no mapping to open first.
    rtc.addCandidate(principal.client, offer.id, null)
    expect(types()).toContain('srflx')
  }, 30_000)

  it('answers within the STUN deadline when the STUN server never replies, and still connects on host candidates', async () => {
    const silent = createSocket('udp4')
    await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', resolve))
    opened.push(() => new Promise<void>((resolve) => silent.close(() => resolve())))
    const stunUrls = [`stun:127.0.0.1:${silent.address().port}`]
    const { rtc } = sessions()
    const principal: ViewerPrincipal = { client: 'console:u1', control: true, stunUrls }
    const started = Date.now()
    const offer = await rtc.offer(principal, { transport: 'stun' })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(offer.sdp).toMatch(/typ host/)
    const connecting = Date.now()
    const { channel } = await trickleBrowser(rtc, principal, [])
    expect(channel.label).toBe('input')
    // Within the browser's eight-second punch attempt, counted from the offer call.
    expect(Date.now() - connecting).toBeLessThan(8000)
  }, 30_000)

  it('takes no trickled candidate on an ICE-lite session or for another viewer', async () => {
    const { rtc } = sessions()
    const offer = await rtc.offer({ client: 'console:u1', control: true }, { hostAddress: '127.0.0.1' })
    const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    expect(() => rtc.addCandidate('console:u1', offer.id, candidate)).toThrow(/ICE-lite/)
    expect(() => rtc.candidates('console:u2', offer.id, 0)).toThrow(/unknown viewer session/)
  }, 30_000)

  it.skipIf(!TURN_URL || !TURN_SECRET)(
    'relays media through TURN when both sides are forced to relay candidates',
    async () => {
      const credentials = (who: string): ComputerIceServer => {
        const username = `${Math.floor(Date.now() / 1000) + 600}:${who}`
        return {
          urls: [TURN_URL!],
          username,
          credential: createHmac('sha1', TURN_SECRET!).update(username).digest('base64')
        }
      }
      const { rtc } = sessions()
      const principal = { client: 'console:u1', control: true, iceServers: [credentials('computer')] }
      const { pc, request } = await browser(rtc, principal, { transport: 'turn' }, [credentials('viewer')])
      expect(pc.localDescription!.sdp).toMatch(/typ relay/)
      expect(await request({ input: { type: 'key', keys: ['escape'] } })).toMatchObject({ ok: true })
    },
    40_000
  )

  // The relay's own TURN server (computer-use.md §7.2), with the CP's REST credentials; both peers relay-only.
  for (const transport of ['udp', 'tcp'] as const) {
    it(`relays media through the relay's TURN over ${transport}`, async () => {
      const secret = 'relay-turn-secret-0123456789abcdefghijklmnop'
      const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
      const turn = new TurnServer({
        realm: 'agentconnect',
        relayedAddress: '198.18.0.9',
        secret: () => secret,
        limits: { maxAllocations: 20, maxAllocationsPerUser: 8, maxBitsPerSecond: 10_000_000, idleTimeoutMs: 60_000 },
        log: quiet
      })
      const listeners = await startTurnListeners({ turn, host: '127.0.0.1', port: 0, maxConnections: 20, log: quiet })
      opened.push(
        () => listeners.close(),
        () => turn.close()
      )
      const port = transport === 'udp' ? listeners.udpPort : listeners.tcpPort
      const credentials = (who: string): ComputerIceServer => {
        const username = `${Math.floor(Date.now() / 1000) + 600}:${who}`
        return {
          urls: [`turn:127.0.0.1:${port}?transport=${transport}`],
          username,
          credential: createHmac('sha1', secret).update(username).digest('base64')
        }
      }
      const { rtc } = sessions()
      const principal = { client: 'console:u1', control: true, iceServers: [credentials('computer-c1')] }
      const { pc, request } = await browser(rtc, principal, { transport: 'turn' }, [credentials('viewer-u1')])
      expect(pc.localDescription!.sdp).toMatch(/198\.18\.0\.9 \d+ typ relay/)
      expect(await request({ input: { type: 'key', keys: ['escape'] } })).toMatchObject({ ok: true })
      expect(turn.allocations).toBeGreaterThanOrEqual(2)
    }, 40_000)
  }

  it('refuses a TURN offer when the TURN server gives no relay candidate', async () => {
    const { rtc } = sessions()
    const principal = {
      client: 'console:u1',
      control: true,
      iceServers: [{ urls: ['turn:127.0.0.1:9'], username: '1:x', credential: 'x' }]
    }
    await expect(rtc.offer(principal, { transport: 'turn' })).rejects.toThrow(/relay candidate/)
    expect(rtc.size()).toBe(0)
  }, 30_000)
})
