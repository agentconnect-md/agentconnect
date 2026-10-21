// The console's Computer viewer (computer-use.md §7, §10): signaling via the relay; media direct or hole-punched, then TURN, then screenshots.
import { relayComputerViewBase } from '@agentconnect.md/protocol/computer-viewer'
import type { ComputerViewerGrantDto } from '@/lib/api'

// `p2p` is a hole-punched pair through the relay's STUN; a full-ICE session that settles on host candidates shows `direct`.
export type ViewerPath = 'direct' | 'p2p' | 'turn' | 'screenshots'
type Transport = 'direct' | 'stun' | 'turn'

export type ViewerInput =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: string[] }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string[] }

/** What the desktop reports at `/view/api/status`. */
export interface ViewerStatus {
  you: string
  mode: 'view' | 'control'
  inControl: boolean
  os: 'linux' | 'macos' | 'windows'
  status: string
  paused: { reason: string; by?: string } | null
  unavailable: string | null
  lease: { holder: string } | null
  webrtc: { unavailable: string | null; error: string | null; turn: boolean; stun?: boolean }
}

export interface ViewerState {
  phase: 'connecting' | 'live' | 'error' | 'stopped'
  path: ViewerPath | null
  status: ViewerStatus | null
  // The latest screenshot while on the screenshot fallback.
  frameUrl: string | null
  error: string | null
  // Why each richer path was skipped, for the path badge's tooltip.
  notes: string[]
}

export interface ViewerDeps {
  grant: () => Promise<ComputerViewerGrantDto>
  computerId: string
  onState: (state: ViewerState) => void
  // Where the WebRTC stream is shown; read when the track arrives.
  video: () => HTMLVideoElement | null
  fetch?: typeof fetch
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection
  now?: () => number
}

