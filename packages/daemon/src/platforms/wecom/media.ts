// WeCom media (official doc, path 101463): inbound downloads decrypted with each URL's own key, outbound chunked uploads over the socket.
import { createDecipheriv, createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { deniedAddress } from '../../credential-proxy/proxy.js'
import { sniffSharedImage } from '../../images/sniff.js'
import type { FileUploader, UploadOutcome } from '../../mcp/ops/context.js'
import { documentMimeType } from '../../mcp/ops/share-file-types.js'
import type { Attachment } from '../../messages/normalized.js'
import type { WeComFrame } from './client.js'
import type { WeComTurnState } from './turn-output.js'

/** A download URL is valid for five minutes after the message (official doc); after that a fetch is not attempted. */
export const WECOM_MEDIA_URL_TTL_MS = 5 * 60_000
const DOWNLOAD_TIMEOUT_MS = 30_000
const AES_BLOCK = 16
// The doc pads to a multiple of 32 bytes, so the ciphertext may exceed the plaintext by up to 32.
const MAX_PADDING = 32
const NAME_MAX_CHARS = 200

/** The 32-byte AES-256 key from its Base64 `aeskey`, as the official SDK decodes it; undefined otherwise. */
export function weComMediaKey(aesKey: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(aesKey)) return undefined
  const key = Buffer.from(aesKey, 'base64')
  return key.length === 32 ? key : undefined
}

/** AES-256-CBC with IV = the key's first 16 bytes and PKCS#7 padding to 32; undefined for a wrong key or bad padding. */
export function decryptWeComMedia(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (key.length !== 32 || ciphertext.length === 0 || ciphertext.length % AES_BLOCK !== 0) return undefined
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, AES_BLOCK))
    decipher.setAutoPadding(false)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
  const pad = plain[plain.length - 1] ?? 0
  if (pad < 1 || pad > MAX_PADDING || pad > plain.length) return undefined
  for (let i = plain.length - pad; i < plain.length; i++) if (plain[i] !== pad) return undefined
  return plain.subarray(0, plain.length - pad)
}

/** An HTTPS URL with a host name and no credentials; an IP literal is refused, since WeCom's media links name a host. */
export function weComMediaUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url
  } catch {
    return undefined
  }
}

/** A lookup that refuses a host when any address it resolves to is loopback, private, link-local or unspecified. */
export function weComMediaLookup(resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      if (!addresses.length || addresses.some((entry) => deniedAddress(entry.address)))
        return callback(new Error('wecom: media host resolves to a refused address'), '', 0)
      if (options.all) return (callback as (e: null, a: typeof addresses) => void)(null, addresses)
      return callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
}

let guardedDispatcher: Agent | undefined

// The connection is pinned to the addresses the lookup checked, so a name cannot re-resolve past the guard.
const guardedFetch: typeof fetch = (input, init) => {
  guardedDispatcher ??= new Agent({ connect: { lookup: weComMediaLookup() } })
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: guardedDispatcher
  }) as unknown as Promise<Response>
}

/** The file name a `Content-Disposition` header names, as the official SDK reads it; a bare, bounded base name or undefined. */
export function weComDispositionName(header: string | null): string | undefined {
  if (!header) return undefined
  const raw = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1] ?? /filename="?([^";]+)"?/i.exec(header)?.[1]
  if (!raw) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const base = (decoded.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') return undefined
  return base.length > NAME_MAX_CHARS ? base.slice(base.length - NAME_MAX_CHARS) : base
}

export interface WeComMediaDeps {
  signal: AbortSignal
  /** A test seam; production uses the guarded fetch above. */
  fetchImpl?: typeof fetch
}

export interface WeComDownloaded {
  bytes: Buffer
  /** The name the download's `Content-Disposition` gave, when it gave one. */
  fileName?: string
}

