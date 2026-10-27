import type { WebchatFileAttachment } from '@agentconnect.md/protocol'
import { reserveFileUpload, signFileUploadParts, type SignedRequestDto } from '@/lib/api'

// A non-image chat upload (source-cache-file-transfer.md): hashed here, PUT straight to the object store, named in the turn.

/** The part a browser hashes in memory at once; a file above it goes in parts when the deployment allows. */
const BROWSER_PART_BYTES = 64 * 1024 * 1024
/** S3's most parts per upload, and the most part URLs one signing call returns. */
const MAX_PARTS = 10_000
const PART_URL_BATCH = 100
const PART_CONCURRENCY = 3
const PART_ATTEMPTS = 3
/** Sign again rather than send a URL this close to its expiry. */
const RESIGN_MARGIN_MS = 60_000

/** One file in a composer: uploading until its PUT lands, then the reference the turn carries. */
export interface ComposerFile {
  key: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'failed'
  attachment?: WebchatFileAttachment
  error?: string
}

/** The protocol's TransferFileName rule: no control characters or path separators, 1–255 characters. */
export function transferFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, 255)
    .trim()
  return cleaned || 'file'
}

/** The protocol's TransferMimeType rule, or octet-stream for a type the browser left empty or malformed. */
export function transferMimeType(type: string): string {
  return /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(type) && type.length <= 255
    ? type
    : 'application/octet-stream'
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Base64 SHA-256 of the file's bytes, the form the presigned PUT signs as `x-amz-checksum-sha256`. */
export async function fileSha256(file: Blob): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
}

/** The COMPOSITE checksum S3 reports for a multipart object: the SHA-256 of its parts' raw digests, in order. */
export async function compositeSha256(parts: readonly string[]): Promise<string> {
  const raw = parts.map((part) => Uint8Array.from(atob(part), (c) => c.charCodeAt(0)))
  const joined = new Uint8Array(raw.reduce((n, digest) => n + digest.length, 0))
  raw.reduce((offset, digest) => (joined.set(digest, offset), offset + digest.length), 0)
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)))
}

/** The part size for a file that goes in parts, or undefined to send it whole; `maxPartBytes` is the deployment's. */
export function uploadPartBytes(size: number, maxPartBytes: number | undefined): number | undefined {
  if (maxPartBytes === undefined) return undefined
  const part = Math.min(maxPartBytes, Math.max(BROWSER_PART_BYTES, Math.ceil(size / MAX_PARTS)))
  return size > part ? part : undefined
}

// A browser sets content-length itself and refuses to be told it.
function browserHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([header]) => header.toLowerCase() !== 'content-length'))
}

/** Hash, reserve and upload one file; resolves with what the turn names once the store holds the bytes. */
export async function uploadWebchatFile(
  agentId: string,
  file: File,
  opts: { put?: typeof fetch; partBytes?: number } = {}
): Promise<WebchatFileAttachment> {
  const put = opts.put ?? fetch
  const name = transferFileName(file.name)
  const mimeType = transferMimeType(file.type)
  const partBytes = uploadPartBytes(file.size, opts.partBytes)
  if (partBytes !== undefined) return await uploadInParts({ agentId, file, name, mimeType, partBytes, put })
  const sha256 = await fileSha256(file)
  const grant = await reserveFileUpload(agentId, { name, mimeType, size: file.size, sha256 })
  if (!('url' in grant)) throw new Error('the control plane did not sign a single upload')
  const res = await put(grant.url, { method: 'PUT', headers: browserHeaders(grant.headers), body: file })
  if (!res.ok) throw new Error(`the object store refused the upload (HTTP ${res.status})`)
  return { uploadId: grant.uploadId, name, mimeType, size: file.size, sha256 }
}

