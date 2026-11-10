// The worker's link to the desktop daemon: a loopback WebSocket named by managed policy, redialed until it holds.
import {
  COMPUTER_FORM_FILL_PROTOCOL,
  COMPUTER_FORM_FILL_SUBPROTOCOL,
  FormFillWelcome,
  type FormFillHello
} from '@agentconnect.md/protocol/computer-form-fill'
import type { FormFillBridge } from './bridge.js'

export interface SocketLike {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(code?: number): void
}

export interface ConnectionDeps {
  bridge: Pick<FormFillBridge, 'handle'>
  // The managed `endpoint` value, read fresh on every dial.
  endpoint: () => Promise<unknown>
  open: (url: string, protocol: string) => SocketLike
  buildId: string
  version: string
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  log?: (line: string) => void
}

const OPEN = 1
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000

/** Only a loopback ws:// endpoint: the extension never dials anywhere else, whatever the policy says. */
export function loopbackEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export class DaemonConnection {
  private socket: SocketLike | undefined
  private ready = false
  private dialing = false
  private retryMs = RETRY_MIN_MS
  private retry: unknown
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (line: string) => void

  constructor(private readonly deps: ConnectionDeps) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = deps.log ?? (() => undefined)
  }

  connected(): boolean {
    return this.ready && this.socket?.readyState === OPEN
  }

  /** Dials unless a socket is open or opening; safe to call from every wake-up. */
  async ensure(): Promise<void> {
    if (this.dialing || (this.socket && this.socket.readyState <= OPEN)) return
    this.dialing = true
    try {
      const endpoint = loopbackEndpoint(await this.deps.endpoint())
      if (!endpoint) {
        this.log('no loopback endpoint in managed storage yet')
        return
      }
      this.dial(endpoint)
    } finally {
      this.dialing = false
    }
  }

  /** The managed endpoint changed: drop the socket and dial the new one. */
  async restart(): Promise<void> {
    const socket = this.socket
    this.socket = undefined
    this.ready = false
    socket?.close(1000)
    this.retryMs = RETRY_MIN_MS
    await this.ensure()
  }

  private dial(endpoint: string): void {
    const socket = this.deps.open(endpoint, COMPUTER_FORM_FILL_SUBPROTOCOL)
    this.socket = socket
    this.ready = false
    socket.onopen = () => {
      const hello: FormFillHello = {
        type: 'hello',
        protocol: COMPUTER_FORM_FILL_PROTOCOL,
        buildId: this.deps.buildId,
        version: this.deps.version
      }
      socket.send(JSON.stringify(hello))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      if (!this.ready) {
        try {
          if (FormFillWelcome.safeParse(JSON.parse(event.data)).success) {
            this.ready = true
            this.retryMs = RETRY_MIN_MS
          }
        } catch {
          // Not a welcome; ignored until one arrives.
        }
        return
      }
      void this.deps.bridge.handle(event.data).then((reply) => {
        if (reply && this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify(reply))
      })
    }
    socket.onerror = () => undefined
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.ready = false
      this.log(`daemon link closed (${event.code}); redialing in ${this.retryMs} ms`)
      this.schedule()
    }
  }

  private schedule(): void {
    if (this.retry !== undefined) this.clearTimer(this.retry)
    const wait = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
    this.retry = this.setTimer(() => {
      this.retry = undefined
      void this.ensure()
    }, wait)
  }
}
