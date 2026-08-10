// @vitest-environment happy-dom

// The dock shell's contract with whatever it hosts: readable labels, the active indicator, a tab press reaching the caller, badges, and the reserved track.

import { act, useEffect, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable so a case can render the state OrgProvider starts in: its list arrives from a network effect, so `activeOrg` is null until then.
const orgs = vi.hoisted(() => ({ activeOrg: { id: 'org-1' } as { id: string } | null }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: orgs.activeOrg })
}))

// The shell owns the mobile app bar, so the ≤768px trigger is a registration; captured here rather than mounting the whole Shell.
const mobileActions: Array<{ icon: string; label: string; active: boolean; onClick: () => void } | null> = []
vi.mock('@/components/console/Shell', () => ({
  useMobileActionSlot: () => ({ action: null, register: (a: unknown) => mobileActions.push(a as never) })
}))

import { DOCK_LABEL_WIDTH, SessionDock, SessionDockSlot, type DockTab, type DockTabStatus } from './SessionDock'
import {
  DOCK_BODY_FLOOR,
  DOCK_INLINE_CHROME,
  DOCK_WIDE_MIN,
  DOCK_WIDTHS_KEY,
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_PROPERTY,
  dockWidthCeiling,
  fitDockWidth,
  readDockWidth,
  writeDockWidth
} from './dock-width'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The two widths are tested apart: happy-dom's 1024px default is below `wide:`, where nothing is withheld, so a plain case tests the preference alone.
const DEFAULT_VIEWPORT = window.innerWidth

// happy-dom's `matchMedia` ignores `innerWidth`, so `useIsMobile` needs one that follows it: the label rule reads the band.
window.matchMedia = ((query: string) => {
  const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY)
  return {
    matches: window.innerWidth <= max,
    addEventListener: () => {},
    removeEventListener: () => {}
  } as unknown as MediaQueryList
}) as typeof window.matchMedia

/** Move the viewport, as a resize does — the applied width is a function of it. */
function setViewport(px: number) {
  window.innerWidth = px
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

const TABS: DockTab[] = [
  { key: 'sessions', label: 'Sessions', icon: 'messages-square', actionIcon: 'plus', actionLabel: 'New session' },
  { key: 'files', label: 'Files', icon: 'folder-tree' },
  { key: 'git', label: 'Git', icon: 'git-commit-horizontal', badge: 3 }
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mobileActions.length = 0
  orgs.activeOrg = { id: 'org-1' }
  window.innerWidth = DEFAULT_VIEWPORT
  window.localStorage.clear()
  // The applied width lives on the document, not in a container: cleared per case so no assertion can be satisfied by the previous one's value.
  document.documentElement.style.removeProperty(DOCK_WIDTH_PROPERTY)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

function dock(props: Partial<Parameters<typeof SessionDock>[0]> = {}) {
  return (
    <SessionDock tabs={TABS} activeKey="files" onTabChange={() => {}} {...props}>
      <div data-body="">panel body</div>
    </SessionDock>
  )
}

/** The width the track and the panel are sized from. A property rather than an inline `width`: the pre-paint script has to be able to set it (`DOCK_WIDTH_INIT`). */
const appliedWidth = () => document.documentElement.style.getPropertyValue(DOCK_WIDTH_PROPERTY)
/** The utility that spends it, asserted beside the value so "612px somewhere on the document" cannot pass for a reserved track. */
const WIDTH_FROM_PROPERTY = 'w-[var(--dock-width)]'

/** Every value written to the property while this is installed, in order, and still written through — the sequence, not just where it settles. */
function recordPublished() {
  const values: string[] = []
  const style = document.documentElement.style
  const real = style.setProperty.bind(style)
  const spy = vi.spyOn(style, 'setProperty').mockImplementation((name: string, value: string | null) => {
    if (name === DOCK_WIDTH_PROPERTY) values.push(String(value))
    real(name, value)
  })
  return { values, restore: () => spy.mockRestore() }
}

const tabButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-dock-tab]'))
const labels = () => tabButtons().map((b) => b.querySelector('[data-dock-label]')?.textContent ?? null)
/** What a screen reader reads for each tab: `aria-label` where it overrides the content, otherwise the content. */
const tabNames = () => tabButtons().map((b) => b.getAttribute('aria-label') ?? b.textContent)

// Width is seeded through the dock's own persistence rather than a stubbed measurement, because that is the path first paint takes.
describe('SessionDock tab labels', () => {
  it('shows every label above the collapse width', () => {
    writeDockWidth('org-1', DOCK_LABEL_WIDTH + 40)
    render(dock())
    expect(labels()).toEqual(['Sessions', 'Files', 'Git'])
  })

  it('shows only the active label at or below the collapse width', () => {
    writeDockWidth('org-1', DOCK_LABEL_WIDTH)
    render(dock())
    expect(labels()).toEqual([null, 'Files', null])
  })

  it('keeps every tab named for a screen reader while its label is collapsed', () => {
    // `aria-label` only where the width took the label away: overriding a visible label would keep its count pill out of the name.
    writeDockWidth('org-1', DOCK_WIDTH_MIN)
    render(dock())
    expect(tabNames()).toEqual(['Sessions', 'Files', 'Git 3'])
    expect(tabButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Sessions', null, 'Git 3'])
  })

  it('reads the count pill out as part of the tab name, labelled or not', () => {
    // "Git" alone loses the reason that tab is worth pressing.
    writeDockWidth('org-1', DOCK_LABEL_WIDTH + 40)
    render(dock({ activeKey: 'git' }))
    expect(tabNames()[2]).toContain('3')
    expect(tabButtons()[2]?.getAttribute('aria-label')).toBeNull()
  })

  it('shows only the active label in the bottom sheet, whose width is the phone and not the dock', () => {
    // `max-desktop:w-auto` overrides the dock's width at ≤768px, where a wide preference would draw every label into ~390px.
    writeDockWidth('org-1', 700)
    window.innerWidth = 390
    render(dock())
    expect(labels()).toEqual([null, 'Files', null])
  })
})

// The width the transcript pays. A preference is no claim on the viewport: 1320px used to render a NARROWER transcript than 1319px did.
describe('SessionDock applied width', () => {
  const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!
  const rendered = () => Number(handle().getAttribute('aria-valuenow'))

  it('bends a wide preference down to the transcript floor on a laptop', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    render(dock())
    expect(rendered()).toBe(fitDockWidth(700, 1366))
    expect(1366 - DOCK_INLINE_CHROME - rendered()).toBe(DOCK_BODY_FLOOR)
  })

  it('leaves the stored preference alone while it bends', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    render(dock())
    expect(rendered()).toBeLessThan(700)
    expect(readDockWidth('org-1')).toBe(700)
  })

  it('hands the whole preference back as the viewport grows, and takes it again as it shrinks', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    render(dock())
    setViewport(1920)
    expect(rendered()).toBe(700)
    setViewport(DOCK_WIDE_MIN)
    expect(rendered()).toBe(DOCK_WIDTH_MIN)
  })

  it('reserves the bent width in the slot too, so the body does not move once the dock arrives', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    render(<SessionDockSlot />)
    expect(container.firstElementChild?.className).toContain(WIDTH_FROM_PROPERTY)
    expect(appliedWidth()).toBe(`${fitDockWidth(700, 1366)}px`)
  })

  it('collapses the labels on the bent width rather than the stored one', () => {
    writeDockWidth('org-1', DOCK_LABEL_WIDTH + 140)
    window.innerWidth = 1366
    render(dock())
    expect(rendered()).toBeLessThan(DOCK_LABEL_WIDTH)
    expect(labels()).toEqual([null, 'Files', null])
  })

  it('hands the render-prop body the bent width, which is the one it lays out in', () => {
    writeDockWidth('org-1', 700)
    window.innerWidth = 1366
    render(
      <SessionDock tabs={TABS} activeKey="files" onTabChange={() => {}}>
        {(width) => <div data-body="">{width}</div>}
      </SessionDock>
    )
    expect(container.querySelector('[data-body]')?.textContent).toBe(String(fitDockWidth(700, 1366)))
  })
})

