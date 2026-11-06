// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newDividerIndex, readSeen, SEEN_SESSIONS_MAX, useSeenMarker, writeSeen } from './transcript-seen'
import { SeenRecorder } from '@/components/console/TranscriptNav'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('remembers how far a session was read, never moving back, and forgets the least recent past the cap', () => {
  expect(readSeen('s1')).toBeNull()
  writeSeen('s1', 200)
  writeSeen('s1', 100)
  expect(readSeen('s1')).toBe(200)
  for (let i = 0; i < SEEN_SESSIONS_MAX; i++) writeSeen(`other-${i}`, i + 1)
  expect(readSeen('s1')).toBeNull()
  expect(readSeen(`other-${SEEN_SESSIONS_MAX - 1}`)).toBe(SEEN_SESSIONS_MAX)
})

it('draws the line above the first turn after the mark, never above the first and never on a first read', () => {
  expect(newDividerIndex([10, 20, 30], null)).toBe(-1)
  expect(newDividerIndex([10, 20, 30], 15)).toBe(1)
  expect(newDividerIndex([10, 20, 30], 5)).toBe(1)
  expect(newDividerIndex([10, 20, 30], 30)).toBe(-1)
  expect(newDividerIndex([10, undefined, 30], 15)).toBe(2)
})

it('takes the mark on load and again when the page regains focus, and records reading only while looked at and following', () => {
  let latest: ReturnType<typeof useSeenMarker> | null = null
  function Probe({ following }: { following: boolean }) {
    latest = useSeenMarker('s1', following)
    return null
  }
  writeSeen('s1', 100)
  act(() => root.render(createElement(Probe, { following: true })))
  expect(latest!.marker).toBe(100)
  act(() => latest!.markSeen(300))
  expect(readSeen('s1')).toBe(300)
  // The line stays where it was while the reader keeps reading.
  expect(latest!.marker).toBe(100)

  // Away: nothing new is recorded as read.
  act(() => window.dispatchEvent(new Event('blur')))
  act(() => latest!.markSeen(500))
  expect(readSeen('s1')).toBe(300)
  // Back: the line moves to what was read before leaving.
  act(() => window.dispatchEvent(new Event('focus')))
  expect(latest!.marker).toBe(300)

  // Scrolled up, the end is not read yet.
  act(() => root.render(createElement(Probe, { following: false })))
  act(() => latest!.markSeen(700))
  expect(readSeen('s1')).toBe(300)
})

it('records what is on screen when the reader returns to the end, and nothing while the transcript is hidden', () => {
  function Page({ following, shown }: { following: boolean; shown: boolean }) {
    const { markSeen } = useSeenMarker('s2', following)
    return shown ? createElement(SeenRecorder, { newestMs: 900, markSeen }) : null
  }
  act(() => root.render(createElement(Page, { following: false, shown: true })))
  expect(readSeen('s2')).toBeNull()
  // Back at the end with no new turn: what it now shows is read.
  act(() => root.render(createElement(Page, { following: true, shown: true })))
  expect(readSeen('s2')).toBe(900)
  // A file open over the transcript reads nothing, however new.
  act(() => root.render(createElement(Page, { following: true, shown: false })))
  expect(readSeen('s2')).toBe(900)
})
