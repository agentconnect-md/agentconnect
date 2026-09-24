// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentModelSelection } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/decisions/provider', () => ({
  useOptionalDecisionsPrototype: () => ({
    api: { mode: 'mock' },
    orgId: 'example-org',
    loading: false,
    error: null,
    decisions: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Complexity',
        question: { type: 'score', instructions: 'Rate complexity.', criteria: ['Simple', 'Moderate', 'Complex'] }
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Task type',
        question: {
          type: 'choice',
          instructions: 'Classify this task.',
          criteria: { deploy: 'Deployment', infrastructure_maintenance: 'Infrastructure maintenance' }
        }
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Urgent',
        question: {
          type: 'boolean',
          instructions: 'Is this urgent?',
          criteria: { true: 'It needs action now', false: 'It can wait' }
        }
      }
    ]
  })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
import { ModelSelectionField } from './ModelSelectionField'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('adds a child Decision, edits its rules, and returns to the root without losing the chain', async () => {
  const fallback = { runtime: 'claude', model: 'model-standard' }
  let saved: AgentModelSelection | null = {
    decisionId: '33333333-3333-4333-8333-333333333333',
    rules: [{ when: { type: 'score', min: 0, max: 2 }, ...fallback }]
  }
  function Form() {
    const [value, setValue] = useState(saved)
    return (
      <ModelSelectionField
        value={value}
        onChange={(next) => {
          saved = next
          setValue(next)
        }}
        onValidityChange={() => {}}
        fallback={fallback}
        onFallbackChange={() => {}}
        runtimes={['claude']}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Form />))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label$="Continue with a Decision"]')!.click())
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === 'Urgent')!
      .click()
  )
  expect(saved!.steps).toHaveLength(1)
  expect(saved!.rules[0]).toMatchObject({ nextStepId: saved!.steps![0]!.id })
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Urgent')
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('nav button')]
      .find((button) => button.textContent === 'Complexity')!
      .click()
  )
  expect(container.textContent).toContain('Urgent')
  expect(saved!.steps![0]!.rules[0]!.when.type).toBe('boolean')
})

it('creates a binding, flags overlapping intervals, removes rules, and returns to the fixed model', async () => {
  const validity = vi.fn()
  function Form() {
    const [value, setValue] = useState<AgentModelSelection | null>(null)
    return (
      <ModelSelectionField
        value={value}
        onChange={setValue}
        onValidityChange={validity}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Form />))
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'By decision')!.click()
  )
  expect(validity).toHaveBeenLastCalledWith(true)
  expect(container.textContent).toContain('0 ≤ score ≤ 2')
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add rule"]')!.click())
  expect(validity).toHaveBeenLastCalledWith(false)
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove rule 2"]')!.click())
  expect(validity).toHaveBeenLastCalledWith(true)
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Fixed')!.click()
  )
  expect(container.textContent).not.toContain('0 ≤ score ≤ 2')
  expect(validity).toHaveBeenLastCalledWith(true)
})

it('selects a complete answer in the themed menu while preserving its probability', async () => {
  const onChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={{
          decisionId: '44444444-4444-4444-8444-444444444444',
          rules: [{ when: { type: 'choice', thresholds: { deploy: 0.6 } }, runtime: 'claude', model: 'model-standard' }]
        }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  )
  expect(container.querySelector('select')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer for rule 1"]')!.click())
  const answer = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (button) => button.textContent === 'infrastructure_maintenance'
  )!
  await act(async () => answer.click())
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      rules: [
        {
          when: { type: 'choice', thresholds: { infrastructure_maintenance: 0.6 } },
          runtime: 'claude',
          model: 'model-standard'
        }
      ]
    })
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('changes a rule without changing sibling or fallback run settings', async () => {
  const onChange = vi.fn()
  const onFallbackChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={{
          decisionId: '44444444-4444-4444-8444-444444444444',
          rules: [
            {
              when: { type: 'choice', thresholds: { deploy: 0.6 } },
              runtime: 'claude',
              model: 'model-standard',
              effort: 'high',
              permissionMode: 'plan',
              fastMode: false
            },
            {
              when: { type: 'choice', thresholds: { infrastructure_maintenance: 0.6 } },
              runtime: 'claude',
              model: 'model-standard',
              effort: 'low',
              permissionMode: 'default',
              fastMode: false
            }
          ]
        }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{
          runtime: 'claude',
          model: 'model-standard',
          effort: 'medium',
          permissionMode: 'default',
          fastMode: false
        }}
        onFallbackChange={onFallbackChange}
      />
    )
  )
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Provider and model for rule 1"]')!.click()
  )
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(onChange.mock.calls[0]![0].rules).toEqual([
    {
      when: { type: 'choice', thresholds: { deploy: 0.6 } },
      runtime: 'claude',
      model: 'model-standard',
      effort: 'high',
      permissionMode: 'plan',
      fastMode: true
    },
    {
      when: { type: 'choice', thresholds: { infrastructure_maintenance: 0.6 } },
      runtime: 'claude',
      model: 'model-standard',
      effort: 'low',
      permissionMode: 'default',
      fastMode: false
    }
  ])
  expect(onFallbackChange).not.toHaveBeenCalled()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Provider and model for rule 1"]')!.click()
  )
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Provider and model"]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(onFallbackChange).toHaveBeenCalledWith({
    runtime: 'claude',
    model: 'model-standard',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: true
  })
  expect(onChange).toHaveBeenCalledOnce()
})

