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

  private async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout
    const response = await (this.options.fetchImpl ?? fetch)(`${this.origin}${path}`, {
      method: 'POST',
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
    if (!response.ok || json === undefined) {
      const code = (json as { code?: unknown } | undefined)?.code
      if (response.status === 401) this.token = undefined
      throw new DingTalkApiError(path, response.status, typeof code === 'string' ? code : undefined)
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
