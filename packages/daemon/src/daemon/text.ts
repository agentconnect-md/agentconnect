import { basename } from 'node:path'

/** Format an error for logs, surfacing a JSON-RPC/ACP RequestError's `code` and
 *  `data` — for an agent-side `Internal error` the actionable detail (the adapter's
 *  underlying exception) lives in `data`, which a bare `.stack` discards. */
export function formatErr(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: number; data?: unknown; stack?: string }
  if (e && typeof e.code === 'number') {
    const data = e.data === undefined ? '' : ` data=${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`
    return `${e.name ?? 'Error'}: ${e.message ?? ''} (code=${e.code})${data}`
  }
  return e?.stack ?? String(err)
}

// A refusal a person reads must name the actual fault, so pick the most specific line rather than
// the adapter's generic wrapper, and reduce absolute paths to basenames: the console user who reads
// this is not entitled to the daemon's filesystem layout.
const ERROR_LINE_RE = /^(?:[A-Za-z]*Error|error)\b[:\s]/
const ABSOLUTE_PATH_RE = /(^|[\s'"(<])((?:file:\/\/)?\/[^\s'"()>]+)/g

/** One bounded, path-free line explaining a failed start, for a client-facing refusal. */
export function startFailureDetail(err: unknown, max = 240): string {
  const message = (err as { message?: string })?.message ?? String(err)
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const specific = [...lines].reverse().find((line) => ERROR_LINE_RE.test(line)) ?? lines[0] ?? ''
  const redacted = specific.replace(ABSOLUTE_PATH_RE, (_match: string, lead: string, path: string) =>
    lead.concat(basename(path))
  )
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

export function formatErrWithCauses(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current !== undefined && current !== null && parts.length < 6 && !seen.has(current)) {
    seen.add(current)
    parts.push(formatErr(current))
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return parts.join('\nCaused by: ')
}