describe('SessionDock tab strip', () => {
  it('puts the active indicator on the active tab', () => {
    render(dock({ activeKey: 'git' }))
    const marked = container.querySelectorAll('[data-dock-indicator]')
    expect(marked).toHaveLength(1)
    expect(marked[0]?.closest('[data-dock-tab]')?.getAttribute('data-dock-tab')).toBe('git')
    expect(tabButtons().find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.dockTab).toBe('git')
  })

  it('reports the pressed tab to the caller', () => {
    const onTabChange = vi.fn()
    render(dock({ onTabChange }))
    act(() => {
      tabButtons()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onTabChange).toHaveBeenCalledWith('sessions')
  })

  it('draws a badge only for a tab that carries one', () => {
    render(dock())
    const badges = tabButtons().map((b) => b.textContent)
    expect(badges[1]).toBe('Files')
    expect(badges[2]).toContain('3')
    expect(badges[0]).not.toContain('3')
  })

  it('renders only the active tab action, beside the shared overflow button', () => {
    // Drawn only for a caller with a menu to open: M0 has none, and a "More" that opens nothing is worse than no button.
    const onOverflow = () => {}
    render(dock({ activeKey: 'files', onOverflow }))
    expect(container.querySelector('[data-dock-action]')).toBeNull()
    render(dock({ activeKey: 'sessions', onOverflow }))
    expect(container.querySelector('[data-dock-action]')?.getAttribute('data-dock-action')).toBe('sessions')
    expect(container.querySelector('[data-dock-overflow]')).not.toBeNull()
    render(dock({ activeKey: 'sessions' }))
    expect(container.querySelector('[data-dock-overflow]')).toBeNull()
  })

  it('reports the active tab action to the caller', () => {
    const onTabAction = vi.fn()
    render(dock({ activeKey: 'sessions', onTabAction }))
    act(() => {
      container.querySelector('[data-dock-action]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onTabAction).toHaveBeenCalledWith('sessions')
  })

  it('hands the live width to a render-prop body', () => {
    writeDockWidth('org-1', 612)
    render(
      <SessionDock tabs={TABS} activeKey="files" onTabChange={() => {}}>
        {(width) => <div data-body="">{width}</div>}
      </SessionDock>
    )
    expect(container.querySelector('[data-body]')?.textContent).toBe('612')
  })
})

// Pointer events, not mouse events: the 769px+ band includes touch tablets with no mouse, where a mouse-only handle cannot be dragged at all.
describe('SessionDock resize', () => {
  const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!

  const pointer = (type: string, clientX: number, pointerType = 'mouse') =>
    new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, pointerType })

  function press(clientX: number, pointerType = 'mouse') {
    act(() => {
      handle().dispatchEvent(pointer('pointerdown', clientX, pointerType))
    })
  }

  function drag(fromX: number, toX: number, pointerType = 'mouse') {
    press(fromX, pointerType)
    act(() => {
      window.dispatchEvent(pointer('pointermove', toX, pointerType))
    })
    act(() => {
      window.dispatchEvent(pointer('pointerup', toX, pointerType))
    })
  }

  it('narrows when the left-edge handle is dragged rightward, and persists on release', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    drag(1000, 1060)
    expect(handle().getAttribute('aria-valuenow')).toBe('540')
    expect(readDockWidth('org-1')).toBe(540)
  })

  it('widens when the handle is dragged leftward', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    drag(1000, 940)
    expect(handle().getAttribute('aria-valuenow')).toBe('660')
  })

  it('clamps the drag rather than following the pointer past the contract', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    drag(1000, 1600)
    expect(handle().getAttribute('aria-valuenow')).toBe(String(DOCK_WIDTH_MIN))
  })

  it('does not persist mid-drag', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    press(1000)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 1060))
    })
    expect(readDockWidth('org-1')).toBe(600)
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1060))
    })
    expect(readDockWidth('org-1')).toBe(540)
  })

  it('resizes under a finger, which is the only pointer the tablet band has', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    drag(1000, 940, 'touch')
    expect(handle().getAttribute('aria-valuenow')).toBe('660')
    expect(readDockWidth('org-1')).toBe(660)
  })

  it('captures the pointer so the drag survives leaving the 5px handle', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    const capture = vi.spyOn(handle(), 'setPointerCapture')
    press(1000)
    expect(capture).toHaveBeenCalledWith(1)
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1000))
    })
    capture.mockRestore()
  })

  it('suppresses text selection for the duration of the drag', () => {
    // Dragging leftward crosses the transcript, which would otherwise select every line the pointer passed over.
    writeDockWidth('org-1', 600)
    render(dock())
    press(1000)
    expect(document.body.style.userSelect).toBe('none')
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1000))
    })
    expect(document.body.style.userSelect).toBe('')
  })

  it('ignores a second pointer that did not start the drag', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    press(1000)
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, pointerId: 2, pointerType: 'touch' }))
    })
    expect(handle().getAttribute('aria-valuenow')).toBe('600')
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1000))
    })
  })

  it('serializes drags, so a second finger cannot strand the first one undetachable', () => {
    // Without the guard the second pointerdown installs its own listener set over `detachRef`, and then whichever pointer ends FIRST restores selection and clears the ref while the other drag is still live.
    writeDockWidth('org-1', 600)
    render(dock())
    press(1000)
    act(() => {
      handle().dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, pointerId: 2, pointerType: 'touch' })
      )
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 1000, pointerId: 2, pointerType: 'touch' }))
    })
    // The first drag still owns the edge: it moves, and selection is still suppressed because it has not released.
    expect(document.body.style.userSelect).toBe('none')
    act(() => {
      window.dispatchEvent(pointer('pointermove', 1060))
    })
    expect(handle().getAttribute('aria-valuenow')).toBe('540')
    act(() => {
      window.dispatchEvent(pointer('pointerup', 1060))
    })
    expect(document.body.style.userSelect).toBe('')
    expect(readDockWidth('org-1')).toBe(540)
  })

  // The separator's maximum is pinned as LITERALS on both sides of the cap, because
  // re-deriving it with the component's own formula cannot catch a wrong formula.
  it('reports the geometric ceiling where that binds, not the preference cap', () => {
    // 1440 − 296 chrome − 640 floor = 504, so announcing 760 would promise 256px the edge never travels.
    writeDockWidth('org-1', 600)
    window.innerWidth = 1440
    render(dock())
    expect(handle().getAttribute('aria-valuemin')).toBe(String(DOCK_WIDTH_MIN))
    expect(handle().getAttribute('aria-valuemax')).toBe('504')
  })

  it('reports the preference cap where the ceiling exceeds it, rather than the geometry', () => {
    // 1920 − 296 − 640 = 984, but the drag clamps at 760 first, so 984 would over-report by 224px.
    writeDockWidth('org-1', 600)
    window.innerWidth = 1920
    render(dock())
    expect(handle().getAttribute('aria-valuemax')).toBe(String(DOCK_WIDTH_MAX))
    expect(dockWidthCeiling(1920)).toBeGreaterThan(DOCK_WIDTH_MAX)
  })

  it('reports the full preference cap below the inline band, where the overlay withholds nothing', () => {
    writeDockWidth('org-1', 600)
    window.innerWidth = 1200
    render(dock())
    expect(handle().getAttribute('aria-valuemax')).toBe(String(DOCK_WIDTH_MAX))
  })

  it('has no handle at all in the bottom sheet, whose width the dock does not own', () => {
    // The sheet is as wide as the phone, so an arrow press here would move nothing while rewriting the desktop preference.
    writeDockWidth('org-1', 600)
    window.innerWidth = 390
    render(dock())
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(readDockWidth('org-1')).toBe(600)
  })

  it('steps the width with the arrow keys, left widening the dock', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
    })
    expect(readDockWidth('org-1')).toBe(616)
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })
    expect(readDockWidth('org-1')).toBe(600)
  })

  it('stops at the viewport ceiling instead of persisting a width the reader never saw', () => {
    writeDockWidth('org-1', 400)
    window.innerWidth = 1366
    render(dock())
    // The pointer asks for 400 + 300 = 700px; the ceiling on a 1366px viewport is 430.
    drag(1000, 700)
    expect(handle().getAttribute('aria-valuenow')).toBe(String(fitDockWidth(700, 1366)))
    expect(readDockWidth('org-1')).toBe(fitDockWidth(700, 1366))
  })

  it('drops its window listeners when the dock unmounts mid-drag', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    render(dock())
    press(1000)
    act(() => root.unmount())
    expect(remove.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel'])
    )
    remove.mockRestore()
    root = createRoot(container)
  })

  it('ends the drag when the pointer is cancelled rather than released', () => {
    writeDockWidth('org-1', 600)
    render(dock())
    press(1000)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 1060))
    })
    act(() => {
      window.dispatchEvent(pointer('pointercancel', 1060))
    })
    expect(readDockWidth('org-1')).toBe(540)
    // The listeners are gone, so a stray move no longer moves the edge.
    act(() => {
      window.dispatchEvent(pointer('pointermove', 900))
    })
    expect(handle().getAttribute('aria-valuenow')).toBe('540')
  })
})

