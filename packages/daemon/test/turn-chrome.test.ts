import { describe, it, expect } from 'vitest'
import { turnChromeFor } from '../src/platforms/turn-chrome.js'

describe('turn chrome facet', () => {
  it('gives Slack the full chrome set', () => {
    expect(turnChromeFor('slack')).toEqual({
      statusSurface: 'turn-bar',
      attributionFooter: true,
      sessionTitle: true,
      chatInputCards: true,
      chromeMarkedNotices: true
    })
  })

  it('declares the on-demand status platforms EXPLICITLY', () => {
    // 'on-demand' (record the dedup key, post nothing) is a declaration, not an
    // absence — the absent case takes each site's legacy default arm instead.
    for (const p of ['telegram', 'discord', 'feishu']) {
      expect(turnChromeFor(p).statusSurface).toBe('on-demand')
      expect(turnChromeFor(p).attributionFooter).toBeUndefined()
      expect(turnChromeFor(p).chatInputCards).toBeUndefined()
    }
  })

  it('does NOT let core-rendered origins inherit Slack chrome', () => {
    // webchat / hook / dream render through the core (Slack-shaped) surface, but
    // a hook turn gets no footer, no DM title, no approval cards, no status bar.
    // This is why lookup is exact rather than core-fallback.
    for (const p of ['webchat', 'hook', 'dream', 'some-future-platform', 'constructor']) {
      expect(turnChromeFor(p)).toEqual({})
    }
  })
})
