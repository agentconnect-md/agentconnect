// WeCom's smart bot long connection: subscribe, heartbeat, replies correlated by req_id, reconnect, and a kick that stays down.
import { randomUUID } from 'node:crypto'
import type { Logger } from '../../log.js'
import type { WeComUploadCommand } from './media.js'

/** WeCom's public long-connection endpoint (official doc, path 101463); privately deployed WeCom is out of scope. */
export const WECOM_LONG_CONNECTION_URL = 'wss://openws.work.weixin.qq.com'

export const WECOM_MSG_CALLBACK = 'aibot_msg_callback'
export const WECOM_EVENT_CALLBACK = 'aibot_event_callback'
const SUBSCRIBE = 'aibot_subscribe'
const PING = 'ping'
const RESPOND = 'aibot_respond_msg'
const RESPOND_UPDATE = 'aibot_respond_update_msg'
const SEND = 'aibot_send_msg'

/** The slice of the WHATWG WebSocket the client uses, so tests can drive a fake. */
export interface WeComSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/** One frame either way; a response carries no `cmd`, only the request's `req_id` and an `errcode`. */
export interface WeComFrame {
  cmd?: string
  headers?: { req_id?: string }
  body?: unknown
  errcode?: number
  errmsg?: string
}

/** A callback as the connection receives it; `generation` names the subscribed socket that delivered it. */
export interface WeComCallback {
  cmd: typeof WECOM_MSG_CALLBACK | typeof WECOM_EVENT_CALLBACK
  reqId: string
  body: Record<string, unknown>
  generation: number
}

/** WeCom answered a request with a non-zero `errcode`; `errmsg` is the platform's own wording. */
export class WeComRequestError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string
  ) {
    super(`WeCom refused the request (errcode ${errcode}: ${errmsg})`)
    this.name = 'WeComRequestError'
  }
}

/** The request never got an answer; `maybeDelivered` when the frame left before the socket failed or the wait ran out. */
export class WeComTransportError extends Error {
  constructor(
    message: string,
    readonly maybeDelivered: boolean
  ) {
    super(message)
    this.name = 'WeComTransportError'
  }
}

export interface WeComClientTiming {
  openTimeoutMs: number
  /** How long a request, the subscribe included, waits for its response. */
  requestTimeoutMs: number
  heartbeatMs: number
  /** Unanswered pings after which the socket is treated as dead. */
  maxMissedPongs: number
  retryBaseMs: number
  retryMaxMs: number
  /** How long a socket must stay subscribed before a drop restarts the backoff from its base. */
  stableMs: number
}

// Conservative choice: the doc names a 30 s heartbeat and a rate-limited subscribe but no backoff, so reconnects start at 5 s and cap at 5 min.
const DEFAULT_TIMING: WeComClientTiming = {
  openTimeoutMs: 15_000,
  requestTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  maxMissedPongs: 2,
  retryBaseMs: 5_000,
  retryMaxMs: 300_000,
  stableMs: 60_000
}

const OPEN = 1

export interface WeComClientDeps {
  botId: string
  secret: string
  url?: string
  createSocket?(url: string): WeComSocket
  onCallback(callback: WeComCallback): void
  /** Another connection subscribed this bot; the client is down and never redials by itself. */
  onKicked(): void
  log: Logger
  timing?: Partial<WeComClientTiming>
}

interface PendingRequest {
  resolve(frame: WeComFrame): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type ClientState = 'idle' | 'up' | 'reconnecting' | 'kicked' | 'stopped'

export class WeComClient {
  private socket?: WeComSocket
  private state: ClientState = 'idle'
  private opening?: Promise<void>
  private generationNo = 0
  private attempt = 0
  private upSince = 0
  private missedPongs = 0
  private heartbeat?: ReturnType<typeof setInterval>
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, PendingRequest>()
  // Replies under one req_id go out one at a time, each after the previous one's response (the official SDK's rule).
  private readonly replyChains = new Map<string, Promise<unknown>>()
  private readonly timing: WeComClientTiming

