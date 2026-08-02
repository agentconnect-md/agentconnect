import { describe, expect, it } from 'vitest'
import { focusAction } from './conversation-focus'

const base = {
  targetVisible: false,
  transcriptReady: true,
  hasEarlier: false,
  paging: false,
  pagesUsed: 0,
  pageBudget: 10
}

describe('focusAction', () => {
  it('waits while the CURRENT key is not loaded — stale previous-conversation state never decides', () => {
    // The key-to-key regression: the old conversation's msgs/cursors are still
    // in component state while the new key loads. Not-ready must win over
    // everything, including a stale "no earlier history" that would otherwise
    // read as give-up.
    expect(focusAction({ ...base, transcriptReady: false })).toBe('wait')
    expect(focusAction({ ...base, transcriptReady: false, hasEarlier: true })).toBe('wait')
    expect(focusAction({ ...base, transcriptReady: false, targetVisible: true })).toBe('wait')
  })

  it('scrolls when the target is visible, pages while budget lasts, then pauses armed', () => {
    expect(focusAction({ ...base, targetVisible: true })).toBe('scroll')
    expect(focusAction({ ...base, hasEarlier: true, pagesUsed: 9 })).toBe('page')
    // §5.3: budget exhaustion with reachable history must NOT complete focus —
    // manual "Load earlier" continues the search.
    expect(focusAction({ ...base, hasEarlier: true, pagesUsed: 10 })).toBe('pause')
    expect(focusAction({ ...base, hasEarlier: true, paging: true })).toBe('wait')
  })

  it('gives up only when history is genuinely exhausted', () => {
    expect(focusAction(base)).toBe('give-up')
  })
})
