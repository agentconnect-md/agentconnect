import { describe, expect, it } from 'vitest'
import { placePopover } from './IntegrationChannelList'

// The default-dispatch popover is portalled to the body at fixed coordinates
// (its host cards clip), so nothing else keeps it inside the viewport — these
// four corners are that guarantee.
describe('placePopover', () => {
  const btn = (left: number, top: number) => ({ left, right: left + 44, top, bottom: top + 28 })

  it('anchors below-left of the button when there is room', () => {
    expect(placePopover(btn(300, 200), 1280, 720).style).toEqual({ left: 300, top: 234 })
  })

  it('right-aligns when the menu would run past the right edge', () => {
    // 1100 + 240 > 1280 - 8 ⇒ pin the menu's right edge to the button's.
    expect(placePopover(btn(1100, 200), 1280, 720).style).toEqual({ right: 1280 - 1144, top: 234 })
  })

  it('flips above the button when the bottom edge is too close', () => {
    expect(placePopover(btn(300, 600), 1280, 720).style).toEqual({ left: 300, bottom: 720 - 600 + 6 })
  })

  it('stays below when flipping up would clip the top instead', () => {
    // A short viewport with the button near the top: neither side fits, and
    // below is the one that keeps the button visible.
    expect(placePopover(btn(300, 40), 1280, 200).style).toEqual({ left: 300, top: 74 })
  })
})
