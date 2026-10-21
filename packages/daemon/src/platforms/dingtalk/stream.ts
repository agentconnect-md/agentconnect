// DingTalk's Stream client (dingtalk-integration.md §3, §3.2): one live socket per app, acks every frame, and hands over without a gap.
import type { Logger } from '../../log.js'

/** The slice of the WHATWG WebSocket the client uses, so tests can drive a fake. */
export interface DingTalkSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface DingTalkStreamFrame {
  specVersion?: string
  type?: string
  headers?: { topic?: string; messageId?: string; [key: string]: unknown }
  data?: string
}

export interface DingTalkStreamDeps {
  /** A fresh endpoint and single-use ticket for each socket. */
  openConnection(): Promise<{ endpoint: string; ticket: string }>
  createSocket?(url: string): DingTalkSocket
  /** One CALLBACK frame's topic and JSON `data`, after it was acknowledged. */
  onCallback(topic: string, data: string): void
  log: Logger
  timing?: Partial<DingTalkStreamTiming>
}

export interface DingTalkStreamTiming {
  openTimeoutMs: number
  /** How long a socket replaced after `disconnect` may keep delivering before the client closes it itself. */
  retireGraceMs: number
  retryBaseMs: number
  retryMaxMs: number
}

const DEFAULT_TIMING: DingTalkStreamTiming = {
  openTimeoutMs: 15_000,
  retireGraceMs: 15_000,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000
}

const OPEN = 1

export class DingTalkStream {
  private current?: DingTalkSocket
  private readonly live = new Set<DingTalkSocket>()
  private opening?: Promise<void>
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly retireTimers = new Set<ReturnType<typeof setTimeout>>()
  private attempt = 0
  private stopped = false
  private readonly timing: DingTalkStreamTiming

  constructor(private readonly deps: DingTalkStreamDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  /** Open the first socket; throws when it cannot, so the caller retries on its own schedule. */
  async start(): Promise<void> {
    await this.open()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    for (const timer of this.retireTimers) clearTimeout(timer)
    this.retireTimers.clear()
    for (const socket of this.live) socket.close(1000, 'stopping')
    this.live.clear()
    this.current = undefined
    await this.opening?.catch(() => undefined)
  }

  /** Sockets currently open; more than one only during a `disconnect` handover. */
  liveSockets(): number {
    return this.live.size
  }

  private open(): Promise<void> {
    this.opening ??= this.openSocket()
      .then((socket) => this.promote(socket))
      .finally(() => {
        this.opening = undefined
      })
    return this.opening
  }

  private connectInBackground(): void {
    if (this.stopped || this.opening) return
    void this.open().catch((error: unknown) => {
      this.deps.log.warn(`dingtalk: stream connect failed (${errorLabel(error)}); retrying`)
      if (!this.current) this.scheduleRetry()
    })
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.current) return
    const exp = Math.min(this.timing.retryMaxMs, this.timing.retryBaseMs * 2 ** this.attempt)
    this.attempt++
    const delay = Math.round(exp / 2 + (Math.random() * exp) / 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connectInBackground()
    }, delay)
    this.retryTimer.unref?.()
  }

  private promote(socket: DingTalkSocket): void {
    if (this.stopped) {
      socket.close(1000, 'stopping')
      return
    }
    const previous = this.current
    this.current = socket
    this.attempt = 0
    if (previous) this.retire(previous)
  }

  // The replaced socket keeps delivering until DingTalk closes it; close it ourselves only if it lingers.
  private retire(socket: DingTalkSocket): void {
    const timer = setTimeout(() => {
      this.retireTimers.delete(timer)
      if (this.live.has(socket)) socket.close(1000, 'replaced')
    }, this.timing.retireGraceMs)
    timer.unref?.()
    this.retireTimers.add(timer)
  }

  private async openSocket(): Promise<DingTalkSocket> {
    const { endpoint, ticket } = await this.deps.openConnection()
    if (this.stopped) throw new Error('stopped')
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`
    const socket = this.deps.createSocket?.(url) ?? (new WebSocket(url) as unknown as DingTalkSocket)
    return await new Promise<DingTalkSocket>((resolve, reject) => {
      let opened = false
      const timer = setTimeout(() => {
        if (opened) return
        socket.close()
        reject(new Error('open timed out'))
      }, this.timing.openTimeoutMs)
      timer.unref?.()
      socket.addEventListener('open', () => {
        opened = true
        clearTimeout(timer)
        this.live.add(socket)
        resolve(socket)
      })
      socket.addEventListener('message', (event) => this.onMessage(socket, event.data))
      socket.addEventListener('error', () => undefined)
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        if (!opened) {
          reject(new Error('closed before open'))
          return
        }
        this.onClose(socket)
      })
    })
  }

  private onClose(socket: DingTalkSocket): void {
    this.live.delete(socket)
    if (this.stopped || socket !== this.current) return
    this.current = undefined
    this.deps.log.warn('dingtalk: stream closed unexpectedly; reconnecting')
    if (!this.opening) this.scheduleRetry()
  }

  private onMessage(socket: DingTalkSocket, raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: DingTalkStreamFrame
    try {
      frame = JSON.parse(raw) as DingTalkStreamFrame
    } catch {
      this.deps.log.warn('dingtalk: dropped an unparseable stream frame')
      return
    }
    const topic = frame.headers?.topic
    const messageId = frame.headers?.messageId
    if (frame.type === 'SYSTEM') {
      // A ping is answered with its own data; `disconnect` means this socket closes in about ten seconds.
      this.ack(socket, messageId, frame.data ?? '{}')
      if (topic === 'disconnect' && socket === this.current) this.connectInBackground()
      return
    }
    if (frame.type === 'EVENT') {
      this.ack(socket, messageId, JSON.stringify({ status: 'SUCCESS', message: 'OK' }))
      return
    }
    if (frame.type !== 'CALLBACK') return
    this.ack(socket, messageId, JSON.stringify({ response: null }))
    if (typeof topic === 'string' && typeof frame.data === 'string') this.deps.onCallback(topic, frame.data)
  }

  private ack(socket: DingTalkSocket, messageId: string | undefined, data: string): void {
    if (!messageId || socket.readyState !== OPEN) return
    socket.send(
      JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data })
    )
  }
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
