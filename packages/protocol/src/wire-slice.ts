// Slicing file bytes into one frame, shared by every carrier of the memory-fs op set (frames/memory-store.ts):
// the pod-side executor, the daemon's readers, and the Control Plane's table-backed home answer the same slice.
import { REPLY_BUDGET } from './wire.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** The encoded size of the payload the wire will carry (JSON.stringify matches the codec's `encode`), in bytes. */
export function encodedBytes(payload: unknown): number {
  return textEncoder.encode(JSON.stringify(payload)).length
}

/** Largest index ≤ `len` on a UTF-8 character boundary; a trailing incomplete character belongs to the next slice. */
export function utf8Boundary(buf: Uint8Array, len: number): number {
  if (len >= buf.length) len = buf.length
  if (len <= 0) return 0
  let start = len - 1
  while (start > 0 && ((buf[start] ?? 0) & 0xc0) === 0x80) start-- // step back over continuation bytes
  const lead = buf[start] ?? 0
  const seqLen =
    lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
  return start + seqLen <= len ? len : start
}

// Shrink `slice[0..end]` until its JSON-escaped text fits `REPLY_BUDGET`, keeping the cut on a UTF-8 boundary.
// Control-byte-heavy text escapes ~6×, so the raw byte limit is not enough on its own.
export function fitToBudget(slice: Uint8Array, end: number): { end: number; content: string } {
  let content = textDecoder.decode(slice.subarray(0, end))
  while (end > 0 && encodedBytes(content) > REPLY_BUDGET) {
    const factor = REPLY_BUDGET / encodedBytes(content)
    const shrunk = Math.max(1, Math.floor(end * factor * 0.9))
    end = utf8Boundary(slice, Math.min(shrunk, end - 1)) // strictly < end ⇒ terminates
    content = textDecoder.decode(slice.subarray(0, end))
  }
  return { end, content }
}