// How long each WebRTC path gets to connect before the next one is tried.
export const DIRECT_TIMEOUT_MS = 6000
export const STUN_TIMEOUT_MS = 8000
export const TURN_TIMEOUT_MS = 12_000
const TIMEOUTS: Record<Transport, number> = {
  direct: DIRECT_TIMEOUT_MS,
  stun: STUN_TIMEOUT_MS,
  turn: TURN_TIMEOUT_MS
}
const LABELS: Record<Transport, string> = { direct: 'Direct', stun: 'Peer to peer', turn: 'TURN' }
// How often the browser fetches the desktop's late candidates while a punched connection is being set up.
const CANDIDATE_POLL_MS = 300
const STATUS_INTERVAL_MS = 2000
const PING_INTERVAL_MS = 2000
const FRAME_INTERVAL_MS = 200
// Renew well before the token lapses; the desktop closes a session whose token is gone.
const RENEW_FRACTION = 0.5

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class ComputerViewerSession {
  private state: ViewerState = { phase: 'connecting', path: null, status: null, frameUrl: null, error: null, notes: [] }
  private grant: ComputerViewerGrantDto | null = null
  private relayIndex = 0
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private seq = 0
  private readonly pending = new Map<number, (reply: { ok: boolean; error?: string }) => void>()
  private timers: ReturnType<typeof setInterval>[] = []
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private inputChain: Promise<unknown> = Promise.resolve()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: ViewerDeps) {
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args))
    this.now = deps.now ?? Date.now
  }

  snapshot(): ViewerState {
    return this.state
  }

  async start(): Promise<void> {
    try {
      this.grant = await this.deps.grant()
      this.scheduleRenewal()
      await this.refreshStatus()
      if (this.stopped) return
      const poll = () =>
        this.refreshStatus().catch((error: Error) => {
          if (!this.stopped && this.state.phase === 'live') this.update({ error: error.message })
        })
      this.timers.push(setInterval(() => void poll(), STATUS_INTERVAL_MS))
      await this.connectMedia()
    } catch (error) {
      if (!this.stopped) this.update({ phase: 'error', error: (error as Error).message })
    }
  }

  stop(): void {
    if (this.stopped && this.state.phase === 'error') return
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.renewTimer) clearTimeout(this.renewTimer)
    // A takeover is handed back on leaving, not left to the desktop's 15 s silence timeout.
    if (this.state.status?.inControl) void this.api('POST', 'control', { action: 'release' }).catch(() => undefined)
    this.closePeer()
    if (this.state.frameUrl) URL.revokeObjectURL(this.state.frameUrl)
    this.update({ phase: 'stopped', frameUrl: null })
  }

  async takeControl(): Promise<void> {
    await this.control('take')
  }

  async release(): Promise<void> {
    await this.control('release')
  }

  /** Send one input in order; each waits for the previous one to be applied. */
  send(input: ViewerInput): Promise<void> {
    if (!this.state.status?.inControl) return Promise.resolve()
    const next = this.inputChain.then(() => this.deliver(input))
    this.inputChain = next.catch((error: Error) => this.update({ error: error.message }))
    return this.inputChain.then(() => undefined)
  }

  private async control(action: 'take' | 'release'): Promise<void> {
    const res = await this.api('POST', 'control', { action })
    const body = (await res.json()) as ViewerStatus & { message?: string }
    if (!res.ok) {
      this.update({ error: body.message ?? `HTTP ${res.status}` })
      return
    }
    this.update({ status: body, error: null })
  }

  private async deliver(input: ViewerInput): Promise<void> {
    const channel = this.channel
    if (channel && channel.readyState === 'open') {
      const reply = await this.request(channel, { input })
      if (!reply.ok) throw new Error(reply.error ?? 'input refused')
      if (this.state.error) this.update({ error: null })
      return
    }
    const res = await this.api('POST', 'input', input)
    if (!res.ok) throw new Error(((await res.json()) as { message?: string }).message ?? `HTTP ${res.status}`)
  }

  private request(channel: RTCDataChannel, message: object): Promise<{ ok: boolean; error?: string }> {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      channel.send(JSON.stringify({ seq: id, ...message }))
    })
  }

  // ---- relay calls ----

  private base(index = this.relayIndex): string {
    return relayComputerViewBase(this.grant!.relays[index]!, this.deps.computerId)
  }

  /** One viewer API call; tries the next relay only when the desktop is not attached to this one or it is unreachable. */
  async api(method: 'GET' | 'POST', endpoint: string, body?: unknown, retried = false): Promise<Response> {
    if (!this.grant) throw new Error('viewer not started')
    const relays = this.grant.relays.length
    let lastError: Error = new Error('no relay reached the computer')
    let detached = 0
    for (let attempt = 0; attempt < relays; attempt++) {
      const index = (this.relayIndex + attempt) % relays
      let res: Response
      try {
        res = await this.fetchImpl(`${this.base(index)}/${endpoint}`, {
          method,
          headers: {
            authorization: `Bearer ${this.grant.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store'
        })
      } catch (error) {
        // Only a request that never left may go elsewhere; a POST that reached a relay is not resent.
        if (method === 'POST' && endpoint !== 'rtc/offer') throw error
        lastError = error as Error
        continue
      }
      if (res.status === 503) {
        const text = await res.clone().text()
        if (text.includes('computer_not_attached')) {
          lastError = new HttpError(503, 'the computer is not connected to any relay')
          detached++
          continue
        }
      }
      this.relayIndex = index
      // The token lapsed between renewals (a sleeping tab): renew once and retry.
      if (res.status === 401 && !retried && (await this.renew())) return this.api(method, endpoint, body, true)
      return res
    }
    // No relay holds the desktop's link: ask the CP, which ends the viewing if it was revoked or went offline.
    if (detached === relays && !retried && (await this.renew())) return this.api(method, endpoint, body, true)
    throw lastError
  }

  private async refreshStatus(): Promise<void> {
    const res = await this.api('GET', 'status')
    if (!res.ok) {
      const message = ((await res.json()) as { message?: string }).message ?? `HTTP ${res.status}`
      if (this.state.phase !== 'connecting') this.update({ error: message })
      throw new HttpError(res.status, message)
    }
    this.update({ status: (await res.json()) as ViewerStatus })
  }

  // ---- token renewal ----

  private scheduleRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    // From the grant's own lifetime, not `expiresAt`: the browser clock may be off from the CP's.
    this.renewTimer = setTimeout(() => void this.renew(), Math.max(5_000, this.grant!.expiresInMs * RENEW_FRACTION))
  }

  private async renew(): Promise<boolean> {
    if (this.stopped) return false
    try {
      const fresh = await this.deps.grant()
      // TURN credentials stay those the live peer allocated with; the new token carries its own for the next offer.
      this.grant = fresh
      this.scheduleRenewal()
      const channel = this.channel
      if (channel && channel.readyState === 'open') {
        const reply = await this.request(channel, { type: 'auth', token: fresh.token })
        if (!reply.ok) this.update({ error: reply.error ?? 'viewer token refused' })
      }
      return true
    } catch (error) {
      // Revoked, removed, offline or no longer allowed: the viewing is over.
      const status = (error as { status?: number }).status
      if (status === 403 || status === 404 || status === 409) {
        this.terminate((error as Error).message)
        return false
      }
      this.update({ error: (error as Error).message })
      // Try again shortly; the desktop drops the stream once the old token lapses.
      this.renewTimer = setTimeout(() => void this.renew(), 10_000)
      return false
    }
  }

  // Ends the viewing for good, keeping the reason on screen until the card is closed.
  private terminate(message: string): void {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.closePeer()
    if (this.state.frameUrl) URL.revokeObjectURL(this.state.frameUrl)
    this.update({ phase: 'error', path: null, status: null, frameUrl: null, error: message })
  }

  // ---- media ----

  private async connectMedia(): Promise<void> {
    const notes: string[] = []
    const unavailable = this.state.status?.webrtc.unavailable
    if (unavailable) notes.push(`WebRTC: ${unavailable}`)
    else {
      // With relay STUN, one full-ICE attempt covers both: ICE checks host pairs first, then punched ones.
      const punch = (this.grant!.stunUrls?.length ?? 0) > 0 && this.state.status?.webrtc.stun === true
      const turn = this.grant!.iceServers.length > 0 && this.state.status?.webrtc.turn === true
      // A desktop without reachable UDP (a managed computer's pod) skips the direct attempt when TURN can carry it.
      const first: Transport | null = punch ? 'stun' : this.grant!.directMedia === false && turn ? null : 'direct'
      const ladder: Transport[] = first ? [first, 'turn'] : ['turn']
      for (const transport of ladder) {
        if (transport === 'turn' && !turn) {
          notes.push('TURN: not configured')
          break
        }
        try {
          await this.connectPeer(transport, TIMEOUTS[transport])
          // Stopped mid-ladder: stop() ran before this peer existed, so close it here.
          if (this.stopped) return this.closePeer()
          const path = transport === 'stun' ? await this.punchedPath(notes) : transport
          this.update({ phase: 'live', path, notes, error: null })
          return
        } catch (error) {
          this.closePeer()
          notes.push(`${LABELS[transport]}: ${(error as Error).message}`)
        }
        if (this.stopped) return
      }
    }
    this.update({ phase: 'live', path: 'screenshots', notes })
    void this.pollFrames()
  }

  // Which pair a full-ICE session settled on: host on both ends reads as direct, anything else as punched.
  private async punchedPath(notes: string[]): Promise<ViewerPath> {
    const route = this.pc ? await selectedRoute(this.pc) : null
    if (!route) return 'p2p'
    if (route.local === 'host' && route.remote === 'host') return 'direct'
    notes.push(`Peer to peer: ${route.local} → ${route.remote}`)
    return 'p2p'
  }

  private async connectPeer(transport: Transport, timeoutMs: number): Promise<void> {
    const offerRes = await this.api('POST', 'rtc/offer', { transport })
    const offer = (await offerRes.json()) as {
      id: string
      sdp: string
      candidates?: number
      message?: string
      error?: string
    }
    if (!offerRes.ok) throw new Error(offer.message ?? offer.error ?? `HTTP ${offerRes.status}`)
    if (this.stopped) throw new Error('viewer stopped')
    const config: RTCConfiguration =
      transport === 'turn'
        ? { iceServers: this.grant!.iceServers, iceTransportPolicy: 'relay' }
        : transport === 'stun'
          ? { iceServers: [{ urls: this.grant!.stunUrls }] }
          : { iceServers: [] }
    const pc = (this.deps.createPeer ?? ((c) => new RTCPeerConnection(c)))(config)
    this.pc = pc
    pc.ontrack = (event) => {
      const video = this.deps.video()
      if (video) video.srcObject = event.streams[0] ?? new MediaStream([event.track])
    }
    pc.ondatachannel = (event) => this.attachChannel(event.channel)
    // Only a peer that once connected starts recovery; a failed attempt just fails its own ladder step.
    let established = false
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no connection within ${timeoutMs / 1000} s`)), timeoutMs)
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          established = true
          clearTimeout(timer)
          resolve()
        } else if (pc.connectionState === 'failed') {
          clearTimeout(timer)
          reject(new Error('ICE failed'))
        }
        // Once live, a dropped peer falls back to the next path instead of freezing.
        if (
          established &&
          this.pc === pc &&
          this.state.phase === 'live' &&
          ['failed', 'closed', 'disconnected'].includes(pc.connectionState)
        ) {
          this.closePeer()
          if (!this.stopped) void this.connectMedia()
        }
      }
    })
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    if (transport === 'stun') return this.trickle(pc, offer.id, offer.candidates ?? 0, connected)
    await pc.setLocalDescription(await pc.createAnswer())
    // No trickle: the answer carries every candidate, TURN relays included.
    await waitForGathering(pc, transport === 'turn' ? 8000 : 3000)
    const answer = await this.api('POST', 'rtc/answer', { id: offer.id, sdp: pc.localDescription!.sdp })
    if (!answer.ok) throw new Error(((await answer.json()) as { message?: string }).message ?? `HTTP ${answer.status}`)
    await connected
  }

  // The punched path answers at once and trickles over the relay: the browser's candidates up, the desktop's late ones down.
  private async trickle(pc: RTCPeerConnection, id: string, inOffer: number, connected: Promise<void>): Promise<void> {
    let settled = false
    let sent: Promise<unknown> = Promise.resolve()
    pc.onicecandidate = (event) => {
      const candidate = event.candidate ? event.candidate.toJSON() : null
      // In order and after the answer; a lost candidate costs only that pair, so failures are not fatal.
      sent = sent.then(() => this.api('POST', 'rtc/candidate', { id, candidate }).catch(() => undefined))
    }
    await pc.setLocalDescription(await pc.createAnswer())
    const answered = this.api('POST', 'rtc/answer', { id, sdp: pc.localDescription!.sdp })
    sent = answered
    const answer = await answered
    if (!answer.ok) throw new Error(((await answer.json()) as { message?: string }).message ?? `HTTP ${answer.status}`)
    const poll = async () => {
      let after = inOffer
      while (!settled && !this.stopped && this.pc === pc) {
        try {
          const res = await this.api('POST', 'rtc/candidates', { id, after })
          if (!res.ok) return
          const late = (await res.json()) as { candidates: RTCIceCandidateInit[]; done: boolean }
          after += late.candidates.length
          for (const candidate of late.candidates) await pc.addIceCandidate(candidate).catch(() => undefined)
          if (late.done && late.candidates.length === 0) return
        } catch {
          return
        }
        await sleep(CANDIDATE_POLL_MS)
      }
    }
    void poll()
    try {
      await connected
    } finally {
      settled = true
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    // A ping would keep a stopped viewer's desktop session alive.
    if (this.stopped) return channel.close()
    this.channel = channel
    const ping = setInterval(() => {
      if (channel.readyState === 'open') channel.send('ping')
    }, PING_INTERVAL_MS)
    this.timers.push(ping)
    channel.onmessage = (event: MessageEvent) => {
      if (event.data === 'pong') return
      const reply = JSON.parse(String(event.data)) as { seq: number; ok: boolean; error?: string }
      const done = this.pending.get(reply.seq)
      if (done) {
        this.pending.delete(reply.seq)
        done(reply)
      }
    }
    channel.onclose = () => {
      clearInterval(ping)
      if (this.channel === channel) this.channel = null
      for (const [id, done] of this.pending) {
        this.pending.delete(id)
        done({ ok: false, error: 'viewer connection closed' })
      }
    }
  }

  private closePeer(): void {
    const pc = this.pc
    this.pc = null
    this.channel = null
    if (pc) {
      pc.onconnectionstatechange = null
      pc.close()
    }
    const video = this.deps.video()
    if (video) video.srcObject = null
  }

  private async pollFrames(): Promise<void> {
    while (!this.stopped && this.state.path === 'screenshots') {
      const started = this.now()
      if (typeof document !== 'undefined' && document.hidden) {
        await sleep(500)
        continue
      }
      try {
        const res = await this.api('GET', 'frame')
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob())
          const old = this.state.frameUrl
          if (this.stopped) URL.revokeObjectURL(url)
          else this.update({ frameUrl: url })
          if (old) URL.revokeObjectURL(old)
        } else await sleep(1000)
      } catch {
        await sleep(1000)
      }
      await sleep(Math.max(0, FRAME_INTERVAL_MS - (this.now() - started)))
    }
  }

  private update(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onState(this.state)
  }
}

