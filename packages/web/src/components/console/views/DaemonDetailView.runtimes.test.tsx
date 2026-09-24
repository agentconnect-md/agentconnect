// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ mobile: false, daemon: null as DaemonRow | null, agents: [] as Agent[] }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'd1' }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/example${path}` }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => false }))
vi.mock('@/lib/acp-registry', () => ({
  useAcpRegistry: () => ({}),
  acpRuntime: (_registry: unknown, id: string) => (id === 'opencode' ? { name: 'OpenCode' } : undefined)
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ daemons: [mocks.daemon], agents: mocks.agents, memberSets: [], members: [] })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/components/console/FleetDetail', async (original) => ({
  ...(await original<typeof import('@/components/console/FleetDetail')>()),
  FleetUsageCard: () => null,
  FleetAgentsCard: () => null
}))

import DaemonDetailView from './DaemonDetailView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.agents = []
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
    if (policy === 'pool') {
      mocks.daemon!.pool = true
      // The pod is a pool agent's boundary, so the pool keeps one view even beside a table.
      mocks.daemon!.caps.strategies = { host: { available: true }, microsandbox: { available: true } }
    } else mocks.daemon!.caps.features.push('sandbox-required')
    mocks.daemon!.runtimeModels.push({
      runtime: 'opencode',
      version: '1',
      models: [],
      hostAvailable: false,
      credentialsConfigured: false,
      authRequired: true
    })
    await render()
    expect(control()).toBeNull()
    expect(host.textContent).toContain('Sandbox')
    expect(host.textContent).toContain('v9.0.0')
    expect(host.textContent).not.toContain('v2.0.0')
    expect(host.textContent).toContain('Binary not installed in image')
    expect(host.textContent?.includes('OpenCode')).toBe(policy === 'pool')
    expect(host.textContent?.includes('Show runtimes not on host')).toBe(policy !== 'pool')
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

  it.each(['Host', 'Sandbox'])('applies all four installation/login states in %s', async (environment) => {
    mocks.daemon!.runtimeModels = [
      { runtime: 'opencode', version: '1', models: [], hostAvailable: true, credentialsConfigured: true },
      {
        runtime: 'codex',
        version: '1',
        models: [],
        hostAvailable: true,
        credentialsConfigured: false,
        authRequired: true
      },
      {
        runtime: 'claude',
        version: '1',
        models: [],
        hostAvailable: false,
        credentialsConfigured: true,
        authRequired: true,
        unavailableReason: 'image-binary-missing'
      },
      {
        runtime: 'grok-build',
        version: '1',
        models: [],
        hostAvailable: false,
        credentialsConfigured: false,
        authRequired: true,
        unavailableReason: 'image-binary-missing'
      }
    ]
    await render()
    if (environment === 'Sandbox') await choose(environment)
    expect(host.textContent).toContain('OpenCode')
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).toContain('Claude')
    expect(host.textContent?.toLowerCase()).not.toContain('grok')
    expect(host.textContent?.match(/Login required/g)).toHaveLength(1)
    expect(host.textContent?.match(/Binary not installed/g)).toHaveLength(1)
    expect(host.textContent).toContain(
      environment === 'Host' ? 'Binary not installed on host' : 'Binary not installed in image'
    )
  })

  it.each([false, true])(
    'folds image-only runtimes, preserving saved login state (%s)',
    async (credentialsConfigured) => {
      mocks.daemon!.runtimeModels = [
        {
          runtime: 'opencode',
          version: '1',
          models: [],
          hostAvailable: false,
          credentialsConfigured,
          authRequired: true
        },
        {
          runtime: 'codex',
          version: '1',
          models: [],
          hostAvailable: true,
          credentialsConfigured: false,
          authRequired: true,
          unavailableReason: 'image-binary-missing'
        }
      ]
      await render()
      expect(host.textContent?.includes('OpenCode')).toBe(credentialsConfigured)
      expect(host.textContent).toContain('Codex')
      await choose('Sandbox')
      expect(host.textContent).not.toContain('OpenCode')
      expect(host.textContent).not.toContain('Login required')
      expect(host.textContent).toContain('Expand below to see runtimes not installed on host.')
      const disclosure = Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Show runtimes not on host (1)')
      )!
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      await act(async () => disclosure.click())
      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
      expect(host.textContent).toContain('OpenCode')
      expect(host.textContent).not.toContain('Codex')
      expect(host.textContent?.match(/Login required/g)).toHaveLength(1)
      expect(host.textContent).not.toContain('Binary not installed')
      await act(async () => disclosure.click())
      expect(host.textContent).not.toContain('OpenCode')
      expect(mocks.daemon!.runtimeModels[0]!.credentialsConfigured).toBe(credentialsConfigured)
    }
  )
})

