// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { messageLink, messageSeqOf, useLocateMessage, type EarlierPages } from './message-link'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const panes: HTMLElement[] = []

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const el of panes.splice(0)) el.remove()
  window.location.hash = ''
  vi.useRealTimers()
})

it('builds a message link on a page’s address, its query kept, and reads the seq back', () => {
  expect(messageLink('/acme/sessions/ses_1?thread=root-1', 42)).toBe(
    `${window.location.origin}/acme/sessions/ses_1?thread=root-1#msg=42`
  )
  expect(messageSeqOf('#msg=42')).toBe(42)
  expect(messageSeqOf('#msg=x')).toBeNull()
  expect(messageSeqOf('#other')).toBeNull()
})

function Locator({ release, earlier }: { release: () => void; earlier?: EarlierPages }) {
  useLocateMessage('page', release, earlier)
  return null
}

/** A transcript pane holding messages by seq, as the session page draws them. */
function pane(...seqs: number[]) {
  const scroller = document.createElement('div')
  scroller.setAttribute('data-transcript-scroll', '')
  for (const seq of seqs) scroller.appendChild(message(seq))
  // Beside the hook's React root, which would clear anything drawn inside it.
  document.body.appendChild(scroller)
  panes.push(scroller)
  return scroller
}
function message(seq: number) {
  const el = document.createElement('div')
  el.setAttribute('data-msg-seq', String(seq))
  el.scrollIntoView = vi.fn()
  return el
}

it('lands on the message a link names once it is drawn: lets go of the bottom-follow, scrolls to it and marks it', () => {
  window.location.hash = '#msg=7'
  const release = vi.fn()
  act(() => root.render(<Locator release={release} />))
  // Drawn after the page arrives, as a transcript read lands.
  const target = pane(5, 7, 9).querySelector<HTMLElement>('[data-msg-seq="7"]')!
  act(() => {
    vi.advanceTimersByTime(250)
  })
  expect(release).toHaveBeenCalledTimes(1)
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  expect(target.hasAttribute('data-message-located')).toBe(true)
  act(() => {
    vi.advanceTimersByTime(3_000)
  })
  expect(target.hasAttribute('data-message-located')).toBe(false)
})

it('reads earlier pages back to a message older than everything drawn, one page at a time', async () => {
  window.location.hash = '#msg=3'
  const scroller = pane(20, 21)
  let pages = 0
  const earlier: EarlierPages = {
    has: true,
    loading: false,
    load: vi.fn(async () => {
      pages++
      // Each page draws ten older messages at the top.
      const from = 20 - pages * 10
      for (let seq = from + 9; seq >= from; seq--) scroller.prepend(message(seq))
    })
  }
  act(() => root.render(<Locator release={() => {}} earlier={earlier} />))
  for (let i = 0; i < 6; i++)
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
  expect(earlier.load).toHaveBeenCalledTimes(2)
  expect(scroller.querySelector('[data-msg-seq="3"]')!.hasAttribute('data-message-located')).toBe(true)
})
