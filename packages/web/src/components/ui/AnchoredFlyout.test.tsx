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
