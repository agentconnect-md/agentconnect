import { describe, expect, it } from 'vitest'
import {
  acceptWebchatDone,
  acceptWebchatOutput,
  createWebchatCursor,
  type OrderedWebchatDone,
  type OrderedWebchatOutput
} from './webchat-stream'

interface Output extends OrderedWebchatOutput {
  text: string
}

interface Done extends OrderedWebchatDone {
  result: string
}

describe('ordered webchat stream', () => {
  it('holds out-of-order frames, drains them contiguously, and ignores duplicates', () => {
    const cursor = createWebchatCursor<Output, Done>('requested-turn')
    expect(cursor).toMatchObject({ requestedTurnId: 'requested-turn', resumeGeneration: 0 })
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 2, text: 'c' }).outputs).toEqual([])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 0, text: 'a' }).outputs.map((o) => o.text)).toEqual(['a'])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'b' }).outputs.map((o) => o.text)).toEqual([
      'b',
      'c'
    ])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'duplicate' }).outputs).toEqual([])
    expect(cursor.nextIndex).toBe(3)
  })

  it('holds done until every output through its lastIndex has arrived', () => {
    const cursor = createWebchatCursor<Output, Done>()
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 0, text: 'a' }).outputs).toHaveLength(1)
    expect(acceptWebchatDone(cursor, { turnId: 't1', lastIndex: 2, result: 'ok' }).done).toBeUndefined()
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 2, text: 'c' }).done).toBeUndefined()
    const final = acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'b' })
    expect(final.outputs.map((o) => o.text)).toEqual(['b', 'c'])
    expect(final.done?.result).toBe('ok')
  })
})
