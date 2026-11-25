// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botSenderLabels, IgnoredBotsInput, type BotSender } from './IgnoredBotsInput'

const SEEN: BotSender[] = [
  { id: 'B00000001', name: 'Alert feed', avatarUrl: null },
  { id: 'B00000002', name: 'Alert digest', avatarUrl: null },
  { id: 'B00000003', name: 'Night patrol', avatarUrl: null }
]

/** Stands in for the console data: the list moves once `save` resolves. */
function Harness({ save, initial = [] }: { save: (next: string[]) => Promise<void>; initial?: string[] }) {
  const [blocked, setBlocked] = useState(initial)
  return (
    <IgnoredBotsInput
      blocked={blocked}
      load={async () => SEEN}
      onChange={async (next) => {
        await save(next)
        setBlocked(next)
      }}
    />
  )
}

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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const input = () => host.querySelector('input')!
const suggestions = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent)
const chips = () =>
  [...host.querySelectorAll<HTMLElement>('button[aria-label^="Remove "]')].map((b) => b.parentElement!.textContent)

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (key: string) =>
  act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

async function mount(save = vi.fn(async () => {}), initial: string[] = []) {
  act(() => root.render(<Harness save={save} initial={initial} />))
  await settle()
  return save
}

describe('IgnoredBotsInput', () => {
  it('completes on the names of the bots seen in the conversation and saves a pick as a chip', async () => {
    const save = await mount()
    expect(input().placeholder).toBe('Add a bot')
    expect(suggestions()).toEqual([])

    type('alert')
    expect(suggestions()).toEqual(['Alert feed', 'Alert digest'])
    type('alert f')
    expect(suggestions()).toEqual(['Alert feed'])
    press('Enter')
    await settle()

    expect(save).toHaveBeenCalledWith(['B00000001'])
    expect(chips()).toEqual(['Alert feed'])
    expect(input().value).toBe('')
    // The placeholder only fills an empty box, and an ignored bot is not offered again.
    expect(input().placeholder).toBe('')
    type('alert')
    expect(suggestions()).toEqual(['Alert digest'])
  })

  it('offers a bare id only when no seen bot answers the query, and shows it as an id until the bot is seen', async () => {
    const save = await mount()
    type('unknown bot')
    expect(suggestions()).toEqual([])
    type('B00000001')
    expect(suggestions()).toEqual(['Alert feed'])

    type('B0NEVERSEEN9')
    expect(suggestions()).toEqual(['Add B0NEVERSEEN9'])
    press('Enter')
    await settle()
    expect(save).toHaveBeenCalledWith(['B0NEVERSEEN9'])
    expect(chips()).toEqual(['B0NEVERSEEN9'])
  })

  it('removes a chip by its button and by Backspace on an empty input', async () => {
    const save = await mount(undefined, ['B00000001', 'B00000003'])
    expect(chips()).toEqual(['Alert feed', 'Night patrol'])

    act(() => host.querySelector<HTMLElement>('button[aria-label="Remove Alert feed"]')!.click())
    await settle()
    expect(save).toHaveBeenLastCalledWith(['B00000003'])

    press('Backspace')
    await settle()
    expect(save).toHaveBeenLastCalledWith([])
    expect(chips()).toEqual([])
  })

  it('keeps the query and tells a refused save under the input', async () => {
    await mount(vi.fn(async () => Promise.reject(new Error('cannot edit this agent'))))
    type('alert f')
    press('Enter')
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('cannot edit this agent')
    expect(chips()).toEqual([])
    expect(input().value).toBe('alert f')
  })
})

describe('botSenderLabels', () => {
  it('tells same-named bots apart by the tail of their ids and names a nameless one by its id', () => {
    const labels = botSenderLabels([
      { id: 'B0AAAA1111', name: 'Alert feed', avatarUrl: null },
      { id: 'B0BBBB2222', name: 'Alert feed', avatarUrl: null },
      { id: 'B0CCCC3333', name: 'Build bot', avatarUrl: null },
      { id: 'B0DDDD4444', name: null, avatarUrl: null }
    ])
    expect([...labels.values()]).toEqual(['Alert feed · 1111', 'Alert feed · 2222', 'Build bot', 'B0DDDD4444'])
  })
})
