// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi, DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider, type DecisionGateUsage } from '@/lib/decisions/provider'
import { DecisionUsedIn } from './DecisionUsedIn'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/decisions/support-category',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'example-org' }, myRole: 'viewer', orgPath: (path: string) => path })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
// The fixtures' evaluations are on 2026-01-01; one older row sits outside the day.
const NOW = Date.parse('2026-01-01T12:00:00.000Z')

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

async function mount(
  usages: (seed: ReturnType<typeof createDecisionMockSeed>) => DecisionUsage[],
  {
    before,
    ...extra
  }: {
    gated?: DecisionGateUsage[]
    hiddenCount?: number
    markFor?: (usage: DecisionUsage) => ReactNode
    agentName?: (id: string) => string | undefined
    canEdit?: (usage: DecisionUsage) => boolean
    onEdit?: (usage: DecisionUsage) => void
    before?: (api: DecisionApi) => void
  } = {}
) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const seed = createDecisionMockSeed()
  const api = decisionMock.createDecisionMockApi({ seed })
  const spies = { gate: vi.spyOn(api, 'listEvaluations'), routing: vi.spyOn(api, 'listRoutingEvaluations') }
  before?.(api)
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionUsedIn
            decisionId={seed.decisions[1]!.id}
            question={seed.decisions[1]!.question}
            usages={usages(seed)}
            usageStatus="ready"
            hrefFor={(usage) => (usage.kind === 'gate' ? `/integrations/${usage.integrationId}` : null)}
            {...extra}
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  return { seed, api, ...spies }
}

const row = (key: string) => container!.querySelector<HTMLElement>(`[data-place="${key}"]`)!
const count = (key: string) => row(key).querySelector('[data-day-count]')!.textContent
const button = (key: string, label: RegExp) =>
  [...row(key).querySelectorAll<HTMLElement>('a, button')].find((node) => label.test(node.getAttribute('aria-label')!))
