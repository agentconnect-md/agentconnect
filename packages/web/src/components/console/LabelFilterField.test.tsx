// @vitest-environment happy-dom
/**
 * The chip field behind "Only with labels": Enter commits, a pasted list splits on
 * commas, Backspace on an empty input takes the last chip back, duplicates fold
 * case-insensitively (the relay matches that way), and the Control Plane's cap
 * hides the input behind a note instead of letting a 21st label be typed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { LabelFilterField, addLabels, LABEL_FILTER_MAX } = await import('./LabelFilterField')

let root: Root | undefined
let host: HTMLDivElement | undefined
const onChange = vi.fn()

async function render(value: string[], collapsible = false) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<LabelFilterField value={value} onChange={onChange} collapsible={collapsible} />)
  })
}

const input = () => document.querySelector<HTMLInputElement>('[data-label-filter="open"] input')
const chips = () => [...document.querySelectorAll('[aria-label^="Remove label "]')]

/** React tracks the DOM value it wrote, so a raw assignment is swallowed. */
async function type(value: string): Promise<void> {
  const field = input()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string) =>
  act(async () => input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  onChange.mockClear()
})

describe('addLabels', () => {
  it('trims, drops blanks and case-insensitive duplicates, and never passes the cap', () => {
    expect(addLabels(['bug'], ['  p0 ', '', 'BUG', 'p0'])).toEqual(['bug', 'p0'])
    const full = Array.from({ length: LABEL_FILTER_MAX }, (_, i) => `l${i}`)
    expect(addLabels(full, ['one-more'])).toEqual(full)
    expect(addLabels([], ['x'.repeat(120)])[0]).toHaveLength(100)
  })
})

describe('LabelFilterField', () => {
  it('commits on Enter and takes the last chip back on Backspace from an empty input', async () => {
    await render(['bug'])
    await type('needs-review')
    await press('Enter')
    expect(onChange).toHaveBeenLastCalledWith(['bug', 'needs-review'])
    expect(input()!.value).toBe('')
    await press('Backspace')
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('folds a duplicate into the existing chip without a change', async () => {
    await render(['Bug'])
    await type('bug')
    await press('Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(input()!.value).toBe('')
  })

  it('removes a chip from its own control', async () => {
    await render(['bug', 'p0'])
    await act(async () => (chips()[0] as HTMLButtonElement).click())
    expect(onChange).toHaveBeenLastCalledWith(['p0'])
  })

  it('hides the input behind a note at the cap', async () => {
    await render(Array.from({ length: LABEL_FILTER_MAX }, (_, i) => `l${i}`))
    expect(input()).toBeNull()
    expect(document.body.textContent).toContain('Label limit reached')
    expect(document.body.textContent).toContain(`${LABEL_FILTER_MAX}/${LABEL_FILTER_MAX}`)
  })

  it('starts as a link when collapsible and empty, and open once a value exists', async () => {
    await render([], true)
    expect(document.querySelector('[data-label-filter="collapsed"]')).not.toBeNull()
    expect(input()).toBeNull()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-label-filter="collapsed"] button')!.click())
    expect(input()).not.toBeNull()
    await act(async () => root?.unmount())
    await render(['bug'], true)
    expect(document.querySelector('[data-label-filter="collapsed"]')).toBeNull()
    expect(chips()).toHaveLength(1)
  })
})
