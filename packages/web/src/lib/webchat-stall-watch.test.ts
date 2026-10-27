import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebchatStallWatch, WEBCHAT_GAP_RESUME_MS, WEBCHAT_IDLE_RESUME_MS } from './webchat-stall-watch'

describe('webchat stall watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resumes a busy session only after a long silence, each frame restarting the wait', () => {
    const onStall = vi.fn()
    const watch = createWebchatStallWatch(onStall)
    watch.observe('s1', false)
    vi.advanceTimersByTime(WEBCHAT_IDLE_RESUME_MS - 1)
    watch.observe('s1', false)
    vi.advanceTimersByTime(WEBCHAT_IDLE_RESUME_MS - 1)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledExactlyOnceWith('s1', 'idle')
  })

  it('repairs a hole soon, and frames still flowing past it never postpone the repair', () => {
    const onStall = vi.fn()
    const watch = createWebchatStallWatch(onStall)
    watch.observe('s1', true)
    vi.advanceTimersByTime(WEBCHAT_GAP_RESUME_MS - 1)
    watch.observe('s1', true)
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledExactlyOnceWith('s1', 'gap')
  })

  it('drops the hole timer once the lane is contiguous again', () => {
    const onStall = vi.fn()
    const watch = createWebchatStallWatch(onStall)
    watch.observe('s1', true)
    watch.observe('s1', false)
    vi.advanceTimersByTime(WEBCHAT_GAP_RESUME_MS)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WEBCHAT_IDLE_RESUME_MS)
    expect(onStall).toHaveBeenCalledExactlyOnceWith('s1', 'idle')
  })

  it('keeps sessions independent and stops watching a cleared one', () => {
    const onStall = vi.fn()
    const watch = createWebchatStallWatch(onStall, { idleMs: 100 })
    watch.observe('s1', false)
    watch.observe('s2', false)
    watch.clear('s1')
    vi.advanceTimersByTime(100)
    expect(onStall).toHaveBeenCalledExactlyOnceWith('s2', 'idle')
    watch.observe('s3', false)
    watch.clearAll()
    vi.advanceTimersByTime(100)
    expect(onStall).toHaveBeenCalledOnce()
  })
})