const hover = async (node: Element) => {
  await act(async () => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
  return document.querySelector('[role="tooltip"]')
}

describe('DecisionUsedIn', () => {
  it("lists each place once with its last day's evaluations, read under the chain's root", async () => {
    const { seed, api, gate, routing } = await mount((seed) => [
      { kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' },
      { kind: 'shared_bot_routing', id: seed.bots[0]!.id, label: 'Support bot', rootDecisionId: seed.decisions[0]!.id }
    ])
    const decisionId = seed.decisions[1]!.id
    expect(gate).toHaveBeenCalledWith({ integrationId: 'int-1', channelId: 'C1' }, { decisionId, limit: 50 })
    expect(routing).toHaveBeenCalledWith(seed.bots[0]!.id, { decisionId: seed.decisions[0]!.id, limit: 50 })
    expect(container!.textContent).toContain('2 places')
    expect(container!.querySelectorAll('[data-place]')).toHaveLength(2)
    // Rows are no longer merged: nothing lists an individual evaluation.
    expect(container!.textContent).not.toContain('Our invoice charged us twice this month.')
    const page = await api.listEvaluations({ integrationId: 'int-1', channelId: 'C1' }, { decisionId, limit: 50 })
    const day = page.items.filter((item) => Date.parse(item.at) >= NOW - 24 * 60 * 60 * 1000).length
    expect(day).toBeLessThan(page.items.length)
    expect(count('gate:gate-1')).toBe(String(day))
  })

  it("opens a place's settings and its history drawer from the row", async () => {
    await mount(() => [{ kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' }])
    expect(button('gate:gate-1', /^Edit/)?.getAttribute('href')).toBe('/integrations/int-1')
    await act(async () => button('gate:gate-1', /^Recent evaluations/)!.click())
    await act(async () => {})
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it("opens a place's own editor where one is offered, and links the rest to their settings", async () => {
    const onEdit = vi.fn()
    const help: DecisionUsage = { kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' }
    await mount(() => [help, { kind: 'gate', id: 'gate-2', label: '#ops', integrationId: 'int-2', channelId: 'C2' }], {
      canEdit: (usage) => usage.id === 'gate-1',
      onEdit
    })
    const edit = button('gate:gate-1', /^Edit/)!
    expect(edit.tagName).toBe('BUTTON')
    await act(async () => edit.click())
    expect(onEdit).toHaveBeenCalledWith(help)
    expect(button('gate:gate-2', /^Edit/)?.getAttribute('href')).toBe('/integrations/int-2')
  })

  it('shows the rule as a chip and every rule with its fallback on hover', async () => {
    const usage: DecisionUsage = {
      kind: 'shared_bot_routing',
      id: 'bot-1',
      label: 'Support bot',
      rules: [
        { when: { type: 'choice', thresholds: { billing: 0.5 } }, then: { type: 'agent', agentId: 'agent-1' } },
        { when: { type: 'choice', thresholds: { bug: 0.6 } }, then: { type: 'agent', agentId: 'agent-9' } }
      ],
      otherwise: { type: 'default_agent' }
    }
    await mount(() => [usage], { agentName: (id) => (id === 'agent-1' ? 'billing-bot' : undefined) })
    const chip = row('shared_bot_routing:bot-1').querySelector('[data-rule-chip]')!
    expect(chip.textContent).toBe('billing ≥ 50%, bug ≥ 60%')
    const card = await hover(chip)
    expect(card?.textContent).toBe(
      '1billing ≥ 50%billing-bot2bug ≥ 60%An agent you cannot see—OtherwiseUse default agent'
    )
  })

  it('keeps a place without history, a local gate that needs review, and the places the viewer cannot see', async () => {
    await mount(() => [{ kind: 'agent_tool', id: 'agent-9', label: 'Triage agent' }], {
      gated: [{ channelId: 'C7', channelName: '#ops', needsReview: true, when: { type: 'boolean', values: [true] } }],
      hiddenCount: 2
    })
    expect(container!.textContent).toContain('4 places')
    expect(container!.textContent).toContain('2 more you cannot see')
    expect(button('agent_tool:agent-9', /^Recent evaluations/)).toBeUndefined()
    expect(count('agent_tool:agent-9')).toBe('—')
    const ops = row('gate-local:C7')
    expect(ops.querySelector('svg.lucide-triangle-alert')).not.toBeNull()
    const card = await hover(ops.querySelector('[data-rule-chip]')!)
    expect(card?.textContent).toBe('StatusNeeds review1YesTrigger—OtherwiseSkip')
  })

  it('reads a place the viewer cannot see as hidden, not failed, and shows each place by its mark', async () => {
    await mount(() => [{ kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' }], {
      markFor: (usage) => <span data-mark={usage.kind} />,
      // The CP answers 404 for a conversation whose audience refuses the caller.
      before: (api) =>
        vi
          .spyOn(api, 'listEvaluations')
          .mockRejectedValue(
            new decisionMock.DecisionMockApiError(404, { error: 'not_found', message: 'conversation not found' })
          )
    })
    expect(container!.querySelector('[role="alert"]')).toBeNull()
    expect(row('gate:gate-1').querySelector('[data-mark="gate"]')).not.toBeNull()
    expect(count('gate:gate-1')).toBe('—')
    expect(button('gate:gate-1', /^Recent evaluations/)).toBeUndefined()
  })

  // An agent's chat API gate records its calls; the Decision page reads them like a gate's (shared-bot-relay.md §10.4).
  it("reads an API gate's evaluations under its agent, and a 403 as a place the viewer cannot see", async () => {
    const apiGate: DecisionUsage = {
      kind: 'api_gate',
      id: 'agent-1',
      label: 'docs-bot',
      rootDecisionId: 'support-category',
      protocol: 'ai-sdk-ui'
    }
    const { gate } = await mount(() => [apiGate])
    expect(gate).toHaveBeenCalledWith(
      { integrationId: 'api:agent-1:ai-sdk-ui', channelId: 'api:agent-1:ai-sdk-ui' },
      expect.objectContaining({ decisionId: 'support-category' })
    )
    expect(count('api_gate:agent-1:ai-sdk-ui')).toMatch(/^\d+\+?$/)
    await act(async () => root?.unmount())
    root = undefined
    container?.remove()

    await mount(() => [apiGate], {
      before: (api) =>
        vi
          .spyOn(api, 'listEvaluations')
          .mockRejectedValue(
            new decisionMock.DecisionMockApiError(403, { error: 'unavailable', message: 'cannot edit this agent' })
          )
    })
    expect(container!.querySelector('[role="alert"]')).toBeNull()
    expect(count('api_gate:agent-1:ai-sdk-ui')).toBe('—')
  })

  it('names a place that failed and retries it', async () => {
    await mount(() => [{ kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' }], {
      before: (api) => vi.spyOn(api, 'listEvaluations').mockRejectedValueOnce(new Error('offline'))
    })
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('1 place could not be loaded.')
    await act(async () =>
      [...container!.querySelectorAll('button')].find((node) => node.textContent === 'Retry')!.click()
    )
    await act(async () => {})
    expect(container!.querySelector('[role="alert"]')).toBeNull()
    expect(count('gate:gate-1')).toMatch(/^\d+$/)
  })

  it('says a Decision is not used anywhere', async () => {
    await mount(() => [])
    expect(container!.textContent).toContain('Not used anywhere yet.')
    expect(container!.querySelectorAll('[data-place]')).toHaveLength(0)
  })
})
