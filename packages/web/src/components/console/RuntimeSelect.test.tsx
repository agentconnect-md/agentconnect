// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeSelect } from './RuntimeSelect'
import { loginRequiredRuntimeIds } from '@/lib/data'

// The registry is an SWR fetch of /api/acp-registry — stub it empty so the test never
// opens a request the environment has to abort on teardown. Labels then come from
// `runtimeLabel`'s static table alone.
vi.mock('@/lib/acp-registry', () => ({
  useAcpRegistry: () => ({}),
  acpRuntime: () => undefined
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Harness({ initial = 'claude', needsLogin }: { initial?: string; needsLogin?: readonly string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <RuntimeSelect value={value} options={['claude', 'codex', 'cursor']} needsLogin={needsLogin} onChange={setValue} />
  )
}

const trigger = () => container!.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
const options = () => [...container!.querySelectorAll<HTMLButtonElement>('[role="option"]')]

async function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
  await act(async () => trigger().click())
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

// Rows keep the `options` order, so index by position rather than by display name.
const CLAUDE = 0
const CODEX = 1

describe('RuntimeSelect', () => {
  it('marks a logged-out runtime without taking the choice away', async () => {
    await mount(<Harness needsLogin={['codex']} />)

    const codex = options()[CODEX]!
    expect(codex.textContent).toContain('Login required')
    expect(codex.getAttribute('title')).toContain('Not signed in on this daemon')
    // Marked, never blocked: placement on a logged-out runtime is a supported state
    // (docs/designs/preset-agents.md §3.2), so nothing here may refuse the pick.
    expect(codex.hasAttribute('disabled')).toBe(false)
    expect(codex.getAttribute('aria-disabled')).toBeNull()

    await act(async () => codex.click())

    expect(trigger().textContent).toContain('Codex')
    expect(options()).toHaveLength(0)
  })

  it('leaves a signed-in runtime unmarked', async () => {
    await mount(<Harness needsLogin={['codex']} />)

    expect(options()[CLAUDE]!.textContent).not.toContain('Login required')
    expect(options()[CLAUDE]!.getAttribute('title')).toBeNull()
  })

  it('carries the warning on the closed trigger, where the menu text does not fit', async () => {
    await mount(<Harness initial="codex" needsLogin={['codex']} />)
    await act(async () => trigger().click()) // close

    expect(options()).toHaveLength(0)
    expect(trigger().querySelector('[title]')?.getAttribute('title')).toContain('Not signed in on this daemon')
  })

  it('keeps arrow-key travel on every row', async () => {
    await mount(<Harness needsLogin={['codex']} />)

    const list = container!.querySelector<HTMLDivElement>('[role="listbox"]')!
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // claude → codex: the marked row is the very next stop, not skipped.
    expect(trigger().textContent).toContain('Codex')
  })
})

describe('loginRequiredRuntimeIds', () => {
  it('names the runtimes the daemon reports as needing a login', () => {
    const daemon = {
      runtimeModels: [
        { runtime: 'claude', version: '1.0.0', models: ['sonnet'] },
        { runtime: 'codex', version: '1.1.4', models: [], authRequired: true },
        { runtime: 'cursor', version: '', models: [] }
      ]
    }

    // Only the flagged one — an empty model list is a runtime that advertises nothing
    // (cursor), not one that needs a login.
    expect(loginRequiredRuntimeIds(daemon)).toEqual(['codex'])
    expect(loginRequiredRuntimeIds(undefined)).toEqual([])
  })
})
