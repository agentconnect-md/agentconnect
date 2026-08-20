// @vitest-environment happy-dom
/**
 * A pool member is a Pod: the pool rolls, every replacement mints another daemon row, and
 * all of them are visible to every org. Listed one card each, a healthy 3-replica deployment
 * read as a dozen look-alike "daemons" nobody could rename, restart or delete. The page
 * therefore shows the pool as ONE entry — and the machines someone actually connected as
 * theirs.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  daemons: [] as unknown[],
  agents: [] as unknown[],
  memberSets: [] as unknown[],
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-pool' }, myRole: 'viewer', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    daemonsLoading: false,
    agents: mocks.agents,
    memberSets: mocks.memberSets,
    refreshDaemons: vi.fn(async () => {}),
    renameDaemon: vi.fn()
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))

const DaemonsView = (await import('./DaemonsView')).default

function daemon(over: Partial<DaemonRow>): DaemonRow {
  return {
    daemonId: 'd',
    pool: false,
    name: 'edge-1',
    version: '1.41.0',
    latestVersion: '1.41.0',
    releaseChannel: 'latest',
    upgradeAvailable: false,
    availableVersions: [],
    lifecycleOp: null,
    lifecycleStatus: null,
    canManageLifecycle: false,
    status: 'online',
    host: 'edge-1',
    cpu: 10,
    mem: 20,
    loadAgents: 0,
    caps: { platforms: [], runtimes: [], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: [],
    activeSessions: '0',
    conns: '4',
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

/** A pool member as the CP reports it: org-less, named after its Pod. `daemonFromDto`
 *  relabels it, which is why the pod name lives in `host` alone. */
const member = (id: string, over: Partial<DaemonRow> = {}): DaemonRow =>
  daemon({ daemonId: id, pool: true, name: 'AgentConnect Cloud', host: `pool-member-${id}`, ...over })

/** An agent placed on the POOL as the live console models it: `agentFromDto` maps a set
 *  placement to the `pool` sentinel, never the ephemeral member id holding the duty. */
const onPool = (id: string): Agent => ({ id, daemon: 'pool', placementKind: 'set', setId: null }) as Agent

function render(): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => {
    root.render(<DaemonsView />)
  })
  const html = host.innerHTML
  act(() => root.unmount())
  host.remove()
  return html
}

/** The console shows the pool only where the deployment asked for it, and names it after the
 *  product only on the managed install (lib/feature-flags.ts). */
const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

beforeEach(() => {
  mocks.daemons = []
  mocks.agents = []
  mocks.memberSets = []
  mocks.push.mockClear()
  setFlags('daemon-pool,managed')
})

describe('DaemonsView pool', () => {
  it('shows one Cloud entry for the whole pool, however many Pods are in it', () => {
    mocks.daemons = [member('p1'), member('p2'), member('p3', { status: 'offline' })]

    const html = render()

    expect(html.match(/AgentConnect Cloud/g)).toHaveLength(1)
    // Cloud topology stays internal: no node count, no version on the managed card.
    expect(html).not.toContain('nodes')
    expect(html).not.toContain('1.41.0')
    // Pod identity is cluster churn — never a name this page puts in front of anyone.
    expect(html).not.toContain('pool-member-p1')
  })

  it('counts the agents across every member, not just the one it links to', () => {
    mocks.daemons = [member('p1'), member('p2')]
    mocks.agents = [onPool('a1'), onPool('a2'), onPool('a3')]

    const html = render()

    expect(html).toContain('agents on Cloud')
    expect(html).toContain('>3<')
  })

  it('reads offline only when no member is serving', () => {
    mocks.daemons = [member('p1', { status: 'offline' }), member('p2', { status: 'offline' })]

    const html = render()

    expect(html).toContain('not serving')
  })

  it('keeps the org’s own machines as their own cards under a labelled section', () => {
    mocks.daemons = [member('p1'), daemon({ daemonId: 'own', name: 'pc.dev' })]

    const html = render()

    expect(html).toContain('pc.dev')
    expect(html).toContain('Daemons')
  })

  it('offers no per-member actions — the pool is nobody’s to rename or detach', () => {
    mocks.daemons = [member('p1', { status: 'offline' })]

    const html = render()

    expect(html).not.toContain('Daemon actions')
    expect(html).not.toContain('Delete')
  })

  it('opens Cloud’s own page, never a member’s — no member id survives a rollout', () => {
    mocks.daemons = [member('dead', { status: 'offline' }), member('serving')]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
      root.render(<DaemonsView />)
    })
    act(() => {
      host.querySelector<HTMLElement>('.card.click')?.click()
    })
    act(() => root.unmount())
    host.remove()

    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/cluster')
  })

  it('still shows the empty state when there is no daemon of any kind', () => {
    const html = render()

    expect(html).toContain('No daemons connected')
  })

  it('names nothing about the pool where the deployment did not ask for it', () => {
    setFlags('')
    mocks.daemons = [member('p1'), daemon({ daemonId: 'own', name: 'pc.dev' })]
    mocks.agents = [onPool('a1')]

    const html = render()

    expect(html).not.toContain('AgentConnect Cloud')
    expect(html).not.toContain('agents on Cloud')
    expect(html).not.toContain('Kubernetes cluster')
    expect(html).toContain('pc.dev')
  })

  it('keeps the groups an org already made when hiding the pool empties the fleet', () => {
    // The two flags are independent switches. Hiding Cloud must not take the group surface
    // with it just because the pool rows were the only thing keeping the fleet non-empty.
    setFlags('daemon-groups')
    mocks.daemons = [member('p1')]
    mocks.memberSets = [{ setId: 'g1', name: 'edge-eu', memberDaemonIds: [], agentCount: 0 }]

    const html = render()

    expect(html).toContain('No daemons connected')
    expect(html).toContain('Daemon groups')
    expect(html).toContain('edge-eu')
  })

  it('reads as an empty fleet when the pool is all there is and it is hidden', () => {
    // Not "0 daemons of an unnamed kind": with the pool hidden the org connected nothing,
    // so the page has to say so — a blank fleet with no empty state is a page that broke.
    setFlags('')
    mocks.daemons = [member('p1'), member('p2')]

    const html = render()

    expect(html).toContain('No daemons connected')
  })
})

