// Inbound WeChat media: a CDN download of AES-128-ECB ciphertext, decrypted with the key iLink sent beside it (wechat-integration.md §4.6).
import { createDecipheriv } from 'node:crypto'
import type { WeChatMediaRef } from '@agentconnect.md/message'
import { sniffImageMimeType } from '../../session/attachment-block.js'
import { WECHAT_CDN_URL } from './api.js'

const REQUEST_TIMEOUT_MS = 30_000
// PKCS#7 adds at most one block, so the ciphertext may exceed the plaintext limit by that much.
const AES_BLOCK = 16

/** The 16-byte key from a raw hex key, base64 of 16 raw bytes, or base64 of 32 hex characters; undefined otherwise. */
export function weChatMediaKey(media: Pick<WeChatMediaRef, 'aesKey' | 'aesKeyHex'>): Buffer | undefined {
  if (media.aesKeyHex) return /^[0-9a-f]{32}$/i.test(media.aesKeyHex) ? Buffer.from(media.aesKeyHex, 'hex') : undefined
  if (!media.aesKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(media.aesKey)) return undefined
  const raw = Buffer.from(media.aesKey, 'base64')
  if (raw.length === AES_BLOCK) return raw
  const hex = raw.toString('latin1')
  return raw.length === 32 && /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined
}

/** AES-128-ECB with PKCS#7 padding; undefined for a wrong key or bad padding, never a throw. */
export function decryptWeChatMedia(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (key.length !== AES_BLOCK || ciphertext.length === 0 || ciphertext.length % AES_BLOCK !== 0) return undefined
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
}

export interface WeChatMediaDeps {
  cdnUrl?: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

function downloadUrl(media: WeChatMediaRef, cdnUrl: string): URL | undefined {
  try {
    if (media.fullUrl) {
      const url = new URL(media.fullUrl)
      return url.protocol === 'https:' ? url : undefined
    }
    if (!media.encryptQueryParam) return undefined
    return new URL(
      `${cdnUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(media.encryptQueryParam)}`
    )
  } catch {
    return undefined
  }
}

/** One received attachment's plaintext within `maxBytes`, or null with a reason reported; never throws. */
export async function downloadWeChatMedia(
  deps: WeChatMediaDeps,
  media: WeChatMediaRef,
  maxBytes: number,
  reportFailure: (reason: string) => void = () => {}
): Promise<Buffer | null> {
  const unavailable = (reason: string): null => {
    reportFailure(reason)
    return null
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
  const key = weChatMediaKey(media)
  if (!key) return unavailable('invalid_key')
  const url = downloadUrl(media, deps.cdnUrl ?? WECHAT_CDN_URL)
  if (!url) return unavailable('invalid_reference')
  const limit = maxBytes + AES_BLOCK
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, { redirect: 'error', signal })
    if (!response.ok || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      return unavailable(response.ok ? 'size_limit' : `http_${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) return unavailable('empty_body')
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) return unavailable('size_limit')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const plain = decryptWeChatMedia(Buffer.concat(chunks), key)
    if (!plain) return unavailable('decrypt_failed')
    if (plain.length > maxBytes) return unavailable('size_limit')
    return !media.image || sniffImageMimeType(plain) ? plain : unavailable('unsupported_format')
  } catch (error) {
    return unavailable(
      deps.signal.aborted
        ? 'aborted'
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'fetch_failed'
    )
  }
}
