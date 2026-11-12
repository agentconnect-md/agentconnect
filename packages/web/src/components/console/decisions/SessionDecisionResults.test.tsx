// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodehostTurnFacts } from '@agentconnect.md/protocol/user-turn-body'
import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import * as decisionMock from '@/lib/decisions/mock-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { ApiError } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/sessions/s1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ integrations: [] })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'viewer', orgPath: (path: string) => path })
}))
const filterWire = vi.hoisted(() => ({
  calls: [] as Array<{ agentId: string; page: { cursor?: number; limit?: number }; orgId?: string }>,
  items: [] as DecisionEvaluationRecord[]
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchCoordinatorFilterEvaluations: vi.fn(
      async (agentId: string, page: { cursor?: number; limit?: number } = {}, orgId?: string) => {
        filterWire.calls.push({ agentId, page, orgId })
        return { items: filterWire.items, nextCursor: null }
      }
    )
  }
})

import {
  CodeHostDecisionResult,
  DecisionResultMarker,
  codeHostTurnRouting,
  useSessionDecisionResults
} from './SessionDecisionResults'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  filterWire.calls = []
  filterWire.items = []
  vi.restoreAllMocks()
})

const facts = (patch: Partial<CodehostTurnFacts>): CodehostTurnFacts => ({
  provider: 'github',
  event: 'issues:opened',
  subject: { repo: 'example-org/example-repo', number: 7 },
  ...patch
})
const routing = { repoId: '42', family: 'issues' as const, decisionId: 'd1', verdictSeq: 9 }

describe('codeHostTurnRouting', () => {
  it('addresses the routed turn’s verdict in its repository lane', () => {
    expect(codeHostTurnRouting(facts({ routing }))).toEqual({
      scope: { provider: 'github', repoId: '42', family: 'issues' },
      seq: 9
    })
  })

  it('returns null for an unrouted turn or a family its provider does not route', () => {
    expect(codeHostTurnRouting(facts({}))).toBeNull()
    expect(codeHostTurnRouting(undefined)).toBeNull()
    expect(codeHostTurnRouting(facts({ routing: { ...routing, family: 'merge_request' } }))).toBeNull()
  })
})

describe('CodeHostDecisionResult', () => {
  it('reads its verdict from the view-authorized list, so a viewer denied the detail still sees it', async () => {
    const api = decisionMock.createDecisionMockApi()
    const lane = { integrationId: 'github:42:issues', channelId: 'github:42:issues' }
    const [, second] = (await api.listEvaluations(lane)).items
    const get = vi.spyOn(api, 'getEvaluation').mockRejectedValue(new ApiError('forbidden', 403))
    const list = vi.spyOn(api, 'listEvaluations')
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    const onOpen = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <CodeHostDecisionResult
              facts={facts({ routing: { ...routing, verdictSeq: second!.seq } })}
              onOpen={onOpen}
            />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(list).toHaveBeenCalledWith(lane, { cursor: second!.seq + 1, limit: 1 })
    expect(get).not.toHaveBeenCalled()
    const marker = container.querySelector('button')
    expect(marker?.textContent).toContain('Received a decision result')
    await act(async () => marker!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ seq: second!.seq, repoName: 'example-org/example-repo' })
    )
  })
})

describe('useSessionDecisionResults on a coordinator session', () => {
  const filterRecord: DecisionEvaluationRecord = {
    seq: 7,
    at: '2026-11-12T06:00:00.000Z',
    messageId: 'slack:C1:1.2',
    title: 'chatter about lunch',
    decisionId: 'coordinator-filter',
    outcome: 'skipped',
    reason: null,
    answer: { type: 'boolean', value: false, probability: 0.05 },
    matchedKeys: [],
    latencyMs: 28,
    requestedModel: 'jev-1.13.0',
    actualModel: 'jev-1.13.0',
    usage: { inputTokens: 12, outputTokens: 1 },
    detailsExpired: false
  }

  function Probe({ onOpen }: { onOpen: (seq: number) => void }) {
    const results = useSessionDecisionResults(
      { agentId: 'agent-1', platform: 'slack', channelId: 'C1', coordinator: true, canEditAgent: true },
      [10, 20],
      [
        { seq: 10, messageId: '1.1', timeMs: Date.parse('2026-11-12T05:59:00.000Z') },
        { seq: 20, messageId: '1.2', timeMs: Date.parse('2026-11-12T06:00:00.000Z') }
      ]
    )
    const record = results.bySeq.get(20)
    if (!record) return null
    return (
      <DecisionResultMarker
        record={record}
        decisionName={results.source?.fixedDecision?.name}
        onOpen={() => onOpen(record.seq)}
      />
    )
  }

  it('matches the agent’s coordinator filter verdicts to the session’s messages and names the filter', async () => {
    const api = decisionMock.createDecisionMockApi()
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue({ ...api, mode: 'live' })
    filterWire.items = [filterRecord]
    const onOpen = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <Probe onOpen={onOpen} />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    for (let i = 0; i < 4; i++) await act(async () => {})
    expect(filterWire.calls).toEqual([
      { agentId: 'agent-1', page: { cursor: undefined, limit: 50 }, orgId: 'org-test' }
    ])
    const marker = container.querySelector('button')
    expect(marker?.textContent).toContain('Received a decision result')
    expect(marker?.textContent).toContain('Coordinator filter')
    expect(marker?.textContent).toContain('No · 95%')
    expect(marker?.textContent).toContain('Skipped')
    await act(async () => marker!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith(7)
  })
})
