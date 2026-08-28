// @vitest-environment happy-dom
/**
 * The Configuration rows read the runtime catalog through the PLACEMENT, not through a member id.
 * A set placement carries the pool sentinel in `daemon`, which matches no daemon row — resolving
 * it as a machine found nothing and printed an em-dash model for every Cloud and group agent,
 * even one with a model explicitly saved.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, MemberSetRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: {} as unknown,
  daemons: [] as unknown[],
  memberSets: [] as unknown[],
  tab: 'tab=config'
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(mocks.tab),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}))
vi.mock('next/link', () => ({ default: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ openPlayground: vi.fn() }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/use-session-list', () => ({ useSessionList: () => ({ sessions: [], total: 0, isLoading: false }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({ runtimes: [] }), acpRuntime: () => null }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [mocks.agent],
    getAgent: () => mocks.agent,
    getSessions: () => [],
    daemons: mocks.daemons,
    daemonsLoading: false,
    integrations: [],
    agentsLoading: false,
    updateAgent: vi.fn(async () => undefined),
    refresh: vi.fn(),
    memberSets: mocks.memberSets,
    orgSetIds: new Set((mocks.memberSets as MemberSetRow[]).map((set) => set.setId))
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] }))
}))

/** One daemon reporting a claude catalog. `pool` and `memberSetId` are what a set resolves through. */
function daemon(over: Partial<DaemonRow>): DaemonRow {
  return {
    daemonId: 'd1',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    status: 'online',
    caps: { platforms: [], runtimes: ['claude'], acp: true, features: [] },
    runtimeModels: [
      {
        runtime: 'claude',
        version: '2.0.0',
        models: ['opus', 'sonnet'],
        acpProtocolVersion: 1,
        mcpCapabilities: null,
        modelCatalog: {
          defaultModel: 'sonnet',
          models: [
            { id: 'opus', name: 'Opus' },
            { id: 'sonnet', name: 'Sonnet' }
          ]
        },
        authRequired: false
      }
    ],
    mcpServers: [],
    ...over
  } as unknown as DaemonRow
}

function agentOn(placement: Partial<Agent>): Agent {
  return {
    id: 'agent-1',
    name: 'pilot',
    model: 'opus',
    runtime: 'claude',
    desc: '',
    outputMode: '—',
    showFooter: true,
    showStatusBar: false,
    reasoning: '',
    fastMode: false,
    pause: false,
    memoryProvider: 'none',
    memoryAutoDistill: false,
    status: 'online',
    placementReady: true,
    workspace: { mode: 'scratch', files: [] },
    integrations: [],
    visibility: 'org',
    callableBy: 'all',
    allowedCallerAgentIds: [],
    canCall: 'all',
    allowedTargetAgentIds: [],
    env: [],
    secretKeys: [],
    organizationVariables: [],
    organizationSecretKeys: [],
    hookKinds: [],
    sharedWith: [],
    permissionMode: '',
    createdBy: '',
    createdAt: '',
    lastModifiedBy: '',
    lastModifiedAt: '',
    region: '—',
    repo: '—',
    workdir: '—',
    tokens: '—',
    cost: '—',
    ...placement
  } as unknown as Agent
}

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentDetailView />
      </SWRConfig>
    )
  })
  return host.textContent ?? ''
}

/** The Integrations grid's tiles by label, with the greyed-out treatment each carries. */
function tileStates(): Record<string, boolean> {
  const tiles = host!.querySelectorAll('[aria-disabled]')
  return Object.fromEntries(
    [...tiles].map((tile) => [(tile.textContent ?? '').trim(), tile.getAttribute('aria-disabled') === 'true'])
  )
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.daemons = []
  mocks.memberSets = []
  mocks.tab = 'tab=config'
})

describe('AgentDetailView, model row by placement', () => {
  it('names the saved model for a POOL agent, which names no member', async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null })
    mocks.daemons = [daemon({ daemonId: 'pod-1', pool: true })]
    const text = await render()
    expect(text).toContain('opus')
  })

  it("falls back to the pool catalog's own default when no model is saved", async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null, model: '' })
    mocks.daemons = [daemon({ daemonId: 'pod-1', pool: true })]
    const text = await render()
    expect(text).toContain('sonnet')
  })

  it('reads a GROUP placement through one of its members', async () => {
    mocks.agent = agentOn({ daemon: 'set:g1', placementKind: 'set', setId: 'g1' })
    mocks.memberSets = [{ setId: 'g1', name: 'lab', memberDaemonIds: ['lab-1'], agentCount: 1 }]
    mocks.daemons = [daemon({ daemonId: 'lab-1', memberSetId: 'g1' })]
    const text = await render()
    expect(text).toContain('opus')
  })

  it('still names a single machine’s model through that machine', async () => {
    mocks.agent = agentOn({ daemon: 'd1', placementKind: 'daemon', setId: null })
    mocks.daemons = [daemon({})]
    const text = await render()
    expect(text).toContain('opus')
  })

  it('keeps the em-dash when nothing reports a catalog at all', async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null })
    mocks.daemons = [daemon({ daemonId: 'pod-1', pool: true, runtimeModels: [] })]
    const text = await render()
    expect(text).not.toContain('opus')
    expect(text).toContain('—')
  })
})

describe('AgentDetailView, platform grid by placement', () => {
  it("greys out a bot platform the POOL's members do not advertise", async () => {
    mocks.tab = ''
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null })
    mocks.daemons = [
      daemon({
        daemonId: 'pod-1',
        pool: true,
        caps: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
      })
    ]
    await render()
    const tiles = tileStates()
    expect(tiles['Slack']).toBe(false)
    expect(tiles['Telegram']).toBe(true)
    // Relay/CP-backed triggers ride no daemon adapter, so they stay selectable.
    expect(tiles['Webhook']).toBe(false)
    expect(tiles['GitHub']).toBe(false)
  })

  it('keeps every platform selectable for an UNPLACED agent', async () => {
    mocks.tab = ''
    mocks.agent = agentOn({
      daemon: '—',
      placementKind: 'daemon',
      setId: null,
      status: 'offline',
      placementReady: false
    })
    mocks.daemons = []
    await render()
    expect(Object.values(tileStates()).every((disabled) => !disabled)).toBe(true)
  })
})
