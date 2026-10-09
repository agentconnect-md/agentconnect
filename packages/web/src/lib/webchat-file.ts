import type { WebchatFileAttachment } from '@agentconnect.md/protocol'
import { reserveFileUpload } from '@/lib/api'

// A non-image chat upload (source-cache-file-transfer.md): hashed here, PUT straight to the object store, named in the turn.

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

/** Base64 SHA-256 of the file's bytes, the form the presigned PUT signs as `x-amz-checksum-sha256`. */
export async function fileSha256(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Hash, reserve and PUT one file; resolves with what the turn names once the store holds the bytes. */
export async function uploadWebchatFile(
  agentId: string,
  file: File,
  put: typeof fetch = fetch
): Promise<WebchatFileAttachment> {
  const name = transferFileName(file.name)
  const mimeType = transferMimeType(file.type)
  const sha256 = await fileSha256(file)
  const grant = await reserveFileUpload(agentId, { name, mimeType, size: file.size, sha256 })
  // A browser sets content-length itself and refuses to be told it.
  const headers = Object.fromEntries(
    Object.entries(grant.headers).filter(([header]) => header.toLowerCase() !== 'content-length')
  )
  const res = await put(grant.url, { method: 'PUT', headers, body: file })
  if (!res.ok) throw new Error(`the object store refused the upload (HTTP ${res.status})`)
  return { uploadId: grant.uploadId, name, mimeType, size: file.size, sha256 }
}

/** The `[attached: …]` marker the daemon records for these files, so the optimistic step reads like the reloaded one. */
export function filesMarker(files: readonly Pick<WebchatFileAttachment, 'name' | 'mimeType'>[]): string {
  return files.length ? `[attached: ${files.map((f) => `${f.name} (${f.mimeType})`).join(', ')}]` : ''
}
