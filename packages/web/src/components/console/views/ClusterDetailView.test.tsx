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

const onPool = (id: string, daemonId: string, over: Partial<Agent> = {}): Agent =>
  ({ id, daemon: daemonId, name: id, status: 'online', runtime: 'claude', model: 'opus', ...over }) as Agent

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
    mocks.agents = [onPool('a1', 'p1')]

    const html = render()

    expect(html).toContain('2 models')
    expect(html).toContain('v0.54.1')
    expect(html).toContain('1 agent')
    expect(html).toContain('no agents')
  })

  it('lists the agents on the cluster and the connections they hold', () => {
    mocks.daemons = [member('p1')]
    mocks.agents = [onPool('a1', 'p1'), onPool('a2', 'p1')]
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
