// @vitest-environment happy-dom

// auto-session-mode.md §4.6: the Usage page says what each agent's coordinator spent, on desktop and on a phone alike.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageDto } from '@/lib/api'

const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'

const row = (agentId: string, totalTokens: number, costAmount: string) => ({
  agentId,
  sessions: 2,
  totalTokens,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  costAmount
})

const usage: UsageDto = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-30T00:00:00.000Z',
  totals: { sessions: 4, totalTokens: 30_000, costAmount: '3', costCurrency: 'USD' },
  agents: [row(AGENT_A, 20_000, '2'), row(AGENT_B, 10_000, '1')],
  models: [],
  sources: [],
  coordinators: [{ ...row(AGENT_A, 4_000, '0.4'), sessions: 1 }],
  series: { bucket: 'day', points: [] }
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('range=d30')
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    orgPath: (path: string) => `/acme${path}`,
    activeOrg: { id: 'org-1' },
    orgs: [{ id: 'org-1' }],
    loading: false,
    error: null
  })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [
      { id: AGENT_A, name: 'helper', displayName: 'Helper', runtime: 'claude' },
      { id: AGENT_B, name: 'builder', displayName: 'Builder', runtime: 'codex' }
    ]
  })
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  fetchUsage: vi.fn(async () => usage)
}))
// The chart has no size to lay out in the test environment, and is not what this test reads.
vi.mock('recharts', () => {
  const none = () => null
  return { Bar: none, BarChart: none, Legend: none, ResponsiveContainer: none, Tooltip: none, XAxis: none }
})
vi.mock('@/components/marks', async (original) => ({
  ...(await original<typeof import('@/components/marks')>()),
  AgentIconView: () => <span />,
  ModelMark: () => <span />
}))

const UsageView = (await import('./UsageView')).default

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('UsageView, the coordinator', () => {
  it('names an agent’s coordinator spend beneath its row in both arrangements, and nothing for another', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <UsageView />
        </SWRConfig>
      )
    })
    await act(async () => {})
    const parts = [...document.querySelectorAll('[data-coordinator-usage]')].map((node) => node.textContent)
    expect(parts).toEqual(['Coordinator: 4K tokens · $0.40', 'Coordinator: 4K tokens · $0.40'])
    expect(document.body.textContent).toContain('Builder')
  })
})
