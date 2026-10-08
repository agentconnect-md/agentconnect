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
