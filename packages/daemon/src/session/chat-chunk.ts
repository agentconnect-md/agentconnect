// Bounded application chunks leave enough room for each protocol's envelope.
export const CHAT_CHUNK_BYTES = 32 * 1024

// Bound emission size by UTF-8 bytes without splitting a code point.
export function chunkText(text: string): string[] {
  if (Buffer.byteLength(text) <= CHAT_CHUNK_BYTES) return [text]
  const out: string[] = []
  let buf = ''
  let bytes = 0
  for (const ch of text) {
    const w = Buffer.byteLength(ch)
    if (bytes + w > CHAT_CHUNK_BYTES && buf) {
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
