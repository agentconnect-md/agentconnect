// DingTalk OpenAPI calls the daemon makes: the access token, the Stream ticket and robot sends (dingtalk-integration.md §3, §4.2).
import { splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'

export const DINGTALK_API_ORIGIN = 'https://api.dingtalk.com'
export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'
/** The most UTF-8 bytes a robot send's `msgParam` may carry (§4.2). */
export const DINGTALK_MSG_PARAM_MAX_BYTES = 15_000

const REQUEST_TIMEOUT_MS = 15_000
// Refresh this long before the 7,200-second token expires, so no call races its expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

export interface DingTalkCredentials {
  clientId: string
  clientSecret: string
}

/** Where a robot send goes: a group by its `openConversationId`, a DM by the member's staff id. */
export type DingTalkTarget = { kind: 'group'; openConversationId: string } | { kind: 'user'; staffId: string }

export function dingTalkTargetForChannel(channel: string): DingTalkTarget {
  return channel.startsWith('dm:')
    ? { kind: 'user', staffId: channel.slice('dm:'.length) }
    : { kind: 'group', openConversationId: channel }
}

/** A failed OpenAPI call; `code` is DingTalk's own error code, never the response text. */
export class DingTalkApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(`dingtalk: ${path} failed (HTTP ${status}${code ? ` ${code}` : ''})`)
    this.name = 'DingTalkApiError'
  }
}

/** Which edition limit refused a call: the organization's monthly quota or the app's per-API QPS (§4.4). */
export type DingTalkLimit = 'quota' | 'rate'

/** A call DingTalk refused for a usage limit rather than for its content. */
export class DingTalkLimitError extends DingTalkApiError {
  constructor(
    path: string,
    status: number,
    code: string,
    readonly limit: DingTalkLimit
  ) {
    super(path, status, code)
    this.name = 'DingTalkLimitError'
  }
}

const LIMIT_CODES: Record<string, DingTalkLimit> = {
  '90020': 'quota',
  'Forbidden.AccessDenied.ApiCountLimitForOrg': 'quota',
  '90018': 'rate',
  'Forbidden.AccessDenied.QpsLimitForAppkeyAndApi': 'rate'
}

/** The typed error for a refused call, mapping DingTalk's limit codes (§4.4). */
export function dingTalkApiError(path: string, status: number, code?: string): DingTalkApiError {
  const limit = code ? LIMIT_CODES[code] : undefined
  return limit && code ? new DingTalkLimitError(path, status, code, limit) : new DingTalkApiError(path, status, code)
}

/** The limit behind `error`, if DingTalk refused the call for one. */
export function dingTalkLimitOf(error: unknown): DingTalkLimit | undefined {
  return error instanceof DingTalkLimitError ? error.limit : undefined
}

// v1.0 APIs answer `{code}` with a non-2xx status; legacy ones answer `{errcode}`, sometimes with HTTP 200.
function errorCode(json: unknown): string | undefined {
  const body = json as { code?: unknown; errcode?: unknown } | undefined
  if (typeof body?.code === 'string' && body.code) return body.code
  if (typeof body?.code === 'number') return String(body.code)
  if (typeof body?.errcode === 'number' && body.errcode !== 0) return String(body.errcode)
  return undefined
}

export interface DingTalkApiOptions {
  fetchImpl?: typeof fetch
  origin?: string
  now?: () => number
  signal?: AbortSignal
}

export class DingTalkApi {
  private token?: { value: string; expiresAt: number }
  private tokenRequest?: Promise<string>

  constructor(
    private readonly credentials: DingTalkCredentials,
    private readonly options: DingTalkApiOptions = {}
  ) {}

  private get origin(): string {
    return this.options.origin ?? DINGTALK_API_ORIGIN
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>('POST', path, body, headers)
  }