describe('DaemonsView pool — self-hosted', () => {
  // Without `managed` the pool is not a product this org bought: it is the operator's own
  // cluster, and the card has to say so or a self-hoster reads their own machines as a bill.
  beforeEach(() => setFlags('daemon-pool'))

  it('names the cluster rather than the product', () => {
    mocks.daemons = [member('p1'), member('p2')]

    const html = render()

    expect(html).not.toContain('AgentConnect Cloud')
    expect(html).not.toContain('Managed by AgentConnect')
    expect(html.match(/Kubernetes cluster/g)).toHaveLength(1)
    expect(html).toContain('2 nodes')
  })

  it('quotes the cluster’s own budget: agents running against the ceiling its members report', () => {
    mocks.daemons = [member('p1', { conns: '20', loadAgents: 7 }), member('p2', { conns: '40', loadAgents: 27 })]
    mocks.agents = [onPool('a1'), onPool('a2')]

    const html = render()

    expect(html).toContain('34 / 60')
    expect(html).toContain('57%')
    expect(html).toContain('Sandbox capacity in use')
    // The org's OWN agents there — a different number from the slots every org's agents fill.
    expect(html).toContain('agents on cluster')
    expect(html).toContain('>2<')
  })

  it('counts only the serving members towards the ceiling', () => {
    mocks.daemons = [member('p1', { conns: '10', loadAgents: 5 }), member('gone', { status: 'offline', conns: '10' })]

    const html = render()

    expect(html).toContain('5 / 10')
  })

  it('names an unbounded cluster ∞ — no ceiling is not a ceiling of zero', () => {
    // `maxAgents <= 0` is the daemon's UNBOUNDED sentinel (observability/pool-metrics.ts): a
    // cluster holding one has no finite budget, so quoting a total would advertise "full" about
    // a pool that can never be. What it IS running is still worth reading.
    mocks.daemons = [member('p1', { conns: '20', loadAgents: 7 }), member('p2', { conns: '0', loadAgents: 3 })]

    const html = render()

    expect(html).toContain('10 / ∞')
    expect(html).toContain('no limit')
    expect(html).toContain('Sandbox capacity in use')
    expect(html).toContain('agents on cluster')
  })

  it('says nothing about capacity while nothing is serving', () => {
    mocks.daemons = [member('p1', { status: 'offline', conns: '20' })]

    const html = render()

    expect(html).toContain('no nodes serving')
    expect(html).not.toContain('Sandbox capacity in use')
  })

  it('offers no Manage button — the card already opens what it would open', () => {
    mocks.daemons = [member('p1')]

    const html = render()

    expect(html).not.toContain('Manage')
  })

  it('opens the CLUSTER, never one of its Pods', () => {
    // A member id does not survive a rollout, so landing on one machine's page would name
    // the cluster after a Pod that is already gone.
    mocks.daemons = [member('dead', { status: 'offline' }), member('serving')]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
      root.render(<DaemonsView />)
    })
    act(() => {
      host.querySelector<HTMLElement>('.card.click')?.click()
    })
    act(() => root.unmount())
    host.remove()

    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/cluster')
  })

  it('still shows the whole cluster as ONE entry', () => {
    mocks.daemons = [member('p1'), member('p2'), member('p3')]

    const html = render()

    expect(html.match(/agents on cluster/g)).toHaveLength(1)
    expect(html).not.toContain('pool-member-p1')
  })
})
