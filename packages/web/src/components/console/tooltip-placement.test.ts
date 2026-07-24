import { describe, expect, it } from 'vitest'
import {
  isTooltipSource,
  placeTooltip,
  TOOLTIP_EDGE,
  TOOLTIP_GAP,
  TOOLTIP_SHOW_DELAY_MS,
  TOOLTIP_WARM_MS
} from './tooltip-placement'

const VIEWPORT = { width: 1280, height: 800 }
const TIP = { width: 160, height: 28 }

describe('placeTooltip', () => {
  it('sits centered above the anchor when there is room', () => {
    const anchor = { top: 400, left: 600, width: 30, height: 30 }

    const pos = placeTooltip(anchor, TIP, VIEWPORT)

    expect(pos.placement).toBe('top')
    expect(pos.top).toBe(400 - TIP.height - TOOLTIP_GAP)
    expect(pos.left).toBe(600 + 15 - TIP.width / 2)
  })

  it('flips below when the anchor is against the top edge', () => {
    const anchor = { top: 4, left: 600, width: 30, height: 30 }

    const pos = placeTooltip(anchor, TIP, VIEWPORT)

    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBe(4 + 30 + TOOLTIP_GAP)
  })

  it('keeps an edge-hugging anchor inside the viewport', () => {
    const right = placeTooltip({ top: 400, left: 1270, width: 20, height: 20 }, TIP, VIEWPORT)
    const left = placeTooltip({ top: 400, left: 0, width: 20, height: 20 }, TIP, VIEWPORT)

    expect(right.left).toBe(VIEWPORT.width - TIP.width - TOOLTIP_EDGE)
    expect(left.left).toBe(TOOLTIP_EDGE)
  })

  it('pins to the near edge rather than inverting when the tooltip cannot fit', () => {
    const pos = placeTooltip({ top: 10, left: 10, width: 20, height: 20 }, { width: 2000, height: 40 }, VIEWPORT)

    expect(pos.left).toBe(TOOLTIP_EDGE)
  })

  it('takes the roomier side when neither above nor below fits', () => {
    // A tall tooltip against a short viewport: below has more space here, and
    // the clamp then slides it up so its bottom stays inside the viewport.
    const viewport = { width: 1280, height: 340 }
    const tip = { width: 160, height: 300 }

    const pos = placeTooltip({ top: 20, left: 600, width: 30, height: 30 }, tip, viewport)

    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBe(viewport.height - tip.height - TOOLTIP_EDGE)
  })
})

describe('isTooltipSource', () => {
  it('accepts ordinary controls carrying a hint', () => {
    expect(isTooltipSource('BUTTON', 'Remove')).toBe(true)
    expect(isTooltipSource('span', 'agt_9f2c41a0')).toBe(true)
  })

  it('ignores blank titles', () => {
    expect(isTooltipSource('BUTTON', '')).toBe(false)
    expect(isTooltipSource('BUTTON', '   ')).toBe(false)
  })

  it('ignores tags whose title is metadata, not a hover hint', () => {
    // An <iframe title> is its accessible name; <svg><title> is an element.
    expect(isTooltipSource('IFRAME', 'Preview')).toBe(false)
    expect(isTooltipSource('svg', 'Chart')).toBe(false)
  })
})

describe('timing', () => {
  it('opens well inside the browser-native tooltip dwell', () => {
    // The whole point of the layer: the native tooltip waits about a second.
    expect(TOOLTIP_SHOW_DELAY_MS).toBeLessThanOrEqual(150)
    expect(TOOLTIP_WARM_MS).toBeGreaterThan(TOOLTIP_SHOW_DELAY_MS)
  })
})