it('edits the agent run settings from the fixed picker', async () => {
  const onFallbackChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={null}
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard', effort: 'medium', permissionMode: 'default' }}
        onFallbackChange={onFallbackChange}
      />
    )
  )
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Provider and model"]')!.click())
  const approval = document.querySelector<HTMLSelectElement>('select[aria-label="Approval"]')!
  const other = [...approval.options].find((option) => option.value !== 'default')!.value
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(approval, other)
    approval.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(onFallbackChange).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: 'claude', model: 'model-standard', effort: 'medium' })
  )
  expect(onFallbackChange.mock.calls[0]![0].permissionMode).not.toBe('default')
})

it('reorders choice rules from the keyboard on the drag handle', async () => {
  const onChange = vi.fn()
  const deploy = { when: { type: 'choice', thresholds: { deploy: 0.6 } }, runtime: 'claude', model: 'model-standard' }
  const maintenance = {
    when: { type: 'choice', thresholds: { infrastructure_maintenance: 0.4 } },
    runtime: 'claude',
    model: 'model-standard'
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={{ decisionId: '44444444-4444-4444-8444-444444444444', rules: [deploy, maintenance] as never }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  )
  const handle = container.querySelector<HTMLButtonElement>('button[aria-label^="Reorder rule 1"]')!
  expect(handle.getAttribute('draggable')).toBe('true')
  await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rules: [maintenance, deploy] }))
})

it('lists Yes and No and splits a shared Boolean rule when one answer gets its own model', async () => {
  const onChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={{
          decisionId: '55555555-5555-4555-8555-555555555555',
          rules: [{ when: { type: 'boolean', values: [false, true] }, runtime: 'claude', model: 'model-standard' }]
        }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  )
  expect(container.querySelectorAll('[data-testid="model-rule"]')).toHaveLength(2)
  expect(container.querySelector('button[aria-label="Add rule"]')).toBeNull()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Provider and model when the answer is No"]')!.click()
  )
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click())
  expect(onChange.mock.calls[0]![0].rules).toEqual([
    { when: { type: 'boolean', values: [false] }, runtime: 'claude', model: 'model-standard', fastMode: true },
    { when: { type: 'boolean', values: [true] }, runtime: 'claude', model: 'model-standard' }
  ])
})

it('adds a rule below the table on narrow screens, where the header is hidden', async () => {
  const onChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <ModelSelectionField
        value={{
          decisionId: '44444444-4444-4444-8444-444444444444',
          rules: [{ when: { type: 'choice', thresholds: { deploy: 0.6 } }, runtime: 'claude', model: 'model-standard' }]
        }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  )
  const mobile = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Add rule"]')].find(
    (button) => !button.closest('.hidden')
  )!
  expect(mobile.className).toContain('desktop:hidden')
  await act(async () => mobile.click())
  expect(onChange.mock.calls[0]![0].rules[1].when).toEqual({
    type: 'choice',
    thresholds: { infrastructure_maintenance: 0.5 }
  })
})

it('returns a Boolean answer to the fallback but keeps the last rule', async () => {
  const onChange = vi.fn()
  const render = (rules: AgentModelSelection['rules']) =>
    root!.render(
      <ModelSelectionField
        value={{ decisionId: '55555555-5555-4555-8555-555555555555', rules }}
        onChange={onChange}
        onValidityChange={vi.fn()}
        source={{ runtimeModels: [{ runtime: 'claude', version: '', models: ['model-standard'] }] }}
        runtimes={['claude']}
        fallback={{ runtime: 'claude', model: 'model-standard' }}
        onFallbackChange={vi.fn()}
      />
    )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const yes = { when: { type: 'boolean' as const, values: [true] }, runtime: 'claude', model: 'model-standard' }
  const no = { when: { type: 'boolean' as const, values: [false] }, runtime: 'claude', model: 'model-standard' }
  await act(async () => render([yes, no]))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Use the fallback when the answer is No"]')!.click()
  )
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rules: [yes] }))
  await act(async () => render([yes]))
  expect(container.querySelector('[aria-label="Use the fallback when the answer is No"]')).toBeNull()
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Use the fallback when the answer is Yes"]')!.disabled
  ).toBe(true)
})
