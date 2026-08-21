// @vitest-environment happy-dom

// The dock's shared refresh cadence: which of the three signals reaches a panel in which state. The
// distinctions under test are the ones that cost requests — a background BROWSER stops polling
// outright, a background TAB stops unless the panel opts into `pollWhileHidden` (Files, Git, PR, whose
// freshness the open page itself depends on), a hidden panel with a badge still takes a turn's edge,
// and one without a badge defers that read to the moment it is revealed instead of dropping it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_POLL_MS, useDockRefresh, type DockRefreshReason } from './auto-refresh'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let reasons: DockRefreshReason[] = []

type Props = Parameters<typeof useDockRefresh>[0]

function Probe(props: Omit<Props, 'onRefresh'>) {
  useDockRefresh({ ...props, onRefresh: (reason) => reasons.push(reason) })
  return null
}

async function render(props: Omit<Props, 'onRefresh'>) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe {...props} />)
  })
}

async function rerender(props: Omit<Props, 'onRefresh'>) {
  await act(async () => {
    root?.render(<Probe {...props} />)
  })
}

/** Drive `document.visibilityState`, which happy-dom reports from a getter. */
async function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  reasons = []
  vi.useFakeTimers()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  await setVisibility('visible')
  vi.useRealTimers()
})

describe('useDockRefresh', () => {
  it('polls on its cadence while the tab is on screen, and stops when it is not', async () => {
    await render({ active: true, intervalMs: DOCK_POLL_MS })
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS * 2))
    expect(reasons).toEqual(['poll', 'poll'])

    await rerender({ active: false, intervalMs: DOCK_POLL_MS })
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS * 5))
    expect(reasons).toEqual(['poll', 'poll'])
  })

  it('stops polling while the BROWSER is in the background, and resumes when it comes back', async () => {
    await render({ active: true, intervalMs: DOCK_POLL_MS })
    await setVisibility('hidden')
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS * 3))
    expect(reasons).toEqual([])

    await setVisibility('visible')
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS))
    expect(reasons).toEqual(['poll'])
  })

  it('polls behind another tab with `pollWhileHidden`, and still stops with the BROWSER', async () => {
    // The three panels the page's own state depends on (Files, Git, PR) keep polling whatever tab is
    // selected: an operator who leaves the page open left the whole page, not one tab. The document
    // stays the fence, because it is the same one that decides whether the sandbox is held.
    await render({ active: false, pollWhileHidden: true, intervalMs: DOCK_POLL_MS })
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS * 2))
    expect(reasons).toEqual(['poll', 'poll'])

    await setVisibility('hidden')
    await act(async () => vi.advanceTimersByTime(DOCK_POLL_MS * 3))
    expect(reasons).toEqual(['poll', 'poll'])
  })

  it('never polls without a cadence — a panel that must not spend a budget passes none', async () => {
    await render({ active: true })
    await act(async () => vi.advanceTimersByTime(10 * DOCK_POLL_MS))
    expect(reasons).toEqual([])
  })

  it('refreshes on a turn’s FALLING edge, not while it streams', async () => {
    await render({ active: true, turnActive: false })
    await rerender({ active: true, turnActive: true })
    expect(reasons).toEqual([])
    await rerender({ active: true, turnActive: false })
    expect(reasons).toEqual(['turn'])
  })

  it('takes a hidden tab’s turn edge only for a panel whose badge is on screen', async () => {
    await render({ active: false, turnActive: true, whileHidden: true })
    await rerender({ active: false, turnActive: false, whileHidden: true })
    expect(reasons).toEqual(['turn'])
  })

  it('defers a hidden panel’s turn refresh to the reveal edge, and spends it exactly once', async () => {
    await render({ active: false, turnActive: true })
    await rerender({ active: false, turnActive: false })
    expect(reasons).toEqual([])

    await rerender({ active: true, turnActive: false })
    expect(reasons).toEqual(['reveal'])

    // Nothing owed any more: leaving and returning re-reads nothing on its own.
    await rerender({ active: false, turnActive: false })
    await rerender({ active: true, turnActive: false })
    expect(reasons).toEqual(['reveal'])
  })

  it('collapses several missed turns into one deferred read', async () => {
    await render({ active: false, turnActive: false })
    for (const streaming of [true, false, true, false]) {
      await rerender({ active: false, turnActive: streaming })
    }
    await rerender({ active: true, turnActive: false })
    expect(reasons).toEqual(['reveal'])
  })

  it('spends a deferred read when the BROWSER returns, not only on a tab switch', async () => {
    await render({ active: true, turnActive: false })
    await setVisibility('hidden')
    await rerender({ active: true, turnActive: true })
    await rerender({ active: true, turnActive: false })
    expect(reasons).toEqual([])

    await setVisibility('visible')
    expect(reasons).toEqual(['reveal'])
  })
})
