// @vitest-environment happy-dom
/**
 * What a usage row may say about who spent the money.
 *
 * Two sources, two different questions. The AMOUNTS come from the billing service's split —
 * the only thing that knows how one charge divides — and the PERMISSION to put a name beside
 * one is Agent visibility alone: the viewer's own roster.
 *
 * The Session predicate does not gate naming here — the billing exception in
 * `session-visibility.md` §5. Gating on the viewer-scoped `/usage` projection was tried and
 * blanked every agent whose only spend in the period ran in a session the viewer cannot read,
 * even though the Agents page names that agent to them. What §5 still forbids is pinned here:
 * an id the roster cannot resolve stays id-less, and withheld parts fold into one countless
 * rollup.
 *
 * The fixtures are real figures from a test org: one August with three separate charges. A
 * period holds MANY charges — assuming one charge per period is what blanked the whole feed
 * before.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

const AGENT_ID = '8173602b-1d84-41c5-9777-22a6eb2d2b51'
const OTHER_ID = '4c1e9d2a-7b3f-4e8c-9a6d-2f5b8c1d0e7a'
const debit = (id: string, amount: string, agentId = AGENT_ID) => ({
  type: 'debit' as const,
  id,
  period: '2026-08',
  amount,
  at: '2026-08-25T02:20:00.000Z',
  agents: [{ agentId, amount }]
})
const DEBITS = [
  {
    ...debit('d1', '0.006822824'),
    models: [
      { model: 'model-small', amount: '0.001822824' },
      { model: 'model-large', amount: '0.005' }
    ]
  },
  debit('d2', '0.015224848'),
  debit('d3', '0.001036384'),
  // An agent outside the viewer's roster: withheld, whatever session it ran in.
  debit('d4', '0.5', OTHER_ID)
]

const mocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => [{ id: '8173602b-1d84-41c5-9777-22a6eb2d2b51', name: 'reviewer', runtime: 'claude' }])
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
  fetchAgents: mocks.fetchAgents
}))
vi.mock('@/lib/billing-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')),
  createBillingPurchase: vi.fn(),
  fetchBillingPurchase: vi.fn(),
  fetchBillingAccount: async () => ({ orgId: 'org-1', balanceMicro: 10_000_000 }),
  fetchBillingTransactions: async () => ({ items: DEBITS, nextCursor: null }),
  fetchBillingTransactionsSince: async () => DEBITS
}))

const {
  default: BillingView,
  fmtPostedRange,
  groupUsage,
  revealScrollTop,
  rowAttribution,
  usageDays,
  usageHours
} = await import('./BillingView')

const agent = (id: string, name: string) => ({ id, name, runtime: 'claude' }) as Agent
const roster = new Map([
  ['agt_1', agent('agt_1', 'reviewer')],
  ['agt_2', agent('agt_2', 'triage')]
])

describe('rowAttribution', () => {
  it('names an agent the roster resolves, for its exact per-row amount', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '0.006822824' }], roster)
    expect(chips).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '0.006822824' }])
  })

  it('names a visible agent regardless of which sessions the spend ran in', () => {
    // Agent visibility is the whole gate: a charge from a session the viewer cannot read is
    // still named after the agent they can see. Recorded in session-visibility.md §5.
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '100' }], roster)
    expect(chips).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '100' }])
  })

  it('withholds an agent the roster cannot resolve, id and all', () => {
    const chips = rowAttribution([{ agentId: 'agt_gone', amount: '3' }], roster)
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
      roster
    )
    expect(chips.map((c) => c.agent?.name)).toEqual(['triage', 'reviewer'])
  })

  it('fails closed on an empty roster', () => {
    const chips = rowAttribution([{ agentId: 'agt_1', amount: '3' }], new Map())
    expect(chips).toEqual([{ key: 'withheld', amount: '3' }])
  })

  it('renders nothing when the service sent no split, or an empty one', () => {
    expect(rowAttribution(undefined, roster)).toEqual([])
    expect(rowAttribution(null, roster)).toEqual([])
    expect(rowAttribution([], roster)).toEqual([])
    // A zero part is noise, not attribution.
    expect(rowAttribution([{ agentId: 'agt_1', amount: '0' }], roster)).toEqual([])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(rowAttribution([{ agentId: 'agt_1', amount: 'twelve' }], roster)).toEqual([])
  })

  it('orders chips by exact amount when a float cannot tell the amounts apart', () => {
    const bigRoster = new Map([
      ['agt_a', agent('agt_a', 'alpha')],
      ['agt_b', agent('agt_b', 'bravo')],
      ['agt_c', agent('agt_c', 'charlie')],
      ['agt_d', agent('agt_d', 'delta')],
      ['agt_e', agent('agt_e', 'echo')]
    ])
    // Every amount here rounds to the same float64 (1e19), so a float sort keeps arrival order.
    const chips = rowAttribution(
      [
        { agentId: 'agt_e', amount: '10000000000000000001' },
        { agentId: 'agt_d', amount: '10000000000000000000' },
        { agentId: 'agt_a', amount: '10000000000000000010' },
        { agentId: 'agt_c', amount: '10000000000000000008' },
        { agentId: 'agt_b', amount: '10000000000000000009' }
      ],
      bigRoster
    )
    expect(chips.map((c) => c.key)).toEqual(['agt_a', 'agt_b', 'agt_c', 'agt_e', 'agt_d'])
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

  it('names the agent from the roster alone — no per-period usage read', async () => {
    const host = await render()
    // The roster is the only read behind attribution; nothing else asks the CP about spend.
    expect(mocks.fetchAgents).toHaveBeenCalled()
    const chips = [...host.querySelectorAll('[data-tx-agent]')]
    // Desktop shows the name; the share is disclosure — `title`, which the TooltipLayer opens on
    // hover and on keyboard focus (hence tabbable). The trailing amount span is the ≤768px copy
    // (visible where touch has neither hover nor focus), CSS-hidden on desktop but present in
    // textContent here. Sub-cent amounts keep significant digits rather than rounding to `$0.00`.
    // d2 and d3 share agent and (no) models, so they fold into one record carrying their sum.
    expect(chips.slice(0, 2).map((c) => c.textContent)).toEqual(['reviewer$0.006823', 'reviewer$0.01626'])
    expect(chips.slice(0, 2).map((c) => c.getAttribute('title'))).toEqual([
      'reviewer — $0.006823',
      'reviewer — $0.01626'
    ])
    expect(chips[0]!.getAttribute('aria-label')).toBe('reviewer — $0.006823')
    expect(chips.every((c) => c.getAttribute('tabindex') === '0')).toBe(true)
  })

  it('folds an agent outside the roster into the id-less rollup', async () => {
    const host = await render()
    const rollups = [...host.querySelectorAll('[data-tx-agent-default]')]
    expect(rollups).toHaveLength(1)
    const chip = rollups[0]!.closest('[data-tx-agent]')!
    expect(chip.getAttribute('title')).toBe('Agents you don’t have access to — $0.50')
    expect(host.innerHTML).not.toContain(OTHER_ID)
  })

  it('splits a usage row into agent and model columns, and expands its per-model spend', async () => {
    const host = await render()
    const headers = [...host.querySelectorAll('.row.h > span')].map((h) => h.textContent)
    expect(headers.slice(0, 4)).toEqual(['', 'Agent', 'Models', 'Amount'])
    // A model-split charge and a folded record get toggles; a lone unsplit charge stays a plain row.
    const toggles = [...host.querySelectorAll<HTMLButtonElement>('[data-tx-toggle]')]
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-tx-models]')).toBeNull()
    await act(async () => toggles[0]!.click())
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true')
    const lines = [...host.querySelectorAll('[data-tx-models] > div')].map((l) => l.textContent)
    expect(lines).toEqual(['model-large73.3%-$0.005', 'model-small26.7%-$0.001823'])
    // Clicking anywhere on the row toggles too.
    await act(async () => (toggles[0]!.closest('.row') as HTMLElement).click())
    expect(host.querySelector('[data-tx-models]')).toBeNull()
  })

  it('folds charges with the same agent and models into one record that expands into its charges', async () => {
    const host = await render()
    const badges = [...host.querySelectorAll('[data-tx-count]')]
    expect(badges.map((b) => b.textContent)).toEqual(['2 charges'])
    const row = badges[0]!.closest('.row') as HTMLElement
    expect(row.textContent).toContain('-$0.01626')
    await act(async () => row.click())
    expect(host.querySelector('[data-tx-stats]')!.textContent).toBe('2 charges · avg $0.008131 · max $0.01522')
    // Both charges fall on one local day: one day row, closed until clicked.
    const days = [...host.querySelectorAll<HTMLButtonElement>('[data-tx-day]')]
    expect(days).toHaveLength(1)
    expect(days[0]!.textContent).toContain('2 charges100%-$0.01626')
    expect(host.querySelector('[data-tx-charge]')).toBeNull()
    await act(async () => days[0]!.click())
    expect(days[0]!.getAttribute('aria-expanded')).toBe('true')
    // The opened day is an hourly chart plus one table row per charge: local posted time, then amount.
    const rows = [...host.querySelectorAll('[data-tx-day-charges] [data-tx-charge]')]
    expect(rows.map((r) => r.textContent!.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d/, ''))).toEqual([
      '-$0.01522',
      '-$0.001036'
    ])
    expect(rows[0]!.querySelector('[title]')!.getAttribute('title')).toBe('$0.015224848')
    expect(host.querySelector('[data-tx-models]')).toBeNull()
    // Hovering a row lights its hour: both charges share one, so both rows go hot, and leaving clears it.
    expect(rows.some((r) => r.hasAttribute('data-hot'))).toBe(false)
    await act(async () => rows[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(rows.map((r) => r.hasAttribute('data-hot'))).toEqual([true, true])
    await act(async () =>
      rows[0]!.parentElement!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    )
    expect(rows.some((r) => r.hasAttribute('data-hot'))).toBe(false)
  })
})

describe('groupUsage', () => {
  const tx = (id: string, agents: { agentId: string; amount: string }[], models?: string[]) => ({
    type: 'debit' as const,
    id,
    period: '2026-08',
    amount: String(agents.reduce((sum, a) => sum + Number(a.amount), 0)),
    at: `2026-08-25T0${id.slice(1)}:00:00.000Z`,
    agents,
    models: models?.map((model) => ({ model, amount: '1' }))
  })

  it('keeps model sets apart and orders records by their newest charge', () => {
    const groups = groupUsage(
      [
        tx('t3', [{ agentId: 'agt_1', amount: '1' }], ['a']),
        tx('t2', [{ agentId: 'agt_1', amount: '2' }], ['b']),
        tx('t1', [{ agentId: 'agt_1', amount: '3' }], ['a'])
      ],
      roster,
      false
    )
    expect(groups.map((g) => g.txs.map((t) => t.id))).toEqual([['t3', 't1'], ['t2']])
    expect(groups[0]).toMatchObject({
      amount: '4',
      at: '2026-08-25T03:00:00.000Z',
      models: [{ model: 'a', amount: '2' }]
    })
    expect(groups[0]!.agents).toEqual([{ key: 'agt_1', agent: roster.get('agt_1'), amount: '4' }])
  })

  it('folds different withheld agents into one record without keeping their ids', () => {
    const groups = groupUsage(
      [tx('t2', [{ agentId: 'x', amount: '1' }]), tx('t1', [{ agentId: 'y', amount: '2' }])],
      roster,
      false
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.agents).toEqual([{ key: 'withheld', agent: undefined, amount: '3' }])
    expect(groups[0]!.key).not.toMatch(/"x"|"y"/)
  })

  it('orders grouped agents and models by exact amount when a float cannot tell them apart', () => {
    const groups = groupUsage(
      [
        {
          type: 'debit' as const,
          id: 't1',
          period: '2026-08',
          amount: '20000000000000000003',
          at: '2026-08-25T01:00:00.000Z',
          // The bigger spender arrives second; a float sort sees a tie and leaves it in place.
          agents: [
            { agentId: 'agt_2', amount: '10000000000000000001' },
            { agentId: 'agt_1', amount: '10000000000000000002' }
          ],
          models: [
            { model: 'model-less', amount: '10000000000000000001' },
            { model: 'model-more', amount: '10000000000000000002' }
          ]
        }
      ],
      roster,
      false
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.agents.map((a) => a.key)).toEqual(['agt_1', 'agt_2'])
    expect(groups[0]!.models.map((m) => m.model)).toEqual(['model-more', 'model-less'])
  })
})

describe('fmtPostedRange', () => {
  // Local wall-clock instants, so the expectation holds in any test timezone.
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString()

  it('prints one time for a single instant', () => {
    expect(fmtPostedRange(at(2026, 10, 19, 10, 2), at(2026, 10, 19, 10, 2))).toBe('2026-10-19 10:02')
  })

  it('keeps the date once when both ends share a day', () => {
    expect(fmtPostedRange(at(2026, 10, 19, 0, 9), at(2026, 10, 19, 10, 2))).toBe('2026-10-19 00:09–10:02')
  })

  it('drops the shared year across days, and keeps both years across years', () => {
    expect(fmtPostedRange(at(2026, 10, 18, 22, 50), at(2026, 10, 19, 10, 2))).toBe('10-18 22:50 – 10-19 10:02')
    expect(fmtPostedRange(at(2025, 12, 31, 23, 0), at(2026, 1, 1, 1, 0))).toBe('2025-12-31 23:00 – 2026-01-01 01:00')
  })
})

describe('revealScrollTop', () => {
  // A 190px list scrolled to 64; rows are 32px.
  const at = (top: number, bottom: number) => revealScrollTop({ top, bottom, scrollTop: 64, clientHeight: 190 })

  it('leaves a fully visible block where it is', () => {
    expect(at(64, 160)).toBeNull()
  })

  it('centres a block below or above the viewport', () => {
    expect(at(320, 384)).toBe(257)
    expect(at(0, 32)).toBe(0)
  })

  it('top-aligns a block taller than the list', () => {
    expect(at(320, 640)).toBe(320)
  })
})

describe('usageDays', () => {
  const charge = (id: string, d: number, h: number, amount: string) => ({
    type: 'debit' as const,
    id,
    period: '2026-10',
    amount,
    at: new Date(2026, 9, d, h, 0).toISOString()
  })

  it('splits newest-first charges by local day and sums each day exactly', () => {
    const days = usageDays([charge('c3', 19, 10, '0.1'), charge('c2', 19, 0, '0.2'), charge('c1', 18, 23, '0.5')])
    expect(days.map((d) => [d.day, d.txs.map((tx) => tx.id), d.amount])).toEqual([
      ['2026-10-19', ['c3', 'c2'], '0.3'],
      ['2026-10-18', ['c1'], '0.5']
    ])
  })

  it('buckets a day into 24 local hours with exact totals', () => {
    const hours = usageHours([charge('c3', 19, 10, '0.1'), charge('c2', 19, 10, '0.2'), charge('c1', 19, 0, '0.5')])
    expect(hours).toHaveLength(24)
    expect(hours[10]).toEqual({ label: '10', amount: 0.3, total: '0.3', count: 2 })
    expect(hours[0]).toMatchObject({ label: '00', total: '0.5', count: 1 })
    expect(hours[23]).toMatchObject({ label: '23', amount: 0, count: 0 })
  })
})
