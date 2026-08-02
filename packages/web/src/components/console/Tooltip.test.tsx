// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipLayer } from './Tooltip'
import { TOOLTIP_SHOW_DELAY_MS } from './tooltip-placement'

// React logs a warning unless the test runner advertises itself as one.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

/** Hover `el` and let the open delay elapse. */
async function hover(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, TOOLTIP_SHOW_DELAY_MS + 20))
  })
}

async function unhover() {
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
}

/** Keyboard-focus `el`, standing in for `:focus-visible` the env cannot produce. */
async function focus(el: HTMLElement) {
  const real = Element.prototype.matches
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':focus-visible' ? this === el : real.call(this, selector)
  } as typeof Element.prototype.matches
  try {
    await act(async () => {
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  } finally {
    Element.prototype.matches = real
  }
}

const tooltip = () => document.getElementById('ac-tooltip')

/** An icon-only control: its `title` is the only thing naming it. */
function iconButton(title: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.setAttribute('title', title)
  btn.innerHTML = '<svg></svg>'
  host.appendChild(btn)
  return btn
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root.render(<TooltipLayer />))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('TooltipLayer', () => {
  it('shows the title and lifts it so the native tooltip cannot fire', async () => {
    const btn = iconButton('Remove')

    await hover(btn)

    expect(tooltip()?.textContent).toBe('Remove')
    expect(btn.hasAttribute('title')).toBe(false)
    expect(btn.getAttribute('aria-describedby')).toBe('ac-tooltip')
  })

  it('keeps an icon-only control named while its title is lifted', async () => {
    const btn = iconButton('Edit')

    await hover(btn)

    // `title` is the last-resort accessible NAME here — aria-describedby only
    // adds a description, so the name has to be restated explicitly.
    expect(btn.getAttribute('aria-label')).toBe('Edit')

    await unhover()

    expect(btn.getAttribute('title')).toBe('Edit')
    expect(btn.hasAttribute('aria-label')).toBe(false)
    expect(btn.hasAttribute('aria-describedby')).toBe(false)
  })

  it('never overrides a name the control already has', async () => {
    const labelled = iconButton('Remove')
    labelled.setAttribute('aria-label', 'Remove header')
    const texted = document.createElement('button')
    texted.setAttribute('title', 'Fast-forward pull from the remote')
    texted.textContent = 'Pull'
    host.appendChild(texted)

    await hover(labelled)
    expect(labelled.getAttribute('aria-label')).toBe('Remove header')
    await unhover()
    // The author's own label survives release untouched.
    expect(labelled.getAttribute('aria-label')).toBe('Remove header')

    await hover(texted)
    // Name-from-content: labelling this would REPLACE "Pull" as the name.
    expect(texted.hasAttribute('aria-label')).toBe(false)
  })

  it('follows a title that changes while the tooltip is up', async () => {
    const btn = iconButton('Copy command')

    await hover(btn)
    expect(tooltip()?.textContent).toBe('Copy command')

    // What React does on activation — it writes to the element it can see,
    // which is the one we emptied. Keyboard activation emits no pointerdown,
    // so nothing else would have torn the tooltip down.
    await act(async () => {
      btn.setAttribute('title', 'Copied')
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(tooltip()?.textContent).toBe('Copied')
    // Re-lifted: the native tooltip must not come back on a live control.
    expect(btn.hasAttribute('title')).toBe(false)
    expect(btn.getAttribute('aria-label')).toBe('Copied')

    await unhover()
    expect(btn.getAttribute('title')).toBe('Copied')
  })

  it('does not clobber a newer title with the stale parked one', async () => {
    const btn = iconButton('Show secret')

    await hover(btn)
    // A re-render lands between lift and release without the observer having
    // re-parked it (e.g. the tooltip is already closing).
    btn.setAttribute('title', 'Hide secret')
    await unhover()

    expect(btn.getAttribute('title')).toBe('Hide secret')
  })

  it('opens on a focused row whose hint sits on an inner element', async () => {
    // The agents list: the link takes focus, but the description hangs off the
    // name so a hover opens it where the pointer reads. `closest` only walks
    // up, so focus has to find it going down or the row goes silent.
    const link = document.createElement('a')
    link.href = '#'
    host.appendChild(link)
    const name = document.createElement('div')
    name.setAttribute('title', 'Ships and rolls back deploys from chat.')
    name.textContent = 'deploy-bot'
    link.appendChild(name)

    await focus(link)

    expect(tooltip()?.textContent).toBe('Ships and rolls back deploys from chat.')
  })

  it('releases a focused title before keyboard activation updates it', async () => {
    const btn = iconButton('Show secret')
    // A control whose activation drops its own title (the reveal toggles do this
    // when their label flips). By the time this runs, the tooltip layer has
    // already lifted the DOM attribute.
    btn.addEventListener('click', () => btn.removeAttribute('title'))

    await focus(btn)
    expect(tooltip()?.textContent).toBe('Show secret')

    await act(async () => btn.click())
    await act(async () => btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

    expect(tooltip()).toBeNull()
    expect(btn.hasAttribute('title')).toBe(false)
  })

  it('stays out of a subtree marked data-no-tooltip', async () => {
    const rail = document.createElement('aside')
    rail.setAttribute('data-no-tooltip', '')
    host.appendChild(rail)
    const link = document.createElement('a')
    link.setAttribute('title', 'Sessions')
    link.textContent = 'Sessions'
    rail.appendChild(link)

    await hover(link)

    expect(tooltip()).toBeNull()
    // Left completely alone — the native tooltip is still the rail's fallback.
    expect(link.getAttribute('title')).toBe('Sessions')
  })

  it('hands every title back when the layer unmounts mid-hover', async () => {
    const btn = iconButton('Daemon actions')
    await hover(btn)
    expect(btn.hasAttribute('title')).toBe(false)

    await act(async () => root.unmount())

    expect(btn.getAttribute('title')).toBe('Daemon actions')
    expect(btn.hasAttribute('aria-label')).toBe(false)
  })
})
