import { createHash } from 'node:crypto'
import { QQAttachmentUrl } from '@agentconnect.md/message'
import type { UploadPrepareResponse } from '@tencent-connect/qqbot-nodejs/protocol'
import { sniffImageMimeType } from '../../session/attachment-block.js'
import type { QQRestPort, QQTarget } from './sender.js'

export const QQImageMaxBytes = 30 * 1024 * 1024

export class QQImageUploadError extends Error {}

async function downloadQQBytes(
  source: string,
  maxBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  reportFailure?: (reason: string) => void,
  requireImage = false
): Promise<Buffer | null> {
  const unavailable = (reason: string): null => {
    reportFailure?.(reason)
    return null
  }
  try {
    let url = QQAttachmentUrl(source)
    if (!url) return unavailable('invalid_url')
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
    const cap = Math.min(maxBytes, QQImageMaxBytes)
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, { redirect: 'manual', signal: timeout })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        url = location ? QQAttachmentUrl(new URL(location, url).href) : undefined
        if (!url) return unavailable('invalid_redirect')
        continue
      }
      if (!response.ok || Number(response.headers.get('content-length')) > cap) {
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
          if (size > cap) return unavailable('size_limit')
          chunks.push(Buffer.from(value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const bytes = Buffer.concat(chunks)
      return !requireImage || sniffImageMimeType(bytes) ? bytes : unavailable('unsupported_format')
    }
    return unavailable('redirect_limit')
  } catch (error) {
    return unavailable(
      signal.aborted
        ? 'cancelled'
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'network_error'
    )
  }
}

export function downloadQQAttachment(
  source: string,
  maxBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  reportFailure?: (reason: string) => void
): Promise<Buffer | null> {
  return downloadQQBytes(source, maxBytes, signal, fetchImpl, reportFailure)
}

export function downloadQQImage(
  source: string,
  maxBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  reportFailure?: (reason: string) => void
): Promise<Buffer | null> {
  return downloadQQBytes(source, maxBytes, signal, fetchImpl, reportFailure, true)
}

// Upload bytes without publishing; the sender alone commits the visible media message.
export async function uploadQQImage(
  api: QQRestPort,
  token: string,
  target: QQTarget,
  file: { bytes: Buffer; name: string },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  signal.throwIfAborted()
  const { bytes, name } = file
  const path = `/v2/${target.kind === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(target.id)}`
  const hash = (algorithm: string, data = bytes) => createHash(algorithm).update(data).digest('hex')
  const prepared = await api.request<Omit<UploadPrepareResponse, 'block_size'> & { block_size: number | string }>(
    token,
    'POST',
    `${path}/upload_prepare`,
    {
      file_type: 1,
      file_name: name,
      file_size: bytes.length,
      md5: hash('md5'),
      sha1: hash('sha1'),
      md5_10m: hash('md5', bytes.subarray(0, 10_002_432))
    }
  )
  const { upload_id, block_size: rawBlockSize, parts } = prepared
  // QQ returns decimal strings in production despite the SDK's numeric declaration.
  const block_size =
    typeof rawBlockSize === 'number' ? rawBlockSize : /^\d+$/.test(rawBlockSize) ? Number(rawBlockSize) : NaN
  if (
    !upload_id ||
    !Number.isSafeInteger(block_size) ||
    block_size <= 0 ||
    !Array.isArray(parts) ||
    parts.length !== Math.ceil(bytes.length / block_size) ||
    parts.some((part, i) => part.index !== i + 1)
  )
    throw new QQImageUploadError('QQ returned an invalid image upload plan')
  for (const part of parts) {
    signal.throwIfAborted()
    const url = new URL(part.presigned_url)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new QQImageUploadError('QQ returned an invalid upload URL')
    const chunk = bytes.subarray((part.index - 1) * block_size, part.index * block_size)
    const response = await fetchImpl(url, {
      method: 'PUT',
      body: new Uint8Array(chunk),
      headers: { 'Content-Length': String(chunk.length) },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    })
    await response.body?.cancel()
    if (!response.ok) throw new QQImageUploadError(`QQ image part upload failed (HTTP ${response.status})`)
    signal.throwIfAborted()
    await api.request(token, 'POST', `${path}/upload_part_finish`, {
      upload_id,
      part_index: part.index,
      block_size: chunk.length,
      md5: hash('md5', chunk)
    })
  }
  signal.throwIfAborted()
  const result = await api.request<{ file_info?: string; ttl?: number }>(token, 'POST', `${path}/files`, { upload_id })
  if (!result.file_info || !result.ttl || result.ttl <= 0)
    throw new QQImageUploadError('QQ returned no usable image upload')
  return result.file_info
}
