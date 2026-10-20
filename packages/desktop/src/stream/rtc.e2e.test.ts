// WebRTC between the desktop's RtcSessions and a werift peer standing in for the browser: direct, and through TURN.
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import type { ComputerIceServer } from '@agentconnect.md/protocol/computer'
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