  /** One call with the app's access token, for the card APIs (§4.3). */
  async call<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    const token = await this.accessToken()
    return await this.request<T>(method, path, body, { 'x-acs-dingtalk-access-token': token })
  }

  private async request<T>(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout
    const response = await (this.options.fetchImpl ?? fetch)(`${this.origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = undefined
    }
    const code = errorCode(json)
    if (!response.ok || json === undefined || (code && LIMIT_CODES[code])) {
      if (response.status === 401) this.token = undefined
      throw dingTalkApiError(path, response.status, code)
    }
    return json as T
  }

  /** The app's access token, cached and refreshed before it expires; concurrent callers share one request. */
  accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now())
      return Promise.resolve(this.token.value)
    this.tokenRequest ??= this.post<{ accessToken?: unknown; expireIn?: unknown }>('/v1.0/oauth2/accessToken', {
      appKey: this.credentials.clientId,
      appSecret: this.credentials.clientSecret
    })
      .then((result) => {
        if (typeof result.accessToken !== 'string' || !result.accessToken)
          throw new DingTalkApiError('/v1.0/oauth2/accessToken', 200)
        const lifetimeS = typeof result.expireIn === 'number' && result.expireIn > 0 ? result.expireIn : 7200
        this.token = { value: result.accessToken, expiresAt: this.now() + lifetimeS * 1000 }
        return result.accessToken
      })
      .finally(() => {
        this.tokenRequest = undefined
      })
    return this.tokenRequest
  }

  /** A Stream endpoint and its single-use ticket, valid for 90 seconds. */
  async openStream(): Promise<{ endpoint: string; ticket: string }> {
    const path = '/v1.0/gateway/connections/open'
    const result = await this.post<{ endpoint?: unknown; ticket?: unknown }>(path, {
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
      subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }],
      ua: 'agentconnect-daemon',
      localIp: '127.0.0.1'
    })
    if (typeof result.endpoint !== 'string' || typeof result.ticket !== 'string') throw new DingTalkApiError(path, 200)
    return { endpoint: result.endpoint, ticket: result.ticket }
  }

  /** One robot message; returns the send's process query key, the only handle DingTalk gives the bot for it. */
  async send(target: DingTalkTarget, msgKey: string, msgParam: string): Promise<string | undefined> {
    const token = await this.accessToken()
    const base = { robotCode: this.credentials.clientId, msgKey, msgParam }
    const result =
      target.kind === 'group'
        ? await this.post<{ processQueryKey?: unknown }>(
            '/v1.0/robot/groupMessages/send',
            { ...base, openConversationId: target.openConversationId },
            { 'x-acs-dingtalk-access-token': token }
          )
        : await this.post<{ processQueryKey?: unknown }>(
            '/v1.0/robot/oToMessages/batchSend',
            { ...base, userIds: [target.staffId] },
            { 'x-acs-dingtalk-access-token': token }
          )
    return typeof result.processQueryKey === 'string' && result.processQueryKey ? result.processQueryKey : undefined
  }
}

/** A notification title for a Markdown message: its first line without markup, at most 32 characters. */
export function dingTalkMarkdownTitle(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.replace(/[#>*_`~[\]()|]/g, '').trim())
    .find(Boolean)
  if (!line) return 'Reply'
  const chars = [...line]
  return chars.length > 32 ? `${chars.slice(0, 31).join('')}…` : line
}

function paramBytes(param: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(param), 'utf8')
}

/** Split `text` so each part's `msgParam` fits the byte limit once encoded with `wrap`, which may add a fixed suffix. */
export function splitForMsgParam(
  text: string,
  wrap: (part: string) => Record<string, string>,
  maxBytes = DINGTALK_MSG_PARAM_MAX_BYTES
): string[] {
  const fit = (body: string, budget: number): string[] =>
    splitMarkdownByBytes(body, budget).flatMap((part) => {
      const bytes = paramBytes(wrap(part))
      if (bytes <= maxBytes) return [part]
      // JSON escaping grew the part past the limit: split it again under a budget scaled by the growth.
      const next = Math.floor((budget * maxBytes) / bytes) - 16
      return next > 0 && next < budget ? fit(part, next) : [part]
    })
  return fit(text, Math.max(1, maxBytes - paramBytes(wrap(''))))
}
