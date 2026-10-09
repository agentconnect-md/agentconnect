import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { IlinkJsonTransport } from '../transport/ilink-json-transport.js'
import type { NormalizedChatEvent } from '../protocol/chat-event.js'
import type { DownloadMediaOptions, DownloadMediaResult } from '../protocol/chat-event.js'
import { GatewayFault } from '../internal/errors.js'
import { cipherBudgetForPlain, decodeCdnAesMaterial, openAes128Ecb, sealAes128Ecb } from './symmetric-block.js'
import { guessMimeByPath } from '../internal/mime-table.js'
import { materializeUserSuppliedFile } from '../internal/load-bytes.js'
import type { InputFile } from '../protocol/chat-event.js'
import { delay } from '../internal/async-tools.js'

export interface StagedCipherPayload {
  slotKey: string
  remoteHandle: string
  aesKeyHex: string
  plainMd5Hex: string
  plainBytes: number
  cipherBudget: number
  originalName: string
  mime: string
}

function cdnPullUrl(handle: string, cdnRoot: string): string {
  return `${cdnRoot}/download?encrypted_query_param=${encodeURIComponent(handle)}`
}

function cdnPushUrl(root: string, uploadToken: string, slotKey: string): string {
  return `${root}/upload?encrypted_query_param=${encodeURIComponent(uploadToken)}&filekey=${encodeURIComponent(slotKey)}`
}

async function postCiphertextToEdge(uploadUrl: string, key16: Buffer, plain: Buffer): Promise<string> {
  const body = sealAes128Ecb(plain, key16)
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(body)
      })
      if (response.status >= 400 && response.status < 500) {
        const hint = response.headers.get('x-error-message') ?? (await response.text())
        throw new GatewayFault('CDN_UPLOAD_CLIENT_ERROR', `边缘写入失败: ${hint}`)
      }
      if (response.status === 200) {
        const headerHandle = response.headers.get('x-encrypted-param')
        if (!headerHandle) {
          throw new GatewayFault('CDN_UPLOAD_MISSING_PARAM', '响应缺少 x-encrypted-param')
        }
        return headerHandle
      }
      lastError = new GatewayFault(
        'CDN_UPLOAD_SERVER_ERROR',
        `边缘写入失败: ${response.headers.get('x-error-message') ?? `HTTP ${String(response.status)}`}`
      )
    } catch (error) {
      if (error instanceof GatewayFault && error.code !== 'CDN_UPLOAD_SERVER_ERROR') {
        throw error
      }
      lastError = error
    }
    if (attempt < 3) await delay(attempt * 250)
  }
  throw new GatewayFault('CDN_UPLOAD_RETRY_EXHAUSTED', 'CDN 上传连续失败 3 次', {
    cause: lastError
  })
}

/** 申请槽位并上传密文，返回后续 sendmessage 所需句柄 */
export async function stageBinaryForPeer(params: {
  transport: IlinkJsonTransport
  input: InputFile
  peerKey: string
  uploadKind: number
  filename?: string
  contentType?: string
}): Promise<StagedCipherPayload> {
  const blob = await materializeUserSuppliedFile(params.input, {
    filename: params.filename,
    contentType: params.contentType
  })
  const slotKey = crypto.randomBytes(16).toString('hex')
  const key16 = crypto.randomBytes(16)
  const plainLen = blob.buffer.length
  const md5hex = crypto.createHash('md5').update(blob.buffer).digest('hex')
  const padded = cipherBudgetForPlain(plainLen)

  const grant = await params.transport.reserveCdnUploadSlot({
    filekey: slotKey,
    media_type: params.uploadKind,
    to_user_id: params.peerKey,
    rawsize: plainLen,
    rawfilemd5: md5hex,
    filesize: padded,
    no_need_thumb: true,
    aeskey: key16.toString('hex')
  })

  const fullUploadUrl = grant.upload_full_url
  const uploadToken = grant.upload_param
  let uploadUrl: string
  if (fullUploadUrl) {
    uploadUrl = safeHttpsUrl(fullUploadUrl, 'CDN_UPLOAD_URL_INVALID')
  } else if (uploadToken) {
    uploadUrl = cdnPushUrl(params.transport.cdnBaseUrl, uploadToken, slotKey)
  } else {
    throw new GatewayFault('UPLOAD_URL_MISSING', 'reserveCdnUploadSlot 未返回 upload_full_url 或 upload_param')
  }

  const remoteHandle = await postCiphertextToEdge(uploadUrl, key16, blob.buffer)

  return {
    slotKey,
    remoteHandle,
    aesKeyHex: key16.toString('hex'),
    plainMd5Hex: md5hex,
    plainBytes: plainLen,
    cipherBudget: padded,
    originalName: blob.fileName,
    mime: blob.contentType
  }
}

