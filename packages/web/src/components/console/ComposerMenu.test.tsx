// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerMenu } from './ComposerMenu'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Harness() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('low')
  return (
    <ComposerMenu
      title="Effort"
      value={value}
      options={[
        { value: 'low', label: 'Low', description: 'Faster, lighter reasoning' },
        { value: 'high', label: 'High' }
      ]}
      open={open}
      onOpenChange={setOpen}
      onChange={setValue}
    />
  )
}

function SearchHarness() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('a1')
  return (
    <ComposerMenu
      title="Agent"
      value={value}
      options={[
        { value: 'a1', label: 'sentio-reviewer' },
        { value: 'a2', label: 'Processor Doctor' },
        { value: 'a3', label: 'Move Builder' }
      ]}
      searchable
      searchPlaceholder="Search agents…"
      open={open}
      onOpenChange={setOpen}
      onChange={setValue}
    />
  )
}

const labels = (scope: ParentNode) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).map((o) => o.textContent)

function setInput(input: HTMLInputElement, text: string) {
  // React's controlled input needs the native value setter bypassed, then an `input` event.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('ComposerMenu', () => {
  it('opens a titled popover and applies the selected option', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<Harness />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    expect(trigger.title).toBe('Faster, lighter reasoning')
    await act(async () => trigger.click())

    const menu = container.querySelector<HTMLElement>('[role="menu"]')
    expect(menu?.textContent).toContain('Effort')
    expect(menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.title).toBe('Faster, lighter reasoning')
    const high = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []).find(
      (option) => option.textContent === 'High'
    )!
    expect(high.title).toBe('Effort: High')

    await act(async () => high.click())

    expect(trigger.textContent).toContain('High')
    expect(trigger.title).toBe('Effort: High')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('filters options by keyword when searchable, and Enter picks the first match', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SearchHarness />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    await act(async () => trigger.click())

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    const search = menu.querySelector<HTMLInputElement>('[role="searchbox"]')!
    expect(search.placeholder).toBe('Search agents…')
    // The placeholder names the list, so the heading row is dropped — but the menu
    // keeps its accessible name.
    expect(menu.textContent).not.toContain('Agent')
    expect(menu.getAttribute('aria-label')).toBe('Agent')
    expect(menu.getAttribute('aria-labelledby')).toBeNull()
    expect(labels(menu)).toEqual(['sentio-reviewer', 'Processor Doctor', 'Move Builder'])

    await act(async () => setInput(search, 'DOC'))
    expect(labels(menu)).toEqual(['Processor Doctor'])

    await act(async () => setInput(search, 'zzz'))
    expect(labels(menu)).toEqual([])
    expect(menu.textContent).toContain('No matches')

    await act(async () => setInput(search, 'move'))
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(trigger.textContent).toContain('Move Builder')
    expect(container.querySelector('[role="menu"]')).toBeNull()

    // Reopening starts unfiltered — the old query must not hide the list.
    await act(async () => trigger.click())
    expect(labels(container.querySelector('[role="menu"]')!)).toHaveLength(3)
  })

  it('leaves Enter and Escape to the IME while a CJK term is still composing', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SearchHarness />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    await act(async () => trigger.click())
    const search = container.querySelector<HTMLInputElement>('[role="searchbox"]')!

    // A candidate-confirming Enter must not pick an option...
    await act(async () => setInput(search, 'move'))
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(trigger.textContent).toContain('sentio-reviewer')

    // ...nor may a candidate-cancelling Escape close the menu.
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()

    // Once composition ends the same keys work as before.
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(trigger.textContent).toContain('Move Builder')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })
})
