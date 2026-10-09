import {
  ADAPTER_SEMVER,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_CDN_ROOT_DEFAULT,
  ILINK_FAST_RPC_MS,
  ILINK_HTTP_ORIGIN_DEFAULT,
  ILINK_LONG_WAIT_MS,
  ILINK_RPC_BUDGET_MS
} from '../internal/config.js'
import { fuseAbortClock } from '../internal/async-tools.js'
import { StaleCredentialFault, GatewayFault } from '../internal/errors.js'
import { ephemeralWeixinHeaderTag } from '../internal/random-tags.js'
import { normalizeServiceRoot, withTrailingSlash } from '../internal/url-utils.js'
import type { WireChannelFingerprint } from '../protocol/wire-models.js'
import type {
  CdnSlotGrant,
  CdnSlotRequest,
  ConfigWireAck,
  OutboundWireEnvelope,
  PollWireBatch,
  QrBitmapReply,
  QrPhaseReply,
  TypingWireAck,
  TypingWireEnvelope
} from '../protocol/wire-models.js'

export interface TransportRuntimePatch {
  baseUrl?: string
  cdnBaseUrl?: string
  token?: string
  routeTag?: string
}

function fingerprintPayload(): WireChannelFingerprint {
  return { channel_version: ADAPTER_SEMVER, bot_agent: `OneBots/${ADAPTER_SEMVER}` }
}

/** 负责与 ilinkai 网关的全部 HTTP 交互 */
export class IlinkJsonTransport {
  baseUrl: string
  cdnBaseUrl: string
  token?: string
  routeTag?: string

  constructor(seed: TransportRuntimePatch = {}) {
    this.baseUrl = normalizeServiceRoot(seed.baseUrl?.trim() || ILINK_HTTP_ORIGIN_DEFAULT, 'iLink API 根地址')
    this.cdnBaseUrl = normalizeServiceRoot(seed.cdnBaseUrl?.trim() || ILINK_CDN_ROOT_DEFAULT, 'iLink CDN 根地址')
    this.token = seed.token?.trim() || undefined
    this.routeTag = seed.routeTag?.trim() || undefined
  }

  patchRuntimeTargets(patch: TransportRuntimePatch): void {
    // 先完整校验再一次性更新，避免第二个地址无效时留下半应用状态。
    const nextBaseUrl = patch.baseUrl?.trim()
      ? normalizeServiceRoot(patch.baseUrl.trim(), 'iLink API 根地址')
      : this.baseUrl
    const nextCdnBaseUrl = patch.cdnBaseUrl?.trim()
      ? normalizeServiceRoot(patch.cdnBaseUrl.trim(), 'iLink CDN 根地址')
      : this.cdnBaseUrl
    this.baseUrl = nextBaseUrl
    this.cdnBaseUrl = nextCdnBaseUrl
    if (patch.token !== undefined) this.token = patch.token?.trim() || undefined
    if (patch.routeTag !== undefined) this.routeTag = patch.routeTag?.trim() || undefined
  }