describe('SessionDockSlot', () => {
  it('reserves the persisted width', () => {
    writeDockWidth('org-1', 612)
    render(<SessionDockSlot />)
    expect(container.firstElementChild?.className).toContain(WIDTH_FROM_PROPERTY)
    expect(appliedWidth()).toBe('612px')
  })

  it('reserves the default width when nothing was ever dragged', () => {
    render(<SessionDockSlot />)
    expect(appliedWidth()).toBe(`${DOCK_WIDTH_DEFAULT}px`)
  })

  it('reserves the stored width before the active organization has resolved', () => {
    // EVERY first paint: correcting the default one effect later slides the centred body by (stored − default) / 2 on every load.
    writeDockWidth('org-1', 612)
    orgs.activeOrg = null
    render(<SessionDockSlot />)
    expect(appliedWidth()).toBe('612px')
  })

  // EVERY value the property takes, in order — a first-frame jump is invisible to a snapshot of the last one, and only visible here.
  it('publishes one width, the fitted one, rather than an unfitted answer over the pre-paint script', () => {
    // 760px at 1400px would leave the transcript 344px, under the 640px floor `fitDockWidth` exists to protect; at the seeded viewport of 0 that is exactly what the ceiling allows.
    writeDockWidth('org-1', DOCK_WIDTH_MAX)
    window.innerWidth = 1400
    const published = recordPublished()
    render(<SessionDockSlot />)
    published.restore()
    expect(published.values).toEqual([`${fitDockWidth(DOCK_WIDTH_MAX, 1400)}px`])
  })

  it('publishes the same single width the dock does', () => {
    // The dock's `preferred === null` guard is what the slot was missing; the two have to agree, since one hands over to the other mid-load.
    writeDockWidth('org-1', DOCK_WIDTH_MAX)
    window.innerWidth = 1400
    const published = recordPublished()
    render(dock())
    published.restore()
    expect(published.values).toEqual([`${fitDockWidth(DOCK_WIDTH_MAX, 1400)}px`])
  })

  it('reserves the same track the dock itself occupies', () => {
    writeDockWidth('org-1', 612)
    render(<SessionDockSlot />)
    const slotClass = container.firstElementChild?.getAttribute('class')
    render(dock())
    expect(container.firstElementChild?.getAttribute('class')).toBe(slotClass)
    expect(appliedWidth()).toBe('612px')
  })
})