/** The candidate types of the pair a peer selected, from its stats; null when the browser does not say. */
export async function selectedRoute(pc: RTCPeerConnection): Promise<{ local: string; remote: string } | null> {
  if (typeof pc.getStats !== 'function') return null
  try {
    const reports = [...(await pc.getStats()).values()] as Array<Record<string, unknown>>
    const byId = new Map(reports.map((r) => [r.id as string, r]))
    const transport = reports.find((r) => r.type === 'transport' && r.selectedCandidatePairId)
    const pair =
      (transport && byId.get(transport.selectedCandidatePairId as string)) ??
      reports.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
    const local = pair && byId.get(pair.localCandidateId as string)
    const remote = pair && byId.get(pair.remoteCandidateId as string)
    if (!local || !remote) return null
    return { local: String(local.candidateType), remote: String(remote.candidateType) }
  } catch {
    return null
  }
}

function waitForGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    }
  })
}

const NAMED: Record<string, string> = {
  Enter: 'return',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'escape',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ' ': 'space'
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/** A browser key event as viewer input: plain characters as text, everything else as a key chord; null to ignore. */
export function keyToInput(
  event: KeyEventLike,
  os: ViewerStatus['os']
): ViewerInput | { type: 'char'; text: string } | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return null
  // A Mac's Cmd shortcuts map to Ctrl on Windows and Linux computers.
  const meta = event.metaKey ? [os === 'macos' ? 'cmd' : 'ctrl'] : []
  const mods = [...new Set([...meta, ...(event.ctrlKey ? ['ctrl'] : []), ...(event.altKey ? ['alt'] : [])])]
  if (event.key.length === 1 && mods.length === 0) return { type: 'char', text: event.key }
  let key = NAMED[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key.toLowerCase() : null)
  if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase()
  if (!key && /^Digit\d$/.test(event.code)) key = event.code.slice(5)
  if (!key && event.key.length === 1) key = event.key.toLowerCase()
  if (!key) return null
  const shift = event.shiftKey && (mods.length > 0 || event.key.length !== 1) ? ['shift'] : []
  return { type: 'key', keys: [...mods, ...shift, key] }
}
