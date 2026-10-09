// @vitest-environment happy-dom
// The Activity tab is offered only for an assistant-mode agent, and only behind the console flag.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(),
  query: '',
  assistantMode: undefined as { enabled: boolean; responsibleUserId?: string } | undefined,
  canEdit: true
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
vi.mock('@/components/console/AssistantActivityPanel', () => ({
  AssistantActivityPanel: ({ agentId, canEdit }: { agentId: string; canEdit: boolean }) => (
    <div data-activity-panel={agentId} data-can-edit={String(canEdit)} />
  )
}))
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
    daemons: [],
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
    workspace: { mode: 'scratch', files: [] },
    integrations: [],
    visibility: 'org',
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
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the agent page’s Activity tab', () => {
  it('appears last for an assistant-mode agent behind the flag, and opens the panel', async () => {
    mocks.flags = new Set(['assistant-mode'])
    mocks.assistantMode = { enabled: true, responsibleUserId: 'usr-1' }
    mocks.query = 'tab=activity'
    const scope = await render()
    expect(tabs(scope).at(-1)).toEqual(['Activity', '/agents/agent-1?tab=activity'])
    expect(scope.querySelector('a.tab.on')?.textContent).toBe('Activity')
    const panel = scope.querySelector('[data-activity-panel]')
    expect(panel?.getAttribute('data-activity-panel')).toBe('agent-1')
    expect(panel?.getAttribute('data-can-edit')).toBe('true')
  })

  it('hands a viewer the panel read-only', async () => {
    mocks.flags = new Set(['assistant-mode'])
    mocks.assistantMode = { enabled: true, responsibleUserId: 'usr-1' }
    mocks.query = 'tab=activity'
    mocks.canEdit = false
    const scope = await render()
    expect(scope.querySelector('[data-activity-panel]')?.getAttribute('data-can-edit')).toBe('false')
  })

  it('is hidden with the flag off, even for an assistant-mode agent', async () => {
    mocks.assistantMode = { enabled: true, responsibleUserId: 'usr-1' }
    mocks.query = 'tab=activity'
    const scope = await render()
    expect(tabs(scope).map(([label]) => label)).not.toContain('Activity')
    expect(scope.querySelector('[data-activity-panel]')).toBeNull()
    // A link to the tab lands on Integrations instead.
    expect(scope.querySelector('a.tab.on')?.textContent).toBe('Integrations')
  })

  it('is hidden for an agent outside assistant mode, flag or not', async () => {
    mocks.flags = new Set(['assistant-mode'])
    mocks.query = 'tab=activity'
    for (const mode of [undefined, { enabled: false }]) {
      mocks.assistantMode = mode
      const scope = await render()
      expect(tabs(scope).map(([label]) => label)).toEqual([
        'Integrations',
        'Configuration',
        'Workspace',
        'Memory',
        'Tools & Skills'
      ])
      expect(scope.querySelector('[data-activity-panel]')).toBeNull()
      await act(async () => root!.unmount())
      host?.remove()
      root = undefined
    }
  })
})
