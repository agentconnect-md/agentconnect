import { randomUUID } from 'node:crypto'
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, type PeerConfig } from 'werift'
import { ComputerViewerRenewal, type ComputerViewerTransport } from '@agentconnect.md/protocol/computer'
import type { ScreenStream } from './screen-stream.js'
import type { ViewerPrincipal } from '../viewer.js'

export interface RtcSessionsOptions {
  stream: ScreenStream
  // Handles one DataChannel message from the viewer; the resolved value (or error) is sent back with its seq.
  onMessage: (principal: ViewerPrincipal, message: unknown) => Promise<unknown>
  // A fresh token the viewer sent over the DataChannel; undefined when it does not hold.
  reauthorize?: (token: string) => ViewerPrincipal | undefined
  log: (line: string) => void
  // Advertise only this address (NAT / Docker bridge) instead of the one the browser reached us on.
  advertiseAddress?: string
  portRange?: [number, number]
}

export interface OfferOptions {
  // The local address the browser reached us on; unknown when signaling came through a relay.
  hostAddress?: string | undefined
  // `direct` is ICE-lite with host candidates; `turn` relays media through the token's TURN servers.
  transport?: ComputerViewerTransport
}

interface Session {
  id: string
  principal: ViewerPrincipal
  transport: ComputerViewerTransport
  pc: RTCPeerConnection
  lastSeen: number
  unsubscribe?: () => void
}

const MAX_SESSIONS = 4
const GATHER_TIMEOUT_MS = 3000
// A TURN allocation is a round trip or two to the server, then the relayed candidate is ready.
const TURN_GATHER_TIMEOUT_MS = 8000
const ANSWER_TIMEOUT_MS = 30_000
// ICE-lite never notices a vanished browser, so the page pings over the DataChannel and silent sessions are closed.
const SILENCE_TIMEOUT_MS = 10_000

const h264 = () =>
  new RTCRtpCodecParameters({
    mimeType: 'video/H264',
    clockRate: 90_000,
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
    parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1'
  })

