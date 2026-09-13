// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeSelect } from './RuntimeSelect'
import { loginRequiredRuntimeIds } from '@/lib/data'

// Use static runtime labels without fetching the ACP registry.
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
const option = (label: string) => options().find((row) => row.textContent?.startsWith(label))!

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

describe('RuntimeSelect', () => {
  it('keeps an empty reported list unselected and closed', async () => {
    const onChange = vi.fn()
    await mount(<RuntimeSelect value="" options={[]} onChange={onChange} />)
    expect(trigger().disabled).toBe(true)
    expect(trigger().textContent).toContain('Select runtime')
    expect(options()).toHaveLength(0)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('groups logged-out runtimes last without taking the choice away', async () => {
    await mount(<Harness needsLogin={['claude', 'codex']} />)

    expect(options()).toEqual([option('cursor'), option('Claude Code'), option('Codex')])
    expect(option('Claude Code').previousElementSibling?.className).toBe('dmsep')
    expect(option('Claude Code').getAttribute('aria-selected')).toBe('true')
    const codex = option('Codex')
    expect(codex.textContent).toContain('Login required')
    expect(codex.getAttribute('title')).toContain('Not signed in on this daemon')
    // Logged-out placement is supported (docs/designs/preset-agents.md §3.2).
    expect(codex.hasAttribute('disabled')).toBe(false)
    expect(codex.getAttribute('aria-disabled')).toBeNull()

    await act(async () => codex.click())

    expect(trigger().textContent).toContain('Codex')
    expect(options()).toHaveLength(0)
  })

  it('prioritizes a missing image binary until it is available for execution', async () => {
    const onChange = vi.fn()
    const select = (imageBinaryMissing?: string[]) => (
      <RuntimeSelect
        value="codex"
        options={['claude', 'codex']}
        needsLogin={['claude', 'codex']}
        imageBinaryMissing={imageBinaryMissing}
        onChange={onChange}
      />
    )
    await mount(select(['codex']))
    expect(options()).toEqual([option('Codex'), option('Claude Code')])
    const codex = option('Codex')
    expect(codex.textContent).toContain('Binary not installed in image')
    expect(codex.textContent).not.toContain('Login required')
    await act(async () => codex.click())
    expect(onChange).toHaveBeenCalledWith('codex')
    expect(trigger().querySelector('[title]')?.getAttribute('title')).toBe('Binary not installed in image')

    await act(async () => root?.render(select()))
    expect(trigger().querySelector('[title]')?.getAttribute('title')).toContain('Not signed in on this daemon')
    await act(async () => trigger().click())
    expect(options()).toEqual([option('Claude Code'), option('Codex')])
    expect(container!.querySelector('.dmsep')).toBeNull()
    expect(option('Codex').textContent).toContain('Login required')
    expect(option('Codex').textContent).not.toContain('Binary not installed in image')
  })

  it('leaves a signed-in runtime unmarked', async () => {
    await mount(<Harness needsLogin={['codex']} />)

    expect(options()).toEqual([option('Claude Code'), option('cursor'), option('Codex')])
    expect(option('Claude Code').textContent).not.toContain('Login required')
    expect(option('Claude Code').getAttribute('title')).toBeNull()
  })

  it('carries the warning on the closed trigger, where the menu text does not fit', async () => {
    await mount(<Harness initial="codex" needsLogin={['codex']} />)
    await act(async () => trigger().click()) // close

    expect(options()).toHaveLength(0)
    expect(trigger().querySelector('[title]')?.getAttribute('title')).toContain('Not signed in on this daemon')
  })

  it('keeps arrow-key travel on every row', async () => {
    await mount(<Harness initial="cursor" needsLogin={['codex']} />)

    const list = container!.querySelector<HTMLDivElement>('[role="listbox"]')!
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Keyboard navigation crosses the separator to reach the logged-out group.
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

    // An empty model list alone does not require login.
    expect(loginRequiredRuntimeIds(daemon)).toEqual(['codex'])
    expect(loginRequiredRuntimeIds(undefined)).toEqual([])
  })
})
