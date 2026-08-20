// @vitest-environment happy-dom
/**
 * A daemon group has its own page because it is a placement TARGET, not a machine — and the
 * whole risk of the page is that it starts reading like whichever member happened to answer.
 * So these tests pin the two rules: every aggregate is over the members that are SERVING, and
 * the group itself never borrows a member's host, version or uptime.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, MemberSetRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  daemons: [] as unknown[],
  agents: [] as unknown[],
  integrations: [] as unknown[],
  memberSets: [] as unknown[],
  memberSetsLoading: false,
  routeId: 'g1',
  push: vi.fn(),
  openModal: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ id: mocks.routeId })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    agents: mocks.agents,
    integrations: mocks.integrations,
    memberSets: mocks.memberSets,
    memberSetsLoading: mocks.memberSetsLoading
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))

const GroupDetailView = (await import('./GroupDetailView')).default

function daemon(id: string, over: Partial<DaemonRow> = {}): DaemonRow {
  return {
    daemonId: id,
    pool: false,
    memberSetId: null,
    name: id,
    version: '1.41.0',
    latestVersion: '1.41.0',
    releaseChannel: 'latest',
    upgradeAvailable: false,
    availableVersions: [],
    lifecycleOp: null,
    lifecycleStatus: null,
    canManageLifecycle: true,
    status: 'online',
    host: `${id}.internal`,
    cpu: 20,
    mem: 40,
    loadAgents: 0,
    caps: { platforms: [], runtimes: [], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: [],
    activeSessions: '0',
    conns: '8',
    uptime: '1m',
    createdBy: '',
    createdAt: '',
    lastModifiedBy: '',
    lastModifiedAt: '',
    sessionRetention: '7d',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true,
    ...over
  } as DaemonRow
}

const group = (over: Partial<MemberSetRow> = {}): MemberSetRow => ({
  setId: 'g1',
  name: 'build-farm',
  memberDaemonIds: [],
  agentCount: 0,
  ...over
})

/** An agent placed on the GROUP: kind `set` plus the group's own set id — never a member id,
 *  because whichever member holds the duty is interchangeable. */
const onGroup = (id: string, setId = 'g1', over: Partial<Agent> = {}): Agent =>
  ({
    id,
    daemon: 'pool',
    placementKind: 'set',
    setId,
    placementReady: true,
    name: id,
    status: 'online',
    runtime: 'claude',
    model: 'opus',
    ...over
  }) as Agent

/** An agent PINNED to one machine — it does not move with the group and is not on it. */
const pinned = (id: string, daemonId: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    daemon: daemonId,
    placementKind: 'daemon',
    setId: null,
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
    root.render(<GroupDetailView />)
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
  mocks.memberSets = []
  mocks.memberSetsLoading = false
  mocks.routeId = 'g1'
  mocks.push.mockClear()
  mocks.openModal.mockClear()
  setFlags('daemon-groups')
})

describe('GroupDetailView', () => {
  it('names the group and its members, and reads them as one fleet', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [daemon('d1'), daemon('d2', { status: 'offline' })]

    const html = render()

    expect(html).toContain('build-farm')
    expect(html).toContain('Any daemon in the group')
    expect(html).toContain('2 daemons')
    // Serving is what routes work, so it is what the strip counts.
    expect(html).toContain('1 / 2')
  })

  it('is online while ANY member is serving', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [daemon('d1', { status: 'offline' }), daemon('d2')]

    // One serving member is what routes work, so it is what makes the group online.
    expect(render()).toContain('1 serving of 2')

    mocks.daemons = [daemon('d1', { status: 'offline' }), daemon('d2', { status: 'offline' })]

    const dark = render()
    expect(dark).toContain('0 serving of 2')
    // Nothing on the page is green once no member answers — the group's own badge included.
    expect(dark).not.toContain('var(--status-online)')
  })

  it('never borrows a member’s host, version or uptime for the group itself', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1', { host: 'builder.internal', version: '9.9.9', uptime: '31d' })]

    const html = render()

    // A group has no machine identity of its own — showing one is the bug this page avoids.
    expect(html).not.toContain('builder.internal')
    expect(html).not.toContain('9.9.9')
    expect(html).not.toContain('31d')
  })

  it('counts the agents placed on the GROUP, not the ones pinned to its members', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]
    mocks.agents = [onGroup('a1'), onGroup('elsewhere', 'g2'), pinned('a3', 'd1')]

    const html = render()

    expect(html).toContain('Agents on this group')
    expect(html).toContain('>a1<')
    // A group placement naming another set is not this group's.
    expect(html).not.toContain('>elsewhere<')
    // A pinned agent stays pinned — it is reported against its member, not the group.
    expect(html).not.toContain('>a3<')
  })

  it('unions the runtimes over the SERVING members only', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [
      daemon('d1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      }),
      daemon('d2', {
        status: 'offline',
        runtimeModels: [{ runtime: 'codex', version: '1.0.0', models: ['gpt-5'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]
    mocks.agents = [onGroup('a1')]

    const html = render()

    expect(html).toContain('Runtimes across the group')
    expect(html).toContain('v0.54.1')
    // A member that stopped answering can no longer offer a runtime.
    expect(html).not.toContain('v1.0.0')
    expect(html).toContain('1 agent')
  })

  it('lists the connections the group’s agents hold', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]
    mocks.agents = [onGroup('a1')]
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
        agentId: 'other',
        name: 'not-ours',
        platform: 'slack',
        workspace: 'x',
        status: 'online',
        channels: []
      }
    ]

    const html = render()

    expect(html).toContain('acme-ops')
    expect(html).toContain('1 channel')
    expect(html).not.toContain('not-ours')
  })

  it('opens a member’s own page, because that is where a machine’s detail lives', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
      root.render(<GroupDetailView />)
    })
    act(() => {
      host.querySelector<HTMLElement>('.row.click')?.click()
    })
    act(() => root.unmount())
    host.remove()

    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/d1')
  })

  it('says how to populate an empty group instead of showing an empty table', () => {
    mocks.memberSets = [group()]

    const html = render()

    expect(html).toContain('No daemons in this group')
    expect(html).toContain('0 / 0')
  })

  it('offers no log tail — a fabricated one is indistinguishable from telemetry', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]

    expect(render()).not.toContain('tail · local time')
  })

  it('404s on a set id this org does not own, and waits while the list loads', () => {
    mocks.routeId = 'nope'
    mocks.memberSets = [group()]

    expect(render()).toContain('Group not found')

    mocks.memberSetsLoading = true

    expect(render()).not.toContain('Group not found')
  })

  it('is not reachable where the deployment did not ask for groups', () => {
    setFlags('')
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]

    const html = render()

    expect(html).toContain('Group not found')
    expect(html).not.toContain('build-farm')
  })
})
