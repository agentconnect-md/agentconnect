// @vitest-environment happy-dom
/**
 * What a daemon lends its group's sessions, on the page that already lists it (session-executors.md
 * §10). Two rules the console cannot get wrong: a machine whose owner shared nothing must not read
 * as one with a capacity, and a strategy it cannot run must keep the reason rather than vanish —
 * that reason is the whole answer to "why is nothing landing here".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ daemons: [] as unknown[] }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
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
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))

const DaemonsView = (await import('./DaemonsView')).default

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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
    hostedSessions: null,
    conns: '4',
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

function render(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => {
    root.render(<DaemonsView />)
  })
  return host
}

beforeEach(() => {
  mocks.daemons = []
  document.body.innerHTML = ''
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: '' }
})

describe('DaemonsView — what a daemon lends its group', () => {
  it('names the sessions it hosts against its capacity, beside the strategies it offers', () => {
    mocks.daemons = [
      daemon({
        hostedSessions: 2,
        caps: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [],
          executor: { enabled: true, strategies: { host: { available: true } }, capacity: 8 }
        }
      })
    ]

    const html = render().innerHTML

    expect(html).toContain('2 / 8 sessions')
    expect(html).toContain('>host<')
  })

  it('keeps a strategy it cannot run, with the reason on hover', () => {
    mocks.daemons = [
      daemon({
        hostedSessions: 0,
        caps: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [],
          executor: {
            enabled: true,
            strategies: { host: { available: true }, microsandbox: { available: false, reason: 'no backend here' } },
            capacity: 4
          }
        }
      })
    ]

    const host = render()

    expect(host.innerHTML).toContain('microsandbox unavailable')
    const chip = [...host.querySelectorAll('[title]')].find((el) => el.textContent?.includes('microsandbox'))
    expect(chip?.getAttribute('title')).toBe('no backend here')
  })

  it('says nothing at all about a daemon whose owner shared nothing', () => {
    // No facet, no capacity: the machine's own `sandbox.share` is off, so a "0 / n" here would
    // report a limit it does not have — and an operator would read it as a full machine.
    mocks.daemons = [daemon({ hostedSessions: 3 })]

    const html = render().innerHTML

    expect(html).not.toContain('sessions')
    expect(html).toContain('edge-1')
  })

  it('counts nothing hosted until the daemon has reported a count', () => {
    mocks.daemons = [
      daemon({
        hostedSessions: null,
        caps: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [],
          executor: { enabled: true, strategies: { host: { available: true } }, capacity: 6 }
        }
      })
    ]

    expect(render().innerHTML).toContain('0 / 6 sessions')
  })

  it('states the count alone when the daemon named no ceiling', () => {
    // `limits.maxConcurrentSessions` is what the capacity IS, so a daemon that reports none has no
    // ceiling to show against — and inventing one would be a limit nothing enforces.
    mocks.daemons = [
      daemon({
        hostedSessions: 1,
        caps: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [],
          executor: { enabled: true, strategies: { host: { available: true } } }
        }
      })
    ]

    const html = render().innerHTML

    expect(html).toContain('1 session')
    expect(html).not.toContain(' / ')
  })
})