function resolveDownloadTarget(
  evt: NormalizedChatEvent,
  cdnRoot: string
): {
  url: string
  key16?: Buffer
  fallbackName: string
  mime: string
} {
  if (!evt.media) {
    throw new GatewayFault('NO_MEDIA', '当前事件不含可下载媒体')
  }
  switch (evt.media.kind) {
    case 'photo': {
      let key16: Buffer | undefined
      if (evt.media.item.aeskey) {
        key16 = Buffer.from(evt.media.item.aeskey, 'hex')
      } else if (evt.media.aesKey) {
        key16 = decodeCdnAesMaterial(evt.media.aesKey)
      }
      return {
        url: mediaDownloadUrl(evt.media, evt.media.fileId, cdnRoot),
        key16,
        fallbackName: 'image.jpg',
        mime: 'image/jpeg'
      }
    }
    case 'video':
      return {
        url: mediaDownloadUrl(evt.media, evt.media.fileId, cdnRoot),
        key16: evt.media.aesKey ? decodeCdnAesMaterial(evt.media.aesKey) : undefined,
        fallbackName: 'video.mp4',
        mime: 'video/mp4'
      }
    case 'document':
      return {
        url: mediaDownloadUrl(evt.media, evt.media.fileId, cdnRoot),
        key16: evt.media.aesKey ? decodeCdnAesMaterial(evt.media.aesKey) : undefined,
        fallbackName: evt.media.fileName ?? 'file.bin',
        mime: guessMimeByPath(evt.media.fileName ?? 'file.bin')
      }
    case 'voice':
      return {
        url: mediaDownloadUrl(evt.media, evt.media.fileId, cdnRoot),
        key16: evt.media.aesKey ? decodeCdnAesMaterial(evt.media.aesKey) : undefined,
        fallbackName: 'voice.silk',
        mime: 'audio/silk'
      }
  }
}

export async function pullUserMediaAttachment(params: {
  transport: IlinkJsonTransport
  message: NormalizedChatEvent
  options?: DownloadMediaOptions
}): Promise<DownloadMediaResult> {
  const spec = resolveDownloadTarget(params.message, params.transport.cdnBaseUrl)
  const response = await fetch(spec.url)
  if (!response.ok) {
    throw new GatewayFault('CDN_DOWNLOAD_FAILED', `拉取失败 ${response.status} ${response.statusText}`)
  }
  const cipher = Buffer.from(await response.arrayBuffer())
  const plain = spec.key16 ? openAes128Ecb(cipher, spec.key16) : cipher
  if (params.options?.filePath) {
    await fs.writeFile(params.options.filePath, plain)
  }
  return { buffer: plain, fileName: spec.fallbackName, mimeType: spec.mime }
}

function mediaDownloadUrl(media: { downloadUrl?: string }, handle: string | undefined, cdnRoot: string): string {
  if (media.downloadUrl) return safeHttpsUrl(media.downloadUrl, 'CDN_DOWNLOAD_URL_INVALID')
  if (handle) return cdnPullUrl(handle, cdnRoot)
  throw new GatewayFault('CDN_DOWNLOAD_URL_MISSING', '媒体缺少 full_url 与下载句柄')
}

function safeHttpsUrl(value: string, code: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new GatewayFault(code, 'iLink CDN 返回无效完整 URL', { cause: error })
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new GatewayFault(code, 'iLink CDN 完整 URL 必须使用 HTTPS 且不能包含凭据')
  }
  return url.href
}

export function mapMimeFamilyToUploadKind(contentType: string): number {
  if (contentType.startsWith('image/')) return 1
  if (contentType.startsWith('video/')) return 2
  return 3
}
