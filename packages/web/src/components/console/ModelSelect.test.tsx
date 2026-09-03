// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from './ModelSelect'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function render(element: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(element))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const OPTIONS = [
  { value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
  { value: 'opus[1m]', name: 'Opus (1M context)', description: 'Opus 5 with 1M context' },
  { value: 'haiku' }
]

const openMenu = async () => {
  const trigger = container!.querySelector('button')!
  await act(async () => trigger.click())
  return container!.querySelector<HTMLElement>('.fmenu')!
}

describe('ModelSelect', () => {
  it('offers every advertised id verbatim, with the runtime name beside it', async () => {
    await render(<ModelSelect value="default" options={OPTIONS} onChange={vi.fn()} />)
    const rows = [...(await openMenu()).querySelectorAll('[role="option"]')]

    expect(rows.map((row) => row.textContent)).toEqual([
      'defaultDefault (recommended)',
      'opus[1m]Opus (1M context)',
      'haiku'
    ])
    // The blurb is the row's hover text — the id stays the label.
    expect(rows[1]!.getAttribute('title')).toBe('Opus 5 with 1M context')
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('reports the picked id and closes', async () => {
    const onChange = vi.fn()
    await render(<ModelSelect value="default" options={OPTIONS} onChange={onChange} />)
    const menu = await openMenu()
    await act(async () => menu.querySelectorAll<HTMLElement>('[role="option"]')[2]!.click())

    expect(onChange).toHaveBeenCalledWith('haiku')
    expect(container?.querySelector('.fmenu')).toBeNull()
  })

  it('opens INWARD from the field, and lets a row narrow to the cap', async () => {
    // Model is the last field of its row: a left-anchored menu wider than the trigger pushed
    // past the dialog, which widened the form's scroll area and added a horizontal scrollbar.
    await render(<ModelSelect value="default" options={OPTIONS} onChange={vi.fn()} />)
    const menu = await openMenu()

    expect(menu.className).toContain('right-0')
    // `.fmenu` itself sets `left: 0`, so the override has to be explicit.
    expect(menu.className).toContain('left-auto')
    expect(menu.className).not.toMatch(/(^|\s)left-0(\s|$)/)
    // The name is the shrinkable half; a row that cannot shrink forces its own min-content
    // width on the dialog however the menu is capped.
    const name = menu.querySelectorAll('[role="option"]')[1]!.children[1]!
    expect(name.className).toContain('min-w-0')
    expect(name.className).not.toContain('flex-none')
  })

  it('is inert with its reason when the runtime advertises no models', async () => {
    await render(
      <ModelSelect value="" options={[]} onChange={vi.fn()} disabledHint="This runtime reports no selectable models" />
    )
    const trigger = container!.querySelector('button')!

    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('title')).toBe('This runtime reports no selectable models')
    expect(trigger.textContent).toContain('—')
    await act(async () => trigger.click())
    expect(container?.querySelector('.fmenu')).toBeNull()
  })
})