describe('SessionDock before the active organization resolves', () => {
  it('opens at the stored width rather than the default', () => {
    writeDockWidth('org-1', 612)
    orgs.activeOrg = null
    render(dock())
    expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('612')
  })

  it('takes the width the reader used most recently when several orgs are remembered', () => {
    writeDockWidth('org-2', 420)
    writeDockWidth('org-1', 612)
    orgs.activeOrg = null
    render(dock())
    expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('612')
  })
})

// A drag in that window is the reader's answer for the org that is about to arrive — it is not a width the empty id owns, and `''` is a store slot.
describe('SessionDock resized before the active organization resolves', () => {
  const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!
  const entries = () => JSON.parse(window.localStorage.getItem(DOCK_WIDTHS_KEY) ?? '[]') as Array<{ orgId: string }>

  function dragBeforeOrg() {
    orgs.activeOrg = null
    render(dock())
    act(() => {
      handle().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 940, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 940, pointerId: 1 }))
    })
  }

  it('stores nothing under the empty organization id', () => {
    dragBeforeOrg()
    expect(handle().getAttribute('aria-valuenow')).toBe('540')
    expect(entries().map((entry) => entry.orgId)).not.toContain('')
  })

  it('does not become the MRU answer for the next reader whose org has not resolved', () => {
    // An entry under `''` would out-rank every real org for the rest of the browser's life, at a width that org never had.
    dragBeforeOrg()
    expect(readDockWidth('')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('keeps the dragged width once the organization lands, and remembers it there', () => {
    dragBeforeOrg()
    orgs.activeOrg = { id: 'org-1' }
    render(dock())
    expect(handle().getAttribute('aria-valuenow')).toBe('540')
    expect(readDockWidth('org-1')).toBe(540)
  })

  it('still seeds from storage when the reader did not drag first', () => {
    writeDockWidth('org-1', 612)
    orgs.activeOrg = null
    render(dock())
    orgs.activeOrg = { id: 'org-1' }
    render(dock())
    expect(handle().getAttribute('aria-valuenow')).toBe('612')
  })

  // The org can also land WHILE the pointer is down. The `end` handler is a raw window listener captured at pointerdown, so it used to persist through the closure built when `orgId` was `''`.
  it('keeps the dragged width under the pointer when the organization lands mid-drag', () => {
    orgs.activeOrg = null
    render(dock())
    act(() => {
      handle().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 800, pointerId: 1 }))
    })
    expect(handle().getAttribute('aria-valuenow')).toBe('680')

    orgs.activeOrg = { id: 'org-1' }
    render(dock())
    // The seed for the arriving org used to read storage over the live drag, snapping the edge back to the default under the finger.
    expect(handle().getAttribute('aria-valuenow')).toBe('680')

    // Moved AGAIN after the org landed, so the only party that can have stored this number is the release — not the seed.
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 900, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 900, pointerId: 1 }))
    })
    expect(handle().getAttribute('aria-valuenow')).toBe('580')
    expect(readDockWidth('org-1')).toBe(580)
    expect(entries().map((entry) => entry.orgId)).not.toContain('')
  })

  it('does not overwrite the NEXT organization with a width dragged before the first one landed', () => {
    // The second half of the same defect: the release wrote nothing, so the stale pending width survived to be spent on whichever org came next.
    writeDockWidth('org-2', 600)
    orgs.activeOrg = null
    render(dock())
    act(() => {
      handle().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 940, pointerId: 1 }))
    })
    orgs.activeOrg = { id: 'org-1' }
    render(dock())
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 940, pointerId: 1 }))
    })

    orgs.activeOrg = { id: 'org-2' }
    render(dock())
    expect(handle().getAttribute('aria-valuenow')).toBe('600')
    expect(readDockWidth('org-2')).toBe(600)
    // The drag belonged to the org it was made in, which is the one that had just landed.
    expect(readDockWidth('org-1')).toBe(660)
  })

  it('prefers the drag over the width that organization had stored, since the reader just moved the edge', () => {
    // The seed reads 600 through the MRU path, the drag widens it by 60, and the org landing must not read the 600 back over that.
    writeDockWidth('org-1', 600)
    dragBeforeOrg()
    orgs.activeOrg = { id: 'org-1' }
    render(dock())
    expect(handle().getAttribute('aria-valuenow')).toBe('660')
    expect(readDockWidth('org-1')).toBe(660)
  })
})

