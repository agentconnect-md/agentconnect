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
