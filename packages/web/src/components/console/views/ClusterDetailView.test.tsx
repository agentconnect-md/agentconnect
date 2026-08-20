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
  integrations: [] as unknown[],
  daemonsLoading: false,
  balance: { data: { orgId: 'org-pool', balanceMicro: 38_740_000 } } as Record<string, unknown>,
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
    integrations: mocks.integrations
  })
}))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
// The Credits card's Balance is live; nothing else on the page fetches.
vi.mock('swr', () => ({ default: () => mocks.balance }))

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
  mocks.integrations = []
  mocks.daemonsLoading = false
  mocks.balance = { data: { orgId: 'org-pool', balanceMicro: 38_740_000 } }
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
    expect(html).toContain('Agent ceiling')
    expect(html).toContain('>60<')
    // Utilization is the average across the serving nodes, never the dead one's.
    expect(html).toContain('40%')
    expect(html).toContain('60%')
  })

  it('names an unbounded cluster ∞ rather than a ceiling of zero', () => {
    mocks.daemons = [member('p1', { conns: '20', loadAgents: 7 }), member('p2', { conns: '0', loadAgents: 3 })]

    const html = render()

    expect(html).toContain('10 / ∞')
    expect(html).toContain('unbounded')
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

  it('lists the agents on the cluster and the connections they hold', () => {
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1'), onPool('a2')]
    mocks.integrations = [
      {
        id: 'i1',
        agentId: 'a1',
        name: 'acme-ops',
        platform: 'slack',
        workspace: 'acme.slack.com',
        status: 'online',
        channels: [{ channelId: 'C1', name: 'deploys', trigger: 'mention' }]
      },
      {
        id: 'i2',
        agentId: 'elsewhere',
        name: 'other',
        platform: 'slack',
        workspace: 'x',
        status: 'online',
        channels: []
      }
    ]

    const html = render()

    expect(html).toContain('Agents on this cluster')
    expect(html).toContain('Connections held here')
    expect(html).toContain('acme-ops')
    expect(html).toContain('1 channel')
    // An integration whose agent runs elsewhere is not held here.
    expect(html).not.toContain('>other<')
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

  it('shows the REAL balance and chips only the figures it cannot serve', () => {
    // A fabricated balance beside a "Manage billing" link to the real one reads as headroom the
    // org has, so the one figure billing can already answer is live and the rest are marked.
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).toContain('Credits')
    expect(html).toContain('$38.74')
    expect(html).toContain('sample')
    expect(html).toContain('Manage billing')
    // Decoration, not a figure a reader could act on.
    expect(html).toContain('aria-hidden')
    // A plan's included usage is not derivable from load telemetry, so no bar pretends it is.
    expect(html).not.toContain('included')
  })

  it('keeps the sample total and the sample bars consistent with each other', () => {
    // They come from ONE series once wired, so the placeholder satisfies that invariant already.
    mocks.daemons = [member('p1')]

    // 146,600 cents across the 30 bars.
    expect(render()).toContain('$1,466.00')
  })

  it('lets the balance failure say which failure it was', () => {
    // A shape mismatch throws BillingShapeError into the same slot as an unreachable service, and
    // this console deploys ahead of the pinned billing image — so blaming the network guesses.
    mocks.daemons = [member('p1')]
    mocks.balance = { error: new Error('billing sent an unexpected account — the console may be out of date') }

    const html = render()

    expect(html).toContain('unavailable')
    expect(html).toContain('may be out of date')
    expect(html).not.toContain('Could not reach')
  })

  it('dates the axis relatively, so it cannot go stale', () => {
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).toContain('30 days ago')
    expect(html).toContain('today')
  })

  it('never generates the placeholder series, so it cannot read as live data', () => {
    mocks.daemons = [member('p1')]

    expect(render()).toBe(render())
  })

  it('offers no billing surface where the deployment has none', () => {
    setFlags('daemon-pool,managed')
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).toContain('AgentConnect Cloud')
    expect(html).not.toContain('Manage billing')
    expect(html).not.toContain('Credits')
  })

  it('still lists the runtimes, agents and connections Cloud offers', () => {
    mocks.daemons = [
      member('p1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus', 'sonnet'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]
    mocks.agents = [onPool('a1')]
    mocks.integrations = [
      {
        id: 'i1',
        agentId: 'a1',
        name: 'acme-ops',
        platform: 'slack',
        workspace: 'acme.slack.com',
        status: 'online',
        channels: [{ channelId: 'C1', name: 'deploys', trigger: 'mention' }]
      }
    ]

    const html = render()

    expect(html).toContain('Agents on Cloud')
    expect(html).toContain('acme-ops')
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
