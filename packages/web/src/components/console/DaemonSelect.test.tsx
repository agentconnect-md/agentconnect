// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonSelect, type DaemonSelectOption } from './DaemonSelect'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const options: DaemonSelectOption[] = [
  {
    value: 'pool-1',
    label: 'AgentConnect Cloud',
    title: 'Model usage included — no API key needed.',
    kind: 'pool' as const
  },
  { value: 'edge-1', label: 'edge-1', title: 'Uses the credentials on this machine.' },
  { value: 'edge-2', label: 'edge-2', meta: 'offline', title: 'Offline — bring this machine online.', disabled: true }
]

function Harness() {
  const [value, setValue] = useState('pool-1')
  return <DaemonSelect value={value} options={options} onChange={setValue} />
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<Harness />))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('DaemonSelect', () => {
  it('renders Cloud first with its managed-runtime explanation', async () => {
    await mount()
    const trigger = container!.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await act(async () => trigger.click())
    const rows = [...container!.querySelectorAll<HTMLButtonElement>('[role="option"]')]

    expect(rows[0]?.dataset.pool).toBe('true')
    // The row is ONE line: the name, and a compact meta when there is one. The longer reason is a
    // tooltip, not a second line (the design's `.fopt`).
    expect(rows[0]?.textContent).toContain('AgentConnect Cloud')
    expect(rows[0]?.textContent).not.toContain('Model usage included')
    expect(rows[0]?.getAttribute('title')).toBe('Model usage included — no API key needed.')
    expect(rows[2]?.textContent).toContain('offline')
    expect(rows).toHaveLength(3)
    // The selected row carries the design's `.fopt.on`, which is where its background and weight
    // come from — the component states the class, `globals.css` has to define it.
    expect(rows[0]?.className).toMatch(/\bon\b/)
    expect(rows[1]?.className).not.toMatch(/\bon\b/)
  })

  it('draws an action row with its own icon and reports it like any other choice', async () => {
    const picked: string[] = []
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <DaemonSelect
          value="pool-1"
          options={[...options, { value: '__add_daemon__', label: 'Add daemon', icon: 'plus' }]}
          onChange={(next) => picked.push(next)}
        />
      )
    )
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await act(async () => trigger.click())
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]

    expect(rows[3]?.querySelector('svg')?.getAttribute('class')).toContain('lucide-plus')
    await act(async () => rows[3]?.click())
    expect(picked).toEqual(['__add_daemon__'])
  })

  it('selects a local daemon and skips unavailable choices with the keyboard', async () => {
    await mount()
    const trigger = container!.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await act(async () => trigger.click())
    const list = container!.querySelector<HTMLDivElement>('[role="listbox"]')!
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(trigger.textContent).toContain('edge-1')
    expect(container!.querySelector('[role="listbox"]')).toBeNull()
  })
})
