import { randomUUID } from 'node:crypto'
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from 'werift'
import type { ScreenStream } from './screen-stream.js'

export interface RtcSessionsOptions {
  stream: ScreenStream
  // Handles one DataChannel message from the viewer; the resolved value (or error) is sent back with its seq.
  onMessage: (client: string, message: unknown) => Promise<unknown>
  log: (line: string) => void
  // Advertise only this address (NAT / Docker bridge) instead of the one the browser reached us on.
  advertiseAddress?: string
  portRange?: [number, number]
}

interface Session {
  id: string
  client: string
  pc: RTCPeerConnection
  lastSeen: number
  unsubscribe?: () => void
}

const MAX_SESSIONS = 4
const GATHER_TIMEOUT_MS = 3000
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
          this.options.log(`viewer ${session.client}: no heartbeat, closing WebRTC session`)
          this.close(session.id)
        }
      }
    }, 2000)
    this.reaper.unref()
  }

  // `hostAddress` is the local address the browser reached us on; tun interfaces such as Tailscale are otherwise skipped.
  async offer(client: string, hostAddress: string | undefined): Promise<{ id: string; sdp: string }> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('too many viewer sessions')
    const { advertiseAddress, portRange } = this.options
    const address = advertiseAddress ?? hostAddress?.replace(/^::ffff:/, '')
    const pc = new RTCPeerConnection({
      codecs: { video: [h264()] },
      // ICE-lite host candidates only: no STUN round trip (werift would otherwise default to Google's), one transport.
      iceLite: true,
      iceServers: [],
      iceUseIpv6: false,
      bundlePolicy: 'max-bundle',
      ...(address ? { iceAdditionalHostAddresses: [address] } : {}),
      ...(portRange ? { icePortRange: portRange } : {})
    })
    const session: Session = { id: randomUUID(), client, pc, lastSeen: Date.now() }
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
          const result = await this.options.onMessage(client, message)
          channel.send(JSON.stringify({ seq: message.seq, ok: true, result }))
        } catch (error) {
          channel.send(JSON.stringify({ seq: message.seq, ok: false, error: (error as Error).message }))
        }
      })
    })
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        session.lastSeen = Date.now()
        this.options.log(`viewer ${client}: WebRTC connected`)
        session.unsubscribe ??= this.options.stream.subscribe((packet) => track.writeRtp(packet))
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.close(session.id)
    })
    setTimeout(() => {
      if (pc.connectionState === 'new') this.close(session.id)
    }, ANSWER_TIMEOUT_MS).unref()

    await pc.setLocalDescription(await pc.createOffer())
    // No trickle: wait for host candidates so the offer is complete in one round trip.
    if (pc.iceGatheringState !== 'complete') {
      await Promise.race([
        new Promise<void>((resolve) =>
          pc.iceGatheringStateChange.subscribe((state) => (state === 'complete' ? resolve() : undefined))
        ),
        new Promise((resolve) => setTimeout(resolve, GATHER_TIMEOUT_MS))
      ])
    }
    const sdp = pc.localDescription!.sdp
    return { id: session.id, sdp: advertiseAddress ? onlyCandidatesFor(sdp, advertiseAddress) : sdp }
  }

  async answer(client: string, id: string, sdp: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.client !== client) throw new Error('unknown viewer session')
    await session.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.unsubscribe?.()
    void session.pc.close().catch(() => undefined)
    this.options.log(`viewer ${session.client}: WebRTC session closed`)
  }

  closeAll(): void {
    clearInterval(this.reaper)
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}

// Drops host candidates for interface addresses (e.g. a container IP) that a NATed browser cannot reach.
export const onlyCandidatesFor = (sdp: string, address: string): string =>
  sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || line.split(' ')[4] === address)
    .join('\r\n')
