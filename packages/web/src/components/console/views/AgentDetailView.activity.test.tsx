// @vitest-environment happy-dom
// The Activity tab is offered for an assistant-mode agent whatever the console flag, which only offers switching the mode on, and for any other agent whose daemon serves it.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(),
  query: '',
  assistantMode: undefined as { enabled: boolean } | undefined,
  canEdit: true,
  /** What the agent's daemon advertises. */
  features: [] as string[]
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}))
vi.mock('next/link', () => ({
  default: ({ children, className, href }: { children?: ReactNode; className?: string; href?: string }) => (
    <a className={className} href={href}>
      {children}
    </a>
  )
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => mocks.flags.has(id) }))
vi.mock('@/components/console/MemoryPanel', () => ({ MemoryPanel: () => <div data-memory-panel /> }))
vi.mock('@/components/console/AssistantModePanel', () => ({
  AssistantModePanel: ({ assistantMode }: { assistantMode?: { enabled: boolean } }) => (
    <div data-assistant-mode-panel={String(assistantMode?.enabled === true)} />
  )
}))
vi.mock('@/components/console/AssistantActivityPanel', () => ({
  AssistantActivityPanel: ({ agentId, canEdit }: { agentId: string; canEdit: boolean }) => (
    <div data-activity-panel={agentId} data-can-edit={String(canEdit)} />
  )
}))
vi.mock('@/components/console/AgentCapabilityRequestsCard', () => ({
  AgentCapabilityRequestsCard: ({ agentId }: { agentId: string }) => <div data-capability-requests-card={agentId} />
}))
vi.mock('@/lib/use-daemon-detail', () => ({ useDaemonDetail: (row: unknown) => row }))
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
    agents: [agent()],
    getAgent: () => agent(),
    getSessions: () => [],
    daemons: [
      {
        daemonId: 'daemon-1',
        name: 'edge-1',
        pool: false,
        memberSetId: null,
        status: 'online',
        caps: { platforms: [], runtimes: ['claude-acp'], acp: true, features: mocks.features },
        runtimeModels: [],
        mcpServers: []
      }
    ],
    daemonsLoading: false,
    integrations: [],
    bots: [],
    agentsLoading: false,
    updateAgent: vi.fn(async () => undefined),
    refresh: vi.fn(),
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] }))
}))

function agent() {
  return {
    id: 'agent-1',
    name: 'pilot',
    model: 'sonnet',
    runtime: 'claude-acp',
    desc: '',
    outputMode: '—',
    showFooter: true,
    showStatusBar: false,
    reasoning: '',
    fastMode: false,
    pause: false,
    memoryProvider: 'managed',
    memoryAutoDistill: false,
    status: 'online',
    daemon: 'daemon-1',
    workspace: { mode: 'scratch', files: [] },
    integrations: [],
    visibility: 'org',
    permissionMode: 'default',
    chatActions: 'approve',
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
    canEdit: mocks.canEdit,
    ...(mocks.assistantMode ? { assistantMode: mocks.assistantMode } : {})
  } as unknown as Parameters<typeof Object.freeze>[0]
}

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<HTMLDivElement> {
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
  return host
}

/** The tab strip's labels, in order: one strip serves both widths. */
const tabs = (scope: HTMLElement) =>
  [...scope.querySelectorAll('a.tab')].map((a) => [a.textContent, a.getAttribute('href')] as const)

