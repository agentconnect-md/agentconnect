// Workspace file download (inbound-file-attachments.md §5.1): byte slices from the owning daemon, assembled and never stored.
import { createHash } from 'node:crypto'
import { MAX_WORKSPACE_DOWNLOAD_BYTES, type WorkspaceReadContent } from '@agentconnect.md/protocol'
import { ProtocolError } from '../domain/errors.js'

/** Raw bytes per slice: the read's own ceiling, whose base64 stays well inside one frame. */
export const DOWNLOAD_SLICE_BYTES = 65_536

/** A download the route answers with its own status and code rather than as a daemon failure. */
export class WorkspaceDownloadRefusal extends Error {
  constructor(
    readonly status: 404 | 409 | 413,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceDownloadRefusal'
  }
}

/** Pull a file slice by slice, proving the slices are one unchanged file within the download ceiling. */
export async function assembleWorkspaceFile(
  read: (offset: number) => Promise<WorkspaceReadContent>,
  maxBytes = MAX_WORKSPACE_DOWNLOAD_BYTES
): Promise<Buffer> {
  const parts: Buffer[] = []
  let offset = 0
  let size = -1
  let mtime: string | undefined
  do {
    const slice = await read(offset)
    if (!slice.exists || slice.type === 'dir') {
      if (size < 0) throw new WorkspaceDownloadRefusal(404, 'WORKSPACE_FILE_NOT_FOUND', 'file not found')
      throw changedFile()
    }
    if (slice.encoding !== 'base64' || slice.size === undefined || slice.offset !== offset) throw invalidSlice()
    if (size < 0) {
      if (slice.size > maxBytes) {
        throw new WorkspaceDownloadRefusal(
          413,
          'WORKSPACE_FILE_TOO_LARGE',
          `the file is ${slice.size} bytes; downloads are limited to ${maxBytes} bytes`
        )
      }
      size = slice.size
      mtime = slice.mtime
    } else if (slice.size !== size || slice.mtime !== mtime) {
      throw changedFile()
    }
    const bytes = canonicalBase64(slice.content ?? '')
    const next = slice.nextOffset
    if (
      next === undefined ||
      next !== offset + bytes.byteLength ||
      next > size ||
      (offset < size && !bytes.byteLength)
    ) {
      throw invalidSlice()
    }
    parts.push(bytes)
    offset = next
  } while (offset < size)
  return Buffer.concat(parts, size)
}

/** Whether the bytes' SHA-256 starts with the (case-insensitive) hex prefix a marker recorded. */
export function sha256Matches(bytes: Buffer, prefix: string): boolean {
  return createHash('sha256').update(bytes).digest('hex').startsWith(prefix.toLowerCase())
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

/** The type a download is labelled with; anything a browser could execute (HTML, SVG, script) stays opaque. */
export function downloadContentType(path: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase()
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream'
}

/** RFC 6266 attachment header: an ASCII fallback name plus the exact UTF-8 name. */
export function attachmentDisposition(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'download'
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`
}

function canonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw invalidSlice()
  return bytes
}

function changedFile(): WorkspaceDownloadRefusal {
  return new WorkspaceDownloadRefusal(409, 'WORKSPACE_FILE_CHANGED', 'the file changed while it was being read')
}

function invalidSlice(): ProtocolError {
  return new ProtocolError('BAD_PAYLOAD', 'daemon returned an invalid file slice')
}
