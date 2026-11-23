// @vitest-environment happy-dom
// An online daemon whose every runtime is logged out or missing cannot run anything; its card must say so.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ daemons: [] as unknown[], push: vi.fn(), openModal: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    daemonsLoading: false,
    agents: [],
    memberSets: [],
    refreshDaemons: vi.fn(async () => {}),
    renameDaemon: vi.fn()
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('../ComputersSection', () => ({ ComputersSection: () => null }))

const DaemonsView = (await import('./DaemonsView')).default

type Rt = DaemonRow['runtimeModels'][number]
const rt = (over: Partial<Rt>): Rt => ({ runtime: 'claude', version: '', models: [], ...over }) as Rt

function daemon(over: Partial<DaemonRow>): DaemonRow {
  return {
    daemonId: 'd1',
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
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    createdAtIso: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    createdAt: '',
    lastModifiedBy: '',
    lastModifiedAt: '',
    sessionRetention: '90d',
    workspaceRetention: '7d',
    visibility: 'org',
    sharedWith: [],
    canEdit: false,
    canManageSharing: false,
    ...over
  } as DaemonRow
}

function mount(): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => root.render(<DaemonsView />))
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

beforeEach(() => {
  mocks.daemons = []
  mocks.push.mockClear()
  mocks.openModal.mockClear()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: '' }
})

describe('DaemonsView runtime readiness', () => {
  it('opens the login command from the card in one click, without leaving the list', () => {
    mocks.daemons = [
      daemon({
        runtimeModels: [
          rt({ runtime: 'codex', unavailableReason: 'host-binary-missing' }),
          rt({ runtime: 'claude', authRequired: true })
        ]
      })
    ]
    const { host, unmount } = mount()
    const badge = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Runtime login required')
    expect(badge).toBeDefined()
    act(() => badge!.click())
    unmount()

    expect(mocks.openModal).toHaveBeenCalledWith('runtimeLogin', {
      runtimeId: 'claude',
      runtimeLabel: expect.any(String),
      daemonName: 'edge-1'
    })
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('names a host with nothing installed, leaving the fix to the detail page', () => {
    mocks.daemons = [daemon({ runtimeModels: [rt({ unavailableReason: 'host-binary-missing' })] })]
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()

    expect(html).toContain('No runtime installed')
    expect(html).not.toContain('Runtime login required')
  })

  it('stays quiet while any runtime is usable or still being checked, and for offline machines', () => {
    mocks.daemons = [
      daemon({
        daemonId: 'a',
        runtimeModels: [rt({ authRequired: true }), rt({ runtime: 'codex', acpProtocolVersion: 1 })]
      }),
      // no issue reported yet: the probe may still be running
      daemon({ daemonId: 'b', runtimeModels: [rt({})] }),
      daemon({ daemonId: 'c', runtimeModels: [] }),
      daemon({ daemonId: 'd', status: 'offline', runtimeModels: [rt({ authRequired: true })] })
    ]
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()

    expect(html).not.toContain('Runtime login required')
    expect(html).not.toContain('No runtime installed')
  })
})