beforeEach(() => {
  mocks.flags = new Set()
  mocks.query = ''
  mocks.assistantMode = undefined
  mocks.canEdit = true
  mocks.features = []
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the agent page’s Activity tab', () => {
  it('appears last for an assistant-mode agent, and opens the panel', async () => {
    mocks.assistantMode = { enabled: true }
    mocks.query = 'tab=activity'
    const scope = await render()
    expect(tabs(scope).at(-1)).toEqual(['Activity', '/agents/agent-1?tab=activity'])
    expect(scope.querySelector('a.tab.on')?.textContent).toBe('Activity')
    const panel = scope.querySelector('[data-activity-panel]')
    expect(panel?.getAttribute('data-activity-panel')).toBe('agent-1')
    expect(panel?.getAttribute('data-can-edit')).toBe('true')
    // The agent's open capability requests head the tab, ahead of its tasks.
    const requests = scope.querySelector('[data-capability-requests-card]')
    expect(requests?.getAttribute('data-capability-requests-card')).toBe('agent-1')
    expect(requests?.compareDocumentPosition(panel!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('appears for an assistant-mode agent whether or not its daemon serves every agent', async () => {
    mocks.assistantMode = { enabled: true }
    mocks.query = 'tab=activity'
    mocks.features = ['activity-every-agent-v1']
    const scope = await render()
    expect(tabs(scope).at(-1)).toEqual(['Activity', '/agents/agent-1?tab=activity'])
  })

  it('appears for an agent outside assistant mode whose daemon serves every agent’s', async () => {
    mocks.features = ['activity-every-agent-v1']
    mocks.query = 'tab=activity'
    for (const mode of [undefined, { enabled: false }]) {
      mocks.assistantMode = mode
      const scope = await render()
      expect(tabs(scope).at(-1)).toEqual(['Activity', '/agents/agent-1?tab=activity'])
      expect(scope.querySelector('a.tab.on')?.textContent).toBe('Activity')
      const panel = scope.querySelector('[data-activity-panel]')
      expect(panel?.getAttribute('data-activity-panel')).toBe('agent-1')
      await act(async () => root!.unmount())
      host?.remove()
      root = undefined
    }
  })

  it('hands a viewer the panel read-only', async () => {
    mocks.assistantMode = { enabled: true }
    mocks.query = 'tab=activity'
    mocks.canEdit = false
    const scope = await render()
    expect(scope.querySelector('[data-activity-panel]')?.getAttribute('data-can-edit')).toBe('false')
  })

  it('is hidden for an agent outside assistant mode whose daemon serves only assistant mode’s', async () => {
    mocks.features = ['assistant-activity-v1', 'assistant-subsession-panel-v1']
    mocks.query = 'tab=activity'
    for (const mode of [undefined, { enabled: false }]) {
      mocks.assistantMode = mode
      const scope = await render()
      expect(tabs(scope).map(([label]) => label)).toEqual([
        'Integrations',
        'Configuration',
        'Workspace',
        'Memory',
        'Knowledge',
        'Tools'
      ])
      expect(scope.querySelector('[data-activity-panel]')).toBeNull()
      await act(async () => root!.unmount())
      host?.remove()
      root = undefined
    }
  })
})

describe('the agent’s open capability requests', () => {
  const cards = (scope: HTMLElement) => [...scope.querySelectorAll('[data-capability-requests-card]')]

  it('head the default tab of an agent with no Activity tab, and appear nowhere else', async () => {
    const scope = await render()
    expect(scope.querySelector('a.tab.on')?.textContent).toBe('Integrations')
    expect(cards(scope).map((card) => card.getAttribute('data-capability-requests-card'))).toEqual(['agent-1'])
    expect(scope.querySelector('[data-capability-requests-slot="integrations"]')).toBeTruthy()
  })

  it('stay in the Activity tab of an agent that has one, never also on its default tab', async () => {
    mocks.assistantMode = { enabled: true }
    const integrations = await render()
    expect(cards(integrations)).toEqual([])
    await act(async () => root!.unmount())
    host?.remove()
    mocks.query = 'tab=activity'
    const activity = await render()
    expect(cards(activity)).toHaveLength(1)
  })
})

describe('the assistant mode switch', () => {
  const panel = async () => {
    mocks.query = 'tab=config'
    const scope = await render()
    return scope.querySelector('[data-assistant-mode-panel]')?.getAttribute('data-assistant-mode-panel')
  }

  it('sits on the Configuration tab, not the Memory tab', async () => {
    mocks.assistantMode = { enabled: true }
    expect(await panel()).toBe('true')
    await act(async () => root!.unmount())
    host?.remove()
    root = undefined
    mocks.query = 'tab=memory'
    const memory = await render()
    expect(memory.querySelector('[data-memory-panel]')).toBeTruthy()
    expect(memory.querySelector('[data-assistant-mode-panel]')).toBeNull()
  })

  it('is offered whether the agent is on or off, so it can be switched either way', async () => {
    for (const [mode, shown] of [
      [undefined, 'false'],
      [{ enabled: false }, 'false'],
      [{ enabled: true }, 'true']
    ] as const) {
      mocks.assistantMode = mode
      expect(await panel()).toBe(shown)
      await act(async () => root!.unmount())
      host?.remove()
      root = undefined
    }
  })
})
