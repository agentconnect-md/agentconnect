import { randomUUID } from 'node:crypto'
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, type PeerConfig } from 'werift'
import {
  ComputerViewerRenewal,
  type ComputerViewerCandidate,
  type ComputerViewerTransport
} from '@agentconnect.md/protocol/computer'
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
  // `direct` is ICE-lite with host candidates; `stun` is full ICE with server-reflexive ones; `turn` relays through TURN.
  transport?: ComputerViewerTransport
}

/** One trickled ICE candidate in its JSON form. */
export interface CandidateInit {
  candidate: string
  sdpMid?: string | null | undefined
  sdpMLineIndex?: number | null | undefined
}

interface Session {
  id: string
  principal: ViewerPrincipal
  transport: ComputerViewerTransport
  pc: RTCPeerConnection
  lastSeen: number
  remoteCandidates?: number
  // Every local candidate in gathering order, for the browser to fetch over signaling; `gathered` once gathering is done.
  candidates: CandidateInit[]
  gathered: boolean
  // A punched session's server-reflexive candidates, withheld until the desktop has sent to the browser's public one.
  held?: CandidateInit[]
  connected?: boolean
  unsubscribe?: () => void
}

const MAX_SESSIONS = 4
const GATHER_TIMEOUT_MS = 3000
// A TURN allocation is a round trip or two to the server, then the relayed candidate is ready.
const TURN_GATHER_TIMEOUT_MS = 8000
// One Binding round trip to the relay's STUN; later candidates still reach the browser by trickle.
const STUN_GATHER_TIMEOUT_MS = 2000
const MAX_REMOTE_CANDIDATES = 64
// werift schedules a new pair's first check within its 20 ms loop; this leaves it time to leave before the browser learns where to knock.
const RELEASE_DELAY_MS = 100
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

  // The peer configuration for one transport; `stun` and `turn` need full ICE, which an ICE-lite peer cannot do.
  peerConfig(principal: ViewerPrincipal, offer: OfferOptions): Partial<PeerConfig> {
    const base: Partial<PeerConfig> = { codecs: { video: [h264()] }, iceUseIpv6: false, bundlePolicy: 'max-bundle' }
    const { advertiseAddress, portRange } = this.options
    if (offer.transport === 'stun') {
      // Host and server-reflexive candidates, so ICE takes a same-network host pair first and a punched pair otherwise.
      return {
        ...base,
        iceServers: (principal.stunUrls ?? []).map((urls) => ({ urls })),
        // werift awaits STUN inside setLocalDescription (5 s by default), so a silent server must not hold the offer longer.
        iceStunGatherTimeout: STUN_GATHER_TIMEOUT_MS / 1000,
        ...(advertiseAddress ? { iceAdditionalHostAddresses: [advertiseAddress] } : {}),
        ...(portRange ? { icePortRange: portRange } : {})
      }
    }
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

  // `candidates` counts the local candidates the SDP already carries, so trickling resumes after them.
  async offer(
    principal: ViewerPrincipal,
    offer: OfferOptions = {}
  ): Promise<{ id: string; sdp: string; candidates: number }> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('too many viewer sessions')
    const transport = offer.transport ?? 'direct'
    const pc = new RTCPeerConnection(this.peerConfig(principal, offer))
    const session: Session = {
      id: randomUUID(),
      principal,
      transport,
      pc,
      lastSeen: Date.now(),
      candidates: [],
      gathered: false,
      ...(transport === 'stun' ? { held: [] } : {})
    }
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return void (session.gathered = true)
      const { candidate: line, sdpMid, sdpMLineIndex } = candidate.toJSON()
      ;(session.held && candidateType(line) === 'srflx' ? session.held : session.candidates).push({
        candidate: line,
        sdpMid,
        sdpMLineIndex
      })
    })
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') session.gathered = true
    })
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
        session.connected = true
        session.lastSeen = Date.now()
        this.options.log(`viewer ${client()}: WebRTC connected (${transport}${selectedPairType(pc)})`)
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
        new Promise((resolve) =>
          setTimeout(
            resolve,
            transport === 'turn'
              ? TURN_GATHER_TIMEOUT_MS
              : transport === 'stun'
                ? STUN_GATHER_TIMEOUT_MS
                : GATHER_TIMEOUT_MS
          )
        )
      ])
    }
    const sdp = pc.localDescription!.sdp
    if (transport === 'turn' && !sdp.split('\r\n').some((line) => / typ relay/.test(line))) {
      this.close(session.id)
      throw new Error('the TURN server gave no relay candidate')
    }
    const advertise = this.options.advertiseAddress
    const candidates = session.candidates.length
    return {
      id: session.id,
      sdp:
        transport === 'direct' && advertise
          ? onlyCandidatesFor(sdp, advertise)
          : transport === 'stun'
            ? withoutReflexive(sdp)
            : sdp,
      candidates
    }
  }

  async answer(client: string, id: string, sdp: string): Promise<void> {
    await this.owned(client, id).pc.setRemoteDescription({ type: 'answer', sdp })
  }

  /** A candidate the browser trickled after its answer; null marks the end of its gathering. */
  addCandidate(client: string, id: string, candidate: ComputerViewerCandidate['candidate']): void {
    const session = this.owned(client, id)
    if (session.transport === 'direct') throw new Error('an ICE-lite session takes no trickled candidates')
    // Without a public candidate from the browser there is no mapping to open first, so the browser gets them all.
    if (!candidate || candidate.candidate === '') return this.release(session)
    // Each one is a connectivity check the desktop sends, so a viewer cannot make it probe without bound.
    const remote = (session.remoteCandidates = (session.remoteCandidates ?? 0) + 1)
    if (remote > MAX_REMOTE_CANDIDATES) throw new Error('too many candidates')
    // Not awaited: werift resolves a browser's mDNS host name first, which must not hold up the candidates after it.
    void session.pc
      .addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined
      })
      .then(() => {
        // A NAT that saw the browser knock first maps the desktop's reply to another port; once our check is out, it can't.
        if (isPublicIpv4(candidate.candidate)) setTimeout(() => this.release(session), RELEASE_DELAY_MS).unref()
      })
      .catch((error: Error) => this.options.log(`viewer ${client}: candidate refused: ${error.message}`))
  }

  private release(session: Session): void {
    if (!session.held) return
    session.candidates.push(...session.held)
    session.held = undefined
  }

  /** The desktop's own candidates after the first `after`, and whether gathering is done, for the browser to trickle in. */
  candidates(client: string, id: string, after: number): { candidates: CandidateInit[]; done: boolean } {
    const session = this.owned(client, id)
    return { candidates: session.candidates.slice(after), done: session.gathered && !session.held }
  }

  private owned(client: string, id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.principal.client !== client) throw new Error('unknown viewer session')
    return session
  }

  // A renewed token must name the same viewer; it may narrow what the viewer can do, never switch who it is.
  private renew(session: Session, token: string): void {
    const next = this.options.reauthorize?.(token)
    if (!next || next.client !== session.principal.client) throw new Error('viewer token refused')
    session.principal = {
      ...next,
      iceServers: next.iceServers ?? session.principal.iceServers ?? [],
      stunUrls: next.stunUrls ?? session.principal.stunUrls ?? []
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.unsubscribe?.()
    // A full-ICE session that never connected says why: each side's candidates and how far each pair's checks got.
    if (session.transport !== 'direct' && !session.connected) {
      this.options.log(
        `viewer ${session.principal.client}: ${session.transport} never connected: ${iceReport(session.pc, session.remoteCandidates ?? 0)}`
      )
    }
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

// The selected pair's local candidate type (host, srflx, prflx or relay), for the log line.
function selectedPairType(pc: RTCPeerConnection): string {
  const pair = pc.iceTransports[0]?.connection.nominated
  return pair ? `, ${pair.localCandidate.type} → ${pair.remoteCandidate.type}` : ''
}

const PAIR_STATES = ['frozen', 'waiting', 'in-progress', 'succeeded', 'failed']

const endpoint = (c: { type: string; host: string; port: number }) => `${c.type} ${c.host}:${c.port}`

/** Local and remote candidates plus each pair's state and check counts (sent/answered/received), for a failed attempt's log line. */
export function iceReport(pc: RTCPeerConnection, trickled: number): string {
  const connection = pc.iceTransports[0]?.connection
  if (!connection) return 'no ICE transport'
  const local = connection.localCandidates.map(endpoint).join(', ') || 'none'
  const remote = connection.remoteCandidates.map(endpoint).join(', ') || 'none'
  const pairs =
    connection.checkList
      .map(
        (pair) =>
          `${pair.localCandidate.type} → ${endpoint(pair.remoteCandidate)} ${PAIR_STATES[pair.state] ?? pair.state} ` +
          `${pair.requestsSent}/${pair.responsesReceived}/${pair.requestsReceived}`
      )
      .join(', ') || 'none'
  return `ICE ${connection.state}; local ${local}; remote ${remote} (${trickled} trickled); pairs sent/answered/received ${pairs}`
}

const candidateType = (line: string): string | undefined => / typ (\w+)/.exec(line)?.[1]

// A browser candidate the desktop's checks reach through the browser's NAT: server-reflexive, peer-reflexive or relayed, over IPv4.
const isPublicIpv4 = (line: string): boolean =>
  ['srflx', 'prflx', 'relay'].includes(candidateType(line) ?? '') &&
  /^\d+\.\d+\.\d+\.\d+$/.test(line.split(' ')[4] ?? '')

/** Drops server-reflexive candidates from an offer, so the browser cannot knock on the desktop's NAT before the desktop has sent. */
export const withoutReflexive = (sdp: string): string =>
  sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || candidateType(line) !== 'srflx')
    .join('\r\n')

// Drops host candidates for interface addresses (e.g. a container IP) that a NATed browser cannot reach.
export const onlyCandidatesFor = (sdp: string, address: string): string =>
  sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || line.split(' ')[4] === address)
    .join('\r\n')
