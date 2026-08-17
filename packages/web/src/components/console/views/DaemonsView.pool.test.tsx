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
    memberSets: [],
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

const onPool = (id: string, daemonId: string): Agent => ({ id, daemon: daemonId }) as Agent

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

/** The console shows the pool only where the deployment asked for it (lib/experiments.ts). */
const setExperiments = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { EXPERIMENTS: value }
}

beforeEach(() => {
  mocks.daemons = []
  mocks.agents = []
  mocks.push.mockClear()
  setExperiments('daemon-pool')
})

describe('DaemonsView pool', () => {
  it('shows one Cloud entry for the whole pool, however many Pods are in it', () => {
    mocks.daemons = [member('p1'), member('p2'), member('p3', { status: 'offline' })]

    const html = render()

    expect(html.match(/AgentConnect Cloud/g)).toHaveLength(1)
    // Serving nodes only: a row left behind by a replaced Pod must not inflate the count.
    expect(html).toContain('2 nodes')
    // Pod identity is cluster churn — never a name this page puts in front of anyone.
    expect(html).not.toContain('pool-member-p1')
  })

  it('counts the agents across every member, not just the one it links to', () => {
    mocks.daemons = [member('p1'), member('p2')]
    mocks.agents = [onPool('a1', 'p1'), onPool('a2', 'p2'), onPool('a3', 'p2')]

    const html = render()

    expect(html).toContain('agents on Cloud')
    expect(html).toContain('>3<')
  })

  it('reads offline only when no member is serving', () => {
    mocks.daemons = [member('p1', { status: 'offline' }), member('p2', { status: 'offline' })]

    const html = render()

    expect(html).toContain('no nodes serving')
    expect(html).not.toContain('nodes ·')
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

  it('opens a serving member for the runtimes the pool offers', () => {
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

    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/serving')
  })

  it('still shows the empty state when there is no daemon of any kind', () => {
    const html = render()

    expect(html).toContain('No daemons connected')
  })

  it('names nothing about the pool where the deployment did not ask for it', () => {
    setExperiments('')
    mocks.daemons = [member('p1'), daemon({ daemonId: 'own', name: 'pc.dev' })]
    mocks.agents = [onPool('a1', 'p1')]

    const html = render()

    expect(html).not.toContain('AgentConnect Cloud')
    expect(html).not.toContain('agents on Cloud')
    expect(html).toContain('pc.dev')
  })

  it('reads as an empty fleet when the pool is all there is and it is hidden', () => {
    // Not "0 daemons of an unnamed kind": with the pool hidden the org connected nothing,
    // so the page has to say so — a blank fleet with no empty state is a page that broke.
    setExperiments('')
    mocks.daemons = [member('p1'), member('p2')]

    const html = render()

    expect(html).toContain('No daemons connected')
  })
})
