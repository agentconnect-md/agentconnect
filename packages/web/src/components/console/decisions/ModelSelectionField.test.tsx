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
