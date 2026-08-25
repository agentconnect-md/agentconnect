// @vitest-environment happy-dom
/**
 * The debit row's agent attribution, reduced to what the viewer is entitled to.
 *
 * The billing service authorizes on ORG membership alone, so the `agents` split it sends
 * carries the org's agent ids and not the viewer's. `session-visibility.md` §5 makes usage
 * attribution the INTERSECTION of Agent visibility and the Session predicate, and returns
 * everything it withholds as one id-less rollup carrying no count. Naming an agent here
 * therefore needs both halves — the viewer's `/agents` roster and the CP's viewer-scoped
 * `/usage` projection for that period — and what fails either must collapse, not merely
 * lose its name. What is pinned below is that boundary, not a formatting choice.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

const DEBIT = {
  type: 'debit' as const,
  id: 'd1',
  period: '2026-08',
  amount: '1.40',
  at: '2026-08-20T10:00:00.000Z',
  agents: [
    { agentId: 'agt_1', amount: '1.00' },
    { agentId: 'agt_hidden', amount: '0.40' }
  ]
}

const mocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => [
    { id: 'agt_1', name: 'reviewer', runtime: 'claude' },
    { id: 'agt_hidden', name: 'secret-bot', runtime: 'claude' }
  ]),
  fetchAttributable: vi.fn(async () => new Set(['agt_1']))
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
  fetchAttributableAgentIds: mocks.fetchAttributable
}))
vi.mock('@/lib/billing-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/billing-api')>('@/lib/billing-api')),
  createBillingPurchase: vi.fn(),
  fetchBillingPurchase: vi.fn(),
  fetchBillingAccount: async () => ({ orgId: 'org-1', balanceMicro: 10_000_000 }),
  fetchBillingTransactions: async () => ({ items: [DEBIT], nextCursor: null }),
  fetchBillingTransactionsSince: async () => [DEBIT]
}))

const { default: BillingView, agentSplit } = await import('./BillingView')

const agent = (id: string, name: string) => ({ id, name, runtime: 'claude' }) as Agent
const roster = new Map([
  ['agt_1', agent('agt_1', 'reviewer')],
  ['agt_2', agent('agt_2', 'triage')]
])
const both = new Set(['agt_1', 'agt_2'])

describe('agentSplit', () => {
  it('names an agent only when BOTH predicates clear', () => {
    // On the roster but NOT attributable for this period: the viewer can see the agent, but
    // its billed spend came from sessions they may not read. Agent visibility alone is not
    // the permission this surface needs, so it must not be named.
    const rows = agentSplit(
      [
        { agentId: 'agt_1', amount: '1.00' },
        { agentId: 'agt_2', amount: '0.50' }
      ],
      roster,
      new Set(['agt_1'])
    )
    expect(rows.map((r) => r.agent?.name)).toEqual(['reviewer', undefined])
    expect(JSON.stringify(rows)).not.toContain('agt_2')
  })

  it('withholds an attributable agent that is missing from the roster', () => {
    const rows = agentSplit([{ agentId: 'agt_gone', amount: '1.00' }], roster, new Set(['agt_gone']))
    expect(rows).toEqual([{ key: 'withheld', amount: '1' }])
  })

  it('collapses every withheld part into ONE rollup, disclosing neither count nor partition', () => {
    const rows = agentSplit(
      [
        { agentId: 'x', amount: '0.10' },
        { agentId: 'y', amount: '0.20' },
        { agentId: 'z', amount: '0.05' },
        { agentId: 'agt_2', amount: '1.00' }
      ],
      roster,
      both
    )
    expect(rows).toHaveLength(2)
    // The sum, and only the sum — three contributors must not be legible as three chips.
    expect(rows[1]).toEqual({ key: 'withheld', amount: '0.35' })
  })

  it('sums the rollup exactly, never as a float', () => {
    const rows = agentSplit(
      [
        { agentId: 'x', amount: '0.1' },
        { agentId: 'y', amount: '0.2' }
      ],
      roster,
      both
    )
    expect(rows[0]!.amount).toBe('0.3')
  })

  it('orders named agents by spend, biggest first', () => {
    const rows = agentSplit(
      [
        { agentId: 'agt_1', amount: '0.40' },
        { agentId: 'agt_2', amount: '2.50' }
      ],
      roster,
      both
    )
    expect(rows.map((r) => r.agent?.name)).toEqual(['triage', 'reviewer'])
  })

  it('renders nothing when the service sent no split, or an empty one', () => {
    expect(agentSplit(undefined, roster, both)).toEqual([])
    expect(agentSplit(null, roster, both)).toEqual([])
    expect(agentSplit([], roster, both)).toEqual([])
    // A zero part is noise, not attribution.
    expect(agentSplit([{ agentId: 'agt_1', amount: '0' }], roster, both)).toEqual([])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(agentSplit([{ agentId: 'agt_1', amount: 'twelve' }], roster, both)).toEqual([])
  })

  it('fails closed when either input is empty', () => {
    const parts = [{ agentId: 'agt_1', amount: '0.40' }]
    // An unloaded or failed roster, and an unloaded or failed projection: both must withhold.
    expect(agentSplit(parts, new Map(), both)).toEqual([{ key: 'withheld', amount: '0.4' }])
    expect(agentSplit(parts, roster, new Set())).toEqual([{ key: 'withheld', amount: '0.4' }])
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
    expect(mocks.fetchAttributable).toHaveBeenCalledWith(
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      'org-1'
    )
  })

  it('pictures the agent it may name, and a default avatar for the rest', async () => {
    const host = await render()
    const chips = host.querySelectorAll('[data-tx-agent]')
    expect(chips).toHaveLength(2)

    // Attributable and on the roster: its own avatar, its label, its amount.
    expect(chips[0]!.textContent).toBe('reviewer$1.00')
    expect(chips[0]!.querySelector('[data-tx-agent-default]')).toBeNull()

    // Withheld: the default avatar and the summed amount — no name, and no id anywhere in
    // the DOM, even though this agent IS on the viewer's roster. `/agents` proves only that
    // they may see the agent, never that they may read the sessions this spend came from.
    expect(chips[1]!.textContent).toBe('$0.40')
    expect(chips[1]!.querySelector('[data-tx-agent-default]')).not.toBeNull()
    expect(host.innerHTML).not.toContain('agt_hidden')
    expect(host.innerHTML).not.toContain('secret-bot')
  })
})
