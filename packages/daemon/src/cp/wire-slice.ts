/**
 * Pure helpers for slicing file bytes into a single WS frame — shared by the
 * workspace and memory readers so both honour the 256 KiB wire cap and never
 * split a UTF-8 character across slices.
 */
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'

/** Encoded-payload ceiling, leaving headroom under MAX_FRAME_BYTES for the
 *  envelope (id/ts/type/corr + fencing ext, well under 4 KiB). */
export const REPLY_BUDGET = MAX_FRAME_BYTES - 4096

/** The encoded size of the payload the wire will carry (JSON.stringify matches
 *  the codec's `encode`), measured in bytes. */
export function encodedBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload))
}

/** Largest index ≤ `len` that lands on a UTF-8 character boundary — i.e. never
 *  cuts a multi-byte sequence. If the slice's trailing char is incomplete, the
 *  boundary is placed before that char (its bytes belong to the next slice). */
export function utf8Boundary(buf: Buffer, len: number): number {
  if (len >= buf.length) len = buf.length
  if (len <= 0) return 0
  let start = len - 1
  while (start > 0 && ((buf[start] ?? 0) & 0xc0) === 0x80) start-- // step back over continuation bytes
  const lead = buf[start] ?? 0
  const seqLen =
    lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
  return start + seqLen <= len ? len : start
}

/** Shrink `content` (a utf8 view of `slice[0..end]`) until its JSON-escaped size
 *  fits `REPLY_BUDGET`, keeping the cut on a UTF-8 boundary. Returns the final
 *  `{ end, content }`. Control-byte-heavy text escapes ~6×, so the raw byte limit
 *  is not enough on its own. */
export function fitToBudget(slice: Buffer, end: number): { end: number; content: string } {
  let content = slice.toString('utf8', 0, end)
  while (end > 0 && encodedBytes(content) > REPLY_BUDGET) {
    const factor = REPLY_BUDGET / encodedBytes(content)
    const shrunk = Math.max(1, Math.floor(end * factor * 0.9))
    end = utf8Boundary(slice, Math.min(shrunk, end - 1)) // strictly < end ⇒ terminates
    content = slice.toString('utf8', 0, end)
  }
  return { end, content }
}