  constructor(private readonly deps: WeComClientDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  /** The subscribed socket's number; a callback from an earlier one can no longer be answered on this socket. */
  get generation(): number {
    return this.generationNo
  }

  get connected(): boolean {
    return this.state === 'up'
  }

  get kicked(): boolean {
    return this.state === 'kicked'
  }

  /** Open and subscribe; throws when either fails, so the caller retries on its own schedule. */
  async start(): Promise<void> {
    if (this.state === 'stopped') throw new Error('stopped')
    await this.open()
  }

  /** Dial again after a kick; only the connection reconciler calls this, after its cooldown. */
  async redial(): Promise<void> {
    if (this.state !== 'kicked') return
    this.state = 'idle'
    try {
      await this.open()
    } catch (error) {
      if (this.state === 'idle') this.state = 'kicked'
      throw error
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHeartbeat()
    this.rejectPending(new WeComTransportError('wecom: connection stopped', false))
    this.socket?.close(1000, 'stopping')
    this.socket = undefined
    await this.opening?.catch(() => undefined)
  }

  /** Answer a callback under its `req_id`, serially per `req_id`; a callback from an earlier socket is refused unsent. */
  respond(reqId: string, generation: number, body: Record<string, unknown>): Promise<WeComFrame> {
    return this.respondAs(RESPOND, reqId, generation, body)
  }

  /** Replace a template card under the `req_id` of the tap that names it; WeCom takes it only within 5 s of the tap. */
  respondUpdate(reqId: string, generation: number, body: Record<string, unknown>): Promise<WeComFrame> {
    return this.respondAs(RESPOND_UPDATE, reqId, generation, body)
  }

  private respondAs(
    cmd: string,
    reqId: string,
    generation: number,
    body: Record<string, unknown>
  ): Promise<WeComFrame> {
    const previous = this.replyChains.get(reqId) ?? Promise.resolve()
    const run = previous.then(() => {
      if (generation !== this.generationNo || this.state !== 'up')
        throw new WeComTransportError('wecom: the callback came on an earlier connection', false)
      return this.request(cmd, body, reqId)
    })
    const settled = run.catch(() => undefined)
    this.replyChains.set(reqId, settled)
    void settled.then(() => {
      if (this.replyChains.get(reqId) === settled) this.replyChains.delete(reqId)
    })
    return run
  }

  /** One media upload step under a fresh `req_id`. */
  command(cmd: WeComUploadCommand, body: Record<string, unknown>): Promise<WeComFrame> {
    if (this.state !== 'up') return Promise.reject(new WeComTransportError('wecom: not connected', false))
    return this.request(cmd, body)
  }

  /** A proactive send under a fresh `req_id`. */
  send(body: Record<string, unknown>): Promise<WeComFrame> {
    if (this.state !== 'up') return Promise.reject(new WeComTransportError('wecom: not connected', false))
    return this.request(SEND, body)
  }

  private open(): Promise<void> {
    this.opening ??= this.openSocket().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  private async openSocket(): Promise<void> {
    const url = this.deps.url ?? WECOM_LONG_CONNECTION_URL
    const socket = this.deps.createSocket?.(url) ?? (new WebSocket(url) as unknown as WeComSocket)
    await new Promise<void>((resolve, reject) => {
      let opened = false
      const timer = setTimeout(() => {
        if (opened) return
        socket.close()
        reject(new WeComTransportError('wecom: open timed out', false))
      }, this.timing.openTimeoutMs)
      timer.unref?.()
      socket.addEventListener('open', () => {
        opened = true
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('message', (event) => this.onMessage(socket, event.data))
      socket.addEventListener('error', () => undefined)
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        if (!opened) {
          reject(new WeComTransportError('wecom: closed before open', false))
          return
        }
        this.onClose(socket)
      })
    })
    if (this.state === 'stopped') {
      socket.close(1000, 'stopping')
      throw new Error('stopped')
    }
    this.socket = socket
    try {
      await this.request(SUBSCRIBE, { bot_id: this.deps.botId, secret: this.deps.secret })
    } catch (error) {
      if (this.socket === socket) this.socket = undefined
      socket.close(1000, 'subscribe failed')
      throw error
    }
    if ((this.state as ClientState) === 'stopped') {
      socket.close(1000, 'stopping')
      throw new Error('stopped')
    }
    this.generationNo++
    this.state = 'up'
    this.upSince = Date.now()
    this.missedPongs = 0
    this.startHeartbeat(socket)
  }

  private request(cmd: string, body: Record<string, unknown> | undefined, reqId = `${cmd}_${randomUUID()}`) {
    const socket = this.socket
    return new Promise<WeComFrame>((resolve, reject) => {
      if (!socket || socket.readyState !== OPEN) {
        reject(new WeComTransportError('wecom: not connected', false))
        return
      }
      const timer = setTimeout(() => {
        if (this.pending.get(reqId)?.timer !== timer) return
        this.pending.delete(reqId)
        reject(new WeComTransportError('wecom: request timed out', true))
      }, this.timing.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(reqId, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ cmd, headers: { req_id: reqId }, ...(body ? { body } : {}) }))
      } catch {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(new WeComTransportError('wecom: send failed', false))
      }
    })
  }

  private startHeartbeat(socket: WeComSocket): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (socket !== this.socket) return
      if (this.missedPongs >= this.timing.maxMissedPongs) {
        this.deps.log.warn('wecom: heartbeat unanswered; reconnecting')
        this.stopHeartbeat()
        socket.close(4000, 'heartbeat timeout')
        // A socket that never reports its close is abandoned so the reconnect still runs.
        this.onClose(socket)
        return
      }
      this.missedPongs++
      this.request(PING, undefined).then(
        () => {
          if (socket === this.socket) this.missedPongs = 0
        },
        () => undefined
      )
    }, this.timing.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private onClose(socket: WeComSocket): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.stopHeartbeat()
    this.rejectPending(new WeComTransportError('wecom: connection closed', true))
    if (this.state !== 'up') return
    if (Date.now() - this.upSince >= this.timing.stableMs) this.attempt = 0
    this.state = 'reconnecting'
    this.deps.log.warn('wecom: connection closed unexpectedly; reconnecting')
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.state !== 'reconnecting' || this.retryTimer) return
    const exp = Math.min(this.timing.retryMaxMs, this.timing.retryBaseMs * 2 ** this.attempt)
    this.attempt++
    const delay = Math.round(exp / 2 + (Math.random() * exp) / 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.state !== 'reconnecting') return
      void this.open().catch((error: unknown) => {
        if (this.state !== 'reconnecting') return
        this.deps.log.warn(`wecom: reconnect failed (${errorLabel(error)}); retrying`)
        this.scheduleRetry()
      })
    }, delay)
    this.retryTimer.unref?.()
  }

  private onMessage(socket: WeComSocket, raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: WeComFrame
    try {
      frame = JSON.parse(raw) as WeComFrame
    } catch {
      this.deps.log.warn('wecom: dropped an unparseable frame')
      return
    }
    if (!frame || typeof frame !== 'object') return
    const reqId = typeof frame.headers?.req_id === 'string' ? frame.headers.req_id : ''
    if (frame.cmd === undefined) {
      this.onResponse(reqId, frame)
      return
    }
    if (socket !== this.socket || this.state !== 'up') return
    if (frame.cmd !== WECOM_MSG_CALLBACK && frame.cmd !== WECOM_EVENT_CALLBACK) return
    const body = frame.body && typeof frame.body === 'object' ? (frame.body as Record<string, unknown>) : undefined
    if (!body) return
    const event = body.event as { eventtype?: unknown } | undefined
    if (frame.cmd === WECOM_EVENT_CALLBACK && event?.eventtype === 'disconnected_event') {
      this.onKicked(socket)
      return
    }
    this.deps.onCallback({ cmd: frame.cmd, reqId, body, generation: this.generationNo })
  }

  private onResponse(reqId: string, frame: WeComFrame): void {
    const pending = this.pending.get(reqId)
    if (!pending) return
    this.pending.delete(reqId)
    clearTimeout(pending.timer)
    if (frame.errcode === 0) pending.resolve(frame)
    else
      pending.reject(
        new WeComRequestError(
          typeof frame.errcode === 'number' ? frame.errcode : -1,
          typeof frame.errmsg === 'string' ? frame.errmsg : 'unknown error'
        )
      )
  }

  // A newer subscribe took the bot over; redialing from here would evict it and start an eviction loop, so the client stays down.
  private onKicked(socket: WeComSocket): void {
    this.state = 'kicked'
    this.socket = undefined
    this.stopHeartbeat()
    this.rejectPending(new WeComTransportError('wecom: another connection took over this bot', true))
    socket.close(1000, 'replaced')
    this.deps.onKicked()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function errorLabel(error: unknown): string {
  if (error instanceof WeComRequestError) return `errcode ${error.errcode}`
  return error instanceof Error ? error.message : 'unknown error'
}
