// @vitest-environment happy-dom
/**
 * What a usage row may say about who spent the money.
 *
 * Two sources, two different questions. The AMOUNTS come from the billing service's split —
 * the only thing that knows how one charge divides — and the PERMISSION to put a name beside
 * one comes from the CP's viewer-scoped `/usage` projection for that charge's period.
 *
 * The gate is per-agent MEMBERSHIP in the projection — the intersection under which Analytics
 * already names that agent to this viewer — per the billing exception in
 * `session-visibility.md` §5. A period-completeness gate was tried and blanked attribution for
 * any org with one private session. What §5 still forbids is pinned here: an agent in NO
 * readable session stays id-less, and withheld parts fold into one countless rollup.
 *
 * The fixtures are real figures from a test org: one August with three separate charges, whose
 * amounts sum to exactly the month's projected total. A period holds MANY charges — assuming
 * one charge per period is what blanked the whole feed before.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

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
  fetchAttribution: vi.fn(async () => new Set(['8173602b-1d84-41c5-9777-22a6eb2d2b51']))
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
const proj = (...ids: string[]): ReadonlySet<string> => new Set(ids)

describe('rowAttribution', () => {
  it('names an agent the projection lists, for its exact per-row amount', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '0.006822824' }], proj('agt_1'), roster)
    expect(chips).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '0.006822824' }])
  })

  it('still names an agent when the period withholds OTHER spend — the billing exception', () => {
    // The projection lists agt_1 (Analytics already names it to this viewer). Some of the
    // period's spend being withheld no longer blanks the whole period — that gate blanked
    // every org with one private session. Recorded in session-visibility.md §5.
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '100' }], proj('agt_1'), roster)
    expect(chips).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '100' }])
  })

  it('withholds an agent the projection does not list at all', () => {
    // No readable spend anywhere in the window ⇒ §5 still forbids naming it here.
    const chips = rowAttribution([{ agentId: 'agt_2', amount: '3' }], proj('agt_1'), roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
    expect(JSON.stringify(chips)).not.toContain('agt_2')
  })

  it('withholds an agent the roster cannot resolve, id and all', () => {
    const chips = rowAttribution([{ agentId: 'agt_gone', amount: '3' }], proj('agt_gone'), roster)
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
      proj('agt_1', 'x', 'y'),
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
      proj('agt_1', 'agt_2'),
      roster
    )
    expect(chips.map((c) => c.agent?.name)).toEqual(['triage', 'reviewer'])
  })

  it('fails closed while the projection is unloaded or errored', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '3' }], undefined, roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('fails closed on an empty roster', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '3' }], proj('agt_1'), new Map())
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('renders nothing when the service sent no split, or an empty one', () => {
    expect(rowAttribution(undefined, proj('agt_1'), roster)).toEqual([])
    expect(rowAttribution(null, proj('agt_1'), roster)).toEqual([])
    expect(rowAttribution([], proj('agt_1'), roster)).toEqual([])
    // A zero part is noise, not attribution.
    expect(rowAttribution([{ agentId: 'agt_1', amount: '0' }], proj('agt_1'), roster)).toEqual([])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(rowAttribution([{ agentId: 'agt_1', amount: 'twelve' }], proj('agt_1'), roster)).toEqual([])
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
    // Desktop shows the name; the share is disclosure — `title`, which the TooltipLayer opens on
    // hover and on keyboard focus (hence tabbable). The trailing amount span is the ≤768px copy
    // (visible where touch has neither hover nor focus), CSS-hidden on desktop but present in
    // textContent here. Sub-cent amounts keep significant digits rather than rounding to `$0.00`.
    expect(chips.map((c) => c.textContent)).toEqual(['reviewer$0.006823', 'reviewer$0.01522', 'reviewer$0.001036'])
    expect(chips.map((c) => c.getAttribute('title'))).toEqual([
      'reviewer — $0.006823',
      'reviewer — $0.01522',
      'reviewer — $0.001036'
    ])
    expect(chips[0]!.getAttribute('aria-label')).toBe('reviewer — $0.006823')
    expect(chips.every((c) => c.getAttribute('tabindex') === '0')).toBe(true)
    expect(host.querySelector('[data-tx-agent-default]')).toBeNull()
  })
})
