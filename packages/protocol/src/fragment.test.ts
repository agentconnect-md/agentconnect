import { describe, expect, it } from 'vitest'
import {
  FRAGMENT_DATA_BYTES,
  FrameAssembler,
  FrameFragment,
  MAX_ASSEMBLED_FRAME_BYTES,
  fragmentFrame,
  type AssembleResult
} from './frames/fragment.js'
import { MAX_FRAME_BYTES } from './wire.js'
import { decodeCpEnvelope } from './codec.js'
import { decodeRelayCpFrame } from './frames/relay-cp.js'

const payloadOf = (part: string): FrameFragment => FrameFragment.parse(JSON.parse(part).payload)

function assemble(parts: string[]): AssembleResult[] {
  const assembler = new FrameAssembler()
  return parts.map((part) => assembler.push(payloadOf(part)))
}

/** A JSON text of about `bytes` UTF-8 bytes whose 3- and 4-byte characters straddle fragment boundaries. */
function bigText(bytes: number): string {
  const unit = 'aé€😀'
  return JSON.stringify({ blob: unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))) })
}

describe('fragmentFrame', () => {
  it('returns a frame within the cap unchanged', () => {
    const text = JSON.stringify({ hello: 'world' })
    expect(fragmentFrame(text, 'frame/fragment')).toEqual([text])
    const edge = 'x'.repeat(MAX_FRAME_BYTES)
    expect(fragmentFrame(edge, 'frame/fragment')).toEqual([edge])
  })

  it('splits a larger frame into fragments that each fit the cap and decode on both wires', () => {
    const parts = fragmentFrame(bigText(3 * MAX_FRAME_BYTES), 'frame/fragment')!
    expect(parts.length).toBe(Math.ceil(Buffer.byteLength(bigText(3 * MAX_FRAME_BYTES)) / FRAGMENT_DATA_BYTES))
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
      const decoded = decodeCpEnvelope(part)
      expect(decoded.ok && decoded.frame.type).toBe('frame/fragment')
    }
    for (const part of fragmentFrame(bigText(2 * MAX_FRAME_BYTES), 'rc/fragment')!) {
      const decoded = decodeRelayCpFrame(part)
      expect(decoded.ok && decoded.frame.type).toBe('rc/fragment')
    }
  })

  it('refuses a frame past the assembled cap', () => {
    expect(fragmentFrame('x'.repeat(MAX_ASSEMBLED_FRAME_BYTES + 1), 'frame/fragment')).toBeNull()
  })
})

describe('FrameAssembler', () => {
  it('reassembles the exact text, multibyte characters included', () => {
    const text = bigText(2 * MAX_FRAME_BYTES + 12345)
    const results = assemble(fragmentFrame(text, 'frame/fragment')!)
    expect(results.slice(0, -1).every((r) => r.done === false && !('error' in r))).toBe(true)
    expect(results.at(-1)).toEqual({ done: true, text })
  })

  it('reassembles consecutive streams', () => {
    const a = bigText(MAX_FRAME_BYTES + 1)
    const b = bigText(2 * MAX_FRAME_BYTES)
    const results = assemble([...fragmentFrame(a, 'frame/fragment')!, ...fragmentFrame(b, 'frame/fragment')!])
    expect(results.filter((r) => r.done)).toEqual([
      { done: true, text: a },
      { done: true, text: b }
    ])
  })

  it('drops a stream with a missing fragment and recovers on the next one', () => {
    const lost = fragmentFrame(bigText(3 * MAX_FRAME_BYTES), 'frame/fragment')!
    const next = bigText(MAX_FRAME_BYTES + 1)
    const results = assemble([lost[0]!, lost[2]!, ...fragmentFrame(next, 'frame/fragment')!])
    expect(results[1]).toMatchObject({ done: false, error: expect.stringContaining('out of sequence') })
    expect(results.at(-1)).toEqual({ done: true, text: next })
  })

  it('reports a run cut off by the start of another', () => {
    const cut = fragmentFrame(bigText(3 * MAX_FRAME_BYTES), 'frame/fragment')!
    const results = assemble([cut[0]!, ...fragmentFrame(bigText(MAX_FRAME_BYTES + 1), 'frame/fragment')!])
    expect(results[1]).toMatchObject({ done: false, error: expect.stringContaining('was cut off') })
  })

  it('drops fragments of a stream it never saw start', () => {
    const parts = fragmentFrame(bigText(2 * MAX_FRAME_BYTES), 'frame/fragment')!
    expect(assemble(parts.slice(1))[0]).toMatchObject({ error: expect.stringContaining('out of sequence') })
  })

  it('drops a stream that claims more bytes than the assembled cap', () => {
    const assembler = new FrameAssembler()
    const data = Buffer.alloc(FRAGMENT_DATA_BYTES).toString('base64')
    const count = Math.ceil(MAX_ASSEMBLED_FRAME_BYTES / FRAGMENT_DATA_BYTES)
    const frameId = '11111111-1111-4111-8111-111111111111'
    let last: AssembleResult = { done: false }
    for (let index = 0; index < count && !('error' in last); index++) {
      last = assembler.push({
        frameId,
        index,
        count,
        data: index === 0 ? Buffer.alloc(FRAGMENT_DATA_BYTES + 1024).toString('base64') : data
      })
    }
    expect(last).toMatchObject({ error: expect.stringContaining('assembled frame cap') })
  })
})
