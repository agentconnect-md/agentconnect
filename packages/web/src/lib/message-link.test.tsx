// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { messageLink, messageSeqOf, useLocateMessage } from './message-link'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

function Locator({ release }: { release: () => void }) {
  useLocateMessage(release)
  return null
}

it('lands on the message a link names once it is drawn: lets go of the bottom-follow, scrolls to it and marks it', () => {
  window.location.hash = '#msg=7'
  const release = vi.fn()
  act(() => root.render(<Locator release={release} />))
  const message = document.createElement('div')
  message.setAttribute('data-msg-seq', '7')
  const scrolled = vi.fn()
  message.scrollIntoView = scrolled
  // Drawn after the page arrives, as a transcript read lands.
  container.appendChild(message)
  act(() => {
    vi.advanceTimersByTime(250)
  })
  expect(release).toHaveBeenCalledTimes(1)
  expect(scrolled).toHaveBeenCalledWith({ block: 'center' })
  expect(message.hasAttribute('data-message-located')).toBe(true)
  act(() => {
    vi.advanceTimersByTime(3_000)
  })
  expect(message.hasAttribute('data-message-located')).toBe(false)
})
