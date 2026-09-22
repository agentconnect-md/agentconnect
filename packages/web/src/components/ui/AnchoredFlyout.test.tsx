// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnchoredFlyout, placeAnchoredFlyout } from './AnchoredFlyout'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('shared AnchoredFlyout', () => {
  it('clamps horizontally and flips above when the lower edge is crowded', () => {
    expect(
      placeAnchoredFlyout(
        { left: 900, right: 950, top: 700, bottom: 730 },
        { width: 1000, height: 800 },
        { width: 280, estimatedHeight: 154, align: 'end', gap: 5, margin: 8 }
      )
    ).toEqual({ left: 670, bottom: 105, width: 280, maxHeight: 687 })
    expect(
      placeAnchoredFlyout(
        { left: 190, right: 240, top: 20, bottom: 50 },
        { width: 250, height: 800 },
        { width: 280, estimatedHeight: 154, align: 'end', gap: 5, margin: 8 }
      )
    ).toMatchObject({ left: 8, top: 55, width: 234 })
  })

  it('grows to a wider trigger only when asked, still inside the viewport', () => {
    const wide = { left: 16, right: 359, top: 100, bottom: 144 }
    const options = { width: 248, estimatedHeight: 300, align: 'end' as const, gap: 6, margin: 8 }
    expect(placeAnchoredFlyout(wide, { width: 375, height: 812 }, options)).toMatchObject({ left: 111, width: 248 })
    expect(
      placeAnchoredFlyout(wide, { width: 375, height: 812 }, { ...options, matchTriggerWidth: true })
    ).toMatchObject({ left: 16, width: 343 })
    // A narrow trigger keeps the flyout's own width.
    expect(
      placeAnchoredFlyout(
        { left: 700, right: 850, top: 100, bottom: 128 },
        { width: 1200, height: 800 },
        { ...options, matchTriggerWidth: true }
      )
    ).toMatchObject({ left: 602, width: 248 })
    expect(
      placeAnchoredFlyout(
        { left: 0, right: 400, top: 100, bottom: 144 },
        { width: 375, height: 812 },
        {
          ...options,
          matchTriggerWidth: true
        }
      )
    ).toMatchObject({ left: 8, width: 359 })
  })

  it('portals its menu to body and distinguishes internal from external scrolling', () => {
    act(() =>
      root.render(
        <div className="overflow-hidden">
          <AnchoredFlyout
            ariaLabel="Add things"
            trigger={({ open, toggle, menuId }) => (
              <button aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={toggle}>
                Add
              </button>
            )}
          >
            {({ close }) => <button onClick={() => close()}>One action</button>}
          </AnchoredFlyout>
        </div>
      )
    )

    act(() => host.querySelector('button')?.click())
    const menu = document.body.querySelector<HTMLElement>('[data-anchored-flyout]')
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(host.contains(menu)).toBe(false)

    act(() => menu?.dispatchEvent(new Event('scroll')))
    expect(document.body.querySelector('[data-anchored-flyout]')).toBe(menu)

    act(() => host.dispatchEvent(new Event('scroll')))
    expect(document.body.querySelector('[data-anchored-flyout]')).toBeNull()

    act(() => host.querySelector('button')?.click())
    act(() => document.body.querySelector<HTMLElement>('[data-anchored-flyout-backdrop]')?.click())
    expect(document.body.querySelector('[data-anchored-flyout]')).toBeNull()
  })
})
