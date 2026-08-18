// Budget for the inline text carried by one WebchatOutput payload. Well under the 256 KiB
// JSON frame cap so envelope overhead (conversationId/turnId/index/kind + JSON escaping of
// control chars, up to a 6x blowup) can never push a chunk over the wire limit.
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