// Both collapsed bands open the SAME panel off one click latch — no hover path, since a second one made `aria-expanded` disagree with the screen.
describe('SessionDock collapsed bands', () => {
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-dock-trigger]')!
  const track = () => container.querySelector<HTMLElement>('[data-dock-track]')!

  it('takes the panel out of the page flow only while it is latched open', () => {
    render(dock())
    expect(track().className).toContain('hidden')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')

    click(trigger())

    // `display: contents` rather than a box: a wrapper would still be a flex item, spending the row's gap on the transcript's right edge.
    expect(track().className).toContain('contents')
    expect(track().className).not.toContain('hidden')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  // The panel node never moves between containers, which is what a two-container shell got wrong.
  it('renders the hosted body exactly once, open or closed', () => {
    render(dock())
    expect(container.querySelectorAll('[data-body]')).toHaveLength(1)
    click(trigger())
    expect(container.querySelectorAll('[data-body]')).toHaveLength(1)
  })

  it('closes on the tap-away scrim, which only exists while it is open', () => {
    render(dock())
    expect(container.querySelector('[data-dock-scrim]')).toBeNull()
    click(trigger())
    click(container.querySelector('[data-dock-scrim]'))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes from the in-panel button, since the overlay covers its own trigger', () => {
    render(dock())
    click(trigger())
    click(container.querySelector('[data-dock-close]'))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the page moves to another session', () => {
    // The detail view survives navigation, so a tapped row would otherwise leave the drawer over the session it just opened.
    render(dock({ overlayKey: 'session-a' }))
    click(trigger())
    render(dock({ overlayKey: 'session-b' }))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('offers the same latch through the shell app bar on mobile', () => {
    render(dock())
    const registered = mobileActions.filter((a) => a !== null)
    expect(registered.at(-1)?.label).toBe('Panels')
    expect(registered.at(-1)?.active).toBe(false)

    act(() => registered.at(-1)?.onClick())

    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(mobileActions.filter((a) => a !== null).at(-1)?.active).toBe(true)
  })

  it('gives the app bar its slot back when the dock unmounts', () => {
    render(dock())
    act(() => root.unmount())
    expect(mobileActions.at(-1)).toBeNull()
    root = createRoot(container)
  })
})

// A dock whose every tab draws nothing is chrome around a void — `status` is how a panel says so, and WHICH kind of nothing it has.
describe('SessionDock with nothing to draw', () => {
  const withStatus = (status: DockTabStatus) => TABS.map((tab) => ({ ...tab, status }))
  const track = () => container.querySelector<HTMLElement>('[data-dock-track]')!

  it('withholds every control that would open a void while its only tab is still loading', () => {
    writeDockWidth('org-1', 612)
    render(dock({ tabs: withStatus('loading') }))
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-dock-trigger]')).toBeNull()
    expect(container.querySelector('[data-dock-close]')).toBeNull()
    expect(container.querySelector('[data-dock-scrim]')).toBeNull()
    expect(mobileActions.filter((a) => a !== null)).toEqual([])
  })

  it('withholds them the same way once that tab has settled empty', () => {
    render(dock({ tabs: withStatus('empty') }))
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[data-dock-trigger]')).toBeNull()
    expect(container.querySelector('[data-dock-close]')).toBeNull()
    expect(mobileActions.filter((a) => a !== null)).toEqual([])
  })

  it('keeps the resize handle in the reserved gutter, which the reader may still narrow at either verdict', () => {
    // The one control the vacant state does NOT withhold: it opens nothing, and without it a lone-session view could not narrow the gutter the track holds.
    writeDockWidth('org-1', 612)
    for (const status of ['loading', 'empty'] as DockTabStatus[]) {
      render(dock({ tabs: withStatus(status) }))
      const handle = container.querySelector<HTMLElement>('[role="separator"]')
      expect(handle?.getAttribute('aria-valuenow')).toBe('612')
      // Inside the track, which is `wide:`-only — so the handle is reachable in exactly the band where the width costs the transcript anything.
      expect(handle?.parentElement).toBe(track())
      expect(track().className).toContain('wide:block')
    }
  })

  it('narrows the vacant gutter from that handle, and remembers the narrower width', () => {
    writeDockWidth('org-1', 600)
    render(dock({ tabs: withStatus('empty') }))
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1060, pointerId: 1 }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1060, pointerId: 1 }))
    })
    expect(appliedWidth()).toBe('540px')
    expect(readDockWidth('org-1')).toBe(540)
  })

  it('still reserves the whole track while the verdict is in flight, since the dock is about to fill it', () => {
    // The same box `SessionDockSlot` held one frame earlier: giving it back here and taking it again would reflow the transcript twice per load.
    writeDockWidth('org-1', 612)
    render(<SessionDockSlot />)
    const slotClass = container.firstElementChild?.getAttribute('class')
    render(dock({ tabs: withStatus('loading') }))
    expect(container.querySelector<HTMLElement>('[data-dock-track]')?.getAttribute('class')).toBe(slotClass)
    expect(appliedWidth()).toBe('612px')
  })

  it('reserves that same track once the verdict has SETTLED empty, so the body does not re-centre under it', () => {
    // The decision the rail wrote down and this dock keeps: an emptiable column shifts the transcript sideways when the round-trip lands, and it lands on every load.
    writeDockWidth('org-1', 612)
    render(<SessionDockSlot />)
    const slotClass = container.firstElementChild?.getAttribute('class')
    render(dock({ tabs: withStatus('empty') }))
    expect(track().className).toContain(WIDTH_FROM_PROPERTY)
    expect(track().getAttribute('class')).toBe(slotClass)
    expect(appliedWidth()).toBe('612px')
  })

  it('holds the widest preference there is across the loading → settled-empty → ready sequence', () => {
    // One load, in order: the widest gutter is the biggest jump a collapse could make, and every step here has to be the same box.
    writeDockWidth('org-1', DOCK_WIDTH_MAX)
    render(dock({ tabs: withStatus('loading') }))
    const loadingClass = track().getAttribute('class')
    render(dock({ tabs: withStatus('empty') }))
    expect(track().getAttribute('class')).toBe(loadingClass)
    render(dock())
    expect(track().getAttribute('class')).toBe(loadingClass)
    expect(appliedWidth()).toBe(`${DOCK_WIDTH_MAX}px`)
  })

  it('keeps the hosted panel mounted, since it owns the fetch that reports the verdict', () => {
    render(dock({ tabs: withStatus('loading') }))
    expect(container.querySelectorAll('[data-body]')).toHaveLength(1)
  })

  // PRESENCE is not IDENTITY: two returns kept a body in the tree at both statuses and still tore it down between them, re-running its fetches.
  it('mounts the hosted panel exactly once across the verdict that raises the chrome', () => {
    const lifecycle: string[] = []
    const Body = () => {
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return <div data-body="">panel body</div>
    }
    const withBody = (tabs: DockTab[]) => (
      <SessionDock tabs={tabs} activeKey="files" onTabChange={() => {}}>
        <Body />
      </SessionDock>
    )
    render(withBody(withStatus('loading')))
    const node = container.querySelector('[data-body]')
    render(withBody(TABS))
    expect(lifecycle).toEqual(['mount'])
    // The same DOM node, not an equal one: a remounted panel would have discarded its scroll position and any open picker with it.
    expect(container.querySelector('[data-body]')).toBe(node)
    render(withBody(withStatus('empty')))
    expect(lifecycle).toEqual(['mount'])
    expect(container.querySelector('[data-body]')).toBe(node)
  })

  it('drops a latched overlay when the panel loses its content', () => {
    render(dock())
    click(container.querySelector('[data-dock-trigger]'))
    render(dock({ tabs: withStatus('empty') }))
    render(dock())
    expect(container.querySelector<HTMLElement>('[data-dock-trigger]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('says which kind of nothing the active tab has while another tab holds content', () => {
    // Visible only once the chrome is up: a spinner means "wait", an empty state means "there is nothing here", and the old code had neither.
    const tabs = TABS.map((tab) => (tab.key === 'files' ? { ...tab, status: 'loading' as DockTabStatus } : tab))
    render(dock({ tabs }))
    expect(container.querySelector('[data-dock-loading]')).not.toBeNull()
    expect(container.querySelector('[data-dock-empty]')).toBeNull()
    expect(container.querySelector('[role="tablist"]')).not.toBeNull()

    render(
      dock({ tabs: TABS.map((tab) => (tab.key === 'files' ? { ...tab, status: 'empty' as DockTabStatus } : tab)) })
    )
    expect(container.querySelector('[data-dock-empty]')).not.toBeNull()
    expect(container.querySelector('[data-dock-loading]')).toBeNull()
  })

  it('draws no placeholder for a tab that has its own content', () => {
    render(dock())
    expect(container.querySelector('[data-dock-loading]')).toBeNull()
    expect(container.querySelector('[data-dock-empty]')).toBeNull()
  })
})

