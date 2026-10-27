import { describe, expect, it } from 'vitest'
import {
  acceptWebchatDone,
  acceptWebchatOutput,
  createWebchatCursor,
  webchatCursorHasGap,
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

  it('reports a hole while frames past a dropped index, or a done it has not reached, are held', () => {
    const cursor = createWebchatCursor<Output, Done>('t1')
    acceptWebchatOutput(cursor, { turnId: 't1', index: 0, text: 'a' })
    expect(webchatCursorHasGap(cursor)).toBe(false)
    // Index 1 went out while the daemon's relay link was down and never arrives on its own.
    acceptWebchatOutput(cursor, { turnId: 't1', index: 2, text: 'c' })
    expect(webchatCursorHasGap(cursor)).toBe(true)
    acceptWebchatDone(cursor, { turnId: 't1', lastIndex: 2, result: 'ok' })
    expect(webchatCursorHasGap(cursor)).toBe(true)
    // The resume replays it, and the held tail and done drain at once.
    const replayed = acceptWebchatOutput(cursor, { turnId: 't1', index: 1, text: 'b' })
    expect(replayed.outputs.map((o) => o.text)).toEqual(['b', 'c'])
    expect(replayed.done?.result).toBe('ok')
    expect(webchatCursorHasGap(cursor)).toBe(false)
  })

  it('reports a done held behind an output that never came as a hole', () => {
    const cursor = createWebchatCursor<Output, Done>('t1')
    acceptWebchatDone(cursor, { turnId: 't1', lastIndex: 0, result: 'ok' })
    expect(webchatCursorHasGap(cursor)).toBe(true)
  })
})
