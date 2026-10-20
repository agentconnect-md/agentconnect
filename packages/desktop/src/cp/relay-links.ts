// The desktop's outbound data-plane links (computer-use.md §3.7): one socket per roster relay, so a NAT-ed desktop is reachable.
import {
  Backoff,
  ClientTransport,
  systemClock,
  type Clock,
  type TimerHandle,
  type Transport
} from '@agentconnect.md/connection'
import {
  RELAY_COMPUTER_MAX_FRAME_BYTES,
  RELAY_COMPUTER_SUBPROTOCOL,
  buildRelayComputerFrame,
  decodeRelayComputerFrame,
  relayComputerWsUrl,
  type ComputerRelayEntry,
  type CrHttpRequest,
  type CrHttpResponse,
  type RelayComputerFrame
} from '@agentconnect.md/protocol/computer'

const HELLO_TIMEOUT_MS = 15_000

export interface RelayLinksDeps {
  computerId: string
  desktopDaemonVersion: string
  /** A fresh relay-audience token, or undefined while this desktop holds no live channel key. */
  token: () => string | undefined
  handle: (request: CrHttpRequest) => Promise<CrHttpResponse>
  log: (line: string) => void
  connect?: (url: string) => Promise<Transport>
  clock?: Clock
  jitter?: () => number
}

type LinkState = 'CONNECTING' | 'HELLO' | 'READY' | 'WAITING' | 'STOPPED'

// One relay: dial, prove the key with `cr/hello`, then answer forwarded requests until closed; redial with backoff.
class RelayLink {
  state: LinkState = 'CONNECTING'
  private transport: Transport | undefined
  private timer: TimerHandle | undefined
  private readonly backoff: Backoff

  constructor(
    readonly entry: ComputerRelayEntry,
    private readonly deps: RelayLinksDeps,
    private readonly clock: Clock
  ) {
    this.backoff = new Backoff(deps.jitter ? { jitter: deps.jitter } : {})
  }

  start(): void {
    void this.attempt()
  }

  stop(): void {
    this.state = 'STOPPED'
    this.clearTimer()
    this.transport?.close(1000, 'shutdown')
    this.transport = undefined
  }

  private dial(url: string): Promise<Transport> {
    if (this.deps.connect) return this.deps.connect(url)
    return ClientTransport.dial(url, {
      subprotocol: RELAY_COMPUTER_SUBPROTOCOL,
      path: new URL(url).pathname,
      maxPayload: RELAY_COMPUTER_MAX_FRAME_BYTES
    })
  }

  private async attempt(): Promise<void> {
    if (this.state === 'STOPPED') return
    this.state = 'CONNECTING'
    const token = this.deps.token()
    // No live key: nothing to prove; the next roster push after the CP channel reconnects restarts the link.
    if (!token) return this.wait()
    let transport: Transport
    try {
      transport = await this.dial(relayComputerWsUrl(this.entry.url))
    } catch (error) {
      this.deps.log(`relay ${this.entry.relayId}: cannot connect: ${(error as Error).message}`)
      return this.wait()
    }
    if (this.state !== 'CONNECTING') return void transport.close(1000, 'shutdown')
    this.transport = transport
    this.state = 'HELLO'
    const hello = buildRelayComputerFrame('cr/hello', {
      computerId: this.deps.computerId,
      token,
      desktopDaemonVersion: this.deps.desktopDaemonVersion
    })
    transport.onMessage((text) => this.onText(transport, hello.id, text))
    transport.onClose((code, reason) => this.onClose(transport, code, reason))
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      if (this.state === 'HELLO' && this.transport === transport) transport.close(1000, 'hello timeout')
    }, HELLO_TIMEOUT_MS)
    transport.send(JSON.stringify(hello))
  }

  private onText(transport: Transport, helloId: string, text: string): void {
    if (this.transport !== transport) return
    const decoded = decodeRelayComputerFrame(text)
    if (!decoded.ok) return this.deps.log(`relay ${this.entry.relayId}: unreadable frame (${decoded.msg})`)
    const frame = decoded.frame
    if (this.state === 'HELLO') return this.onHelloReply(transport, helloId, frame)
    if (this.state === 'READY' && frame.type === 'cr/http') return void this.serve(transport, frame)
  }

  private onHelloReply(transport: Transport, helloId: string, frame: RelayComputerFrame): void {
    if (frame.corr !== helloId) return
    this.clearTimer()
    if (frame.type === 'cr/hello/ok' && frame.payload.relayId === this.entry.relayId) {
      this.state = 'READY'
      this.backoff.reset()
      this.deps.log(`relay ${this.entry.relayId}: attached`)
      return
    }
    // A refusal, or the wrong instance behind the roster url: close and retry later.
    const why =
      frame.type === 'error'
        ? frame.payload.message
        : `reached relay ${String((frame.payload as { relayId?: string }).relayId)}`
    this.deps.log(`relay ${this.entry.relayId}: not attached (${why})`)
    transport.close(1000, 'hello refused')
  }

  private async serve(transport: Transport, frame: Extract<RelayComputerFrame, { type: 'cr/http' }>): Promise<void> {
    let response: CrHttpResponse
    try {
      response = await this.deps.handle(frame.payload)
    } catch (error) {
      this.deps.log(`relay ${this.entry.relayId}: request failed: ${(error as Error).message}`)
      response = { status: 500, headers: {} }
    }
    if (this.transport !== transport || this.state !== 'READY') return
    try {
      transport.send(JSON.stringify(buildRelayComputerFrame('cr/http/result', response, { corr: frame.id })))
    } catch (error) {
      this.deps.log(`relay ${this.entry.relayId}: reply failed: ${(error as Error).message}`)
    }
  }

  private onClose(transport: Transport, code: number, reason: string): void {
    if (this.transport !== transport) return
    this.transport = undefined
    this.clearTimer()
    if (this.state === 'STOPPED') return
    this.deps.log(`relay ${this.entry.relayId}: closed (${code}${reason ? ` ${reason}` : ''})`)
    this.wait()
  }

  private wait(): void {
    if (this.state === 'STOPPED') return
    this.state = 'WAITING'
    this.clearTimer()
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.attempt()
    }, this.backoff.next())
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** Converges one link per relay in the CP's roster; the CP pushes the roster after every auth and on each change. */
export class RelayLinks {
  private readonly links = new Map<string, RelayLink>()
  private readonly clock: Clock

  constructor(private readonly deps: RelayLinksDeps) {
    this.clock = deps.clock ?? systemClock
  }

  converge(relays: ComputerRelayEntry[]): void {
    const wanted = new Map(relays.map((entry) => [entry.relayId, entry]))
    for (const [id, link] of this.links) {
      const entry = wanted.get(id)
      if (entry && entry.url === link.entry.url) continue
      link.stop()
      this.links.delete(id)
    }
    for (const [id, entry] of wanted) {
      const current = this.links.get(id)
      // A link waiting out a lost key restarts now: the roster arrives right after a fresh auth.
      if (current && current.state !== 'WAITING') continue
      current?.stop()
      const link = new RelayLink(entry, this.deps, this.clock)
      this.links.set(id, link)
      link.start()
    }
  }

  /** Close every link: on revoke, a lapsed key or shutdown. */
  stop(): void {
    for (const link of this.links.values()) link.stop()
    this.links.clear()
  }

  /** Relay ids with an attached link. */
  attached(): string[] {
    return [...this.links.values()].filter((link) => link.state === 'READY').map((link) => link.entry.relayId)
  }
}
