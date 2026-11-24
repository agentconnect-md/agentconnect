// Mattermost API v4 REST and WebSocket client: Bearer REST with 429 Retry-After backoff, WS authentication_challenge, heartbeat, and reconnect.
import type { MattermostFileInfo, MattermostPost } from '@agentconnect.md/message'
import { FormData as UndiciFormData } from 'undici'
import { WebSocket as WsWebSocket } from 'ws'
import type { Logger } from '../../log.js'
import {
  downloadMattermostFile,
  makeMattermostLookup,
  mattermostFetch,
  validateMattermostServerUrl,
  type MattermostDownloaded
} from './media.js'
import { MATTERMOST_DEFAULT_RETRY_AFTER_MS, MattermostRateLimiter, parseRetryAfterMs } from './rate-limit.js'

export const MATTERMOST_DEFAULT_MAX_POST_SIZE = 4_000

export interface MattermostClientCapabilities {
  readonly maxPostSize: number
  readonly usernameOverrideEnabled: boolean
  readonly iconOverrideEnabled: boolean
}

function parseClientConfigFlag(raw: unknown, fallback = true): boolean {
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true
  return fallback
}
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_OPEN_TIMEOUT_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_MAX_MISSED_PONGS = 2
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const DEFAULT_STABLE_MS = 60_000
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2
const OPEN = 1

export interface MattermostSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface MattermostWsEvent {
  event?: string
  data?: Record<string, unknown>
  broadcast?: Record<string, unknown>
  seq?: number
  status?: string
  seq_reply?: number
  error?: { id?: string; message?: string }
}

export interface MattermostClientTiming {
  openTimeoutMs: number
  requestTimeoutMs: number
  heartbeatMs: number
  maxMissedPongs: number
  retryBaseMs: number
  retryMaxMs: number
  stableMs: number
  maxRateLimitRetries: number
}

const DEFAULT_TIMING: MattermostClientTiming = {
  openTimeoutMs: DEFAULT_OPEN_TIMEOUT_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
  maxMissedPongs: DEFAULT_MAX_MISSED_PONGS,
  retryBaseMs: DEFAULT_RETRY_BASE_MS,
  retryMaxMs: DEFAULT_RETRY_MAX_MS,
  stableMs: DEFAULT_STABLE_MS,
  maxRateLimitRetries: DEFAULT_MAX_RATE_LIMIT_RETRIES
}

export interface MattermostUser {
  id: string
  username: string
  first_name?: string
  last_name?: string
  nickname?: string
  email?: string
  is_bot?: boolean
  roles?: string
  delete_at?: number
  remote_id?: string
  timezone?: {
    useAutomaticTimezone?: string
    automaticTimezone?: string
    manualTimezone?: string
  }
}

export interface MattermostTeam {
  id: string
  name: string
  display_name?: string
  delete_at?: number
}

export interface MattermostChannel {
  id: string
  create_at?: number
  update_at?: number
  last_post_at?: number
  delete_at?: number
  team_id?: string
  type: 'O' | 'P' | 'D' | 'G' | string
  display_name?: string
  name?: string
  header?: string
  purpose?: string
  shared?: boolean
}

export interface MattermostChannelMember {
  channel_id: string
  user_id: string
  roles?: string
}

export interface MattermostPostList {
  order: string[]
  posts: Record<string, MattermostPost>
  next_post_id?: string
  prev_post_id?: string
}

export interface MattermostReaction {
  user_id: string
  post_id: string
  emoji_name: string
  create_at?: number
}

export class MattermostApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly id?: string,
    readonly retryAfterMs?: number
  ) {
    super(`Mattermost API error (${status}${id ? ` ${id}` : ''}): ${message}`)
    this.name = 'MattermostApiError'
  }

  get isRateLimit(): boolean {
    return this.status === 429
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }

  get isNotFound(): boolean {
    return this.status === 404
  }
}

