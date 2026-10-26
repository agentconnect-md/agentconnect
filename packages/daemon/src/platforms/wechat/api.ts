// iLink bot API calls the daemon makes: the long poll, sends and lifecycle bookkeeping (wechat-integration.md §3.1, §4.4).
import { randomBytes } from 'node:crypto'
import type { WeChatInboundMessage } from '@agentconnect.md/message'
import { DAEMON_VERSION } from '../../version.js'

export const WECHAT_API_URL = 'https://ilinkai.weixin.qq.com'
export const WECHAT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** iLink's answer to a token it no longer accepts; a re-scan is the only cure (§2.3). */
export const WECHAT_STALE_TOKEN = -14

const SEND_TIMEOUT_MS = 15_000
// Bookkeeping only, so a dead network cannot hold a shutdown for long.
const NOTIFY_TIMEOUT_MS = 5_000
const POLL_HOLD_MS = 35_000
// The client waits past the server's hold, so an idle poll ends as an empty answer rather than a timeout.
const POLL_MARGIN_MS = 10_000

export interface WeChatCredentials {
  botToken: string
  apiUrl?: string
}

/** A refusal iLink answered in its body: `ret` or `errcode` non-zero. */
export class WeChatApiError extends Error {
  constructor(
    readonly path: string,
    readonly code: number
  ) {
    super(`wechat: ${path} failed (${code})`)
    this.name = 'WeChatApiError'
  }

  get staleToken(): boolean {
    return this.code === WECHAT_STALE_TOKEN
  }
}

/** A transport failure or a non-2xx answer; for a send, whether it was delivered is unknown. */
export class WeChatTransportError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
    readonly timedOut = false
  ) {
    super(`wechat: ${path} ${timedOut ? 'timed out' : `failed${status ? ` (HTTP ${status})` : ''}`}`)
    this.name = 'WeChatTransportError'
  }
}

export interface WeChatUpdates {
  msgs: WeChatInboundMessage[]
  /** The next cursor; empty when the server sent none, which is never saved (§3.1). */
  cursor: string
  /** How long the server says it holds the next poll. */
  holdMs?: number
}

export interface WeChatApiOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  version?: string
}

// `iLink-App-ClientVersion` packs major, minor and patch as 0x00MMNNPP.
export function weChatClientVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff))
}

// A number past 2^53 keeps its exact digits, so a message id is never rounded (§3.3).
export function parseWeChatJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
      ? context.source
      : value
  )
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : undefined
}

export class WeChatApi {
  readonly apiUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly version: string

  constructor(
    private readonly credentials: WeChatCredentials,
    private readonly options: WeChatApiOptions = {}
  ) {
    this.apiUrl = (credentials.apiUrl ?? WECHAT_API_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.version = options.version ?? DAEMON_VERSION
  }

  private headers(): Record<string, string> {
    // A fresh random uin on every request, decimal then base64, as the official plugin sends it.
    const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.credentials.botToken}`,
      'X-WECHAT-UIN': uin,
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': weChatClientVersion(this.version)
    }
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.version, bot_agent: `AgentConnect/${this.version}` }
  }

  /** One POST; resolves the parsed body, throws {@link WeChatApiError} on a refusal and {@link WeChatTransportError} otherwise. */
  async post(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const caller = [this.options.signal, signal].filter((s): s is AbortSignal => s !== undefined)
    const signals = [AbortSignal.timeout(timeoutMs), ...caller]
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiUrl}/${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...body, base_info: this.baseInfo() }),
        signal: AbortSignal.any(signals)
      })
    } catch (error) {
      if (caller.some((s) => s.aborted)) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new WeChatTransportError(path, undefined, timedOut)
    }
    if (!response.ok) throw new WeChatTransportError(path, response.status)
    let parsed: unknown
    try {
      parsed = parseWeChatJson(await response.text())
    } catch {
      throw new WeChatTransportError(path, response.status)
    }
    const data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const code = numberOf(data.ret) || numberOf(data.errcode)
    if (code) throw new WeChatApiError(path, code)
    return data
  }

  /** One long poll from `cursor`; an empty cursor starts from the present (§3.3). */
  async getUpdates(cursor: string, holdMs = POLL_HOLD_MS, signal?: AbortSignal): Promise<WeChatUpdates> {
    const data = await this.post('ilink/bot/getupdates', { get_updates_buf: cursor }, holdMs + POLL_MARGIN_MS, signal)
    const msgs = Array.isArray(data.msgs) ? (data.msgs as WeChatInboundMessage[]) : []
    const next = typeof data.get_updates_buf === 'string' ? data.get_updates_buf : ''
    const hold = numberOf(data.longpolling_timeout_ms)
    return { msgs, cursor: next, ...(hold && hold > 0 ? { holdMs: hold } : {}) }
  }

  /** Send one complete text message; the answer's id proves nothing about delivery (§4.4). */
  async sendText(to: string, clientId: string, text: string, contextToken?: string): Promise<string | undefined> {
    const data = await this.post(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {})
        }
      },
      SEND_TIMEOUT_MS
    )
    const id = data.message_id
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
  }

  /** Lifecycle bookkeeping around the poll; a failure is the caller's to log and ignore (§3.1). */
  async notify(kind: 'start' | 'stop'): Promise<void> {
    await this.post(`ilink/bot/msg/notify${kind}`, {}, NOTIFY_TIMEOUT_MS)
  }
}
