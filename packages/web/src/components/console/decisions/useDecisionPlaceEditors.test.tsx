// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import { useDecisionPlaceEditors } from './useDecisionPlaceEditors'

const mocks = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  openModal: vi.fn(),
  gates: {
    bindingKey: vi.fn((botId: string | undefined, row: { channelId: string }) => `gate:${botId}:${row.channelId}`),
    saved: vi.fn(() => ({ decisionId: 'd1', when: { type: 'boolean', values: [true] } })),
    edit: vi.fn(() => true),
    strip: vi.fn(() => null)
  }
}))
vi.mock('./channel-gates', () => ({ useChannelGates: () => mocks.gates }))
vi.mock('@/components/console/ModalProvider', () => ({ useOptionalModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    integrations: [{ id: 'int-1', botId: 'bot-1', agentId: 'agent-1', channels: [{ channelId: 'C1', name: 'help' }] }],
    agents: [{ id: 'agent-1', name: 'docs-bot', canEdit: true }]
  })
}))
vi.mock('@/lib/decisions/provider', () => ({
  useDecisionsPrototype: () => ({ orgId: 'example-org', bindingDrafts: mocks.drafts })
}))
vi.mock('./routing/DecisionRoutingModal', async (original) => ({
  ...(await original<object>()),
  DecisionRoutingModal: ({ botId, resume }: { botId: string; resume: boolean }) => (
    <div role="dialog" data-bot={botId} data-resume={String(resume)} />
  )
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
let editors: ReturnType<typeof useDecisionPlaceEditors>

function Harness({ usages, onChanged }: { usages: DecisionUsage[]; onChanged: () => void }) {
  editors = useDecisionPlaceEditors({ usages, onChanged })
  return <>{editors.editors}</>
}

const gate: DecisionUsage = { kind: 'gate', id: 'int-1:C1', label: '#help', integrationId: 'int-1', channelId: 'C1' }
const routing: DecisionUsage = { kind: 'shared_bot_routing', id: 'bot-1', label: 'Support bot' }
const model: DecisionUsage = { kind: 'model_selection', id: 'agent-1', label: 'docs-bot' }
const tool: DecisionUsage = { kind: 'agent_tool', id: 'agent-1', label: 'docs-bot' }

async function render(usages: DecisionUsage[], onChanged = vi.fn()) {
  await act(async () => root.render(<Harness usages={usages} onChanged={onChanged} />))
  return onChanged
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const key of Object.keys(mocks.drafts)) delete mocks.drafts[key]
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

it("opens a gate's rules through its row and renders only that modal", async () => {
  await render([gate])
  expect(editors.editable(gate)).toBe(true)
  await act(async () => editors.edit(gate))
  expect(mocks.gates.edit).toHaveBeenCalledWith('bot-1', expect.objectContaining({ channelId: 'C1' }))
  expect(mocks.gates.strip).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-1', modalOnly: true }))
})

it('re-reads the usages once a gate modal closes', async () => {
  mocks.drafts['gate:bot-1:C1'] = { phase: 'editing' }
  const onChanged = await render([gate])
  expect(onChanged).not.toHaveBeenCalled()
  delete mocks.drafts['gate:bot-1:C1']
  await render([gate], onChanged)
  expect(onChanged).toHaveBeenCalledTimes(1)
})

it("opens Edit agent on the model's runtime section and keeps agent tools as links", async () => {
  const onChanged = await render([model, tool])
  expect(editors.editable(tool)).toBe(false)
  expect(editors.editable(model)).toBe(true)
  await act(async () => editors.edit(model))
  expect(mocks.openModal).toHaveBeenCalledWith('editAgent', expect.objectContaining({ id: 'agent-1' }), {
    focusSection: 'runtime',
    onSaved: onChanged
  })
})

it("opens a bot's rules in place, and reopens them after an inline Create decision named no row", async () => {
  await render([routing])
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => editors.edit(routing))
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('data-resume')).toBe('false')
  await act(async () => root.unmount())

  window.history.replaceState(null, '', '/decisions/d1?decisionRouting=bot-1%7C')
  root = createRoot(container)
  await render([routing])
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('data-resume')).toBe('true')
  expect(window.location.search).toBe('')
})
