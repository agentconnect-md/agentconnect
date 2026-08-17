import { describe, expect, it } from 'vitest'
import {
  createWebchatDeltaBuffer,
  type WebchatDeltaScheduler,
  type WebchatTextDeltaBatch
} from './webchat-delta-buffer'

function harness() {
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  const scheduler: WebchatDeltaScheduler = {
    requestFrame: (callback) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelFrame: (id) => frames.delete(id),
    setTimer: (callback) => {
      const id = nextId++
      timers.set(id, callback)
      return id
    },
    clearTimer: (id) => timers.delete(Number(id))
  }
  const flushed: WebchatTextDeltaBatch[] = []
  const buffer = createWebchatDeltaBuffer((batch) => flushed.push(batch), { scheduler })
  return {
    buffer,
    flushed,
    runFrame: () => frames.values().next().value?.(16),
    runTimer: () => timers.values().next().value?.(),
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size
  }
}

describe('webchat delta buffer', () => {
  it('merges same-kind deltas in one lane into one frame commit', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'Hel' })
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'lo' })
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: '!' })

    expect(h.flushed).toEqual([])
    h.runFrame()
    expect(h.flushed).toEqual([
      { laneKey: 's:a', sessionId: 's', turnId: 't1', event: { kind: 'message', text: 'Hello!' } }
    ])
    expect(h.pendingFrames()).toBe(0)
    expect(h.pendingTimers()).toBe(0)
  })

  it('buffers participant lanes independently', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'A' })
    h.buffer.enqueue('s:b', 's', 't1', { kind: 'message', text: 'B' })

    h.buffer.flush('s:a')
    expect(h.flushed.map((batch) => batch.event.text)).toEqual(['A'])
    expect(h.pendingFrames()).toBe(1)
    h.runFrame()
    expect(h.flushed.map((batch) => batch.event.text)).toEqual(['A', 'B'])
  })

  it('flushes synchronously at kind and turn boundaries', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'thinking', text: 'plan' })
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'answer' })
    h.buffer.enqueue('s:a', 's', 't2', { kind: 'message', text: 'next' })

    expect(h.flushed.map((batch) => [batch.turnId, batch.event.kind, batch.event.text])).toEqual([
      ['t1', 'thinking', 'plan'],
      ['t1', 'message', 'answer']
    ])
    h.runFrame()
    expect(h.flushed.at(-1)).toMatchObject({ turnId: 't2', event: { text: 'next' } })
  })

  it('uses the max-wait timer when animation frames are throttled', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'visible' })
    h.runTimer()

    expect(h.flushed).toHaveLength(1)
    expect(h.pendingFrames()).toBe(0)
    expect(h.pendingTimers()).toBe(0)
  })

  it('flushes every lane in a session and discards scheduled work on teardown', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'A' })
    h.buffer.enqueue('s:b', 's', 't1', { kind: 'message', text: 'B' })
    h.buffer.enqueue('other:a', 'other', 't2', { kind: 'message', text: 'C' })
    h.buffer.flushSession('s')

    expect(h.flushed.map((batch) => batch.event.text)).toEqual(['A', 'B'])
    h.buffer.discardAll()
    expect(h.pendingFrames()).toBe(0)
    expect(h.pendingTimers()).toBe(0)
    expect(h.flushed).toHaveLength(2)
  })

  it('does not double-flush when a stale scheduled callback runs', () => {
    const h = harness()
    h.buffer.enqueue('s:a', 's', 't1', { kind: 'message', text: 'once' })
    h.buffer.flush('s:a')
    h.runFrame()
    h.runTimer()
    expect(h.flushed).toHaveLength(1)
  })
})