const KVM = 'microsandbox needs a usable /dev/kvm'
const agent = (id: string, execution: string) =>
  ({
    id,
    name: id,
    daemon: 'd1',
    runtime: 'claude',
    model: 'example-model',
    execution,
    runInSandbox: execution !== 'host',
    status: 'online'
  }) as unknown as Agent
const expand = async (label: string) => {
  const button = Array.from(host.querySelectorAll('button[aria-expanded]')).find((b) =>
    b.textContent?.includes(label)
  ) as HTMLButtonElement
  await act(async () => button.click())
}

describe.each([false, true])('one runtime tab per strategy in the daemon’s table (mobile: %s)', (mobile) => {
  beforeEach(() => {
    mocks.mobile = mobile
    mocks.daemon!.caps.strategies = {
      microsandbox: { available: false, reason: KVM },
      srt: { available: true },
      host: { available: true }
    }
    mocks.daemon!.runtimeModels = [
      {
        runtime: 'claude',
        version: '9.0.0',
        hostVersion: '2.0.0',
        models: ['host-model'],
        strategies: {
          host: { available: true, models: ['host-model'] },
          srt: { available: true, models: ['srt-model', 'srt-model-2'], modelsSource: 'cached' },
          microsandbox: { available: false, unavailableReason: KVM }
        }
      },
      {
        runtime: 'codex',
        version: '3.0.0',
        hostVersion: '3.0.0',
        models: [],
        credentialsConfigured: false,
        authRequired: true,
        strategies: {
          host: { available: true },
          srt: { available: false, unavailableReason: 'this runtime is not installed on this host' },
          microsandbox: { available: false, unavailableReason: KVM }
        }
      }
    ]
    mocks.agents = [agent('a1', 'host'), agent('a2', 'srt'), agent('a3', 'srt')]
  })

  it('names each tab plainly in a stable order, with its technology and boundary in the tooltip', async () => {
    await render()
    const tabs = Array.from(control()!.querySelectorAll('button'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Host', 'Sandbox', 'VM'])
    expect(tabs.map((tab) => tab.getAttribute('title'))).toEqual([
      'No isolation boundary: sessions run directly on the machine.',
      'SRT: process isolation with bubblewrap, on Linux.',
      'microsandbox: one microVM per session. Needs KVM.'
    ])
    expect(control()?.querySelector('[aria-pressed="true"]')?.textContent).toBe('Host')
  })

  it('lists the runtimes a strategy starts, with their models there and the agents that run in it', async () => {
    await render()
    expect(host.textContent).toContain('v2.0.0 · 1 agent1 model')
    expect(host.textContent).toContain('Codex')
    await choose('Sandbox')
    expect(host.textContent).toContain('v2.0.0 · 2 agents2 models')
    expect(host.textContent).not.toContain('Codex')
    await expand('Claude')
    expect(host.textContent).toContain('srt-model-2')
  })

  it('shows an unavailable strategy’s probe reason instead of runtimes', async () => {
    await render()
    await choose('VM')
    expect(host.textContent).toContain(`VM is unavailable on this daemon. ${KVM}`)
    expect(host.textContent).not.toContain('v2.0.0')
    await choose('Host')
    expect(host.textContent).toContain('v2.0.0')
  })
})
