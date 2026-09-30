// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import type { DecisionModelEvaluationRecord } from '@agentconnect.md/protocol/decision'

const api = vi.hoisted(() => ({ fetchAgentModelEvaluations: vi.fn(), fetchAgentModelEvaluation: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<object>()), ...api }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'example-org' } }) }))
import { ModelSelectionEvaluationsDrawer } from './ModelSelectionEvaluations'

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
  title: 'PR #42: Fix the parser',
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
        <ModelSelectionEvaluationsDrawer target={{ agentId: 'agent-1', agentName: 'Agent', live }} onClose={() => {}} />
      </SWRConfig>
    )
  )
  await act(async () => {})
}

it('shows the empty state without a request when the agent is not live', async () => {
  await render(false)
  expect(api.fetchAgentModelEvaluations).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('No evaluations yet.')
})

it('lists recent selections and opens one in place', async () => {
  api.fetchAgentModelEvaluations.mockResolvedValue({ items: [record], nextCursor: null })
  api.fetchAgentModelEvaluation.mockRejectedValue(new Error('gone'))
  await render(true)
  expect(api.fetchAgentModelEvaluations).toHaveBeenCalledWith('agent-1', { limit: 20 }, 'example-org')
  const row = document.body.querySelector<HTMLButtonElement>('li button')!
  expect(row.textContent).toContain('claude · model-large')
  expect(row.textContent).toContain('PR #42: Fix the parser')
  await act(async () => row.click())
  await act(async () => {})
  expect(api.fetchAgentModelEvaluation).toHaveBeenCalledWith('agent-1', 7, 'example-org')
  expect(document.body.textContent).toContain('Details expired')
  expect(document.body.querySelector('h3')?.textContent).toBe('PR #42: Fix the parser')
  expect(document.body.querySelector('li')).toBeNull()
})

it('shows the frozen instructions of the step selected in the chain', async () => {
  const root = { type: 'boolean' as const, instructions: 'Is it complex?', criteria: { true: 'Yes', false: 'No' } }
  const child = { type: 'boolean' as const, instructions: 'Is it urgent?', criteria: { true: 'Yes', false: 'No' } }
  const answer = { type: 'boolean' as const, value: true, probability: 0.9 }
  const usage = { inputTokens: 1, outputTokens: 1 }
  api.fetchAgentModelEvaluations.mockResolvedValue({ items: [{ ...record, detailsExpired: false }], nextCursor: null })
  api.fetchAgentModelEvaluation.mockResolvedValue({
    ...record,
    detailsExpired: false,
    selection: null,
    question: root,
    input: null,
    fullAnswer: answer,
    chain: [
      {
        stepId: '',
        decisionId: record.decisionId,
        evaluation: { status: 'answered', answer, model: 'model-small', usage }
      },
      { stepId: 'urgent', decisionId: 'child', evaluation: { status: 'answered', answer, model: 'model-child', usage } }
    ],
    steps: [
      { stepId: '', decisionId: record.decisionId, providerId: 'typesafe', model: 'model-small', question: root },
      { stepId: 'urgent', decisionId: 'child', providerId: 'typesafe', model: 'model-child', question: child }
    ],
    rawRequest: null,
    rawResponse: null
  })
  await render(true)
  await act(async () => document.body.querySelector<HTMLButtonElement>('li button')!.click())
  await act(async () => {})
  expect(document.body.textContent).toContain('Is it complex?')
  const steps = [...document.body.querySelectorAll<HTMLButtonElement>('ol[aria-label] button')]
  await act(async () => steps[1]!.click())
  expect(document.body.textContent).toContain('Is it urgent?')
  expect(document.body.textContent).toContain('typesafe / model-child')
  expect(document.body.textContent).not.toContain('Is it complex?')
})
