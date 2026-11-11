// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeModelSelect } from './RuntimeModelSelect'
import type { AgentModelSelection, DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/components/marks', () => ({
  AgentMark: () => <span />,
  ModelMark: () => <span />,
  MarkSlot: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const selection: AgentModelSelection = {
  decisionId: '44444444-4444-4444-8444-444444444444',
  rules: [{ when: { type: 'choice', thresholds: { feature: 0.6 } }, runtime: 'codex', model: 'model-capable' }]
}
const fallback = { runtime: 'codex', model: 'model-standard' }

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
        decision={{ name: 'Complexity', selected: true, onSelect, selection, fallback }}
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
        decision={{ name: 'Task type', selected: true, onSelect: vi.fn(), selection, fallback }}
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
  expect(document.querySelector('select[aria-label="Approval"]')?.textContent).toBe('Auto review')
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
            selection,
            fallback
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

it('switches the menu to the coordinator, which offers no approval and keeps the menu open on a pick', async () => {
  const onChange = vi.fn()
  const onCoordinator = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        runSettings
        value={{ runtime: 'claude', model: 'model-standard', effort: 'medium' }}
        onChange={onChange}
        source={{
          runtimeModels: [
            { runtime: 'claude', version: '', models: ['model-standard', 'model-small'] },
            { runtime: 'codex', version: '', models: ['model-capable'] }
          ]
        }}
        coordinator={{
          value: { runtime: 'claude', model: 'model-small', effort: 'low' },
          onChange: onCoordinator
        }}
      />
    )
  )
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toContain('+ coordinator model-small')
  await act(async () => trigger.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('select[aria-label="Approval"]')).not.toBeNull()
  const tab = (name: string) =>
    [...dialog.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === name)!
  await act(async () => tab('Coordinator').click())
  expect(dialog.querySelector('select[aria-label="Approval"]')).toBeNull()
  expect(dialog.querySelector('button[aria-label$="· model-small"]')!.getAttribute('aria-pressed')).toBe('true')
  await act(async () =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Codex'))!.click()
  )
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Codex · model-capable"]')!.click())
  expect(onCoordinator).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: 'codex', model: 'model-capable' }))
  expect(onChange).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

// auto-session-mode.md §3.6: Disable coordinator ends the coordinator list, and picking a model turns it back on.
it('turns the coordinator off from its tab, and back on with a model', async () => {
  const onCoordinator = vi.fn()
  const onDisabledChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = async (disabled: boolean) =>
    await act(async () =>
      root.render(
        <RuntimeModelSelect
          runSettings
          value={{ runtime: 'claude', model: 'model-standard', effort: 'medium' }}
          onChange={vi.fn()}
          source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard', 'model-small'] }] }}
          coordinator={{
            value: { runtime: 'claude', model: 'model-small', effort: 'low' },
            onChange: onCoordinator,
            disabled,
            onDisabledChange
          }}
        />
      )
    )
  await render(false)
  const trigger = container.querySelector('button')!
  await act(async () => trigger.click())
  let dialog = document.querySelector('[role="dialog"]')!
  const tab = (name: string) =>
    [...dialog.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === name)!
  const disable = () =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Disable coordinator')
  // The task tab offers no such row.
  expect(disable()).toBeUndefined()
  await act(async () => tab('Coordinator').click())
  expect(disable()!.getAttribute('aria-pressed')).toBe('false')
  await act(async () => disable()!.click())
  expect(onDisabledChange).toHaveBeenLastCalledWith(true)

  await render(true)
  expect(trigger.textContent).toContain('+ coordinator off')
  await act(async () => trigger.click())
  dialog = document.querySelector('[role="dialog"]')!
  await act(async () => tab('Coordinator').click())
  expect(disable()!.getAttribute('aria-pressed')).toBe('true')
  expect(dialog.querySelector('button[aria-label$="· model-small"]')!.getAttribute('aria-pressed')).toBe('false')
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label$="· model-small"]')!.click())
  expect(onDisabledChange).toHaveBeenLastCalledWith(false)
  expect(onCoordinator).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: 'claude', model: 'model-small' }))
})

