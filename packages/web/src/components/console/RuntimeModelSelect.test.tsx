// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeModelSelect } from './RuntimeModelSelect'
import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/components/marks', () => ({
  AgentMark: () => <span />,
  MarkSlot: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

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

const choose = async (label: string, value: string) => {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('edits composer run settings in the footer and summarizes them on the pill', async () => {
  const efforts = [
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ]
  const approvals = [
    { value: 'ask', label: 'Ask' },
    { value: 'auto', label: 'Auto' }
  ]
  function Composer() {
    const [effort, setEffort] = useState('medium')
    const [approval, setApproval] = useState('ask')
    const [fast, setFast] = useState(false)
    return (
      <RuntimeModelSelect
        compact
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        settings={{
          effort: { value: effort, options: efforts, onChange: setEffort },
          approval: { value: approval, options: approvals, onChange: setApproval },
          fast: { value: fast, onChange: setFast }
        }}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Composer />))
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toContain('model-standard · Medium · Ask')
  expect(trigger.textContent).not.toContain('FAST')
  await act(async () => trigger.click())
  await choose('Effort', 'high')
  await choose('Approval', 'auto')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(trigger.textContent).toContain('model-standard · High · Auto')
  expect(trigger.textContent).toContain('FAST')
})

it('opens read-only chat settings to the notice alone while the pill still reads its settings', async () => {
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
        settings={{
          effort: { value: 'high', options: [{ value: 'high', label: 'High' }], onChange: vi.fn() },
          fast: { value: false, onChange: vi.fn() }
        }}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  expect(container.querySelector('button')!.textContent).toContain('model-standard · High')
  await act(async () => container.querySelector('button')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toBe('Runtime changes are disabled for this chat.')
  expect(dialog.querySelectorAll('button, input, select')).toHaveLength(0)
})

it('names the Decision and omits the footer while By decision is selected, and Fast mode where the model lacks it', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const settings = { effort: { value: 'high', options: [{ value: 'high', label: 'High' }], onChange: vi.fn() } }
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        compact
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        decision={{ name: 'Task type', selected: true, onSelect: vi.fn() }}
        settings={settings}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toBe('Task type')
  expect(trigger.querySelector('svg.lucide-split')).toBeTruthy()
  await act(async () => trigger.click())
  expect(document.querySelector('select')).toBeNull()
  await act(async () => trigger.click())
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        compact
        value={{ runtime: 'codex', model: 'model-standard' }}
        onChange={vi.fn()}
        settings={settings}
        source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
      />
    )
  )
  await act(async () => trigger.click())
  expect(document.querySelector('select[aria-label="Effort"]')).not.toBeNull()
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
  await choose('Effort', 'high')
  await choose('Approval', 'plan')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(selected).toEqual({
    runtime: 'claude',
    model: 'capable',
    effort: 'high',
    permissionMode: 'plan',
    fastMode: true
  })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(trigger.textContent).toContain('capableHigh')
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
  expect(trigger.textContent).toContain('smallLow')
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search all providers"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'other')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Codex · other"]')!.click())
  expect(selected).toEqual({ runtime: 'codex', model: 'other', effort: '', permissionMode: 'agent', fastMode: false })
  expect(document.querySelector('select[aria-label="Effort"]')).toBeNull()
  expect(document.querySelector('select[aria-label="Approval"]')?.textContent).toBe('Approve for me')
})

it('shows a truncated form trigger in full on hover, with its run settings', async () => {
  vi.useFakeTimers()
  try {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <RuntimeModelSelect
          dense
          runSettings
          value={{ runtime: 'claude', model: 'model-standard', effort: 'high', permissionMode: 'plan' }}
          onChange={vi.fn()}
          source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        />
      )
    )
    const trigger = container.querySelector('button')!
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(260))
    const card = document.querySelector('[role="tooltip"]')!.textContent
    expect(card).toContain('Modelmodel-standard')
    expect(card).toContain('EffortHigh')
    expect(card).toContain('ApprovalPlan')
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('shows the composer pill details on hover, including By decision rules, but not while the picker is open', async () => {
  vi.useFakeTimers()
  try {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <RuntimeModelSelect
          compact
          value={{ runtime: 'codex', model: 'model-standard' }}
          onChange={vi.fn()}
          decision={{
            name: 'Task type',
            selected: true,
            onSelect: vi.fn(),
            rules: [{ when: 'feature ≥ 60%', then: 'model-capable' }],
            fallback: 'model-standard'
          }}
          source={{ runtimeModels: [{ runtime: 'codex', version: '', models: ['model-standard'] }] }}
        />
      )
    )
    const trigger = container.querySelector('button')!
    await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => vi.advanceTimersByTime(260))
    const card = document.querySelector('[role="tooltip"]')!
    expect(card.textContent).toContain('ModelBy decision')
    expect(card.textContent).toContain('DecisionTask type')
    expect(card.textContent).toContain('1feature ≥ 60%model-capable')
    expect(card.textContent).toContain('Fallbackmodel-standard')
    expect(trigger.getAttribute('aria-describedby')).toBe(card.id)
    await act(async () => trigger.click())
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
