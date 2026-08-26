// @vitest-environment happy-dom
/**
 * The self-hosted pool has ONE detail page, and it is the cluster's — not a member's.
 * A member is a Pod: the pool rolls, every replacement mints another daemon row, and no
 * member id survives that. So everything on this page is an aggregate over the serving
 * members, and the two things the design offered that the console cannot honestly serve
 * — a mint/rotate-token action and a live log tail — are absent by construction.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  daemons: [] as unknown[],
  agents: [] as unknown[],
  daemonsLoading: false,
  agentsLoading: false,
  memberSetsLoading: false,
  balance: { data: { orgId: 'org-pool', balanceMicro: 38_740_000 } } as Record<string, unknown>,
  usage: {} as Record<string, unknown>,
  topUps: {} as Record<string, unknown>,
  keys: [] as unknown[][],
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-pool' }, myRole: 'viewer', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    daemonsLoading: mocks.daemonsLoading,
    agents: mocks.agents,
    agentsLoading: mocks.agentsLoading,
    memberSetsLoading: mocks.memberSetsLoading
  })
}))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
// The Credits card is the page's only fetcher, and it reads three independent sources, so
// the stub answers per KEY — one shared response would hide a card that wired the wrong one.
vi.mock('swr', () => ({
  default: (key: unknown) => {
    if (Array.isArray(key)) mocks.keys.push(key)
    const resource = Array.isArray(key) ? key[2] : null
    if (resource === 'billing-account') return mocks.balance
    if (resource === 'usage') return mocks.usage
    if (resource === 'billing-top-ups') return mocks.topUps
    return {}
  }
}))

const ClusterDetailView = (await import('./ClusterDetailView')).default

function member(id: string, over: Partial<DaemonRow> = {}): DaemonRow {
  return {
    daemonId: id,
    pool: true,
    memberSetId: 'pool',
    name: 'AgentConnect Cloud',
    version: '1.41.0',
    latestVersion: '1.41.0',
    releaseChannel: 'latest',
    upgradeAvailable: false,
    availableVersions: [],
    lifecycleOp: null,
    lifecycleStatus: null,
    canManageLifecycle: false,
    status: 'online',
    host: `pool-member-${id}`,
    cpu: 20,
    mem: 40,
    loadAgents: 0,
    caps: { platforms: [], runtimes: [], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: [],
    activeSessions: '0',
    conns: '32',
    uptime: '1m',
    createdBy: '',
    createdAt: '',
    lastModifiedBy: '',
    lastModifiedAt: '',
    sessionRetention: '7d',
    visibility: 'org',
    sharedWith: [],
    canEdit: false,
    canManageSharing: false,
    ...over
  } as DaemonRow
}

/** An agent placed on the POOL as the live console models it: `agentFromDto` maps a set
 *  placement to the `pool` sentinel, never the ephemeral member id holding the duty. Getting
 *  this wrong in a fixture is exactly how a page can report an empty cluster and still pass. */
const onPool = (id: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    daemon: 'pool',
    placementKind: 'set',
    setId: null,
    placementReady: true,
    name: id,
    status: 'online',
    runtime: 'claude',
    model: 'opus',
    ...over
  }) as Agent

/** The 30-day series a `source=gateway` request answers with: already scoped, so a bucket's
 *  `costAmount` IS the Cloud figure for that day. `byAgent` carries a deliberately different
 *  number — a card that still scoped the split itself would quote that instead. */
function gatewayUsage(daily: Record<number, string> = { 3: '1.50', 10: '4.00', 29: '2.50' }) {
  return {
    from: '',
    to: '',
    totals: { sessions: 0, totalTokens: 0, costAmount: '0', costCurrency: 'USD' },
    agents: [],
    models: [],
    sources: [],
    series: {
      bucket: 'day' as const,
      points: Array.from({ length: 30 }, (_, day) => ({
        start: new Date(Date.UTC(2026, 6, 22 + day)).toISOString(),
        costAmount: daily[day] ?? '0',
        byAgent: { a1: '99.00' }
      }))
    }
  }
}

const credit = (day: number, amountMicro: number) => ({
  type: 'credit' as const,
  id: `c${day}`,
  kind: 'purchase' as const,
  amountMicro,
  at: new Date(Date.UTC(2026, 6, 22 + day, 9)).toISOString()
})

function render(): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => {
    root.render(<ClusterDetailView />)
  })
  const html = host.innerHTML
  act(() => root.unmount())
  host.remove()
  return html
}

const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

beforeEach(() => {
  mocks.daemons = []
  mocks.agents = []
  mocks.daemonsLoading = false
  mocks.agentsLoading = false
  mocks.memberSetsLoading = false
  mocks.balance = { data: { orgId: 'org-pool', balanceMicro: 38_740_000 } }
  mocks.usage = { data: gatewayUsage() }
  mocks.topUps = { data: [] }
  mocks.keys = []
  mocks.push.mockClear()
  setFlags('daemon-pool')
})