// auto-session-mode.md §4.7: the Coordinator tab lists the filter's providers under FILTER, with their models and No filter.
it('picks and removes the coordinator filter from its own group, hidden while the coordinator is off', async () => {
  const onFilter = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = async (filter: { providerId: string; model: string } | null, disabled = false) =>
    await act(async () =>
      root.render(
        <RuntimeModelSelect
          runSettings
          value={{ runtime: 'claude', model: 'model-standard', effort: 'medium' }}
          onChange={vi.fn()}
          source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard', 'model-small'] }] }}
          coordinator={{
            value: { runtime: 'claude', model: 'model-small', effort: 'low' },
            onChange: vi.fn(),
            disabled,
            onDisabledChange: vi.fn(),
            filter: {
              value: filter,
              onChange: onFilter,
              providers: [
                {
                  id: 'typesafe',
                  name: 'TypeSafe',
                  readiness: { status: 'ready' },
                  models: [
                    { id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean'] },
                    { id: 'jev-latest', label: 'Jev latest', questionTypes: ['boolean'] }
                  ]
                }
              ]
            }
          }}
        />
      )
    )
  await render(null)
  const trigger = container.querySelector('button')!
  await act(async () => trigger.click())
  const dialog = () => document.querySelector('[role="dialog"]')!
  const buttons = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')]
  const tab = (name: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === name)!
  // The task tab has no filter.
  expect(dialog().textContent).not.toContain('Filter')
  await act(async () => tab('Coordinator').click())
  expect(dialog().textContent).toContain('Filter')
  // Only the provider list scrolls; the filter group sits below it, outside the scroll.
  const list = dialog().querySelector('[data-testid="provider-list"]')!
  const section = dialog().querySelector('[data-testid="provider-section"]')!
  expect(list.textContent).toContain('Claude Code')
  expect(list.textContent).not.toContain('TypeSafe')
  expect(section.textContent).toContain('TypeSafe')
  const provider = buttons().find((b) => b.textContent === 'TypeSafe2')!
  await act(async () => provider.click())
  // The filter adds to the coordinator model: its runtime stays marked and its settings stay shown.
  expect(list.querySelector('[aria-label="Selected"]')).not.toBeNull()
  expect(section.querySelector('[aria-label="Selected"]')).toBeNull()
  expect(dialog().querySelector('select[aria-label="Effort"]')).not.toBeNull()
  expect(dialog().textContent).toContain('before the coordinator (model-small) reads it')
  expect(
    buttons()
      .find((b) => b.textContent === 'No filter')!
      .getAttribute('aria-pressed')
  ).toBe('true')
  expect(buttons().some((b) => b.textContent === 'Disable coordinator')).toBe(false)
  await act(async () => dialog().querySelector<HTMLButtonElement>('button[aria-label="TypeSafe · Jev 1.13"]')!.click())
  expect(onFilter).toHaveBeenLastCalledWith({ providerId: 'typesafe', model: 'jev-1.13.0' })

  await render({ providerId: 'typesafe', model: 'jev-1.13.0' })
  expect(dialog().querySelector('button[aria-label="TypeSafe · Jev 1.13"]')!.getAttribute('aria-pressed')).toBe('true')
  expect(dialog().querySelector('[data-testid="provider-section"] [aria-label="Selected"]')).not.toBeNull()
  expect(dialog().querySelector('[data-testid="provider-list"] [aria-label="Selected"]')).not.toBeNull()
  expect(trigger.textContent).toContain('+ coordinator model-small · filter Jev 1.13')
  await act(async () =>
    buttons()
      .find((b) => b.textContent === 'No filter')!
      .click()
  )
  expect(onFilter).toHaveBeenLastCalledWith(null)

  await render({ providerId: 'typesafe', model: 'jev-1.13.0' }, true)
  expect(dialog().textContent).not.toContain('Filter')
})

it('shows the coordinator alone on its own field', async () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <RuntimeModelSelect
        value={{ runtime: 'claude', model: 'model-standard' }}
        onChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard', 'model-small'] }] }}
        coordinator={{
          value: { runtime: 'claude', model: 'model-small', effort: 'low' },
          onChange: vi.fn(),
          only: true
        }}
      />
    )
  )
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toContain('model-small')
  expect(trigger.textContent).not.toContain('model-standard')
  await act(async () => trigger.click())
  expect(document.querySelector('[role="dialog"] [role="group"]')).toBeNull()
})
