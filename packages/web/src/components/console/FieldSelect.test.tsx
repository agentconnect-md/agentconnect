// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FieldSelect } from './FieldSelect'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | undefined
let root: Root | undefined

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' }
] as const

async function render(onChange: (v: string) => void): Promise<HTMLButtonElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<FieldSelect ariaLabel="Pick" value="b" options={OPTIONS} onChange={onChange} />)
  })
  return host.querySelector('button[aria-label="Pick"]') as HTMLButtonElement
}

const frame = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))))
const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('FieldSelect keyboard', () => {
  it('opens from the trigger on ArrowDown, focuses the current option, and moves with arrows', async () => {
    const onChange = vi.fn()
    const trigger = await render(onChange)
    trigger.focus()
    await press(trigger, 'ArrowDown')
    await frame()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toBe('Beta')

    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Gamma')
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Alpha')
    await press(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('Gamma')

    await act(async () => {
      ;(document.activeElement as HTMLButtonElement).click()
    })
    expect(onChange).toHaveBeenCalledWith('c')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape without picking', async () => {
    const onChange = vi.fn()
    const trigger = await render(onChange)
    await act(async () => trigger.click())
    await frame()
    await press(document.activeElement!, 'Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
  })
})
