// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider, type DecisionGateUsage } from '@/lib/decisions/provider'
import { DecisionRecentEvaluations } from './DecisionRecentEvaluations'

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

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

async function mount(
  usages: (seed: ReturnType<typeof createDecisionMockSeed>) => DecisionUsage[],
  extra: { gated?: DecisionGateUsage[]; hiddenCount?: number } = {}
) {
  const seed = createDecisionMockSeed()
  const api = decisionMock.createDecisionMockApi({ seed })
  const spies = { gate: vi.spyOn(api, 'listEvaluations'), routing: vi.spyOn(api, 'listRoutingEvaluations') }
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionRecentEvaluations
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
  return { seed, ...spies }
}

const tabs = () => [...container!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const rows = () => [...container!.querySelectorAll<HTMLButtonElement>('li > button')]

describe('DecisionRecentEvaluations', () => {
  it('reads every recorded place for All and merges their rows newest first, each titled with its source', async () => {
    const { seed, gate, routing } = await mount((seed) => [
      { kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' },
      { kind: 'shared_bot_routing', id: seed.bots[0]!.id, label: 'Support bot', rootDecisionId: seed.decisions[0]!.id }
    ])
    const decisionId = seed.decisions[1]!.id
    expect(gate).toHaveBeenCalledWith({ integrationId: 'int-1', channelId: 'C1' }, { decisionId, limit: 10 })
    // A place that records a chain reads it by the chain's root.
    expect(routing).toHaveBeenCalledWith(seed.bots[0]!.id, { decisionId: seed.decisions[0]!.id, limit: 10 })
    expect(container!.textContent).toContain('used in 2 places')
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    const all = rows()
    expect(all.length).toBeGreaterThan(0)
    const times = all.map((row) => row.getAttribute('data-at'))
    expect(times).toEqual([...times].sort().reverse())
    expect(all.some((row) => row.textContent?.includes('Our invoice charged us twice this month.'))).toBe(true)
    // A routing row names its channel by the bot's routing, not by the raw id.
    const routed = all.find((row) => row.textContent?.includes('Support bot'))!
    expect(routed.textContent).toContain('#help')
    expect(routed.textContent).not.toContain('help-channel')
    // Outcomes are worded per history: routing rows use the router's words, gate rows the gate's.
    expect(all.map((row) => row.textContent).join(' ')).toMatch(/Routed|Partially routed|Fallback/)
    expect(all.map((row) => row.textContent).join(' ')).toMatch(/Triggered|Skipped/)
  })

  it('narrows to one place with its chain note, settings link, and panel', async () => {
    await mount((seed) => [
      {
        kind: 'gate',
        id: 'gate-1',
        label: '#help',
        integrationId: 'int-1',
        channelId: 'C1',
        rootDecisionId: seed.decisions[0]!.id
      },
      { kind: 'shared_bot_routing', id: seed.bots[0]!.id, label: 'Support bot' }
    ])
    expect(container!.textContent).not.toContain('Open panel')
    const help = tabs().find((tab) => tab.textContent?.includes('#help'))!
    expect(help.title).toBe('#help\nchannel gate')
    await act(async () => help.click())
    expect(help.getAttribute('aria-selected')).toBe('true')
    expect(container!.textContent).toContain('This source records the Decision chain from its first step.')
    expect(container!.querySelector('a')?.getAttribute('href')).toBe('/integrations/int-1')
    expect(rows().every((row) => row.textContent?.includes('#help'))).toBe(true)
    expect(rows().some((row) => row.textContent?.includes('Support bot'))).toBe(false)
    const panel = [...container!.querySelectorAll('button')].find((node) => node.textContent === 'Open panel')!
    await act(async () => panel.click())
    await act(async () => {})
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('keeps a place that records nothing, a local gate that needs review, and the places the viewer cannot see', async () => {
    await mount(() => [{ kind: 'agent_tool', id: 'agent-9', label: 'Triage agent' }], {
      gated: [{ channelId: 'C7', channelName: '#ops', needsReview: true, when: { type: 'boolean', values: [true] } }],
      hiddenCount: 2
    })
    expect(container!.textContent).toContain('used in 4 places')
    expect(container!.textContent).toContain('No current source records evaluations for this Decision.')
    expect(container!.textContent).toContain('2 more you cannot see')
    const ops = tabs().find((tab) => tab.textContent?.includes('#ops'))!
    expect(ops.title).toBe('#ops\nchannel gate · needs review')
    const tool = tabs().find((tab) => tab.textContent?.includes('Triage agent'))!
    await act(async () => tool.click())
    expect(container!.textContent).toContain('This place does not record evaluations.')
  })

  it('says a Decision is not used anywhere', async () => {
    await mount(() => [])
    expect(container!.textContent).toContain('Not used anywhere yet.')
    expect(tabs()).toEqual([])
  })
})
