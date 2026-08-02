// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeSelect } from './RuntimeSelect'
import { unavailableRuntimeIds } from '@/lib/data'

// The registry is an SWR fetch of /api/acp-registry — stub it empty so the test
// never opens a request the environment has to abort on teardown. With no entry,
// labels fall back to the raw runtime id.
vi.mock('@/lib/acp-registry', () => ({
  useAcpRegistry: () => ({}),
  acpRuntime: () => undefined
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Harness({ initial = 'claude', unavailable }: { initial?: string; unavailable?: readonly string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <RuntimeSelect
      value={value}
      options={['claude', 'codex', 'cursor']}
      unavailable={unavailable}
      onChange={setValue}
    />
  )
}

async function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
  await act(async () => trigger.click())
  return { trigger, options: () => [...container!.querySelectorAll<HTMLButtonElement>('[role="option"]')] }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

// Rows keep the `options` order, and the registry is empty under test (no /api fetch),
// so labels fall back to raw ids — index by position rather than by display name.
const CLAUDE = 0
const CODEX = 1
const CURSOR = 2

describe('RuntimeSelect', () => {
  it('offers a runtime the daemon cannot launch but refuses to select it', async () => {
    const { options } = await mount(<Harness unavailable={['codex']} />)

    const codex = options()[CODEX]!
    expect(codex.getAttribute('aria-disabled')).toBe('true')
    // A `disabled` button emits no pointer events, so the reason has to ride an
    // enabled element for the tooltip layer to ever show it.
    expect(codex.hasAttribute('disabled')).toBe(false)
    expect(codex.getAttribute('title')).toContain('Not signed in on this daemon')

    await act(async () => codex.click())

    // Still open on the original value — the click was a no-op.
    expect(options()[CLAUDE]!.getAttribute('aria-selected')).toBe('true')
    expect(options()[CODEX]!.getAttribute('aria-selected')).toBe('false')
  })

  it('never disables the current value, so a form can always keep its own runtime', async () => {
    const { options } = await mount(<Harness initial="codex" unavailable={['codex', 'cursor']} />)

    expect(options()[CODEX]!.hasAttribute('aria-disabled')).toBe(false)
    expect(options()[CURSOR]!.getAttribute('aria-disabled')).toBe('true')
  })

  it('steps arrow-key travel over unavailable rows', async () => {
    const { trigger, options } = await mount(<Harness unavailable={['codex']} />)

    const list = container!.querySelector<HTMLDivElement>('[role="listbox"]')!
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // claude → (skips codex) → cursor, and the pick closed the list.
    expect(trigger.textContent).toContain('cursor')
    expect(options()).toHaveLength(0)
  })
})

describe('unavailableRuntimeIds', () => {
  it('names the runtimes the daemon reports but cannot launch', () => {
    const daemon = {
      runtimeModels: [
        { runtime: 'claude', version: '1.0.0', models: ['sonnet'] },
        { runtime: 'codex', version: '1.1.4', models: [], authRequired: true },
        { runtime: 'cursor', version: '', models: [] }
      ]
    }

    // Only the logged-out one — an empty model list is a runtime that advertises
    // nothing (cursor), not one that cannot run.
    expect(unavailableRuntimeIds(daemon)).toEqual(['codex'])
    expect(unavailableRuntimeIds(undefined)).toEqual([])
  })
})
