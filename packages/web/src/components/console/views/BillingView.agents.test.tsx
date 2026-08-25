// @vitest-environment happy-dom
/**
 * What a usage row may say about who spent the money.
 *
 * Every figure comes from the CP's viewer-scoped `/usage` projection, gateway-scoped like the
 * charge itself — never from the billing service's own split, whose ids AND amounts are the
 * ORG's (it authorizes on org membership alone). That distinction is the whole boundary:
 * `session-visibility.md` §5 makes usage attribution the intersection of Agent visibility and
 * the Session predicate, and `/usage` applies both, so what it hands over per agent is what
 * this viewer may attribute — never an authorization for that agent's whole month. An agent
 * with $1 of readable spend and $99 of private spend is worth $1 here, and the $99 stays in
 * the id-less residual. These are security properties, not formatting ones.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

const DEBIT = {
  type: 'debit' as const,
  id: 'd1',
  period: '2026-08',
  amount: '100.00',
  at: '2026-08-20T10:00:00.000Z',
  // The billing service's own org-scoped split. Nothing reads it — the assertions below pin
  // that the row's figures come from the projection instead, not from these numbers.
  agents: [{ agentId: 'agt_1', amount: '100.00' }]
}

const mocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => [{ id: 'agt_1', name: 'reviewer', runtime: 'claude' }]),
  fetchAttribution: vi.fn(async () => new Map([['agt_1', '1.00']]))
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
  fetchBillingTransactions: async () => ({ items: [DEBIT], nextCursor: null }),
  fetchBillingTransactionsSince: async () => [DEBIT]
}))

const { default: BillingView, rowAttribution } = await import('./BillingView')

const agent = (id: string, name: string) => ({ id, name, runtime: 'claude' }) as Agent
const roster = new Map([
  ['agt_1', agent('agt_1', 'reviewer')],
  ['agt_2', agent('agt_2', 'triage')]
])

describe('rowAttribution', () => {
  it('names an agent for its SCOPED amount, never the row it appears on', () => {
    // $1 readable + $99 private on one visible agent. Membership would name it for $100;
    // the projection's own figure is the only one it may be named for.
    const chips = rowAttribution('100', new Map([['agt_1', '1']]), roster)
    expect(chips).toEqual([
      { key: 'agt_1', agent: roster.get('agt_1'), amount: '1' },
      { key: 'withheld', amount: '99' }
    ])
  })

  it('leaves an unresolvable agent’s spend in the residual, id and all', () => {
    const chips = rowAttribution('10', new Map([['agt_gone', '4']]), roster)
    expect(chips).toEqual([{ key: 'withheld', amount: '10' }])
    expect(JSON.stringify(chips)).not.toContain('agt_gone')
  })

  it('collapses everything withheld into ONE rollup — no count, no partition', () => {
    const chips = rowAttribution(
      '10',
      new Map([
        ['agt_1', '1'],
        ['x', '2'],
        ['y', '3']
      ]),
      roster
    )
    expect(chips).toHaveLength(2)
    expect(chips[1]).toEqual({ key: 'withheld', amount: '9' })
  })

  it('subtracts exactly, never as a float', () => {
    // 0.3 - 0.1 - 0.1 is 0.09999999999999999 in binary floating point.
    const chips = rowAttribution(
      '0.3',
      new Map([
        ['agt_1', '0.1'],
        ['agt_2', '0.1']
      ]),
      roster
    )
    expect(chips.at(-1)).toEqual({ key: 'withheld', amount: '0.1' })
  })

  it('omits the rollup when the viewer can attribute the whole row', () => {
    const chips = rowAttribution(
      '3',
      new Map([
        ['agt_1', '1'],
        ['agt_2', '2']
      ]),
      roster
    )
    expect(chips.map((c) => c.key)).toEqual(['agt_2', 'agt_1'])
  })

  it('orders named agents by spend, biggest first', () => {
    const chips = rowAttribution(
      '9',
      new Map([
        ['agt_1', '0.4'],
        ['agt_2', '2.5']
      ]),
      roster
    )
    expect(chips.map((c) => c.agent?.name)).toEqual(['triage', 'reviewer', undefined])
  })

  it('shows NOTHING rather than an overstated chip when naming exceeds the row', () => {
    // A partial period, or a settlement this window does not describe: not reconcilable, so
    // there is no split that both adds up and does not overstate. Say nothing.
    expect(rowAttribution('1', new Map([['agt_1', '5']]), roster)).toEqual([])
  })

  it('fails closed on a missing projection or an empty roster', () => {
    expect(rowAttribution('10', undefined, roster)).toEqual([])
    expect(rowAttribution('10', new Map(), roster)).toEqual([])
    expect(rowAttribution('10', new Map([['agt_1', '1']]), new Map())).toEqual([{ key: 'withheld', amount: '10' }])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(rowAttribution('10', new Map([['agt_1', 'twelve']]), roster)).toEqual([{ key: 'withheld', amount: '10' }])
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

  it('asks the CP for the periods on screen, not for a preset range', async () => {
    await render()
    expect(mocks.fetchAttribution).toHaveBeenCalledWith('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'org-1')
  })

  it('renders the projection’s amount, not the billing service’s org-scoped one', async () => {
    const host = await render()
    const chips = host.querySelectorAll('[data-tx-agent]')
    expect(chips).toHaveLength(2)

    // The projection attributes $1 of this $100 charge to a roster agent...
    expect(chips[0]!.textContent).toBe('reviewer$1.00')
    expect(chips[0]!.querySelector('[data-tx-agent-default]')).toBeNull()
    // ...and the other $99 is the id-less residual. The billing split said $100 for this same
    // agent; if that number ever reaches a CHIP, this assertion is what catches it. The row's
    // own total is still $100 — that figure is the org's charge and was never in question.
    expect(chips[1]!.textContent).toBe('$99.00')
    expect(chips[1]!.querySelector('[data-tx-agent-default]')).not.toBeNull()
    expect([...chips].map((c) => c.textContent).join('')).not.toContain('$100.00')
    expect(host.textContent).toContain('-$100.00')
  })
})