export class MattermostTransportError extends Error {
  constructor(
    message: string,
    readonly maybeDelivered: boolean
  ) {
    super(message)
    this.name = 'MattermostTransportError'
  }
}

export interface MattermostClientDeps {
  serverUrl: string
  botToken: string
  onEvent(event: MattermostWsEvent): void
  onDisconnect?(): void
  onReconnect?(): void
  onUnauthorized?(status: 401): void
  log: Logger
  createSocket?(url: string, headers?: Record<string, string>): MattermostSocket
  fetchImpl?: typeof fetch
  rateLimiter?: MattermostRateLimiter
  timing?: Partial<MattermostClientTiming>
  now?(): number
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

interface PendingWsRequest {
  resolve(frame: MattermostWsEvent): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type WsState = 'idle' | 'up' | 'reconnecting' | 'stopped'

/** Derive the Mattermost WebSocket URL (`ws(s)://.../api/v4/websocket`) preserving any subpath. */
export function mattermostWebSocketUrl(normalizedServerUrl: string): string {
  const url = new URL(normalizedServerUrl)
  const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = url.pathname.replace(/\/+$/, '')
  return `${wsProto}//${url.host}${basePath}/api/v4/websocket`
}

function decodeWsData(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  if (Array.isArray(raw) && raw.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(raw).toString('utf8')
  }
  return ''
}

export class MattermostClient {
  readonly serverUrl: string
  readonly rateLimiter: MattermostRateLimiter
  private readonly fetcher: typeof fetch
  private readonly timing: MattermostClientTiming
  private readonly now: () => number
  private readonly abort = new AbortController()
  private socket?: MattermostSocket
  private connectingSocket?: MattermostSocket
  private state: WsState = 'idle'
  private opening?: Promise<void>
  private seq = 1
  private attempt = 0
  private upSince = 0
  private clockOffsetMs = 0
  private missedPongs = 0
  private heartbeat?: ReturnType<typeof setInterval>
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly pendingWs = new Map<number, PendingWsRequest>()

  constructor(private readonly deps: MattermostClientDeps) {
    const validated = validateMattermostServerUrl(deps.serverUrl)
    if (!validated.ok) throw new Error(validated.reason)
    if (!deps.botToken.trim()) throw new Error('Mattermost botToken must not be empty')
    this.serverUrl = validated.serverUrl
    this.now = deps.now ?? Date.now
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.rateLimiter = deps.rateLimiter ?? new MattermostRateLimiter(this.now, deps.sleep)
    this.fetcher = mattermostFetch(deps.fetchImpl)
  }

  /** Server wall clock estimated from REST `Date` headers; watermarks compare against server `create_at`, never the daemon clock. */
  serverNow(): number {
    return this.now() + this.clockOffsetMs
  }

  private noteServerDate(headers: Headers): void {
    const raw = headers.get('date')
    const serverMs = raw ? Date.parse(raw) : Number.NaN
    // `Date` is truncated to the second, so the estimate trails the server by under a second; a low watermark only refetches.
    if (Number.isFinite(serverMs)) this.clockOffsetMs = serverMs - this.now()
  }

  get connected(): boolean {
    return this.state === 'up'
  }

  /** Open the WebSocket v4 connection and authenticate via `authentication_challenge`. */
  async start(): Promise<void> {
    if (this.state === 'stopped') throw new Error('mattermost: client is stopped')
    if (this.state === 'up') return
    await this.open()
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.abort.abort()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHeartbeat()
    this.rejectPendingWs(new MattermostTransportError('mattermost: client stopped', false))
    this.socket?.close(1000, 'stopping')
    this.socket = undefined
    this.connectingSocket?.close(1000, 'stopping')
    this.connectingSocket = undefined
    await this.opening?.catch(() => undefined)
  }