/** Hash each part, reserve a multipart upload, PUT the parts a few at a time, then have the store assemble them. */
async function uploadInParts(input: {
  agentId: string
  file: File
  name: string
  mimeType: string
  partBytes: number
  put: typeof fetch
}): Promise<WebchatFileAttachment> {
  const { agentId, file, name, mimeType, partBytes, put } = input
  const count = Math.ceil(file.size / partBytes)
  const slice = (n: number) => file.slice((n - 1) * partBytes, Math.min(n * partBytes, file.size))
  // One part in memory at a time; the PUTs below stream the same slices again.
  const digests: string[] = []
  for (let n = 1; n <= count; n++) digests.push(await fileSha256(slice(n)))
  const sha256 = await compositeSha256(digests)
  const grant = await reserveFileUpload(agentId, {
    name,
    mimeType,
    size: file.size,
    sha256,
    parts: { partBytes, sha256: digests }
  })
  if (!('multipart' in grant)) throw new Error('the control plane did not sign an upload in parts')
  const { uploadId } = grant
  const { multipartId } = grant.multipart

  const urls = new Map<number, { request: SignedRequestDto; expiresAt: number }>()
  let complete = { request: grant.multipart.complete, expiresAt: Date.parse(grant.expiresAt) }
  for (const part of grant.multipart.parts) urls.set(part.partNumber, { request: part, expiresAt: complete.expiresAt })

  let signing: Promise<void> | undefined
  const sign = (from: number) => {
    signing ??= (async () => {
      const parts = []
      for (let n = from; n <= Math.min(count, from + PART_URL_BATCH - 1); n++)
        parts.push({ partNumber: n, sha256: digests[n - 1]! })
      const signed = await signFileUploadParts(agentId, uploadId, { multipartId, size: file.size, partBytes, parts })
      const expiresAt = Date.parse(signed.expiresAt)
      for (const part of signed.parts) urls.set(part.partNumber, { request: part, expiresAt })
      complete = { request: signed.complete, expiresAt }
    })().finally(() => (signing = undefined))
    return signing
  }
  const fresh = (signed: { expiresAt: number } | undefined) =>
    signed !== undefined && signed.expiresAt - Date.now() > RESIGN_MARGIN_MS

  const putPart = async (n: number): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      // A sign already in flight may cover other parts, so a part can need one more; a skewed clock never loops.
      if (!fresh(urls.get(n))) await sign(n)
      if (!urls.has(n)) await sign(n)
      const signed = urls.get(n)
      if (!signed) throw new Error(`the control plane did not sign part ${n}`)
      const { request } = signed
      let res: Response
      try {
        res = await put(request.url, { method: 'PUT', headers: browserHeaders(request.headers), body: slice(n) })
      } catch (err) {
        if (attempt >= PART_ATTEMPTS) throw err
        continue
      }
      if (res.ok) {
        const etag = res.headers.get('etag')
        if (!etag) throw new Error('the object store hid the part’s ETag; its CORS rule must expose ETag')
        return etag
      }
      // A refused signature is signed again; a store error is retried; anything else is final.
      if (res.status === 403) urls.delete(n)
      if (attempt >= PART_ATTEMPTS || (res.status < 500 && res.status !== 403))
        throw new Error(`the object store refused part ${n} of ${count} (HTTP ${res.status})`)
    }
  }

  const etags: string[] = new Array<string>(count)
  let next = 1
  let failed = false
  await Promise.all(
    Array.from({ length: Math.min(PART_CONCURRENCY, count) }, async () => {
      while (!failed && next <= count) {
        const n = next++
        try {
          etags[n - 1] = await putPart(n)
        } catch (err) {
          failed = true
          throw err
        }
      }
    })
  )

  if (!fresh(complete)) await sign(count + 1)
  const xml = `<CompleteMultipartUpload>${etags
    .map(
      (etag, i) =>
        `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag><ChecksumSHA256>${digests[i]}</ChecksumSHA256></Part>`
    )
    .join('')}</CompleteMultipartUpload>`
  const res = await put(complete.request.url, {
    method: 'POST',
    headers: { ...browserHeaders(complete.request.headers), 'content-type': 'application/xml' },
    body: xml
  })
  // S3 can answer a failed assembly with 200 and an <Error> body.
  const answer = await res.text()
  if (!res.ok || /<Error>/.test(answer))
    throw new Error(`the object store refused to assemble the upload (HTTP ${res.status})`)
  return { uploadId, name, mimeType, size: file.size, sha256 }
}

/** The `[attached: …]` marker the daemon records for these files, so the optimistic step reads like the reloaded one. */
export function filesMarker(files: readonly Pick<WebchatFileAttachment, 'name' | 'mimeType'>[]): string {
  return files.length ? `[attached: ${files.map((f) => `${f.name} (${f.mimeType})`).join(', ')}]` : ''
}

/** A file a sent message names in its `[attached: …]` marker. */
export interface MarkedFile {
  name: string
  mimeType: string
}

/** Split a message's trailing `[attached: …]` marker into its files; an unparseable marker stays in the text. */
export function splitFilesMarker(text: string): { text: string; files: MarkedFile[] } {
  const marker = /(?:^|\n)\[attached: ([^\]\n]+)\]$/.exec(text)
  if (!marker) return { text, files: [] }
  const entry = /(.+?) \(([A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*)\)(?:, |$)/y
  const files: MarkedFile[] = []
  const list = marker[1]!
  while (entry.lastIndex < list.length) {
    const match = entry.exec(list)
    if (!match) return { text, files: [] }
    files.push({ name: match[1]!, mimeType: match[2]! })
  }
  return { text: text.slice(0, marker.index).trimEnd(), files }
}
