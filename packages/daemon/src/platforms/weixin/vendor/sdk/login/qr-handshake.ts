import { ILINK_CDN_ROOT_DEFAULT, ILINK_QR_BOT_CLASS_DEFAULT } from '../internal/config.js'
import { delay } from '../internal/async-tools.js'
import { GatewayFault } from '../internal/errors.js'
import { nextScopedOpId } from '../internal/random-tags.js'
import type { IlinkJsonTransport } from '../transport/ilink-json-transport.js'
import type { CredentialBlob, LoginOutcome, LoginTicket, WaitForLoginOptions } from '../protocol/chat-event.js'

const QR_REFRESH_LIMIT = 3
const QR_TICKET_TTL_MS = 10 * 60_000

type MutableTicket = LoginTicket & {
  qrcode: string
  qrCodeUrl: string
  expiry: ReturnType<typeof setTimeout>
}

const ledger = new Map<string, MutableTicket>()

export async function allocateLoginTicket(
  transport: IlinkJsonTransport,
  options?: { botType?: string; localTokens?: readonly string[]; signal?: AbortSignal }
): Promise<LoginTicket> {
  const category = options?.botType ?? ILINK_QR_BOT_CLASS_DEFAULT
  const bitmap = await transport.openLoginBitmap({
    botType: category,
    localTokens: options?.localTokens,
    signal: options?.signal
  })
  const sessionKey = nextScopedOpId('wxil-login')
  const expiry = setTimeout(() => ledger.delete(sessionKey), QR_TICKET_TTL_MS)
  expiry.unref()
  const ticket: MutableTicket = {
    sessionKey,
    qrcode: bitmap.qrcode,
    qrCodeUrl: bitmap.qrcode_img_content,
    baseUrl: transport.baseUrl,
    botType: category,
    expiry
  }
  ledger.set(ticket.sessionKey, ticket)
  return {
    sessionKey: ticket.sessionKey,
    qrcode: ticket.qrcode,
    qrCodeUrl: ticket.qrCodeUrl,
    baseUrl: ticket.baseUrl,
    botType: ticket.botType
  }
}

export async function awaitLoginTicketResolution(
  transport: IlinkJsonTransport,
  sessionKey: string,
  options: WaitForLoginOptions = {}
): Promise<LoginOutcome> {
  const ticket = ledger.get(sessionKey)
  if (!ticket) {
    throw new GatewayFault('LOGIN_SESSION_NOT_FOUND', `未知登录句柄: ${sessionKey}`)
  }

  const limitMs = Math.max(options.timeoutMs ?? 480_000, 1_000)
  const until = Date.now() + limitMs
  let refreshUsed = 0
  let pollingBaseUrl = ticket.baseUrl
  let verificationCode: string | undefined

  try {
    while (Date.now() < until) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException('登录已取消', 'AbortError')
      }

      const phase = await transport.probeLoginPhase({
        qrcode: ticket.qrcode,
        baseUrl: pollingBaseUrl,
        verifyCode: verificationCode,
        budgetMs: 35_000,
        signal: options.signal
      })

      if (phase.status === 'scaned') verificationCode = undefined

      if (phase.status === 'scaned_but_redirect') {
        if (!phase.redirect_host) {
          throw new GatewayFault('LOGIN_REDIRECT_HOST_MISSING', 'iLink 要求切换登录节点但未返回 redirect_host')
        }
        pollingBaseUrl = normalizeRedirectHost(phase.redirect_host)
        continue
      }

      if (phase.status === 'need_verifycode') {
        if (!options.onVerificationCode) {
          return {
            connected: false,
            message: '手机端要求数字配对码，但宿主未提供输入通道'
          }
        }
        verificationCode = (await options.onVerificationCode()).trim()
        if (!/^\d{4,8}$/u.test(verificationCode)) {
          throw new GatewayFault('LOGIN_VERIFY_CODE_INVALID', '数字配对码必须是 4 至 8 位数字')
        }
        continue
      }

      if (phase.status === 'binded_redirect') {
        return {
          connected: false,
          alreadyConnected: true,
          message: '此微信已绑定当前客户端，无需重复创建会话'
        }
      }

      if (phase.status === 'confirmed') {
        if (!phase.bot_token || !phase.ilink_bot_id) {
          return {
            connected: false,
            message: '登录已确认但上游未返回 token 或 bot id。'
          }
        }
        const session: CredentialBlob = {
          token: phase.bot_token,
          accountId: phase.ilink_bot_id,
          userId: phase.ilink_user_id,
          baseUrl: phase.baseurl?.trim() || ticket.baseUrl || transport.baseUrl,
          cdnBaseUrl: transport.cdnBaseUrl || ILINK_CDN_ROOT_DEFAULT,
          routeTag: transport.routeTag,
          syncBuffer: '',
          contextTokens: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        return { connected: true, message: '登录成功', session }
      }

      if (phase.status === 'expired' || phase.status === 'verify_code_blocked') {
        if (options.refreshExpiredQr === false) {
          return {
            connected: false,
            message: phase.status === 'expired' ? '二维码已过期' : '数字配对码已被锁定'
          }
        }
        refreshUsed += 1
        if (refreshUsed > QR_REFRESH_LIMIT) {
          return { connected: false, message: '扫码验证刷新次数过多' }
        }
        const next = await transport.openLoginBitmap({
          botType: ticket.botType,
          signal: options.signal
        })
        ticket.qrcode = next.qrcode
        ticket.qrCodeUrl = next.qrcode_img_content
        pollingBaseUrl = ticket.baseUrl
        verificationCode = undefined
        options.onQrRefresh?.({ qrcode: ticket.qrcode, qrCodeUrl: ticket.qrCodeUrl })
      }

      await delay(1_000, options.signal)
    }

    return { connected: false, message: '登录超时' }
  } finally {
    clearTimeout(ticket.expiry)
    ledger.delete(sessionKey)
  }
}

function normalizeRedirectHost(value: string): string {
  const host = value.trim()
  if (!host || host.includes('/') || host.includes('\\') || host.includes('@')) {
    throw new GatewayFault('LOGIN_REDIRECT_HOST_INVALID', 'iLink redirect_host 格式无效')
  }
  let url: URL
  try {
    url = new URL(`https://${host}`)
  } catch (error) {
    throw new GatewayFault('LOGIN_REDIRECT_HOST_INVALID', 'iLink redirect_host 格式无效', {
      cause: error
    })
  }
  if (url.hostname !== host && url.host !== host) {
    throw new GatewayFault('LOGIN_REDIRECT_HOST_INVALID', 'iLink redirect_host 格式无效')
  }
  return url.origin
}
