// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerViewerGrantDto } from '@/lib/api'
import { ComputerViewerSession, keyToInput, type ViewerState } from './computer-viewer'

const ID = '00000000-0000-4000-8000-000000000001'
const status = {
  you: 'console:u1',
  mode: 'control',
  inControl: false,
  os: 'linux',
  status: 'online',
  paused: null,
  unavailable: null,
  lease: null,
  webrtc: { unavailable: null, error: null, turn: true }
}

function grant(over: Partial<ComputerViewerGrantDto> = {}): ComputerViewerGrantDto {
  return {
    token: 'actk1.view.1',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    expiresInMs: 120_000,
    mode: 'control',
    relays: ['https://relay-a.example.com', 'https://relay-b.example.com'],
    iceServers: [{ urls: ['turn:turn.example.com:3478'], username: '1:viewer-u1', credential: 'c' }],
    stunUrls: [],
    ...over
  }
}

// A stand-in for the browser's RTCPeerConnection: connects, or fails, as the test says per transport.
class FakeChannel {
  readyState = 'open'
  sent: string[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }
  send(data: string) {
    this.sent.push(data)
    if (data === 'ping') return
    const { seq } = JSON.parse(data) as { seq: number }
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ seq, ok: true, result: null }) } as MessageEvent))
  }
}

// The candidate types a peer reports for its selected pair, as `getStats` would.
const routeStats = (local: string, remote: string) =>
  new Map<string, object>([
    ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
    ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
    ['L', { id: 'L', type: 'local-candidate', candidateType: local }],
    ['R', { id: 'R', type: 'remote-candidate', candidateType: remote }]
  ])

