/**
 * The debit row's agent attribution, reduced to what the viewer is entitled to.
 *
 * The billing service authorizes on ORG membership alone, so the `agents` split it sends
 * carries the org's agent ids and not the viewer's. Naming one the viewer cannot otherwise
 * see would be the resource-existence disclosure `session-visibility.md` §5 forbids, whose
 * rule is that withheld usage comes back id-less. Every part still gets its own entry — the
 * roster decides whether it is NAMED, not whether it appears — so what is pinned here is a
 * security property (no unresolvable id survives the reduction), not a formatting one.
 */
// @vitest-environment happy-dom
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
  fetchAgents: vi.fn(async () => [{ id: 'agt_1', name: 'reviewer', runtime: 'claude' }])
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
  fetchBillingTransactions: async () => ({ items: [DEBIT], nextCursor: null }),
  fetchBillingTransactionsSince: async () => [DEBIT]
}))

const { default: BillingView, agentSplit } = await import('./BillingView')

beforeEach(() => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: 'billing' }
})
afterEach(() => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
})

const agent = (id: string, name: string) => ({ id, name, runtime: 'claude' }) as Agent
const roster = new Map([
  ['agt_1', agent('agt_1', 'reviewer')],
  ['agt_2', agent('agt_2', 'triage')]
])

describe('agentSplit', () => {
  it('resolves an agent on the viewer’s roster, and only that one', () => {
    const rows = agentSplit(
      [
        { agentId: 'agt_1', amount: '0.40' },
        { agentId: 'agt_hidden', amount: '0.10' }
      ],
      roster
    )
    expect(rows.map((r) => r.agent?.name)).toEqual(['reviewer', undefined])
    // The whole point: no unresolvable id reaches the row, in any field — including `key`,
    // so the id cannot leak through a prop that ends up serialized.
    expect(JSON.stringify(rows)).not.toContain('agt_hidden')
  })

  it('gives every unresolvable part its OWN entry rather than folding them', () => {
    const rows = agentSplit(
      [
        { agentId: 'x', amount: '0.10' },
        { agentId: 'y', amount: '0.20' },
        { agentId: 'agt_2', amount: '1.00' }
      ],
      roster
    )
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => !r.agent)).toHaveLength(2)
    // Distinct keys, or React collapses the two into one chip.
    expect(new Set(rows.map((r) => r.key)).size).toBe(3)
  })

  it('orders by spend, biggest first, resolved or not', () => {
    const rows = agentSplit(
      [
        { agentId: 'agt_1', amount: '0.40' },
        { agentId: 'hidden', amount: '5.00' },
        { agentId: 'agt_2', amount: '2.50' }
      ],
      roster
    )
    expect(rows.map((r) => r.agent?.name ?? '—')).toEqual(['—', 'triage', 'reviewer'])
  })

  it('renders nothing when the service sent no split, or an empty one', () => {
    expect(agentSplit(undefined, roster)).toEqual([])
    expect(agentSplit(null, roster)).toEqual([])
    expect(agentSplit([], roster)).toEqual([])
    // A zero part is noise, not attribution.
    expect(agentSplit([{ agentId: 'agt_1', amount: '0' }], roster)).toEqual([])
  })

  it('drops a part whose amount is not a number rather than rendering NaN', () => {
    expect(agentSplit([{ agentId: 'agt_1', amount: 'twelve' }], roster)).toEqual([])
  })

  it('names nothing while the roster is still empty', () => {
    // An unloaded or failed roster must fail CLOSED — a default avatar, never a name.
    const rows = agentSplit([{ agentId: 'agt_1', amount: '0.40' }], new Map())
    expect(rows.map((r) => r.agent)).toEqual([undefined])
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

  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = undefined
  })

  it('pictures the agent it may name, and a default avatar for the one it may not', async () => {
    const host = await render()
    const chips = host.querySelectorAll('[data-tx-agent]')
    expect(chips).toHaveLength(2)

    // Resolved: the agent's own avatar and label.
    expect(chips[0]!.textContent).toBe('reviewer')
    expect(chips[0]!.querySelector('[data-tx-agent-default]')).toBeNull()

    // Unresolved: the default avatar, no name — and its id nowhere in the DOM.
    expect(chips[1]!.textContent).toBe('')
    expect(chips[1]!.querySelector('[data-tx-agent-default]')).not.toBeNull()
    expect(host.innerHTML).not.toContain('agt_hidden')
  })
})
