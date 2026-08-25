// @vitest-environment happy-dom
/**
 * What a usage row may say about who spent the money.
 *
 * Two sources, two different questions. The AMOUNTS come from the billing service's split —
 * the only thing that knows how one charge divides — and the PERMISSION to put a name beside
 * one comes from the CP's viewer-scoped `/usage` projection for that charge's period.
 *
 * The gate is the projection's `complete`, not membership in it. `/usage.agents` lists an agent
 * when ANY of its spend is readable and hides the rest in one id-less residual, so membership
 * alone would let an agent with $1 readable and $99 private be named for charges covering the
 * $99. Only a period that withholds nothing makes a name safe. These are security properties.
 *
 * The fixtures are real figures from a test org: one August with three separate charges, whose
 * amounts sum to exactly the month's projected total. A period holds MANY charges — assuming
 * one charge per period is what blanked the whole feed before.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { GatewayAttribution } from '@/lib/api'

const AGENT_ID = '8173602b-1d84-41c5-9777-22a6eb2d2b51'
const debit = (id: string, amount: string) => ({
  type: 'debit' as const,
  id,
  period: '2026-08',
  amount,
  at: '2026-08-25T02:20:00.000Z',
  agents: [{ agentId: AGENT_ID, amount }]
})
const DEBITS = [debit('d1', '0.006822824'), debit('d2', '0.015224848'), debit('d3', '0.001036384')]

const mocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => [{ id: '8173602b-1d84-41c5-9777-22a6eb2d2b51', name: 'reviewer', runtime: 'claude' }]),
  fetchAttribution: vi.fn(async () => ({
    agents: new Set(['8173602b-1d84-41c5-9777-22a6eb2d2b51']),
    complete: true
  }))
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => p, loading: false })
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/acme/billing',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  fetchAgents: mocks.fetchAgents,
  fetchGatewayAttribution: mocks.fetchAttribution
}))
vi.mock('@/lib/billing-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')),
  createBillingPurchase: vi.fn(),
  fetchBillingPurchase: vi.fn(),
  fetchBillingAccount: async () => ({ orgId: 'org-1', balanceMicro: 10_000_000 }),
  fetchBillingTransactions: async () => ({ items: DEBITS, nextCursor: null }),
  fetchBillingTransactionsSince: async () => DEBITS
}))

const { default: BillingView, rowAttribution } = await import('./BillingView')

const agent = (id: string, name: string) => ({ id, name, runtime: 'claude' }) as Agent
const roster = new Map([
  ['agt_1', agent('agt_1', 'reviewer')],
  ['agt_2', agent('agt_2', 'triage')]
])
const complete = (...ids: string[]): GatewayAttribution => ({ agents: new Set(ids), complete: true })
const partial = (...ids: string[]): GatewayAttribution => ({ agents: new Set(ids), complete: false })

describe('rowAttribution', () => {
  it('names an agent for its exact per-row amount when the period withholds nothing', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '0.006822824' }], complete('agt_1'), roster)
    expect(chips).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '0.006822824' }])
  })

  it('refuses to name ANY agent in a period that withholds something', () => {
    // The $1-readable / $99-private case: the agent is in `agents`, but the residual means the
    // projection cannot say which spend was readable, so no charge in the period may carry a
    // name — however small the residual is.
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '100' }], partial('agt_1'), roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '100' }])
    expect(JSON.stringify(chips)).not.toContain('agt_1')
  })

  it('withholds an agent the projection does not list at all', () => {
    const chips = rowAttribution([{ agentId: 'agt_2', amount: '3' }], complete('agt_1'), roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('withholds an agent the roster cannot resolve, id and all', () => {
    const chips = rowAttribution([{ agentId: 'agt_gone', amount: '3' }], complete('agt_gone'), roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
    expect(JSON.stringify(chips)).not.toContain('agt_gone')
  })

  it('collapses everything withheld into ONE rollup — no count, no partition', () => {
    const chips = rowAttribution(
      [
        { agentId: 'agt_1', amount: '1' },
        { agentId: 'x', amount: '0.1' },
        { agentId: 'y', amount: '0.2' }
      ],
      complete('agt_1', 'x', 'y'),
      roster
    )
    expect(chips).toHaveLength(2)
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(chips[1]).toEqual({ key: 'withheld', amount: '0.3' })
  })

  it('orders named agents by spend, biggest first', () => {
    const chips = rowAttribution(
      [
        { agentId: 'agt_1', amount: '0.40' },
        { agentId: 'agt_2', amount: '2.50' }
      ],
      complete('agt_1', 'agt_2'),
      roster
    )
    expect(chips.map((c) => c.agent?.name)).toEqual(['triage', 'reviewer'])
  })

  it('fails closed while the projection is unloaded or errored', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '3' }], undefined, roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('fails closed on an empty roster', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '3' }], complete('agt_1'), new Map())
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('renders nothing when the service sent no split, or an empty one', () => {
    expect(rowAttribution(undefined, complete('agt_1'), roster)).toEqual([])
    expect(rowAttribution(null, complete('agt_1'), roster)).toEqual([])
    expect(rowAttribution([], complete('agt_1'), roster)).toEqual([])
    // A zero part is noise, not attribution.
    expect(rowAttribution([{ agentId: 'agt_1', amount: '0' }], complete('agt_1'), roster)).toEqual([])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(rowAttribution([{ agentId: 'agt_1', amount: 'twelve' }], complete('agt_1'), roster)).toEqual([])
  })
})

describe('the usage row', () => {
  let root: Root | undefined
  let host: HTMLElement | undefined

  async function render(): Promise<HTMLElement> {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<BillingView />)
    })
    return host
  }

  beforeEach(() => {
    ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
  })
  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = undefined
    ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
  })

  it('asks the CP once for the period the rows share, not once per row', async () => {
    await render()
    expect(mocks.fetchAttribution).toHaveBeenCalledTimes(1)
    expect(mocks.fetchAttribution).toHaveBeenCalledWith('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'org-1')
  })

  it('names the agent on EVERY charge in the period, not just one', async () => {
    // A period holds many charges. Reconciling a monthly projection against a single row is
    // what blanked all three of these before, so each one is asserted.
    const host = await render()
    const chips = [...host.querySelectorAll('[data-tx-agent]')]
    // Sub-cent charges keep their significant digits rather than all rounding to `$0.00`.
    expect(chips.map((c) => c.textContent)).toEqual(['reviewer$0.006823', 'reviewer$0.01522', 'reviewer$0.001036'])
    expect(host.querySelector('[data-tx-agent-default]')).toBeNull()
  })
})
