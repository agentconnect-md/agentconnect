// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ mobile: false, daemon: null as DaemonRow | null }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'd1' }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/example${path}` }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => false }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ daemons: [mocks.daemon], agents: [], memberSets: [], members: [] })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/components/console/FleetDetail', async (original) => ({
  ...(await original<typeof import('@/components/console/FleetDetail')>()),
  FleetUsageCard: () => null
}))

import DaemonDetailView from './DaemonDetailView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.daemon = {
    daemonId: 'd1',
    name: 'Example daemon',
    version: '1.0.0',
    status: 'online',
    pool: false,
    caps: { platforms: [], runtimes: ['claude', 'codex'], acp: true, features: ['sandbox'] },
    runtimeModels: [
      { runtime: 'claude', version: '9.0.0', hostVersion: '2.0.0', models: ['example-model'] },
      {
        runtime: 'codex',
        version: '3.0.0',
        hostVersion: '3.0.0',
        models: [],
        authRequired: true,
        unavailableReason: 'image-binary-missing'
      }
    ],
    cpu: 0,
    mem: 0,
    loadAgents: 0,
    conns: '4',
    activeSessions: '0',
    uptime: '1m',
    availableVersions: [],
    createdBy: '',
    lastModifiedBy: '',
    visibility: 'org',
    sharedWith: []
  } as unknown as DaemonRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(<DaemonDetailView />))
const control = () => host.querySelector('[aria-label="Runtime environment"]')
const choose = async (label: string) => {
  const button = Array.from(control()!.querySelectorAll('button')).find((b) => b.textContent === label)!
  await act(async () => button.click())
}

describe.each([false, true])('runtime environment view (mobile: %s)', (mobile) => {
  beforeEach(() => {
    mocks.mobile = mobile
  })

  it('defaults to host and switches versions and warnings without changing the reported facts', async () => {
    await render()
    expect(control()?.querySelector('[aria-pressed="true"]')?.textContent).toBe('Host')
    expect(host.textContent).toContain('v2.0.0')
    expect(host.textContent).not.toContain('v9.0.0')
    expect(host.textContent).toContain('Login required')
    expect(host.textContent).not.toContain('Binary not installed in image')

    await choose('Sandbox')
    expect(host.textContent).toContain('v9.0.0')
    expect(host.textContent).not.toContain('v2.0.0')
    expect(host.textContent).not.toContain('v3.0.0')
    expect(host.textContent).toContain('Binary not installed in image')
    expect(host.textContent).not.toContain('Login required')

    await choose('Host')
    expect(host.textContent).toContain('v3.0.0')
    expect(host.textContent).toContain('Login required')
    expect(host.textContent).not.toContain('Binary not installed in image')
    expect(mocks.daemon!.runtimeModels[1]!.unavailableReason).toBe('image-binary-missing')
  })

  it.each(['required', 'pool'])('shows only sandbox when policy is %s', async (policy) => {
    if (policy === 'pool') mocks.daemon!.pool = true
    else mocks.daemon!.caps.features.push('sandbox-required')
    await render()
    expect(control()).toBeNull()
    expect(host.textContent).toContain('Sandbox')
    expect(host.textContent).toContain('v9.0.0')
    expect(host.textContent).not.toContain('v2.0.0')
    expect(host.textContent).toContain('Binary not installed in image')
  })

  it('explains an unavailable sandbox while keeping host runtimes visible', async () => {
    mocks.daemon!.caps.features = []
    await render()
    expect(host.textContent).toContain('v2.0.0')
    await choose('Sandbox')
    expect(host.textContent).toContain('Sandbox is unavailable on this daemon.')
    expect(host.textContent).not.toContain('v9.0.0')
    await choose('Host')
    expect(host.textContent).toContain('v2.0.0')
  })
})
