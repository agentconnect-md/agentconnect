// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAgentModelEvaluations: vi.fn(), fetchAgentModelEvaluation: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<object>()), ...api }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'example-org' } }) }))
import { SessionModelSelectionResult } from './SessionModelSelectionResult'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
const record = {
  seq: 7,
  at: '2026-10-08T10:00:00.000Z',
  sessionId: 'session-1',
  title: 'Inspect this image',
  decisionId: 'deleted-decision',
  outcome: 'selected',
  reason: null,
  target: { runtime: 'codex-acp', model: 'gpt-5.6-sol', effort: 'medium' },
  answer: { type: 'boolean', value: false, probability: 0 },
  requestedModel: 'gpt-6-luna',
  actualModel: 'gpt-6-luna',
  latencyMs: 420,
  usage: null,
  detailsExpired: false
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.resetAllMocks()
})
async function render(sessionId = 'session-1', live = true) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionModelSelectionResult target={{ agentId: 'agent-1', agentName: 'Agent', live }} sessionId={sessionId} />
      </SWRConfig>
    )
  )
  await act(async () => {})
}
it('opens the session frozen request without a current Decision or agent binding', async () => {
  api.fetchAgentModelEvaluations.mockResolvedValue({ items: [record], nextCursor: null })
  api.fetchAgentModelEvaluation.mockResolvedValue({
    ...record,
    selection: null,
    question: { type: 'boolean', instructions: 'Is the image red?', criteria: { true: 'Red', false: 'Not red' } },
    input: { currentMessage: { text: 'Inspect this image' } },
    fullAnswer: record.answer,
    chain: [],
    rawRequest: { text: '{"model":"gpt-6-luna","input_image":"[image bytes omitted]"}', truncated: false },
    rawResponse: { text: '{"value":false}', truncated: false }
  })
  await render()
  expect(api.fetchAgentModelEvaluations).toHaveBeenCalledWith(
    'agent-1',
    { sessionId: 'session-1', limit: 1 },
    'example-org'
  )
  expect(container.textContent).toContain('Session model selection')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => {})
  expect(api.fetchAgentModelEvaluation).toHaveBeenCalledWith('agent-1', 7, 'example-org')
  expect(api.fetchAgentModelEvaluations).toHaveBeenCalledWith(
    'agent-1',
    { sessionId: 'session-1', limit: 20 },
    'example-org'
  )
  expect(document.body.textContent).toContain('Is the image red?')
  expect(document.body.textContent).toContain('Raw request')
  expect(document.body.textContent).toContain('[image bytes omitted]')
  expect(document.body.textContent).toContain('gpt-6-luna')
})
it('never shows another session selection', async () => {
  api.fetchAgentModelEvaluations.mockResolvedValue({
    items: [{ ...record, sessionId: 'other-session' }],
    nextCursor: null
  })
  await render()
  expect(container.textContent).toBe('')
})
it('does not query a synthetic playground session before its real id arrives', async () => {
  await render('pg_pending')
  expect(api.fetchAgentModelEvaluations).not.toHaveBeenCalled()
})
it('does not query demo sessions', async () => {
  await render('session-1', false)
  expect(api.fetchAgentModelEvaluations).not.toHaveBeenCalled()
})