  /** Best-effort typing indicator over the open WebSocket (`action: 'user_typing'`). */
  async sendTyping(channelId: string, parentId?: string): Promise<void> {
    const socket = this.socket
    if (this.state !== 'up' || !socket || socket.readyState !== OPEN) return
    const seq = this.seq++
    try {
      socket.send(
        JSON.stringify({
          seq,
          action: 'user_typing',
          data: {
            channel_id: channelId,
            parent_id: parentId ?? ''
          }
        })
      )
    } catch {
      // Typing is transient chrome; never fail a turn if the socket closed concurrently.
    }
  }

  // ── WebSocket lifecycle ──

  private open(): Promise<void> {
    this.opening ??= this.openSocket().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  private async openSocket(): Promise<void> {
    const wsUrl = mattermostWebSocketUrl(this.serverUrl)
    // Authenticate exclusively via post-open `authentication_challenge`: sending an HTTP Upgrade
    // Authorization header pre-authenticates Mattermost's WebConn (`wc.IsAuthenticated() === true`),
    // which causes Mattermost to ignore the subsequent `authentication_challenge` frame with no `seq_reply`.
    const socket: MattermostSocket = this.deps.createSocket?.(wsUrl) ?? this.defaultSocket(wsUrl)
    this.connectingSocket = socket

    try {
      await new Promise<void>((resolve, reject) => {
        let opened = false
        let settled = false
        const settleReject = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        }
        const timer = setTimeout(() => {
          if (opened) return
          socket.close()
          settleReject(new MattermostTransportError('mattermost: websocket open timed out', false))
        }, this.timing.openTimeoutMs)
        timer.unref?.()
        socket.addEventListener('open', () => {
          opened = true
          if (settled) {
            socket.close(1000, 'late open')
            return
          }
          settled = true
          clearTimeout(timer)
          resolve()
        })
        socket.addEventListener('message', (event) => this.onWsMessage(socket, event.data))
        socket.addEventListener('error', () => {
          if (!opened) {
            settleReject(new MattermostTransportError('mattermost: websocket error before open', false))
          }
        })
        socket.addEventListener('close', () => {
          if (!opened) {
            settleReject(new MattermostTransportError('mattermost: websocket closed before open', false))
            return
          }
          this.onWsClose(socket)
        })
      })
    } finally {
      if (this.connectingSocket === socket) this.connectingSocket = undefined
    }

    if ((this.state as WsState) === 'stopped') {
      socket.close(1000, 'stopping')
      throw new Error('mattermost: client stopped')
    }

    this.socket = socket
    this.seq = 1
    const isReconnect = this.state === 'reconnecting'
    try {
      await this.wsRequest(socket, 'authentication_challenge', { token: this.deps.botToken })
    } catch (error) {
      if (this.socket === socket) this.socket = undefined
      socket.close(1000, 'auth failed')
      if (isReconnect) this.deps.onUnauthorized?.(401)
      throw error
    }

    if ((this.state as WsState) === 'stopped') {
      socket.close(1000, 'stopping')
      throw new Error('mattermost: client stopped')
    }

    this.state = 'up'
    this.upSince = this.now()
    this.missedPongs = 0
    this.startHeartbeat(socket)
    // Freeze/launch catch-up synchronously as the socket goes live so no concurrent WS event can advance watermarks first.
    if (isReconnect) this.deps.onReconnect?.()
  }

  private defaultSocket(url: string): MattermostSocket {
    return new WsWebSocket(url, {
      handshakeTimeout: this.timing.openTimeoutMs,
      lookup: makeMattermostLookup()
    })
  }

