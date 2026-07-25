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
    const cursor = createWebchatCursor<Output, Done>('t1')
    expect(cursor).toMatchObject({ requestedTurnId: 't1', resumeGeneration: 0 })
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 2, text: 'c' }).outputs).toEqual([])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 0, text: 'a' }).outputs.map((o) => o.text)).toEqual(['a'])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'b' }).outputs.map((o) => o.text)).toEqual([
      'b',
      'c'
    ])
    expect(acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'duplicate' }).outputs).toEqual([])
    expect(cursor.nextIndex).toBe(3)
  })

  it('rejects output and done from a turn other than the browser-requested one', () => {
    const cursor = createWebchatCursor<Output, Done>('current')
    expect(acceptWebchatOutput(cursor, { turnId: 'abandoned', index: 0, text: 'stale' }).outputs).toEqual([])
    expect(acceptWebchatDone(cursor, { turnId: 'abandoned', lastIndex: -1, result: 'stale' }).done).toBeUndefined()
    expect(cursor).toMatchObject({ requestedTurnId: 'current', nextIndex: 0 })
    expect(cursor.turnId).toBeUndefined()

    expect(acceptWebchatOutput(cursor, { turnId: 'current', index: 0, text: 'fresh' }).outputs).toHaveLength(1)
    expect(cursor.turnId).toBe('current')
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
