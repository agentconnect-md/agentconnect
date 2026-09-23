// @vitest-environment happy-dom

// Routing Try renders each §9.3 row from the draft: rule matches, Otherwise, mentions, threads, Not applied, failures.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { draftFromDetail, type RoutingDraft } from '@/lib/decisions/routing-draft'
import type { RoutingRoster } from '@/lib/decisions/routing-roster'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/integrations/bots/support-bot/routing',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import { DecisionRoutingTry } from './DecisionRoutingTry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

const seed = createDecisionMockSeed()
const decision = seed.decisions[0]!
const saved = draftFromDetail({ config: seed.routings[0]!.config, channelIds: ['help-channel'] })
const roster: RoutingRoster = {
  loading: false,
  error: null,
  bot: { id: 'support-bot', name: 'Support bot', platform: null, shared: true },
  agents: seed.bots[0]!.agents.map((agent) => ({ ...agent, runtime: '' })),
  channels: [
    {
      channelId: 'help-channel',
      name: '#help',
      kind: 'channel',
      trigger: 'decision',
      binding: 'shared_bot_routing',
      defaultAgentId: 'billing-agent'
    },
    {
      channelId: 'off-channel',
      name: '#announcements',
      kind: 'channel',
      trigger: 'off',
      binding: null,
      defaultAgentId: 'billing-agent'
    }
  ],
  refresh: () => {}
}

async function render(api: DecisionApi, draft: RoutingDraft = saved, question = decision) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const node = (next: RoutingDraft) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DecisionsPrototypeProvider>
        <DecisionRoutingTry botId="support-bot" draft={next} decision={question} roster={roster} open />
      </DecisionsPrototypeProvider>
    </SWRConfig>
  )
  await act(async () => root?.render(node(draft)))
  return { view: container, rerender: async (next: RoutingDraft) => act(async () => root?.render(node(next))) }
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  for (let i = 0; i < 3; i += 1) await act(async () => {})
}
async function type(field: HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('no field')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('no select')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const labelled = (view: ParentNode, text: string) =>
  [...view.querySelectorAll('label')].find((label) => label.textContent?.trim() === text)?.querySelector('input') ??
  null
const result = (view: ParentNode) => view.querySelector('[data-testid="routing-try-result"]')?.textContent ?? ''
async function runWith(view: HTMLElement, text = 'My billing API failed') {
  await type(view.querySelector('textarea[aria-label="Current message"]'), text)
  await click(button(view, 'Run'))
}

describe('DecisionRoutingTry', () => {
  it('shows every rule result, all matched rules, and the deduplicated effective targets', async () => {
    const api = decisionMock.createDecisionMockApi()
    const preview = vi.spyOn(api, 'previewRouting')
    const { view } = await render(api)
    await runWith(view)
    expect(preview).toHaveBeenCalledWith(
      'support-bot',
      expect.objectContaining({ channelId: 'help-channel', targets: { type: 'new' } })
    )
    const text = result(view)
    expect(text).toContain('Would activate')
    expect(text).toContain('Rule 1 matched')
    expect(text).toContain('Rule 2 matched')
    expect(text).toContain('Rule 3 did not match')
    expect(text).toContain('billing ≥ 30%')
    expect(text).toContain('Matched rules1, 2')
    expect(text).toContain('Billing')
    expect(text).toContain('Technical')
  })

  it('numbers unsorted Score rules by lower bound, as the editor does', async () => {
    const frustration = seed.decisions.find((entry) => entry.id === 'frustration')!
    const draft: RoutingDraft = {
      ...saved,
      decisionId: 'frustration',
      rules: [
        { id: 'high', when: { type: 'score', min: 1.5, max: 3 }, action: { type: 'agent', agentId: 'sales-agent' } },
        { id: 'low', when: { type: 'score', min: 0, max: 1 }, action: { type: 'skip' } }
      ]
    }
    const { view } = await render(decisionMock.createDecisionMockApi(), draft, frustration)
    await runWith(view)
    const text = result(view)
    expect(text).toContain('Rule 1 did not match')
    expect(text).toContain('Rule 2 matched')
    expect(text).toContain('Matched rules2')
  })

  it('uses Otherwise when no rule matches, naming the resolved default or Would not activate', async () => {
    const draft = { ...saved, rules: saved.rules.slice(2), otherwise: 'default_agent' as const }
    const { view, rerender } = await render(decisionMock.createDecisionMockApi(), draft)
    await runWith(view)
    expect(result(view)).toContain('No rule matched; Otherwise applies.')
    expect(result(view)).toContain('Default agent')
    await rerender({ ...draft, otherwise: 'skip' })
    expect(view.textContent).toContain('The draft or sample changed since this run.')
    await click(button(view, 'Run'))
    expect(result(view)).toContain('Would not activate')
  })

  it('keeps an explicit mention on its recipient and settles an all-participant thread with no evaluation', async () => {
    const { view } = await render(decisionMock.createDecisionMockApi())
    await click(labelled(view, 'Explicit mention'))
    await click(labelled(view, 'Sales'))
    await runWith(view)
    expect(result(view)).toContain('Would continue')
    expect(result(view)).toContain('Sales')
    expect(result(view)).toContain('the recipients are kept')
    await click(labelled(view, 'Established thread'))
    await click(view.querySelector('input[aria-label="Already participating: Sales"]'))
    await click(button(view, 'Run'))
    expect(result(view)).toContain('no evaluation runs')
  })

  it('says Not applied for an Off channel with no evaluation', async () => {
    const { view } = await render(decisionMock.createDecisionMockApi())
    await choose(view.querySelector('select'), 'off-channel')
    await runWith(view)
    expect(result(view)).toContain('Not applied')
    expect(result(view)).toContain('This channel is Off')
  })

  it('names the continuation on a provider failure, never a skip', async () => {
    const { view } = await render(decisionMock.createDecisionMockApi({ scenario: 'provider_unavailable' }))
    await runWith(view)
    expect(result(view)).toContain('Evaluation unavailable')
    expect(result(view)).toContain('continues to the default agent')
    expect(result(view)).not.toContain('Would skip')
  })

  it('reports a selected target that is unavailable or removed without a substitute', async () => {
    const seedWithOutage = createDecisionMockSeed()
    seedWithOutage.bots[0]!.agents[1]!.available = false
    const draft = {
      ...saved,
      rules: [saved.rules[0]!, { ...saved.rules[1]!, action: { type: 'agent' as const, agentId: 'gone-agent' } }]
    }
    const { view } = await render(decisionMock.createDecisionMockApi({ seed: seedWithOutage }), draft)
    await runWith(view)
    expect(result(view)).toContain('Target removed')
    expect(result(view)).toContain('No other agent is chosen instead.')
  })

  it('says the evaluation host is offline instead of showing a result', async () => {
    const { view } = await render(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    await runWith(view)
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('The evaluation host is offline')
    expect(view.querySelector('[data-testid="routing-try-result"]')).toBeNull()
  })
})