  private bareHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION)
    }
    if (this.routeTag) h.SKRouteTag = this.routeTag
    return h
  }

  private signedJsonHeaders(bearer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      'X-Wechat-UIN': ephemeralWeixinHeaderTag()
    }
    const tok = bearer ?? this.token
    if (tok?.trim()) headers.Authorization = `Bearer ${tok.trim()}`
    if (this.routeTag) headers.SKRouteTag = this.routeTag
    return headers
  }

  private async exchangeJson<T>(
    path: string,
    jsonBody: object,
    budgetMs: number,
    bearer?: string,
    outerSignal?: AbortSignal
  ): Promise<T> {
    const body = JSON.stringify({ ...jsonBody, base_info: fingerprintPayload() })
    const { signal, disarm } = fuseAbortClock(budgetMs, outerSignal)
    try {
      const response = await fetch(new URL(path, withTrailingSlash(this.baseUrl)), {
        method: 'POST',
        headers: this.signedJsonHeaders(bearer),
        body,
        signal
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new GatewayFault('HTTP_ERROR', `HTTP ${response.status} ${response.statusText}: ${summarizeBody(raw)}`, {
          operation: path,
          status: response.status
        })
      }
      return parseJsonObject<T>(raw, path)
    } finally {
      disarm()
    }
  }

  async openLoginBitmap(params?: {
    botType?: string
    localTokens?: readonly string[]
    budgetMs?: number
    signal?: AbortSignal
  }): Promise<QrBitmapReply> {
    const url = new URL(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params?.botType ?? '3')}`,
      withTrailingSlash(this.baseUrl)
    )
    const { signal, disarm } = fuseAbortClock(params?.budgetMs ?? ILINK_FAST_RPC_MS, params?.signal)
    try {
      const body = JSON.stringify({ local_token_list: params?.localTokens ?? [] })
      const response = await fetch(url, {
        method: 'POST',
        // 扫码创建通过 local_token_list 识别旧绑定，不应泄露当前 Bearer token。
        headers: this.signedJsonHeaders(''),
        body,
        signal
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new GatewayFault('HTTP_ERROR', `HTTP ${response.status} ${response.statusText}: ${summarizeBody(raw)}`)
      }
      const reply = parseJsonObject<QrBitmapReply>(raw, 'ilink/bot/get_bot_qrcode')
      this.assertApiSuccess(reply, 'get_bot_qrcode')
      if (!reply.qrcode?.trim() || !reply.qrcode_img_content?.trim()) {
        throw new GatewayFault('INVALID_QR_RESPONSE', 'iLink get_bot_qrcode 未返回有效二维码')
      }
      return reply
    } finally {
      disarm()
    }
  }

  async probeLoginPhase(params: {
    qrcode: string
    baseUrl?: string
    verifyCode?: string
    budgetMs?: number
    signal?: AbortSignal
  }): Promise<QrPhaseReply> {
    const pollingBaseUrl = params.baseUrl ? normalizeServiceRoot(params.baseUrl, 'iLink 扫码轮询根地址') : this.baseUrl
    const url = new URL('ilink/bot/get_qrcode_status', withTrailingSlash(pollingBaseUrl))
    url.searchParams.set('qrcode', params.qrcode)
    if (params.verifyCode) url.searchParams.set('verify_code', params.verifyCode)
    const clock = fuseAbortClock(params.budgetMs ?? ILINK_LONG_WAIT_MS, params.signal)
    try {
      const response = await fetch(url, {
        headers: this.bareHeaders(),
        signal: clock.signal
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new GatewayFault('HTTP_ERROR', `HTTP ${response.status} ${response.statusText}: ${summarizeBody(raw)}`)
      }
      const reply = parseJsonObject<QrPhaseReply>(raw, 'ilink/bot/get_qrcode_status')
      this.assertApiSuccess(reply, 'get_qrcode_status')
      if (!QR_PHASES.has(reply.status)) {
        throw new GatewayFault('INVALID_QR_STATUS', `iLink 返回未知扫码状态: ${String(reply.status)}`)
      }
      return reply
    } catch (error) {
      if (params.signal?.aborted) throw params.signal.reason
      if (clock.signal.aborted) {
        return { status: 'wait' }
      }
      throw error
    } finally {
      clock.disarm()
    }
  }

  async pullUnreadBatch(cursor: string, ceilingMs?: number, signal?: AbortSignal): Promise<PollWireBatch> {
    try {
      return await this.exchangeJson<PollWireBatch>(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor ?? '' },
        ceilingMs ?? ILINK_LONG_WAIT_MS,
        undefined,
        signal
      )
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw error
    }
  }

  async notifyStart(signal?: AbortSignal): Promise<void> {
    const reply = await this.exchangeJson<ApiAck>('ilink/bot/msg/notifystart', {}, ILINK_FAST_RPC_MS, undefined, signal)
    this.assertApiSuccess(reply, 'notifystart')
  }

  async notifyStop(signal?: AbortSignal): Promise<void> {
    const reply = await this.exchangeJson<ApiAck>('ilink/bot/msg/notifystop', {}, ILINK_FAST_RPC_MS, undefined, signal)
    this.assertApiSuccess(reply, 'notifystop')
  }

  async reserveCdnUploadSlot(req: CdnSlotRequest & { timeoutMs?: number }): Promise<CdnSlotGrant> {
    const reply = await this.exchangeJson<CdnSlotGrant>(
      'ilink/bot/getuploadurl',
      {
        filekey: req.filekey,
        media_type: req.media_type,
        to_user_id: req.to_user_id,
        rawsize: req.rawsize,
        rawfilemd5: req.rawfilemd5,
        filesize: req.filesize,
        thumb_rawsize: req.thumb_rawsize,
        thumb_rawfilemd5: req.thumb_rawfilemd5,
        thumb_filesize: req.thumb_filesize,
        no_need_thumb: req.no_need_thumb,
        aeskey: req.aeskey
      },
      req.timeoutMs ?? ILINK_RPC_BUDGET_MS
    )
    this.assertApiSuccess(reply, 'getuploadurl')
    return reply
  }

  private assertApiSuccess<T extends ApiAck>(row: T, operation: string): void {
    if ((row.errcode ?? row.ret ?? 0) === -14) {
      throw new StaleCredentialFault(row.errmsg ?? '凭证失效')
    }
    if ((row.errcode ?? 0) !== 0 || (row.ret ?? 0) !== 0) {
      throw new GatewayFault(
        'API_ERROR',
        `${operation} 异常 ret=${String(row.ret ?? '')} errcode=${String(row.errcode ?? '')} errmsg=${String(row.errmsg ?? '')}`,
        { operation, details: { ret: row.ret, errcode: row.errcode } }
      )
    }
  }

  async dispatchOutboundEnvelope(envelope: OutboundWireEnvelope, budgetMs?: number): Promise<void> {
    const ms = budgetMs ?? ILINK_RPC_BUDGET_MS
    const row = await this.exchangeJson<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      envelope,
      ms
    )
    this.assertApiSuccess(row, 'sendmessage')
  }

  async loadPeerTypingConfig(params: {
    ilinkUserId: string
    contextToken?: string
    budgetMs?: number
  }): Promise<ConfigWireAck> {
    const row = await this.exchangeJson<ConfigWireAck>(
      'ilink/bot/getconfig',
      {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken
      },
      params.budgetMs ?? ILINK_FAST_RPC_MS
    )
    this.assertApiSuccess(row, 'getconfig')
    return row
  }

  async signalTypingState(body: TypingWireEnvelope, budgetMs?: number): Promise<TypingWireAck> {
    const row = await this.exchangeJson<TypingWireAck>('ilink/bot/sendtyping', body, budgetMs ?? ILINK_FAST_RPC_MS)
    this.assertApiSuccess(row, 'sendtyping')
    return row
  }
}

interface ApiAck {
  ret?: number
  errcode?: number
  errmsg?: string
}

const QR_PHASES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect'
])

function parseJsonObject<T>(raw: string, operation: string): T {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('响应根必须是对象')
    }
    return value as T
  } catch (error) {
    throw new GatewayFault('INVALID_JSON', `iLink ${operation} 返回无效 JSON`, {
      cause: error,
      operation
    })
  }
}

function summarizeBody(raw: string): string {
  return raw.slice(0, 500)
}
