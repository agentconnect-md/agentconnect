export { MESSAGE_ATTACHMENTS_MAX as WEBCHAT_FILES_MAX } from '@agentconnect.md/protocol/user-turn-body'

// A file an agent shared into its conversation, as the transcript row's trailing marker records it (agent-authored-attachments.md §4).
export interface SharedFile {
  /** Path relative to the session's working root, or to `root`'s area, normalized; null when no download can name it. */
  path: string | null
  /** The session files area a `files:<area>/<path>` marker names; absent for a checkout path. */
  root?: SessionFileArea
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
  const area = parseSessionFileName(raw)
  const path = downloadPath(area ? area.path : raw)
  return {
    caption: text.slice(0, text.length - whole.length).trimEnd(),
    file: {
      path,
      ...(area ? { root: area.area } : {}),
      name: raw.split('/').filter(Boolean).pop() ?? raw,
      mimeType,
      bytes: Number(bytes),
      sha256
    }
  }
}

/** One area of a session's files directory (inbound-file-attachments.md §2.4). */
export type SessionFileArea = (typeof SESSION_FILE_AREAS)[number]

/** A `files:<area>/<rest>` name split into its area and area-relative path; protocol's `parseSessionFileName`, mirrored. */
export function parseSessionFileName(value: string): { area: SessionFileArea; path: string } | undefined {
  if (!value.startsWith(SESSION_FILE_PREFIX)) return undefined
  const rest = value.slice(SESSION_FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  const area = slash < 0 ? rest : rest.slice(0, slash)
  if (!(SESSION_FILE_AREAS as readonly string[]).includes(area)) return undefined
  return { area: area as SessionFileArea, path: slash < 0 ? '' : rest.slice(slash + 1) }
}

/** The path as the download route accepts it: `./` and empty segments dropped, anything absolute or escaping refused. */
function downloadPath(raw: string): string | null {
  if (raw.startsWith('/') || raw.includes('\\')) return null
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
  return segments.length && !segments.includes('..') ? segments.join('/') : null
}

// Mirrors of protocol constants (its root entry is not bundler-safe); shared-file.test.ts pins them.
export const SESSION_FILE_AREAS = ['uploads', 'outputs'] as const
export const SESSION_FILE_PREFIX = 'files:'
export const MAX_WORKSPACE_DOWNLOAD_BYTES = 8 * 1024 * 1024
export const WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES = 1024 * 1024
export const FILE_TRANSFER_FEATURE = 'file-transfer-v2'
export const WEBCHAT_UPLOADS_FEATURE = 'webchat-upload-previews-v1'

function deploymentBytes(key: 'FILE_TRANSFER_MAX_BYTES' | 'FILE_TRANSFER_PART_BYTES'): number | undefined {
  const raw = typeof window === 'undefined' ? process.env[key] : window.__AC_ENV?.[key]
  const bytes = Number(raw)
  return raw && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
}

/** The deployment's console file transfer, as the Control Plane's runtime config published it; undefined when off. */
export function deploymentFileTransfer(): { maxBytes: number; partBytes?: number } | undefined {
  const maxBytes = deploymentBytes('FILE_TRANSFER_MAX_BYTES')
  if (maxBytes === undefined) return undefined
  const partBytes = deploymentBytes('FILE_TRANSFER_PART_BYTES')
  return partBytes === undefined ? { maxBytes } : { maxBytes, partBytes }
}

/** Files move through the bucket when the deployment signs transfers and the agent's daemon speaks that flow. */
export function transferCapable(features: readonly string[] | undefined): boolean {
  return deploymentFileTransfer() !== undefined && features?.includes(FILE_TRANSFER_FEATURE) === true
}

export function uploadPreviewsCapable(features: readonly string[] | undefined): boolean {
  return transferCapable(features) && features?.includes(WEBCHAT_UPLOADS_FEATURE) === true
}

/** How the viewer's download names one workspace file: the session whose root holds it, never a share's digest. */
export interface SessionFileDownload {
  sessionId?: string
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