describe('ClusterDetailView', () => {
  it('names the cluster and reads its nodes as one fleet', () => {
    mocks.daemons = [member('p1'), member('p2'), member('gone', { status: 'offline' })]

    const html = render()

    expect(html).toContain('Kubernetes cluster')
    expect(html).toContain('2 nodes serving')
    expect(html).toContain('2 / 3')
    // Pod identity is cluster churn — never a name this page puts in front of anyone.
    expect(html).not.toContain('pool-member-p1')
  })

  it('sums the ceiling and the load its serving members report', () => {
    mocks.daemons = [
      member('p1', { conns: '20', loadAgents: 7, cpu: 30, mem: 50 }),
      member('p2', { conns: '40', loadAgents: 27, cpu: 50, mem: 70 }),
      member('gone', { status: 'offline', conns: '99', loadAgents: 99 })
    ]

    const html = render()

    expect(html).toContain('34 / 60')
    // Utilization is the average across the serving nodes, never the dead one's.
    expect(html).toContain('40%')
    expect(html).toContain('60%')
  })

  it('names an unbounded cluster ∞ rather than a ceiling of zero', () => {
    mocks.daemons = [member('p1', { conns: '20', loadAgents: 7 }), member('p2', { conns: '0', loadAgents: 3 })]

    const html = render()

    expect(html).toContain('10 / ∞')
    expect(html).toContain('no agent ceiling')
  })

  it('unions the runtimes and models across the serving nodes', () => {
    mocks.daemons = [
      member('p1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      }),
      member('p2', {
        runtimeModels: [
          { runtime: 'claude', version: '0.54.1', models: ['opus', 'sonnet'], acpProtocolVersion: 1 },
          { runtime: 'codex', version: '', models: [], acpProtocolVersion: 1 }
        ]
      })
    ] as unknown[]
    mocks.agents = [onPool('a1')]

    const html = render()

    expect(html).toContain('2 models')
    expect(html).toContain('v0.54.1')
    // The disclosure is operable, not hover-only: a real button carrying aria-expanded.
    expect(html).toContain('aria-expanded')
    expect(html).toContain('1 agent')
    expect(html).toContain('no agents')
  })

  it('lists the agents placed on the cluster', () => {
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1'), onPool('a2')]

    const html = render()

    expect(html).toContain('Agents on this cluster')
    expect(html).toContain('>a1<')
    expect(html).toContain('>a2<')
  })

  it('offers neither a token action nor a log tail', () => {
    // The console mints no cluster credentials, and a fabricated log stream would be
    // indistinguishable from real telemetry.
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).not.toContain('Mint')
    expect(html).not.toContain('Rotate')
    expect(html).not.toContain('tail · local time')
  })

  it('opens a runtime’s models from the keyboard, not a hover alone', () => {
    mocks.daemons = [
      member('p1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus', 'sonnet'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
      root.render(<ClusterDetailView />)
    })
    expect(host.innerHTML).not.toContain('sonnet')
    act(() => {
      host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    })
    const opened = host.innerHTML
    act(() => root.unmount())
    host.remove()

    expect(opened).toContain('sonnet')
    expect(opened).toContain('aria-expanded="true"')
  })

  it('says so when no pool member has registered at all', () => {
    const html = render()

    expect(html).toContain('No cluster connected')
  })

  it('waits rather than 404s while the fleet is still loading', () => {
    mocks.daemonsLoading = true

    const html = render()

    expect(html).not.toContain('No cluster connected')
  })
})

/**
 * The SAME page on the managed install, where the pool is AgentConnect Cloud — a product the
 * org buys rather than infrastructure it runs. Node count, host names, versions and CPU are
 * the operator's business, so the Cloud reading drops them and answers what the org can act
 * on instead: what runs there, what it can run, what it holds, and what it costs.
 */
