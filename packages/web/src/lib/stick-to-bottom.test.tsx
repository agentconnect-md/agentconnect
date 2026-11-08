// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStickToBottom } from './stick-to-bottom'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let grow: () => void = () => {}
let root: Root
let page: HTMLDivElement
let scroller: HTMLDivElement
const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }

beforeEach(() => {
  vi.useFakeTimers()
  // Growth is what the follow reacts to; the stub hands the test its trigger.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        grow = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  page = document.createElement('div')
  page.className = 'content'
  scroller = document.createElement('div')
  scroller.setAttribute('data-transcript-scroll', '')
  scroller.appendChild(document.createElement('div'))
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = Math.min(value, metrics.scrollHeight - metrics.clientHeight)
    }
  })
  Object.defineProperty(scroller, 'scrollHeight', { get: () => metrics.scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { get: () => metrics.clientHeight })
  page.appendChild(scroller)
  const host = document.createElement('div')
  page.appendChild(host)
  document.body.appendChild(page)
  root = createRoot(host)
  Object.assign(metrics, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
})

afterEach(() => {
  act(() => root.unmount())
  page.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount() {
  let api: ReturnType<typeof useStickToBottom> | null = null
  function Probe() {
    api = useStickToBottom('session-1')
    return null
  }
  act(() => root.render(<Probe />))
  return () => api!
}

const growBy = (px: number) => {
  metrics.scrollHeight += px
  act(() => grow())
}

it('follows the end again once a jump that landed there comes to rest', () => {
  const api = mount()
  act(() => api().release(1500))
  // The jump clamps at the end: a scroll event during the hold must not re-arm, the rest must.
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
  act(() => {
    scroller.dispatchEvent(new Event('scrollend'))
  })
  growBy(200)
  expect(metrics.scrollTop).toBe(metrics.scrollHeight - metrics.clientHeight)
})

it('stays where a jump into history landed, and settles a jump that never moved when the hold runs out', () => {
  const api = mount()
  act(() => api().release(1500))
  metrics.scrollTop = 100
  act(() => {
    scroller.dispatchEvent(new Event('scrollend'))
  })
  growBy(200)
  expect(metrics.scrollTop).toBe(100)

  // Back at the end with no scroll at all: the hold's expiry is what re-arms.
  metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight
  act(() => api().release(1500))
  act(() => {
    vi.advanceTimersByTime(1500)
  })
  growBy(100)
  expect(metrics.scrollTop).toBe(metrics.scrollHeight - metrics.clientHeight)
})