/** One received attachment's plaintext within `maxBytes`, or null with a reason reported; never throws and never logs the URL or key. */
export async function downloadWeComMedia(
  deps: WeComMediaDeps,
  media: { url: string; aesKey: string },
  maxBytes: number,
  reportFailure: (reason: string) => void = () => {}
): Promise<WeComDownloaded | null> {
  const unavailable = (reason: string): null => {
    reportFailure(reason)
    return null
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
  const key = weComMediaKey(media.aesKey)
  if (!key) return unavailable('invalid_key')
  const url = weComMediaUrl(media.url)
  if (!url) return unavailable('refused_url')
  const limit = maxBytes + MAX_PADDING
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  try {
    const response = await (deps.fetchImpl ?? guardedFetch)(url, { redirect: 'error', signal })
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
    const plain = decryptWeComMedia(Buffer.concat(chunks), key)
    if (!plain) return unavailable('decrypt_failed')
    if (plain.length > maxBytes) return unavailable('size_limit')
    const fileName = weComDispositionName(response.headers.get('content-disposition'))
    return { bytes: plain, ...(fileName ? { fileName } : {}) }
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

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/** Replace the normalizer's placeholder name and type from the bytes and the download's name; false when an image's bytes are no image. */
export function correctWeComAttachment(
  attachment: Attachment,
  kind: 'image' | 'file' | 'video',
  downloaded: WeComDownloaded
): boolean {
  const sniffed = sniffSharedImage(downloaded.bytes)
  const pictured = sniffed && IMAGE_EXTENSIONS[sniffed] ? sniffed : undefined
  attachment.size = downloaded.bytes.byteLength
  if (kind === 'image') {
    if (!pictured) return false
    attachment.mimeType = pictured
    attachment.name = `${attachment.name.replace(/\.[A-Za-z0-9]+$/, '')}.${IMAGE_EXTENSIONS[pictured]}`
    return true
  }
  if (downloaded.fileName) attachment.name = downloaded.fileName
  if (pictured) attachment.mimeType = pictured
  else if (kind === 'file') attachment.mimeType = documentMimeType(attachment.name)
  else if (documentMimeType(attachment.name).startsWith('video/'))
    attachment.mimeType = documentMimeType(attachment.name)
  return true
}

export const WECOM_UPLOAD_INIT = 'aibot_upload_media_init'
export const WECOM_UPLOAD_CHUNK = 'aibot_upload_media_chunk'
export const WECOM_UPLOAD_FINISH = 'aibot_upload_media_finish'
export type WeComUploadCommand = typeof WECOM_UPLOAD_INIT | typeof WECOM_UPLOAD_CHUNK | typeof WECOM_UPLOAD_FINISH

/** At most 512 KB of raw bytes per chunk and 100 chunks per upload (official doc). */
export const WECOM_UPLOAD_CHUNK_BYTES = 512 * 1024
export const WECOM_UPLOAD_MAX_CHUNKS = 100
// Conservative choice: the doc's "10MB" and "20MB" are read as decimal megabytes, the smaller reading.
export const WECOM_IMAGE_MAX_BYTES = 10_000_000
export const WECOM_FILE_MAX_BYTES = 20_000_000
export const WECOM_MEDIA_MIN_BYTES = 5
const UPLOAD_NAME_MAX_BYTES = 256
// Images WeCom shows as pictures (png, jpg/jpeg, gif); any other file, WEBP included, goes as a file.
const WECOM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])

/** How many chunks `size` bytes take; undefined for an empty file or one over the 100-chunk cap. */
export function weComUploadChunks(size: number): number | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined
  const chunks = Math.ceil(size / WECOM_UPLOAD_CHUNK_BYTES)
  return chunks > WECOM_UPLOAD_MAX_CHUNKS ? undefined : chunks
}

/** What a file uploads and sends as: an image within the image cap, else a file within the file cap; undefined when too large. */
export function weComMediaType(file: { bytes: Buffer; mimeType: string }): 'image' | 'file' | undefined {
  const size = file.bytes.byteLength
  if (WECOM_IMAGE_TYPES.has(file.mimeType) && size <= WECOM_IMAGE_MAX_BYTES) return 'image'
  return size <= WECOM_FILE_MAX_BYTES ? 'file' : undefined
}

/** A file name within the doc's 256 bytes, keeping its extension. */
export function weComUploadName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '') || 'file'
  if (Buffer.byteLength(clean) <= UPLOAD_NAME_MAX_BYTES) return clean
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? ''
  let stem = ''
  for (const char of clean.slice(0, clean.length - ext.length)) {
    if (Buffer.byteLength(stem + char + ext) > UPLOAD_NAME_MAX_BYTES) break
    stem += char
  }
  return stem + ext
}

/** WeCom answered an upload step without the id the next step needs. */
export class WeComUploadError extends Error {
  constructor(step: string) {
    super(`wecom: the upload ${step} answer named no id`)
    this.name = 'WeComUploadError'
  }
}

/** The socket half an upload needs. */
export interface WeComUploadPort {
  command(cmd: WeComUploadCommand, body: Record<string, unknown>): Promise<WeComFrame>
}

function bodyString(frame: WeComFrame, field: string): string | undefined {
  const value = (frame.body as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' && value ? value : undefined
}

// Conservative choice: chunk_index counts from 0, as the doc's field description and the SDK's code do (its example and type comment say 1).
/** Upload bytes in three steps, one chunk at a time; returns the `media_id`, valid for three days. */
export async function uploadWeComMedia(
  port: WeComUploadPort,
  file: { bytes: Buffer; name: string },
  type: 'image' | 'file'
): Promise<string> {
  const chunks = weComUploadChunks(file.bytes.byteLength)
  if (chunks === undefined) throw new RangeError('wecom: the file does not fit an upload')
  const init = await port.command(WECOM_UPLOAD_INIT, {
    type,
    filename: weComUploadName(file.name),
    total_size: file.bytes.byteLength,
    total_chunks: chunks,
    md5: createHash('md5').update(file.bytes).digest('hex')
  })
  const uploadId = bodyString(init, 'upload_id')
  if (!uploadId) throw new WeComUploadError('init')
  for (let index = 0; index < chunks; index++) {
    const chunk = file.bytes.subarray(index * WECOM_UPLOAD_CHUNK_BYTES, (index + 1) * WECOM_UPLOAD_CHUNK_BYTES)
    await port.command(WECOM_UPLOAD_CHUNK, {
      upload_id: uploadId,
      chunk_index: index,
      base64_data: chunk.toString('base64')
    })
  }
  const mediaId = bodyString(await port.command(WECOM_UPLOAD_FINISH, { upload_id: uploadId }), 'media_id')
  if (!mediaId) throw new WeComUploadError('finish')
  return mediaId
}

/** The send half the uploader needs from the leased connection. */
export interface WeComMediaPort {
  sendMedia(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    caption?: string
  ): Promise<UploadOutcome>
}

/** The turn's file sender, bound to the connection it leased; absent for a headless turn. */
export function weComFileUploader(state: WeComTurnState): FileUploader | undefined {
  const conn = state.conn as Partial<WeComMediaPort> | undefined
  if (typeof conn?.sendMedia !== 'function') return undefined
  return (file, caption) => conn.sendMedia!(state.channel, file, caption)
}