describe('ClusterDetailView — managed (AgentConnect Cloud)', () => {
  beforeEach(() => setFlags('daemon-pool,managed,billing'))

  it('names Cloud and keeps its topology to itself', () => {
    mocks.daemons = [member('p1'), member('p2', { status: 'offline' })]

    const html = render()

    expect(html).toContain('AgentConnect Cloud')
    expect(html).toContain('Managed by AgentConnect')
    // Everything a self-hoster is shown about their own cluster is Cloud's internals.
    expect(html).not.toContain('nodes serving')
    expect(html).not.toContain('Agent ceiling')
    expect(html).not.toContain('Sandbox capacity')
    expect(html).not.toContain('pool-member-p1')
  })

  it('asks the CP for the gateway-metered slice rather than scoping the org total itself', () => {
    // The footnote right below this card promises agents on your own daemons are never billed
    // here. Scope is now the REQUEST — `source=gateway`, the ingress the pool meters through —
    // so the bucket total is already the Cloud figure and the per-agent split is not read.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]

    const html = render()

    expect(mocks.keys.find((k) => k[2] === 'usage')).toEqual(['console', 'org-pool', 'usage', 'd30', 'gateway'])
    expect(html).toContain('Credits')
    expect(html).toContain('$8.00')
    // 30 buckets × $99.00 is what scoping the split by placement would have quoted.
    expect(html).not.toContain('$297.00')
  })

  it('shows the REAL balance beside them', () => {
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]

    const html = render()

    expect(html).toContain('$38.74')
    expect(html).toContain('Manage billing')
    // A plan's included usage is not derivable from load telemetry, so no bar pretends it is.
    expect(html).not.toContain('included')
  })

  it('sums the credit rows that fall inside the window', () => {
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    mocks.topUps = { data: [credit(4, 20_000_000), credit(25, 30_000_000)] }

    const html = render()

    expect(html).toContain('$50.00')
    expect(html).toContain('2 top-ups')
  })

  it('quotes the spend while placement is still loading — placement no longer scopes it', () => {
    // It used to: the figure was the per-agent split filtered by current placement, so it had
    // to wait for the agent list AND the set ids. A server-scoped series needs neither.
    mocks.daemons = [member('p1')]
    mocks.agents = []
    mocks.agentsLoading = true
    mocks.memberSetsLoading = true

    const html = render()

    expect(html).toContain('$8.00')
  })

  it('keeps the stale figure through a failed revalidation instead of contradicting the chart', () => {
    // SWR retains `data` when a revalidation fails; the chart below still draws that series,
    // so the header must not flip to "unavailable" beside it.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    mocks.usage = { data: gatewayUsage(), error: new Error('fetch failed') }
    mocks.topUps = { data: [credit(4, 20_000_000)], error: new Error('fetch failed') }
    mocks.balance = { data: { orgId: 'org-pool', balanceMicro: 38_740_000 }, error: new Error('fetch failed') }

    const html = render()

    expect(html).toContain('$8.00')
    expect(html).toContain('$20.00')
    expect(html).toContain('$38.74')
    expect(html).not.toContain('unavailable')
  })

  it('keeps a negative credit in the net total but out of the chart and the count', () => {
    // Stacked on a positive spend base, a negative segment draws downward over the brand bar —
    // and it is not a "top-up", so the note counts only the positive rows the chart marks.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    mocks.topUps = { data: [credit(4, 20_000_000), { ...credit(25, -5_000_000), kind: 'adjustment' as const }] }

    const html = render()

    expect(html).toContain('$15.00')
    expect(html).toContain('1 top-up')
    expect(html).not.toContain('2 top-ups')
  })

  it("holds the chart's footprint while the first load is in flight", () => {
    // A card that collapsed to its figures and grew a chart underneath would shove the page
    // down the moment the series lands.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    mocks.usage = { isLoading: true }
    mocks.topUps = { isLoading: true }
    mocks.balance = { isLoading: true }

    const html = render()

    expect(html).toContain('animate-pulse')
    expect(html).toContain('min-h-[140px]')
    // Nothing is claimed while it loads — not even a zero.
    expect(html).not.toContain('$0.00')
  })

  it('quotes a series that carries no per-agent split at all', () => {
    // The split used to BE the scope, so a CP without it left the figure unavailable. Now the
    // scope is the request and the split is not read — an older CP answers this card fine.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    const noSplit = gatewayUsage().series.points.map(({ byAgent: _, ...p }) => p)
    mocks.usage = { data: { ...gatewayUsage(), series: { bucket: 'day' as const, points: noSplit } } }

    const html = render()

    expect(html).toContain('$8.00')
    expect(html).not.toContain('unavailable')
    expect(html).toContain('$38.74')
  })

  it('lets each figure fail on its own', () => {
    // A shape mismatch throws BillingShapeError into the same slot as an unreachable service, and
    // this console deploys ahead of the pinned billing image — so blaming the network guesses.
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1')]
    mocks.balance = { error: new Error('billing sent an unexpected account — the console may be out of date') }

    const html = render()

    expect(html).toContain('unavailable')
    expect(html).toContain('may be out of date')
    expect(html).not.toContain('Could not reach')
    // A failed balance is not a failed spend: the CP's figure still renders.
    expect(html).toContain('$8.00')
  })

  it('offers no billing surface where the deployment has none', () => {
    setFlags('daemon-pool,managed')
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).toContain('AgentConnect Cloud')
    expect(html).not.toContain('Manage billing')
    expect(html).not.toContain('Credits')
  })

  it('still lists the runtimes Cloud offers and the agents on it', () => {
    mocks.daemons = [
      member('p1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus', 'sonnet'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]
    mocks.agents = [onPool('a1')]

    const html = render()

    expect(html).toContain('Agents on Cloud')
    expect(html).toContain('>a1<')
    expect(html).toContain('2 models')
    expect(html).toContain('Runtimes available')
  })

  it('says where Cloud usage is billed, and where it is not', () => {
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).toContain('billed to this organization')
    expect(html).toContain('never billed here')
  })
})
