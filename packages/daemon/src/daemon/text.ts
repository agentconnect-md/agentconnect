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

// Prefer the underlying fault over an adapter's generic wrapper when explaining a failed start.
const ERROR_LINE_RE = /^(?:[A-Za-z]*Error|error|fatal)\b[:\s]/
// Cover POSIX and Windows paths without exposing the daemon's filesystem layout.
const ABSOLUTE_PATH_RE = /(?<![A-Za-z0-9._-])(?:(?:file:\/\/)?\/[^\s'"()>\]]+|[A-Za-z]:[\\/][^\s'"()>\]]+)/g

/** One bounded, path-free line explaining a failed start, for a client-facing refusal. */
export function startFailureDetail(err: unknown, max = 240): string {
  const message = (err as { message?: string })?.message ?? String(err)
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const specific = [...lines].reverse().find((line) => ERROR_LINE_RE.test(line)) ?? lines[0] ?? ''
  const redacted = specific
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi, '[remote]')
    .replace(ABSOLUTE_PATH_RE, (path: string) => basename(path.replaceAll('\\', '/')))
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted
}

/** One bounded single-line summary of a diagnostic that has to fit a wire schema; the full text belongs in the log. */
export function boundedDiagnostic(text: string, max = 500): string {
  const body = text
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return body.length > max ? `${body.slice(0, max - 1)}…` : body
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
