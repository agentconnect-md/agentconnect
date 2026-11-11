// @vitest-environment happy-dom
// A thread's record keeps being re-read under a parent that re-renders more often than the poll interval.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionThreadMessagesDto } from '@/lib/api'

const wire = vi.hoisted(() => ({ reads: 0, starting: true }))

vi.mock(import('@/lib/api'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchSessionThreadMessages: vi.fn(async (sessionId: string, rootId: string) => {
      wire.reads += 1
      return {
        sessionId,
        rootId,
        messages: [],
        nextCursor: null,
        liveCursor: null,
        liveMore: false,
        summary: {
          rootId,
          replies: 0,
          participants: [],
          // A task with no session row yet: unread because it is starting.
          ...(wire.starting ? { task: { state: 'open', starting: true }, readable: false } : { readable: true })
        }
      } satisfies SessionThreadMessagesDto
    })
  }
})

import { useThreadRecord } from './task-thread'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Panel({ tick }: { tick: number }) {
  const thread = useThreadRecord({ sessionId: 'ses_coordinator', rootId: 'root-1' })
  return (
    <span data-tick={tick} data-starting={thread.summary?.task?.starting ? '' : undefined}>
      {thread.summary ? 'read' : 'reading'}
    </span>
  )
}

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

const render = (tick: number) =>
  act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <Panel tick={tick} />
      </SWRConfig>
    )
    await Promise.resolve()
  })
let cache = new Map()

beforeEach(() => {
  vi.useFakeTimers()
  wire.reads = 0
  wire.starting = true
  cache = new Map()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.useRealTimers()
})

describe('useThreadRecord polling', () => {
  it('re-reads a starting thread every few seconds while its panel re-renders each second, until it is readable', async () => {
    await render(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wire.reads).toBe(1)
    expect(container?.querySelector('[data-starting]')).not.toBeNull()
    // A parent that re-renders every second, as a conversation with a live turn does.
    for (let tick = 1; tick <= 11; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      await render(tick)
    }
    // Eleven seconds at the running interval is two more reads; the timer restarted by each render made none.
    expect(wire.reads).toBe(3)
    wire.starting = false
    for (let tick = 12; tick <= 17; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      await render(tick)
    }
    expect(container?.querySelector('[data-starting]')).toBeNull()
  })
})