// The overlay is a dialog in both collapsed bands — the semantics the rail's mobile panel had, and which binding Escape already implies.
describe('SessionDock overlay dialog semantics', () => {
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-dock-trigger]')!
  const panel = () => container.querySelector<HTMLElement>('[role="dialog"]')

  const escape = (defaultPrevented = false) =>
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      if (defaultPrevented) event.preventDefault()
      window.dispatchEvent(event)
    })

  const tab = (shiftKey = false) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
    })

  it('is a labelled dialog only while it is an overlay', () => {
    render(dock())
    expect(panel()).toBeNull()
    click(trigger())
    expect(panel()?.getAttribute('aria-label')).toBe('Panels')
  })

  it('is MODAL, since the scrim under it already blocks the page behind', () => {
    // Without `aria-modal` a screen reader still offers the whole page a pointer cannot reach.
    render(dock())
    click(trigger())
    expect(panel()?.getAttribute('aria-modal')).toBe('true')
    click(container.querySelector('[data-dock-close]'))
    expect(container.querySelector('[aria-modal]')).toBeNull()
  })

  it('wraps Tab at the end of the dialog instead of letting it walk behind the scrim', () => {
    render(dock())
    click(trigger())
    const stops = Array.from(
      panel()!.querySelectorAll<HTMLElement>('[role="separator"],[data-dock-tab="files"],button')
    )
    const last = stops.at(-1)!
    act(() => last.focus())
    tab()
    expect(document.activeElement).toBe(stops[0])
  })

  it('wraps Shift+Tab off the front of the dialog to its last stop', () => {
    render(dock())
    click(trigger())
    // Focus opens on the panel BOX, which precedes every stop — the very place a backward Tab would leave the dialog from.
    expect(document.activeElement).toBe(panel())
    tab(true)
    const stops = Array.from(
      panel()!.querySelectorAll<HTMLElement>('[role="separator"],[data-dock-tab="files"],button')
    )
    expect(document.activeElement).toBe(stops.at(-1))
  })

  it('pulls focus back in when it has escaped the dialog altogether', () => {
    render(dock())
    click(trigger())
    act(() => trigger().focus())
    tab()
    expect(panel()?.contains(document.activeElement)).toBe(true)
  })

  it('hands focus back after a scrim close, which leaves it on the body', () => {
    // A restore guarded on the panel still holding focus skipped this close, leaving the reader on `<body>` with no stop to carry on from.
    render(dock())
    trigger().focus()
    click(trigger())
    // What a pointer press on a non-focusable element does, and what a dispatched click alone does not: the panel is blurred first.
    act(() => (document.activeElement as HTMLElement).blur())
    expect(document.activeElement).toBe(document.body)
    click(container.querySelector('[data-dock-scrim]'))
    expect(document.activeElement).toBe(trigger())
  })

  it('leaves focus alone when it has deliberately moved on to the page', () => {
    // Restoring over a reader who clicked into the transcript would take away the thing they just picked.
    render(dock())
    trigger().focus()
    click(trigger())
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    act(() => elsewhere.focus())
    click(container.querySelector('[data-dock-scrim]'))
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('moves focus into the panel when it opens', () => {
    render(dock())
    click(trigger())
    expect(document.activeElement).toBe(panel())
  })

  it('hands focus back to whatever opened it', () => {
    render(dock())
    trigger().focus()
    click(trigger())
    click(container.querySelector('[data-dock-close]'))
    expect(document.activeElement).toBe(trigger())
  })

  // Above `wide:` the SAME node is an ordinary column, and its close button and scrim are both `wide:hidden` — so dialog semantics carried across that line trap a reader in something that looks like a column.
  it('stops being a modal dialog when a resize turns the overlay into the inline column', () => {
    window.innerWidth = 1200
    render(dock())
    click(trigger())
    expect(panel()?.getAttribute('aria-modal')).toBe('true')

    setViewport(DOCK_WIDE_MIN)

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[aria-modal]')).toBeNull()
    // The panel box itself: an `aria-label` left on a plain column names it as something a reader can leave, which above `wide:` it is not.
    expect(container.querySelector('[role="tabpanel"]')?.parentElement?.getAttribute('aria-label')).toBeNull()
    // The latch goes with them: nothing above `wide:` hides the column, so a latch there is state with no control to clear it.
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('paints no frame in which the inline column is still a dialog', () => {
    // The latch is cleared in a passive effect, which runs AFTER the resize's frame is committed — so the semantics have to be withheld in render, and a settled-state assertion cannot see that.
    const frames: boolean[] = []
    const Body = () => {
      // No deps, and reached through the render-prop, so this records every commit of the dock rather than only the ones that change the body.
      useLayoutEffect(() => {
        frames.push(Boolean(container.querySelector('[role="dialog"]')))
      })
      return <div data-body="">panel body</div>
    }
    window.innerWidth = 1200
    render(
      <SessionDock tabs={TABS} activeKey="files" onTabChange={() => {}}>
        {() => <Body />}
      </SessionDock>
    )
    click(trigger())
    expect(frames.at(-1)).toBe(true)

    frames.length = 0
    setViewport(DOCK_WIDE_MIN)

    expect(frames.length).toBeGreaterThan(0)
    expect(frames).not.toContain(true)
  })

  it('drops the Tab trap on that same crossing, so focus can leave the column', () => {
    window.innerWidth = 1200
    render(dock())
    click(trigger())
    const stops = Array.from(
      panel()!.querySelectorAll<HTMLElement>('[role="separator"],[data-dock-tab="files"],button')
    )
    const last = stops.at(-1)!

    setViewport(DOCK_WIDE_MIN)
    act(() => last.focus())
    tab()

    // With the trap installed this wrapped to the first stop; unwrapped, the browser's own Tab order carries on into the page.
    expect(document.activeElement).toBe(last)
  })

  it('leaves focus where the reader left it on that crossing, since nothing was dismissed', () => {
    // The dialog's teardown hands focus back to whatever opened it — right for a close, wrong here: the panel is still on screen as the column.
    window.innerWidth = 1200
    render(dock())
    trigger().focus()
    click(trigger())
    const inside = container.querySelector<HTMLElement>('[data-dock-tab="files"]')!
    act(() => inside.focus())

    setViewport(DOCK_WIDE_MIN)

    expect(document.activeElement).toBe(inside)
  })

  it('closes on Escape', () => {
    render(dock())
    click(trigger())
    escape()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves an Escape a popover inside it already handled alone', () => {
    // The agent picker takes Escape first; closing the drawer with the same press would take away the list the reader was filtering.
    render(dock())
    click(trigger())
    escape(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })
})

// The ARIA tabs keyboard pattern: `role="tab"` promises arrow keys, and every tab being its own tab stop is the other half of that broken promise.
describe('SessionDock tab strip keyboard', () => {
  const press = (key: string) =>
    act(() => {
      container
        .querySelector<HTMLElement>('[data-dock-tab="files"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })

  it('gives the strip one tab stop, on the active tab', () => {
    render(dock())
    expect(tabButtons().map((b) => b.tabIndex)).toEqual([-1, 0, -1])
  })

  it('keeps the strip reachable when the caller has selected no tab at all', () => {
    render(dock({ activeKey: 'nothing' }))
    expect(tabButtons().map((b) => b.tabIndex)).toEqual([0, -1, -1])
  })

  it('selects and focuses the next tab on ArrowRight', () => {
    const onTabChange = vi.fn()
    render(dock({ onTabChange }))
    press('ArrowRight')
    expect(onTabChange).toHaveBeenCalledWith('git')
    expect(document.activeElement).toBe(container.querySelector('[data-dock-tab="git"]'))
  })

  it('selects and focuses the previous tab on ArrowLeft', () => {
    const onTabChange = vi.fn()
    render(dock({ onTabChange }))
    press('ArrowLeft')
    expect(onTabChange).toHaveBeenCalledWith('sessions')
    expect(document.activeElement).toBe(container.querySelector('[data-dock-tab="sessions"]'))
  })

  it('wraps around the ends of the strip', () => {
    const onTabChange = vi.fn()
    render(dock({ activeKey: 'git', onTabChange }))
    act(() => {
      container
        .querySelector<HTMLElement>('[data-dock-tab="git"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onTabChange).toHaveBeenCalledWith('sessions')
  })

  it('leaves other keys to the strip', () => {
    const onTabChange = vi.fn()
    render(dock({ onTabChange }))
    press('ArrowDown')
    expect(onTabChange).not.toHaveBeenCalled()
  })
})
