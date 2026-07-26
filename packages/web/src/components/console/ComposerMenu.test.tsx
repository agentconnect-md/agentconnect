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
})