  private wsRequest(
    socket: MattermostSocket,
    action: string,
    data?: Record<string, unknown>
  ): Promise<MattermostWsEvent> {
    const seq = this.seq++
    return new Promise<MattermostWsEvent>((resolve, reject) => {
      if (socket.readyState !== OPEN) {
        reject(new MattermostTransportError('mattermost: websocket not connected', false))
        return
      }
      const timer = setTimeout(() => {
        if (this.pendingWs.get(seq)?.timer !== timer) return
        this.pendingWs.delete(seq)
        reject(new MattermostTransportError(`mattermost: websocket ${action} timed out`, action !== 'ping'))
      }, this.timing.requestTimeoutMs)
      timer.unref?.()
      this.pendingWs.set(seq, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ seq, action, ...(data ? { data } : {}) }))
      } catch {
        clearTimeout(timer)
        this.pendingWs.delete(seq)
        reject(new MattermostTransportError(`mattermost: websocket ${action} send failed`, false))
      }
    })
  }

  private startHeartbeat(socket: MattermostSocket): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (socket !== this.socket) return
      if (this.missedPongs >= this.timing.maxMissedPongs) {
        this.deps.log.warn('mattermost: websocket heartbeat unanswered; reconnecting')
        this.stopHeartbeat()
        socket.close(4000, 'heartbeat timeout')
        this.onWsClose(socket)
        return
      }
      this.missedPongs++
      this.wsRequest(socket, 'ping').then(
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

  private onWsClose(socket: MattermostSocket): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.stopHeartbeat()
    this.rejectPendingWs(new MattermostTransportError('mattermost: websocket closed', true))
    if (this.state !== 'up') return
    if (this.now() - this.upSince >= this.timing.stableMs) this.attempt = 0
    this.state = 'reconnecting'
    this.deps.onDisconnect?.()
    this.deps.log.warn('mattermost: websocket closed unexpectedly; reconnecting')
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.state !== 'reconnecting' || this.retryTimer) return
    const exp = Math.min(this.timing.retryMaxMs, this.timing.retryBaseMs * 2 ** this.attempt)
    this.attempt++
    const delay = Math.min(this.timing.retryMaxMs, Math.round(exp / 2 + (Math.random() * exp) / 2))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.state !== 'reconnecting') return
      void this.open().then(
        () => undefined,
        (error: unknown) => {
          if (this.state !== 'reconnecting') return
          this.deps.log.warn(`mattermost: websocket reconnect failed (${errorSummary(error)}); retrying`)
          this.scheduleRetry()
        }
      )
    }, delay)
    this.retryTimer.unref?.()
  }

  private onWsMessage(socket: MattermostSocket, raw: unknown): void {
    const text = decodeWsData(raw)
    if (!text) return
    let frame: MattermostWsEvent
    try {
      frame = JSON.parse(text) as MattermostWsEvent
    } catch {
      this.deps.log.warn('mattermost: dropped an unparseable websocket frame')
      return
    }
    if (!frame || typeof frame !== 'object') return

    if (socket !== this.socket && socket !== this.connectingSocket) return
    if (typeof frame.seq_reply === 'number') {
      const pending = this.pendingWs.get(frame.seq_reply)
      if (pending) {
        this.pendingWs.delete(frame.seq_reply)
        clearTimeout(pending.timer)
        if (frame.status === 'FAIL' || frame.error) {
          const msg = frame.error?.message || 'websocket request failed'
          pending.reject(new MattermostApiError(401, msg, frame.error?.id))
        } else {
          pending.resolve(frame)
        }
      }
      return
    }

    if (socket !== this.socket || this.state !== 'up') return
    if (typeof frame.event === 'string') {
      this.deps.onEvent(frame)
    }
  }

  private rejectPendingWs(error: Error): void {
    for (const pending of this.pendingWs.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingWs.clear()
  }

  // ── REST API v4 ──

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts?: { body?: unknown; form?: UndiciFormData | FormData; timeoutMs?: number; skipUnauthorizedHook?: boolean }
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`
    const timeoutMs = opts?.timeoutMs ?? this.timing.requestTimeoutMs
    const maxRetries = Math.max(0, this.timing.maxRateLimitRetries)

    for (let attempt = 0; ; attempt++) {
      await this.rateLimiter.waitIfLimited(this.abort.signal)
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)])
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.deps.botToken}`,
        Accept: 'application/json'
      }
      let body: string | UndiciFormData | FormData | undefined
      if (opts?.form) {
        body = opts.form
      } else if (opts?.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(opts.body)
      }

      let response: Response
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          ...(body !== undefined ? { body: body as NonNullable<Parameters<typeof fetch>[1]>['body'] } : {}),
          redirect: 'error',
          signal
        })
      } catch (error) {
        if (error instanceof MattermostApiError || error instanceof MattermostTransportError) throw error
        const reason = this.abort.signal.aborted
          ? 'client stopped'
          : error instanceof Error && error.name === 'TimeoutError'
            ? `${method} ${path} timed out`
            : `${method} ${path} failed`
        throw new MattermostTransportError(`mattermost: ${reason}`, method !== 'GET' && !this.abort.signal.aborted)
      }

      this.noteServerDate(response.headers)
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers, this.now()) ?? MATTERMOST_DEFAULT_RETRY_AFTER_MS
        const errPayload = await readErrorPayload(response)
        this.rateLimiter.backoff(retryAfterMs)
        if (attempt < maxRetries) continue
        throw new MattermostApiError(429, errPayload.message ?? 'Too Many Requests', errPayload.id, retryAfterMs)
      }

      if (!response.ok) {
        const errPayload = await readErrorPayload(response)
        if (response.status === 401 && !opts?.skipUnauthorizedHook) {
          this.deps.onUnauthorized?.(401)
        }
        throw new MattermostApiError(response.status, errPayload.message ?? `HTTP ${response.status}`, errPayload.id)
      }

      const text = await response.text()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new MattermostTransportError(`mattermost: invalid JSON from ${method} ${path}`, false)
      }
    }
  }

  getMe(opts?: { skipUnauthorizedHook?: boolean }): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', '/api/v4/users/me', {
      ...(opts?.skipUnauthorizedHook ? { skipUnauthorizedHook: true } : {})
    })
  }

  getClientConfig(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/api/v4/config/client?format=old')
  }

  /** Probe `MaxPostSize` and identity override flags from `/api/v4/config/client?format=old`. */
  async getClientCapabilities(): Promise<MattermostClientCapabilities> {
    try {
      const cfg = await this.getClientConfig()
      const raw = cfg?.MaxPostSize
      const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
      const maxPostSize = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : MATTERMOST_DEFAULT_MAX_POST_SIZE
      return {
        maxPostSize,
        usernameOverrideEnabled: parseClientConfigFlag(cfg?.EnablePostUsernameOverride, true),
        iconOverrideEnabled: parseClientConfigFlag(cfg?.EnablePostIconOverride, true)
      }
    } catch (error) {
      this.deps.log.debug(
        `mattermost: config/client probe failed (${errorSummary(error)}); using default ${MATTERMOST_DEFAULT_MAX_POST_SIZE}`
      )
      return {
        maxPostSize: MATTERMOST_DEFAULT_MAX_POST_SIZE,
        usernameOverrideEnabled: true,
        iconOverrideEnabled: true
      }
    }
  }

  /** Probe `MaxPostSize` from `/api/v4/config/client?format=old`, falling back safely to 4000. */
  async getMaxPostSize(): Promise<number> {
    return (await this.getClientCapabilities()).maxPostSize
  }

  getMyTeams(): Promise<MattermostTeam[]> {
    return this.request<MattermostTeam[]>('GET', '/api/v4/users/me/teams')
  }

  getMyChannels(includeDeleted = false): Promise<MattermostChannel[]> {
    const query = includeDeleted ? '?include_deleted=true' : '?include_deleted=false'
    return this.request<MattermostChannel[]>('GET', `/api/v4/users/me/channels${query}`)
  }

  getChannel(channelId: string): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('GET', `/api/v4/channels/${encodeURIComponent(channelId)}`)
  }

  getChannelByName(teamId: string, name: string): Promise<MattermostChannel> {
    return this.request<MattermostChannel>(
      'GET',
      `/api/v4/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(name)}`
    )
  }

  getChannelMembers(channelId: string, page = 0, perPage = 200): Promise<MattermostChannelMember[]> {
    return this.request<MattermostChannelMember[]>(
      'GET',
      `/api/v4/channels/${encodeURIComponent(channelId)}/members?page=${page}&per_page=${perPage}`
    )
  }

  getChannelMember(channelId: string, userId: string): Promise<MattermostChannelMember> {
    return this.request<MattermostChannelMember>(
      'GET',
      `/api/v4/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`
    )
  }

  addChannelMember(channelId: string, userId: string): Promise<MattermostChannelMember> {
    return this.request<MattermostChannelMember>('POST', `/api/v4/channels/${encodeURIComponent(channelId)}/members`, {
      body: { user_id: userId }
    })
  }

  removeChannelMember(channelId: string, userId: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/api/v4/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`
    )
  }

  createEphemeralPost(userId: string, channelId: string, message: string, rootId?: string): Promise<void> {
    return this.request<void>('POST', '/api/v4/posts/ephemeral', {
      body: {
        user_id: userId,
        post: {
          channel_id: channelId,
          message,
          ...(rootId ? { root_id: rootId } : {})
        }
      }
    })
  }

  createChannel(body: {
    team_id: string
    name: string
    display_name: string
    type: 'O' | 'P'
    purpose?: string
    header?: string
  }): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('POST', '/api/v4/channels', { body })
  }

  createDirectChannel(userIds: [string, string]): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('POST', '/api/v4/channels/direct', { body: userIds })
  }

  createGroupChannel(userIds: string[]): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('POST', '/api/v4/channels/group', { body: userIds })
  }

  getUser(userId: string): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', `/api/v4/users/${encodeURIComponent(userId)}`)
  }

  getUsersByIds(userIds: string[]): Promise<MattermostUser[]> {
    if (userIds.length === 0) return Promise.resolve([])
    return this.request<MattermostUser[]>('POST', '/api/v4/users/ids', { body: userIds })
  }

  getUsersByUsernames(usernames: string[]): Promise<MattermostUser[]> {
    if (usernames.length === 0) return Promise.resolve([])
    return this.request<MattermostUser[]>('POST', '/api/v4/users/usernames', { body: usernames })
  }

  createPost(body: {
    channel_id: string
    message: string
    root_id?: string
    file_ids?: string[]
    props?: Record<string, unknown>
  }): Promise<MattermostPost & { id: string }> {
    return this.request<MattermostPost & { id: string }>('POST', '/api/v4/posts', { body })
  }

  /** Partial update via `PUT /api/v4/posts/{id}/patch` (Mattermost v4 uses PUT, never HTTP PATCH). */
  patchPost(
    postId: string,
    body: {
      message?: string
      file_ids?: string[]
      props?: Record<string, unknown>
      is_pinned?: boolean
    }
  ): Promise<MattermostPost & { id: string }> {
    return this.request<MattermostPost & { id: string }>('PUT', `/api/v4/posts/${encodeURIComponent(postId)}/patch`, {
      body
    })
  }

  async deletePost(postId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/v4/posts/${encodeURIComponent(postId)}`)
  }

  getPost(postId: string): Promise<MattermostPost> {
    return this.request<MattermostPost>('GET', `/api/v4/posts/${encodeURIComponent(postId)}`)
  }

  getPostThread(
    postId: string,
    opts?: { perPage?: number; fromCreateAt?: number; fromPost?: string; direction?: 'up' | 'down' }
  ): Promise<MattermostPostList> {
    const params = new URLSearchParams()
    if (opts?.perPage !== undefined) params.set('perPage', String(opts.perPage))
    if (opts?.fromCreateAt !== undefined) params.set('fromCreateAt', String(opts.fromCreateAt))
    if (opts?.fromPost !== undefined) params.set('fromPost', opts.fromPost)
    if (opts?.direction !== undefined) params.set('direction', opts.direction)
    const qs = params.toString()
    return this.request<MattermostPostList>(
      'GET',
      `/api/v4/posts/${encodeURIComponent(postId)}/thread${qs ? `?${qs}` : ''}`
    )
  }

  getChannelPosts(
    channelId: string,
    opts?: { page?: number; perPage?: number; since?: number; before?: string; after?: string }
  ): Promise<MattermostPostList> {
    const params = new URLSearchParams()
    if (opts?.page !== undefined) params.set('page', String(opts.page))
    if (opts?.perPage !== undefined) params.set('per_page', String(opts.perPage))
    if (opts?.since !== undefined) params.set('since', String(opts.since))
    if (opts?.before !== undefined) params.set('before', opts.before)
    if (opts?.after !== undefined) params.set('after', opts.after)
    const qs = params.toString()
    return this.request<MattermostPostList>(
      'GET',
      `/api/v4/channels/${encodeURIComponent(channelId)}/posts${qs ? `?${qs}` : ''}`
    )
  }

  searchTeamPosts(
    teamId: string,
    body: {
      terms: string
      is_or_search?: boolean
      time_zone_offset?: number
      include_deleted_channels?: boolean
      page?: number
      per_page?: number
    }
  ): Promise<MattermostPostList> {
    return this.request<MattermostPostList>('POST', `/api/v4/teams/${encodeURIComponent(teamId)}/posts/search`, {
      body
    })
  }

  addReaction(body: { user_id: string; post_id: string; emoji_name: string }): Promise<MattermostReaction> {
    return this.request<MattermostReaction>('POST', '/api/v4/reactions', { body })
  }

  async removeReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/api/v4/users/${encodeURIComponent(userId)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emojiName)}`
    )
  }

  getReactions(postId: string): Promise<MattermostReaction[]> {
    return this.request<MattermostReaction[]>('GET', `/api/v4/posts/${encodeURIComponent(postId)}/reactions`)
  }

  /** Step 1 of file sharing: multipart upload to `POST /api/v4/files?channel_id=...`. */
  async uploadFiles(
    channelId: string,
    files: readonly { bytes: Buffer; name: string; mimeType?: string }[]
  ): Promise<MattermostFileInfo[]> {
    // Use undici's FormData so undiciFetch serializes multipart/form-data (node global FormData falls back to "[object FormData]").
    const form = new UndiciFormData()
    for (const file of files) {
      const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mimeType || 'application/octet-stream' })
      form.append('files', blob, file.name)
    }
    const res = await this.request<{ file_infos?: MattermostFileInfo[] }>(
      'POST',
      `/api/v4/files?channel_id=${encodeURIComponent(channelId)}`,
      { form }
    )
    return res?.file_infos ?? []
  }

  getFileInfo(fileId: string): Promise<MattermostFileInfo> {
    return this.request<MattermostFileInfo>('GET', `/api/v4/files/${encodeURIComponent(fileId)}/info`)
  }

  downloadFile(fileIdOrUrl: string, maxBytes: number): Promise<MattermostDownloaded | null> {
    return downloadMattermostFile(
      {
        serverUrl: this.serverUrl,
        botToken: this.deps.botToken,
        signal: this.abort.signal,
        fetchImpl: this.deps.fetchImpl,
        rateLimiter: this.rateLimiter,
        now: this.now,
        sleep: this.deps.sleep
      },
      fileIdOrUrl,
      maxBytes,
      (reason) => this.deps.log.warn(`mattermost: file download failed (${reason})`)
    )
  }
}

async function readErrorPayload(response: Response): Promise<{ id?: string; message?: string }> {
  try {
    const raw = await response.text()
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { id?: unknown; message?: unknown }
    return {
      ...(typeof parsed.id === 'string' && parsed.id ? { id: parsed.id } : {}),
      ...(typeof parsed.message === 'string' && parsed.message ? { message: parsed.message } : {})
    }
  } catch {
    return {}
  }
}

function errorSummary(error: unknown): string {
  if (error instanceof MattermostApiError) return `HTTP ${error.status}${error.id ? ` (${error.id})` : ''}`
  return error instanceof Error ? error.message : 'unknown error'
}
