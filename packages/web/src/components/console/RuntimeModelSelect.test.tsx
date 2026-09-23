// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeModelSelect } from './RuntimeModelSelect'
import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/components/marks', () => ({ AgentMark: () => <span /> }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('searches across runtimes, selects a complete pair and can return to the agent Decision', async () => {
  const onChange = vi.fn()
  const onSelect = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        value={{ runtime: 'claude', model: 'model-standard' }}
        source={{
          runtimeModels: [
            { runtime: 'claude', version: '', models: ['model-standard'] },
            { runtime: 'codex', version: '', models: ['model-capable'], authRequired: true }
          ]
        }}
        onChange={onChange}
        decision={{ name: 'Complexity', selected: true, onSelect }}
      />
    )
  )
  await act(async () => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  const search = dialog.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'capable')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(dialog.textContent).not.toContain('model-standard')
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Codex · model-capable"]')!.click())
  expect(onChange).toHaveBeenLastCalledWith({ runtime: 'codex', model: 'model-capable' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => container.querySelector('button')!.click())
  expect(document.querySelector('[title="Login required"]')).not.toBeNull()
  await act(async () =>
    [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => button.textContent?.includes('By decision'))!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  )
  expect(onSelect).toHaveBeenCalledOnce()
})

it('shows the selected Fast mode on the closed form selector', async () => {
  function Form() {
    const [fast, setFast] = useState(false)
    return (
      <RuntimeModelSelect
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        fastMode={fast}
        onFastModeChange={setFast}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Form />))
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).not.toContain('FAST')
  await act(async () => trigger.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  await act(async () => trigger.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(trigger.textContent).toContain('FAST')
})

it('opens read-only chat settings to the notice alone, without runtime or Fast choices', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        compact
        readOnly
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        decision={{ name: 'Task type', selected: true, onSelect: vi.fn() }}
        onFastModeChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  await act(async () => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toBe('Runtime changes are disabled for this chat.')
  expect(dialog.querySelectorAll('button, input')).toHaveLength(0)
})

it('hides Fast mode when the selected model does not offer it', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        fastMode
        fastModeAvailable={false}
        onFastModeChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).not.toContain('FAST')
  await act(async () => trigger.click())
  expect(document.querySelector('[aria-label="Fast mode"]')).toBeNull()
})

it('edits run settings in the open picker and adapts them when choosing another model or runtime', async () => {
  let selected: DecisionRuntimeTarget = {
    runtime: 'claude',
    model: 'capable',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false
  }
  function Form() {
    const [value, setValue] = useState(selected)
    return (
      <RuntimeModelSelect
        runSettings
        value={value}
        onChange={(next) => {
          selected = next
          setValue(next)
        }}
        source={{
          runtimeModels: [
            {
              runtime: 'claude',
              version: '',
              models: ['capable', 'small'],
              modelCatalog: {
                source: 'acp',
                observedAt: '2026-01-01T00:00:00Z',
                models: [
                  {
                    id: 'capable',
                    efforts: [{ value: 'medium' }, { value: 'high' }],
                    defaultEffort: 'medium',
                    fastMode: true
                  },
                  { id: 'small', efforts: [{ value: 'low' }], defaultEffort: 'low', fastMode: false }
                ],
                permissionModes: [{ value: 'default' }, { value: 'plan' }],
                defaultPermissionMode: 'default'
              }
            },
            {
              runtime: 'codex',
              version: '',
              models: ['other'],
              modelCatalog: {
                source: 'acp',
                observedAt: '2026-01-01T00:00:00Z',
                models: [{ id: 'other', efforts: [], fastMode: false }],
                permissionModes: [{ value: 'agent' }],
                defaultPermissionMode: 'agent'
              }
            }
          ]
        }}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Form />))
  const trigger = container.querySelector('button')!
  await act(async () => trigger.click())
  const option = (group: string, label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${group}"] button`)].find(
      (button) => button.textContent === label
    )!
  await act(async () => option('Effort', 'High').click())
  await act(async () => option('Approval', 'Plan').click())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(selected).toEqual({
    runtime: 'claude',
    model: 'capable',
    effort: 'high',
    permissionMode: 'plan',
    fastMode: true
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(trigger.textContent).toContain('capable (High)')
  expect(trigger.textContent).not.toContain('Plan')
  expect(trigger.textContent).toContain('FAST')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Claude Code · small"]')!.click())
  expect(selected).toEqual({
    runtime: 'claude',
    model: 'small',
    effort: 'low',
    permissionMode: 'plan',
    fastMode: false
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Fast mode"]')).toBeNull()
  expect(trigger.textContent).toContain('small (Low)')
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search all providers"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'other')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Codex · other"]')!.click())
  expect(selected).toEqual({ runtime: 'codex', model: 'other', effort: '', permissionMode: 'agent', fastMode: false })
  expect(document.querySelector('[role="group"][aria-label="Effort"]')).toBeNull()
  expect(document.querySelector('[role="group"][aria-label="Approval"]')?.textContent).toBe('Approve for me')
})
