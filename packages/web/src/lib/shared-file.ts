// A file an agent shared into its conversation, as the transcript row's trailing marker records it (agent-authored-attachments.md §4).
export interface SharedFile {
  /** Workspace-relative path under the session's working root, normalized; null when no download can name it. */
  path: string | null
  name: string
  mimeType: string
  bytes: number
  /** The digest prefix the marker recorded; the download must still match it. */
  sha256: string
}

const MARKER = /(?:^|\n)\[shared: ([^\n]+) \(([^()\n]+), (\d+) bytes, sha256:([0-9a-f]{16,64})\)\]$/

/** Split a share row into its caption and the file its trailing marker names; null when it carries none. */
export function sharedFileMarker(text: string): { caption: string; file: SharedFile } | null {
  const match = MARKER.exec(text)
  if (!match) return null
  const [whole, raw, mimeType, bytes, sha256] = match as unknown as [string, string, string, string, string]
  const path = downloadPath(raw)
  return {
    caption: text.slice(0, text.length - whole.length).trimEnd(),
    file: {
      path,
      name: raw.split('/').filter(Boolean).pop() ?? raw,
      mimeType,
      bytes: Number(bytes),
      sha256
    }
  }
}

/** The path as the download route accepts it: `./` and empty segments dropped, anything absolute or escaping refused. */
function downloadPath(raw: string): string | null {
  if (raw.startsWith('/') || raw.includes('\\')) return null
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
  return segments.length && !segments.includes('..') ? segments.join('/') : null
}

// Mirrors of protocol constants (its root entry is not bundler-safe); shared-file.test.ts pins them.
export const WORKSPACE_UPLOADS_DIR = 'uploads'
export const MAX_WORKSPACE_DOWNLOAD_BYTES = 8 * 1024 * 1024
export const WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES = 1024 * 1024
export const FILE_TRANSFER_FEATURE = 'file-transfer-v1'
export const WEBCHAT_FILES_MAX = 4

/** How the download route names one workspace file: the session whose root holds it, and a share's digest when one names it. */
export interface SessionFileDownload {
  sessionId?: string
  sha256?: string
}

/** Any workspace file downloads by path; a file the session shared also carries the digest of its latest share marker. */
export function sessionFileDownload(
  path: string,
  sessionId: string | undefined,
  rows: Iterable<{ text: string; sessionId: string | undefined }>
): SessionFileDownload {
  if (!sessionId) return {}
  let sha256: string | undefined
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue
    const shared = sharedFileMarker(row.text)
    if (shared?.file.path === path) sha256 = shared.file.sha256
  }
  return sha256 ? { sessionId, sha256 } : { sessionId }
}

/** Large text and any binary go through the object store when the daemon has one; small text keeps the proxied download. */
export function viaTransfer(file: { size: number | null; encoding: string | null }, transfer: boolean): boolean {
  return transfer && (file.encoding === 'none' || (file.size ?? 0) > WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES)
}

/** Start a browser download straight from a presigned URL; the store answers it as an attachment. */
export function openDownloadUrl(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Hand the browser a blob as a named download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked late: some browsers still read the URL after `click()` returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
