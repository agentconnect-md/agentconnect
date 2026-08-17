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

// Budget for the inline text carried by one WebchatOutput payload. Well under
// the 256 KiB JSON frame cap so the envelope overhead (conversationId/turnId/index/
// kind + JSON escaping of control chars, up to a 6× blowup) can never push a chunk
// over the wire limit. Long agent output is split across several chunks at this size.
export const WEBCHAT_CHUNK_BYTES = 32 * 1024

/** Split `text` into pieces whose UTF-8 byte length each stays under WEBCHAT_CHUNK_BYTES
 *  so no single relay `rd/chat` payload exceeds the 256 KiB cap. Splits on byte budget
 *  by character (never mid-code-point); short text returns a single piece. */
export function chunkText(text: string): string[] {
  if (Buffer.byteLength(text) <= WEBCHAT_CHUNK_BYTES) return [text]
  const out: string[] = []
  let buf = ''
  let bytes = 0
  for (const ch of text) {
    const w = Buffer.byteLength(ch)
    if (bytes + w > WEBCHAT_CHUNK_BYTES && buf) {
      out.push(buf)
      buf = ''
      bytes = 0
    }
    buf += ch
    bytes += w
  }
  if (buf) out.push(buf)
  return out
}
