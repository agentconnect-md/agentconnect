// The two iLink calls of a personal-WeChat QR login (wechat-integration.md §2.2); the response carries a bot token, so never log it.
import { randomBytes } from 'node:crypto'

export const WECHAT_DEFAULT_API_URL = 'https://ilinkai.weixin.qq.com'

/** How long one status call may hold the Console's poll; iLink holds it about 35 s before answering `wait`. */
export const WECHAT_STATUS_WAIT_MS = 40_000

export interface WeChatQrCode {
  qrcode: string
  qrUrl: string
}

export type WeChatQrStatus =
  | { status: 'wait' | 'scaned' | 'expired' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect' }
  | { status: 'scaned_but_redirect'; redirectHost: string }
  | { status: 'confirmed'; botToken: string; ilinkBotId: string; ilinkUserId: string; baseUrl: string | null }
  | { status: 'unknown' }

export interface WeChatLoginClient {
  newQrCode(): Promise<WeChatQrCode>
  /** One status call against `host`; a timeout or transport failure throws. */
  status(host: string, qrcode: string, verifyCode?: string): Promise<WeChatQrStatus>
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(2 << 16)
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

export function createWeChatLoginClient(
  apiUrl = WECHAT_DEFAULT_API_URL,
  fetchImpl: typeof fetch = fetch
): WeChatLoginClient {
  const base = apiUrl.replace(/\/+$/, '')
  return {
    async newQrCode() {
      const response = await fetchImpl(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(15_000)
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const qrcode = text(body.qrcode)
      const qrUrl = text(body.qrcode_img_content)
      if (!response.ok || !qrcode || !qrUrl) throw new Error(`get_bot_qrcode failed with HTTP ${response.status}`)
      return { qrcode, qrUrl }
    },
    async status(host, qrcode, verifyCode) {
      const query = new URLSearchParams({ qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}) })
      const response = await fetchImpl(`${host.replace(/\/+$/, '')}/ilink/bot/get_qrcode_status?${query}`, {
        headers: headers(),
        signal: AbortSignal.timeout(WECHAT_STATUS_WAIT_MS)
      })
      if (!response.ok) throw new Error(`get_qrcode_status failed with HTTP ${response.status}`)
      const body = (await response.json()) as Record<string, unknown>
      switch (body.status) {
        case 'wait':
        case 'scaned':
        case 'expired':
        case 'need_verifycode':
        case 'verify_code_blocked':
        case 'binded_redirect':
          return { status: body.status }
        case 'scaned_but_redirect': {
          const redirectHost = text(body.redirect_host)
          return redirectHost ? { status: 'scaned_but_redirect', redirectHost } : { status: 'scaned' }
        }
        case 'confirmed': {
          const botToken = text(body.bot_token)
          const ilinkBotId = text(body.ilink_bot_id)
          const ilinkUserId = text(body.ilink_user_id)
          if (!botToken || !ilinkBotId || !ilinkUserId) return { status: 'unknown' }
          return { status: 'confirmed', botToken, ilinkBotId, ilinkUserId, baseUrl: text(body.baseurl) ?? null }
        }
        default:
          return { status: 'unknown' }
      }
    }
  }
}

/** A redirect names a bare host; a full URL is kept, anything else falls back to the public endpoint. */
export function weChatPollHost(redirectHost: string): string | null {
  if (/^https:\/\//.test(redirectHost)) return redirectHost
  return /^[a-z0-9.-]+(:\d+)?$/i.test(redirectHost) ? `https://${redirectHost}` : null
}