// Server-offer WebRTC: a sendonly H.264 track fed by the shared ScreenStream plus an "input" DataChannel.
export class RtcSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly reaper: NodeJS.Timeout

  constructor(private readonly options: RtcSessionsOptions) {
    this.reaper = setInterval(() => {
      for (const session of [...this.sessions.values()]) {
        if (Date.now() - session.lastSeen > SILENCE_TIMEOUT_MS && session.pc.connectionState !== 'new') {
          this.options.log(`viewer ${session.principal.client}: no heartbeat, closing WebRTC session`)
          this.close(session.id)
        } else if (session.principal.valid && !session.principal.valid()) {
          this.options.log(`viewer ${session.principal.client}: viewer token lapsed, closing WebRTC session`)
          this.close(session.id)
        }
      }
    }, 2000)
    this.reaper.unref()
  }

  // The peer configuration for one transport; `turn` needs full ICE because an ICE-lite peer cannot allocate a relay.
  peerConfig(principal: ViewerPrincipal, offer: OfferOptions): Partial<PeerConfig> {
    const base: Partial<PeerConfig> = { codecs: { video: [h264()] }, iceUseIpv6: false, bundlePolicy: 'max-bundle' }
    if (offer.transport === 'turn') {
      return {
        ...base,
        iceServers: (principal.iceServers ?? []).map(({ urls, username, credential }) => ({
          urls,
          username,
          credential
        })),
        iceTransportPolicy: 'relay'
      }
    }
    const { advertiseAddress, portRange } = this.options
    const address = advertiseAddress ?? offer.hostAddress?.replace(/^::ffff:/, '')
    return {
      ...base,
      // ICE-lite host candidates only: no STUN round trip (werift would otherwise default to Google's), one transport.
      iceLite: true,
      iceServers: [],
      ...(address ? { iceAdditionalHostAddresses: [address] } : {}),
      ...(portRange ? { icePortRange: portRange } : {})
    }
  }

  async offer(principal: ViewerPrincipal, offer: OfferOptions = {}): Promise<{ id: string; sdp: string }> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('too many viewer sessions')
    const transport = offer.transport ?? 'direct'
    const pc = new RTCPeerConnection(this.peerConfig(principal, offer))
    const session: Session = { id: randomUUID(), principal, transport, pc, lastSeen: Date.now() }
    const client = () => session.principal.client
    this.sessions.set(session.id, session)
    const track = new MediaStreamTrack({ kind: 'video' })
    pc.addTransceiver(track, { direction: 'sendonly' })
    const channel = pc.createDataChannel('input')
    let replies = Promise.resolve()
    channel.onMessage.subscribe((data) => {
      session.lastSeen = Date.now()
      if (data.toString() === 'ping') return channel.send('pong')
      // Strictly in order: a click must not overtake the move or keys before it.
      replies = replies.then(async () => {
        let message: { seq?: unknown } = {}
        try {
          message = JSON.parse(data.toString()) as { seq?: unknown }
          const renewal = ComputerViewerRenewal.safeParse(message)
          if (renewal.success) {
            this.renew(session, renewal.data.token)
            return channel.send(JSON.stringify({ seq: message.seq, ok: true, result: null }))
          }
          const result = await this.options.onMessage(session.principal, message)
          channel.send(JSON.stringify({ seq: message.seq, ok: true, result }))
        } catch (error) {
          channel.send(JSON.stringify({ seq: message.seq, ok: false, error: (error as Error).message }))
        }
      })
    })
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        session.lastSeen = Date.now()
        this.options.log(`viewer ${client()}: WebRTC connected (${transport})`)
        session.unsubscribe ??= this.options.stream.subscribe((packet) => track.writeRtp(packet))
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.close(session.id)
    })
    setTimeout(() => {
      if (pc.connectionState === 'new') this.close(session.id)
    }, ANSWER_TIMEOUT_MS).unref()

    await pc.setLocalDescription(await pc.createOffer())
    // No trickle: wait for the candidates so the offer is complete in one round trip.
    if (pc.iceGatheringState !== 'complete') {
      await Promise.race([
        new Promise<void>((resolve) =>
          pc.iceGatheringStateChange.subscribe((state) => (state === 'complete' ? resolve() : undefined))
        ),
        new Promise((resolve) => setTimeout(resolve, transport === 'turn' ? TURN_GATHER_TIMEOUT_MS : GATHER_TIMEOUT_MS))
      ])
    }
    const sdp = pc.localDescription!.sdp
    if (transport === 'turn' && !sdp.split('\r\n').some((line) => / typ relay/.test(line))) {
      this.close(session.id)
      throw new Error('the TURN server gave no relay candidate')
    }
    const advertise = this.options.advertiseAddress
    return { id: session.id, sdp: transport === 'direct' && advertise ? onlyCandidatesFor(sdp, advertise) : sdp }
  }

  async answer(client: string, id: string, sdp: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.principal.client !== client) throw new Error('unknown viewer session')
    await session.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  // A renewed token must name the same viewer; it may narrow what the viewer can do, never switch who it is.
  private renew(session: Session, token: string): void {
    const next = this.options.reauthorize?.(token)
    if (!next || next.client !== session.principal.client) throw new Error('viewer token refused')
    session.principal = { ...next, iceServers: next.iceServers ?? session.principal.iceServers ?? [] }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.unsubscribe?.()
    void session.pc.close().catch(() => undefined)
    this.options.log(`viewer ${session.principal.client}: WebRTC session closed`)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  stop(): void {
    clearInterval(this.reaper)
    this.closeAll()
  }

  size(): number {
    return this.sessions.size
  }
}

// Drops host candidates for interface addresses (e.g. a container IP) that a NATed browser cannot reach.
export const onlyCandidatesFor = (sdp: string, address: string): string =>
  sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || line.split(' ')[4] === address)
    .join('\r\n')
