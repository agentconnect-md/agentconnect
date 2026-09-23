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
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add rule'))!.click()
  )
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
