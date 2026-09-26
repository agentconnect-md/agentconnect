// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import type { DecisionModelEvaluationRecord } from '@agentconnect.md/protocol/decision'

const api = vi.hoisted(() => ({ fetchAgentModelEvaluations: vi.fn(), fetchAgentModelEvaluation: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<object>()), ...api }))
import { ModelSelectionEvaluations } from './ModelSelectionEvaluations'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

const record: DecisionModelEvaluationRecord = {
  seq: 7,
  at: '2026-09-26T10:00:00.000Z',
  sessionId: '11111111-1111-4111-8111-111111111111',
  decisionId: '22222222-2222-4222-8222-222222222222',
  outcome: 'selected',
  reason: null,
  target: { runtime: 'claude', model: 'model-large' },
  answer: { type: 'boolean', value: true, probability: 0.9 },
  requestedModel: 'model-small',
  actualModel: 'model-small',
  latencyMs: 120,
  usage: null,
  detailsExpired: true
}

async function render(live: boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ModelSelectionEvaluations agentId="agent-1" orgId="example-org" live={live} />
      </SWRConfig>
    )
  )
  await act(async () => {})
}

it('shows the empty state without a request when the editor is not live', async () => {
  await render(false)
  expect(api.fetchAgentModelEvaluations).not.toHaveBeenCalled()
  expect(container.querySelector('summary')?.textContent).toContain('none yet')
  expect(container.textContent).toContain('No evaluations yet.')
})

it('lists recent selections and opens one in place', async () => {
  api.fetchAgentModelEvaluations.mockResolvedValue({ items: [record], nextCursor: null })
  api.fetchAgentModelEvaluation.mockRejectedValue(new Error('gone'))
  await render(true)
  expect(api.fetchAgentModelEvaluations).toHaveBeenCalledWith('agent-1', { limit: 20 }, 'example-org')
  expect(container.querySelector('summary')?.textContent).not.toContain('none yet')
  const row = container.querySelector<HTMLButtonElement>('li button')!
  expect(row.textContent).toContain('claude · model-large')
  await act(async () => row.click())
  await act(async () => {})
  expect(api.fetchAgentModelEvaluation).toHaveBeenCalledWith('agent-1', 7, 'example-org')
  expect(container.textContent).toContain('Details expired')
  expect(container.querySelector('li')).toBeNull()
})
