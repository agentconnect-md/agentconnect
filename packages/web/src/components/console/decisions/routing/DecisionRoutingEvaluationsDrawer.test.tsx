// @vitest-environment happy-dom

// Routing Recent evaluations drawer: one row per outcome, per-target admissions, Load more, the detail with model result, and 503 states.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { ApiError } from '@/lib/api'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/integrations/bots/support-bot/routing',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'viewer', orgPath: (path: string) => path })
}))

import { DecisionRoutingEvaluationsDrawer } from './DecisionRoutingEvaluationsDrawer'

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

const names = new Map([
  ['billing-agent', 'Billing'],
  ['technical-agent', 'Technical']
])

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}
async function render(api: DecisionApi, onClose: () => void = () => {}) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionRoutingEvaluationsDrawer
            botId="support-bot"
            botName="Support bot"
            onClose={onClose}
            channels={[{ channelId: 'help-channel', name: '#help' }]}
            agentNames={names}
            ruleNumbers={
              new Map([
                ['billing', 1],
                ['technical', 2],
                ['sales', 3]
              ])
            }
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await settle()
  return drawer()
}
const drawer = () => document.body.querySelector<HTMLElement>('[data-testid="routing-evaluations"]')!
const detail = () => document.body.querySelector<HTMLElement>('[data-testid="routing-evaluation-detail"]')
const rows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>('li button')]
async function escape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  await settle()
}
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe('DecisionRoutingEvaluationsDrawer', () => {
  it('lists each routing outcome with channel, matched rules, targets, and latency', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    const list = rows(view)
    expect(list).toHaveLength(8)
    expect(list.map((row) => row.querySelector('.badge')?.textContent)).toEqual([
      'Pending',
      'Routed',
      'Partially routed',
      'Skipped',
      'Fallback · Timed out',
      'Unavailable · Provider error',
      'Canceled · Stopped',
      'Routed'
    ])
    expect(list[1]!.textContent).toContain('#help')
    expect(list[1]!.textContent).toContain('Rules 1, 2 (billing, technical)')
    expect(list[1]!.textContent).toContain('Billing ✓, Technical ✓')
    expect(list[2]!.textContent).toContain('Technical ✕')
    expect(list[3]!.textContent).toContain('Otherwise')
    expect(list[1]!.textContent).toContain('710 ms')
  })

  it('opens the detail with snapshots, constraint, per-target admission and model result, and says Details expired', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    expect(view.textContent).toContain('Support bot · shared bot routing')
    await click(rows(view)[2])
    const sheet = detail()!
    expect(sheet.textContent).toContain('Admitted')
    expect(sheet.textContent).toContain('Unavailable')
    expect(sheet.textContent).toContain('Routing at evaluation')
    expect(sheet.textContent).toContain('The export fails and I was charged for it.')
    expect(sheet.textContent).toContain('None: a new, unaddressed conversation')
    const bars = [...sheet.querySelectorAll('[data-testid="model-result"] li')]
    expect(bars[0]!.textContent).toContain('✓ triggers')
    expect(bars[0]!.textContent).toContain('Rule 1 → Billing')
    expect(bars.map((bar) => bar.querySelectorAll('[title^="≥"]').length)).toEqual([1, 1, 1])
    expect(bars[2]!.textContent).toContain('≥ 70%')
    expect(bars[1]!.textContent).toContain('Rule 2 → Technical')
    expect(bars[2]!.textContent).not.toContain('✓ triggers')
    expect(sheet.querySelector('[data-testid="model-result"] details pre')?.textContent).toContain('"type": "choice"')
    await escape()
    expect(detail()).toBeNull()
    expect(document.activeElement).toBe(rows(view)[2])
    await click(rows(view)[7])
    const expired = detail()!
    expect(expired.textContent).toContain('Details expired')
    expect(expired.textContent).not.toContain('Evaluated message')
  })

  it('numbers frozen Score rules by lower bound, the same order the summary uses', async () => {
    const api = decisionMock.createDecisionMockApi()
    const original = api.getRoutingEvaluation.bind(api)
    vi.spyOn(api, 'getRoutingEvaluation').mockImplementation(async (...args) => {
      const detail = await original(...args)
      if (!detail.snapshot) return detail
      const question = {
        type: 'score' as const,
        instructions: 'How urgent?',
        criteria: ['calm', 'uneasy', 'upset', 'angry']
      }
      const rules = [
        {
          id: 'high',
          when: { type: 'score' as const, min: 2, max: 3 },
          action: { type: 'agent' as const, agentId: 'technical-agent' }
        },
        {
          id: 'low',
          when: { type: 'score' as const, min: 0, max: 2 },
          action: { type: 'agent' as const, agentId: 'billing-agent' }
        }
      ]
      return { ...detail, snapshot: { ...detail.snapshot, question, routing: { ...detail.snapshot.routing, rules } } }
    })
    const view = await render(api)
    await click(rows(view)[2])
    const frozen = [...detail()!.querySelectorAll('ol li')].map((row) => row.textContent)
    expect(frozen[0]).toMatch(/^1.*Billing$/)
    expect(frozen[1]).toMatch(/^2.*Technical$/)
  })

  it('keeps Load more while the cursor continues, even after an audience-filtered empty page', async () => {
    const api = decisionMock.createDecisionMockApi()
    const all = await api.listRoutingEvaluations('support-bot')
    const list = vi
      .spyOn(api, 'listRoutingEvaluations')
      .mockResolvedValueOnce({ items: all.items.slice(0, 2), nextCursor: 207 })
      .mockResolvedValueOnce({ items: [], nextCursor: 205 })
      .mockResolvedValueOnce({ items: all.items.slice(3, 5), nextCursor: null })
    const view = await render(api)
    expect(rows(view)).toHaveLength(2)
    const more = () => [...view.querySelectorAll('button')].find((node) => node.textContent === 'Load more')
    await click(more())
    expect(rows(view)).toHaveLength(2)
    await click(more())
    expect(rows(view)).toHaveLength(4)
    expect(more()).toBeUndefined()
    expect(list.mock.calls.map((call) => call[1])).toEqual([
      { limit: 20 },
      { cursor: 207, limit: 20 },
      { cursor: 205, limit: 20 }
    ])
  })

  it('reads a 503 as an offline host or an upgrade prompt', async () => {
    const offline = await render(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    expect(offline.textContent).toContain('The evaluation host is offline')
    if (root) await act(async () => root?.unmount())
    container?.remove()
    const api = decisionMock.createDecisionMockApi()
    vi.spyOn(api, 'listRoutingEvaluations').mockRejectedValue(new ApiError('upgrade', 503, 'DAEMON_UPGRADE_REQUIRED'))
    const upgrade = await render(api)
    expect(upgrade.textContent).toContain('Upgrade the evaluation host daemon')
  })
})
