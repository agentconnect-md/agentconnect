// A frame above MAX_FRAME_BYTES crosses the wire as fragment envelopes when the receiver advertises FRAME_FRAGMENTS_FEATURE (daemon-cp-ws-protocol.md §1.2).
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MAX_FRAME_BYTES, REPLY_BUDGET, buildEnvelopeRaw } from '../wire.js'

/** Receiver feature: it reassembles fragment envelopes, so a sender may split a frame larger than MAX_FRAME_BYTES. */
export const FRAME_FRAGMENTS_FEATURE = 'frame-fragments-v1'

/** Ceiling on one reassembled frame; a larger fragment stream is dropped. */
export const MAX_ASSEMBLED_FRAME_BYTES = 16 * 1024 * 1024

/** Raw bytes per fragment: their base64 plus the envelope stays within REPLY_BUDGET's headroom under MAX_FRAME_BYTES. */
export const FRAGMENT_DATA_BYTES = Math.floor(REPLY_BUDGET / 4) * 3

const MAX_FRAGMENTS = Math.ceil(MAX_ASSEMBLED_FRAME_BYTES / FRAGMENT_DATA_BYTES)

/** One slice of an oversized frame: `data` is base64 of bytes `[index·FRAGMENT_DATA_BYTES, …)` of its UTF-8 text. */
export const FrameFragment = z.object({
  frameId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  count: z.number().int().min(2).max(MAX_FRAGMENTS),
  data: z.string().min(1).max(REPLY_BUDGET)
})
export type FrameFragment = z.infer<typeof FrameFragment>

/** Split an encoded frame into fragment envelopes of `type`; one that fits is returned as is, one past MAX_ASSEMBLED_FRAME_BYTES as null. */
export function fragmentFrame(text: string, type: string): string[] | null {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so most frames skip the encode.
  if (text.length * 3 <= MAX_FRAME_BYTES) return [text]
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_FRAME_BYTES) return [text]
  if (bytes.length > MAX_ASSEMBLED_FRAME_BYTES) return null
  const frameId = randomUUID()
  const count = Math.ceil(bytes.length / FRAGMENT_DATA_BYTES)
  const out: string[] = []
  for (let index = 0; index < count; index++) {
    const data = bytes.subarray(index * FRAGMENT_DATA_BYTES, (index + 1) * FRAGMENT_DATA_BYTES).toString('base64')
    out.push(JSON.stringify(buildEnvelopeRaw(type, { frameId, index, count, data })))
  }
  return out
}

export type AssembleResult = { done: false } | { done: true; text: string } | { done: false; error: string }

/** Reassembles one sender's fragment streams; a sender emits each stream contiguously, so one is in flight at a time. */
export class FrameAssembler {
  private frameId: string | undefined
  private count = 0
  private parts: Buffer[] = []
  private bytes = 0

  push(fragment: FrameFragment): AssembleResult {
    if (fragment.index === 0 && this.frameId !== undefined)
      return this.fail(`frame ${this.frameId} was cut off by frame ${fragment.frameId}`)
    if (fragment.index === 0) this.start(fragment)
    else if (fragment.frameId !== this.frameId || fragment.count !== this.count || fragment.index !== this.parts.length)
      return this.fail(`fragment ${fragment.index}/${fragment.count} of ${fragment.frameId} is out of sequence`)
    const part = Buffer.from(fragment.data, 'base64')
    this.bytes += part.length
    if (this.bytes > MAX_ASSEMBLED_FRAME_BYTES)
      return this.fail(`frame ${fragment.frameId} exceeds the assembled frame cap`)
    this.parts.push(part)
    if (this.parts.length < this.count) return { done: false }
    const text = Buffer.concat(this.parts).toString('utf8')
    this.reset()
    return { done: true, text }
  }

  reset(): void {
    this.frameId = undefined
    this.count = 0
    this.parts = []
    this.bytes = 0
  }

  private start(fragment: FrameFragment): void {
    this.reset()
    this.frameId = fragment.frameId
    this.count = fragment.count
  }

  private fail(error: string): AssembleResult {
    this.reset()
    return { done: false, error }
  }
}