function peers(
  outcome: (config: RTCConfiguration) => 'connected' | 'failed',
  onCreate?: () => void,
  stats?: Map<string, object>
) {
  const created: {
    config: RTCConfiguration
    channel: FakeChannel
    closed: boolean
    added: RTCIceCandidateInit[]
    drop: () => void
  }[] = []
  const createPeer = (config: RTCConfiguration) => {
    onCreate?.()
    const record = {
      config,
      channel: new FakeChannel(),
      closed: false,
      added: [] as RTCIceCandidateInit[],
      drop: () => undefined as void
    }
    created.push(record)
    const pc = {
      connectionState: 'new',
      iceGatheringState: 'complete',
      localDescription: null as RTCSessionDescriptionInit | null,
      onconnectionstatechange: null as (() => void) | null,
      onicecandidate: null as ((event: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null,
      ontrack: null,
      ondatachannel: null as ((event: { channel: FakeChannel }) => void) | null,
      async setRemoteDescription() {},
      async createAnswer() {
        return { type: 'answer', sdp: 'v=0 answer' }
      },
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        pc.localDescription = description
        // A trickling browser reports its candidates after the answer is set, then the end of gathering.
        queueMicrotask(() => {
          pc.onicecandidate?.({
            candidate: { toJSON: () => ({ candidate: 'candidate:b 1 udp 1 198.51.100.7 6000 typ srflx', sdpMid: '0' }) }
          })
          pc.onicecandidate?.({ candidate: null })
        })
      },
      async addIceCandidate(candidate: RTCIceCandidateInit) {
        record.added.push(candidate)
      },
      ...(stats ? { getStats: async () => stats } : {}),
      close() {
        record.closed = true
      }
    }
    record.drop = () => {
      pc.connectionState = 'disconnected'
      pc.onconnectionstatechange?.()
    }
    // The connection settles once the answer has been posted, as ICE would.
    setTimeout(() => {
      pc.ondatachannel?.({ channel: record.channel })
      pc.connectionState = outcome(config)
      pc.onconnectionstatechange?.()
    }, 5)
    return pc as unknown as RTCPeerConnection
  }
  return { created, createPeer }
}

function relayFetch(opts: { attachedOn?: string; offerFails?: boolean; stun?: boolean } = {}) {
  const calls: { url: string; method: string; body?: unknown; auth: string | null }[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init.method ?? 'GET', body, auth: new Headers(init.headers).get('authorization') })
    if (opts.attachedOn && !url.startsWith(opts.attachedOn)) {
      return new Response(JSON.stringify({ error: 'computer_not_attached' }), { status: 503 })
    }
    const endpoint = url.split('/view/api/')[1]
    if (endpoint === 'status')
      return Response.json({ ...status, webrtc: { ...status.webrtc, stun: opts.stun ?? false } })
    if (endpoint === 'rtc/offer') return Response.json({ id: 'rtc-1', sdp: 'v=0 offer', candidates: 1 })
    if (endpoint === 'rtc/answer' || endpoint === 'rtc/candidate') return Response.json({ ok: true })
    if (endpoint === 'rtc/candidates') {
      const desktop = [
        { candidate: 'candidate:h 1 udp 2 10.0.0.9 5000 typ host', sdpMid: '0' },
        { candidate: 'candidate:d 1 udp 1 203.0.113.9 5000 typ srflx', sdpMid: '0' }
      ]
      return Response.json({ candidates: desktop.slice(body.after), done: true })
    }
    if (endpoint === 'control') return Response.json({ ...status, inControl: body.action === 'take' })
    if (endpoint === 'frame') return new Response(new Blob(['png']), { headers: { 'content-type': 'image/png' } })
    return new Response('{}', { status: 404 })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const sessions: ComputerViewerSession[] = []
afterEach(() => {
  for (const s of sessions.splice(0)) s.stop()
})

function open(opts: {
  grant?: ComputerViewerGrantDto
  fetch: typeof fetch
  createPeer: (c: RTCConfiguration) => RTCPeerConnection
}) {
  const states: ViewerState[] = []
  const grants = vi.fn(async () => opts.grant ?? grant())
  const session = new ComputerViewerSession({
    computerId: ID,
    grant: grants,
    onState: (s) => states.push(s),
    video: () => null,
    fetch: opts.fetch,
    createPeer: opts.createPeer
  })
  sessions.push(session)
  return { session, states, grants }
}

describe('ComputerViewerSession', () => {
  it('signals through the relay the desktop is attached to and goes live on the direct path', async () => {
    const { calls, fetchImpl } = relayFetch({ attachedOn: 'https://relay-b.example.com' })
    const { created, createPeer } = peers(() => 'connected')
    const { session } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    expect(session.snapshot()).toMatchObject({ phase: 'live', path: 'direct' })
    expect(calls[0]!.url).toBe(`https://relay-a.example.com/cr/computers/${ID}/view/api/status`)
    expect(calls[1]!.url).toBe(`https://relay-b.example.com/cr/computers/${ID}/view/api/status`)
    // Once found, the desktop's relay is used first.
    expect(calls.slice(2).every((c) => c.url.startsWith('https://relay-b.example.com'))).toBe(true)
    expect(calls.find((c) => c.url.endsWith('rtc/offer'))?.body).toEqual({ transport: 'direct' })
    expect(calls.every((c) => c.auth === 'Bearer actk1.view.1')).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]!.config.iceServers).toEqual([])
  })

  it('falls back to TURN with relay-only candidates when the direct path fails', async () => {
    const { calls, fetchImpl } = relayFetch()
    const { created, createPeer } = peers((config) => (config.iceTransportPolicy === 'relay' ? 'connected' : 'failed'))
    const { session } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    expect(session.snapshot()).toMatchObject({ phase: 'live', path: 'turn', notes: ['Direct: ICE failed'] })
    expect(calls.filter((c) => c.url.endsWith('rtc/offer')).map((c) => c.body)).toEqual([
      { transport: 'direct' },
      { transport: 'turn' }
    ])
    expect(created[0]!.closed).toBe(true)
    expect(created[1]!.config).toMatchObject({ iceTransportPolicy: 'relay', iceServers: grant().iceServers })
  })

  it('hole-punches through the relays’ STUN with one full-ICE attempt, trickling candidates both ways', async () => {
    const { calls, fetchImpl } = relayFetch({ stun: true })
    const stunUrls = ['stun:stun-0.example.com:3478']
    const { created, createPeer } = peers(() => 'connected', undefined, routeStats('srflx', 'srflx'))
    const { session } = open({ fetch: fetchImpl, createPeer, grant: grant({ stunUrls }) })
    await session.start()
    expect(session.snapshot()).toMatchObject({ phase: 'live', path: 'p2p', notes: ['Peer to peer: srflx → srflx'] })
    expect(calls.filter((c) => c.url.endsWith('rtc/offer')).map((c) => c.body)).toEqual([{ transport: 'stun' }])
    expect(created[0]!.config).toEqual({ iceServers: [{ urls: stunUrls }] })
    // The answer goes first, then the browser's candidates in order, ending with null.
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith('rtc/candidate'))).toHaveLength(2))
    const signaling = calls.filter((c) => /rtc\/(answer|candidate)$/.test(c.url)).map((c) => c.url.split('/').at(-1))
    expect(signaling).toEqual(['answer', 'candidate', 'candidate'])
    expect(calls.filter((c) => c.url.endsWith('rtc/candidate')).map((c) => c.body)).toEqual([
      { id: 'rtc-1', candidate: { candidate: 'candidate:b 1 udp 1 198.51.100.7 6000 typ srflx', sdpMid: '0' } },
      { id: 'rtc-1', candidate: null }
    ])
    // The offer already carried the desktop's first candidate, so trickling starts after it.
    expect(calls.find((c) => c.url.endsWith('rtc/candidates'))?.body).toEqual({ id: 'rtc-1', after: 1 })
  })

  it('adds the desktop’s late candidates and shows a same-network host pair as direct', async () => {
    const { fetchImpl } = relayFetch({ stun: true })
    const { created, createPeer } = peers(() => 'connected', undefined, routeStats('host', 'host'))
    const { session } = open({
      fetch: fetchImpl,
      createPeer,
      grant: grant({ stunUrls: ['stun:stun-0.example.com:3478'] })
    })
    await session.start()
    expect(session.snapshot()).toMatchObject({ phase: 'live', path: 'direct' })
    await vi.waitFor(() => expect(created[0]!.added).toHaveLength(1))
    expect(created[0]!.added[0]).toMatchObject({ candidate: expect.stringContaining('203.0.113.9') })
  })

  it('falls through to TURN when hole punching fails, as behind a symmetric NAT', async () => {
    const { calls, fetchImpl } = relayFetch({ stun: true })
    const { createPeer } = peers((config) => (config.iceTransportPolicy === 'relay' ? 'connected' : 'failed'))
    const { session } = open({
      fetch: fetchImpl,
      createPeer,
      grant: grant({ stunUrls: ['stun:stun-0.example.com:3478'] })
    })
    await session.start()
    expect(session.snapshot()).toMatchObject({ path: 'turn', notes: ['Peer to peer: ICE failed'] })
    expect(calls.filter((c) => c.url.endsWith('rtc/offer')).map((c) => c.body)).toEqual([
      { transport: 'stun' },
      { transport: 'turn' }
    ])
  })

  it('keeps the ICE-lite direct path when the desktop was issued no STUN', async () => {
    const { calls, fetchImpl } = relayFetch({ stun: false })
    const { createPeer } = peers(() => 'connected')
    const { session } = open({ fetch: fetchImpl, createPeer, grant: grant({ stunUrls: ['stun:stun-0.example.com'] }) })
    await session.start()
    expect(session.snapshot().path).toBe('direct')
    expect(calls.find((c) => c.url.endsWith('rtc/offer'))?.body).toEqual({ transport: 'direct' })
  })

  it('falls back to screenshots over the relay without TURN', async () => {
    const { calls, fetchImpl } = relayFetch()
    const { createPeer } = peers(() => 'failed')
    const { session } = open({ fetch: fetchImpl, createPeer, grant: grant({ iceServers: [] }) })
    await session.start()
    expect(session.snapshot()).toMatchObject({
      path: 'screenshots',
      notes: ['Direct: ICE failed', 'TURN: not configured']
    })
    await vi.waitFor(() => expect(session.snapshot().frameUrl).toBeTruthy())
    expect(calls.some((c) => c.url.endsWith('/frame'))).toBe(true)
  })

  it('takes control, sends input over the DataChannel in order, and renews the token on it', async () => {
    const { calls, fetchImpl } = relayFetch()
    const { created, createPeer } = peers(() => 'connected')
    const { session, grants } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    await session.takeControl()
    expect(calls.find((c) => c.url.endsWith('/control'))?.body).toEqual({ action: 'take' })
    expect(session.snapshot().status?.inControl).toBe(true)
    await session.send({ type: 'click', x: 0.5, y: 0.5 })
    await session.send({ type: 'type', text: 'hi' })
    const sent = created[0]!.channel.sent.filter((d) => d !== 'ping').map((d) => JSON.parse(d) as object)
    expect(sent).toEqual([
      { seq: 1, input: { type: 'click', x: 0.5, y: 0.5 } },
      { seq: 2, input: { type: 'type', text: 'hi' } }
    ])
    grants.mockResolvedValueOnce(grant({ token: 'actk1.view.2' }))
    await (session as unknown as { renew: () => Promise<boolean> }).renew()
    expect(JSON.parse(created[0]!.channel.sent.filter((d) => d !== 'ping').at(-1)!)).toEqual({
      seq: 3,
      type: 'auth',
      token: 'actk1.view.2'
    })
    await session.release()
    expect(calls.at(-1)).toMatchObject({ body: { action: 'release' }, auth: 'Bearer actk1.view.2' })
  })

  it('ends the viewing when the desktop refuses the token and the CP will not renew it', async () => {
    const { fetchImpl } = relayFetch()
    const { created, createPeer } = peers(() => 'connected')
    const { session, grants } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    // Revoked: the desktop dropped its key, so every call is 401, and the CP refuses a new token.
    ;(fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    )
    grants.mockRejectedValue(Object.assign(new Error('computer is revoked'), { status: 409 }))
    await expect(session.api('GET', 'status')).resolves.toMatchObject({ status: 401 })
    expect(session.snapshot()).toMatchObject({ phase: 'error', path: null, status: null, error: 'computer is revoked' })
    expect(created[0]!.closed).toBe(true)
    expect(grants).toHaveBeenCalledTimes(2)
  })

  it('asks the CP when no relay holds the desktop, and ends the viewing once it is offline', async () => {
    const { fetchImpl } = relayFetch()
    const { createPeer } = peers(() => 'connected')
    const { session, grants } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    ;(fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response(JSON.stringify({ error: 'computer_not_attached' }), { status: 503 })
    )
    grants.mockRejectedValue(Object.assign(new Error('this computer is offline'), { status: 409 }))
    await expect(session.api('GET', 'status')).rejects.toThrow(/not connected to any relay/)
    expect(session.snapshot()).toMatchObject({ phase: 'error', error: 'this computer is offline' })
  })

  it('runs one recovery ladder when a live peer drops and its direct replacement fails', async () => {
    const { calls, fetchImpl } = relayFetch()
    let attempts = 0
    const { created, createPeer } = peers((config) =>
      config.iceTransportPolicy === 'relay' || attempts++ === 0 ? 'connected' : 'failed'
    )
    const { session } = open({ fetch: fetchImpl, createPeer })
    await session.start()
    expect(session.snapshot().path).toBe('direct')
    created[0]!.drop()
    await vi.waitFor(() => expect(session.snapshot().path).toBe('turn'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.filter((c) => c.url.endsWith('rtc/offer')).map((c) => c.body)).toEqual([
      { transport: 'direct' },
      { transport: 'direct' },
      { transport: 'turn' }
    ])
    expect(created.map((c) => c.closed)).toEqual([true, true, false])
  })

  it('closes a peer that connects after the viewer was stopped mid-ladder, without pinging', async () => {
    const { fetchImpl } = relayFetch()
    let stop = () => undefined as void
    const { created, createPeer } = peers(
      () => 'connected',
      () => stop()
    )
    const { session } = open({ fetch: fetchImpl, createPeer })
    stop = () => session.stop()
    await session.start()
    expect(created).toHaveLength(1)
    expect(created[0]!.closed).toBe(true)
    expect(created[0]!.channel.readyState).toBe('closed')
    expect(session.snapshot()).toMatchObject({ phase: 'stopped', path: null })
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect(created[0]!.channel.sent).not.toContain('ping')
  })

  it('creates no peer when stopped while the offer is in flight', async () => {
    const { fetchImpl } = relayFetch()
    const { created, createPeer } = peers(() => 'connected')
    const { session } = open({
      fetch: (async (url: string, init: RequestInit) => {
        if (url.endsWith('rtc/offer')) session.stop()
        return fetchImpl(url, init)
      }) as typeof fetch,
      createPeer
    })
    await session.start()
    expect(created).toHaveLength(0)
    expect(session.snapshot().phase).toBe('stopped')
  })

  it('schedules renewal from the grant lifetime, not from a skewed browser clock', async () => {
    const { fetchImpl } = relayFetch()
    const { createPeer } = peers(() => 'connected')
    // The browser clock runs 10 minutes ahead, so `expiresAt` already looks past.
    const skewed = grant({ expiresAt: new Date(Date.now() - 480_000).toISOString() })
    const { session } = open({ fetch: fetchImpl, createPeer, grant: skewed })
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    ;(session as unknown as { grant: ComputerViewerGrantDto }).grant = skewed
    ;(session as unknown as { scheduleRenewal: () => void }).scheduleRenewal()
    expect(timeouts).toHaveBeenLastCalledWith(expect.any(Function), 60_000)
    timeouts.mockRestore()
  })

  it('reports an error when the grant is refused', async () => {
    const { fetchImpl } = relayFetch()
    const { createPeer } = peers(() => 'connected')
    const session = new ComputerViewerSession({
      computerId: ID,
      grant: async () => {
        throw new Error('only the computer’s allowed members can watch it')
      },
      onState: () => undefined,
      video: () => null,
      fetch: fetchImpl,
      createPeer
    })
    sessions.push(session)
    await session.start()
    expect(session.snapshot()).toMatchObject({
      phase: 'error',
      error: 'only the computer’s allowed members can watch it'
    })
  })
})

describe('keyToInput', () => {
  const key = (over: Partial<KeyboardEvent>) =>
    ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent
  it('types characters, sends chords, and maps a Mac Cmd to Ctrl on Linux', () => {
    expect(keyToInput(key({ key: 'a', code: 'KeyA' }), 'linux')).toEqual({ type: 'char', text: 'a' })
    expect(keyToInput(key({ key: 'Enter' }), 'linux')).toEqual({ type: 'key', keys: ['return'] })
    expect(keyToInput(key({ key: 'c', code: 'KeyC', metaKey: true }), 'linux')).toEqual({
      type: 'key',
      keys: ['ctrl', 'c']
    })
    expect(keyToInput(key({ key: 'c', code: 'KeyC', metaKey: true }), 'macos')).toEqual({
      type: 'key',
      keys: ['cmd', 'c']
    })
    expect(keyToInput(key({ key: 'Tab', shiftKey: true }), 'linux')).toEqual({ type: 'key', keys: ['shift', 'tab'] })
    expect(keyToInput(key({ key: 'Shift' }), 'linux')).toBeNull()
  })
})
