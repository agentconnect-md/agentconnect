// @vitest-environment happy-dom
// auto-session-mode.md §10: an agent's Playground is the member's private coordinator with it, where its daemon reads Auto.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  openPlayground: vi.fn(() => 'pg_1'),
  openCoordinator: vi.fn(async (): Promise<{ conversationId: string; sessionId?: string }> => ({
    conversationId: 'conv-co'
  })),
  features: [] as string[]
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mocks.push, replace: vi.fn() })
}))
vi.mock('next/link', () => ({
  default: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  )
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({ openPlayground: mocks.openPlayground })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/use-session-list', () => ({ useSessionList: () => ({ sessions: [], total: 0, isLoading: false }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({ runtimes: [] }), acpRuntime: () => null }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    getAgent: () => agent,
    getSessions: () => [],
    daemons: [
      { daemonId: 'd1', status: 'online', runtimeModels: [], caps: { features: mocks.features, platforms: [] } }
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
  openCoordinatorConversation: mocks.openCoordinator,
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] }))
}))

const agent = {
  id: 'agent-1',
  name: 'pilot',
  model: 'sonnet',
  runtime: 'claude',
  daemon: 'd1',
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
  workspace: { mode: 'scratch', files: [] },
  integrations: [],
  visibility: 'org'
} as unknown as Parameters<typeof Object.freeze>[0]

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function openPlaygroundButtons(): Promise<HTMLButtonElement[]> {
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
  return [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Playground')
}

beforeEach(() => {
  mocks.push.mockClear()
  mocks.openPlayground.mockClear()
  mocks.openCoordinator.mockClear()
  mocks.features = ['session-mode-auto-v1']
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe("an agent's Playground", () => {
  it('opens the coordinator session the member already has, on desktop and phone', async () => {
    mocks.openCoordinator.mockResolvedValue({ conversationId: 'conv-co', sessionId: 'sess-co' })
    const buttons = await openPlaygroundButtons()
    expect(buttons).toHaveLength(2)
    for (const button of buttons) await act(async () => button.click())
    expect(mocks.openCoordinator).toHaveBeenCalledWith('org-1', 'agent-1')
    expect(mocks.push.mock.calls).toEqual([['/sessions/sess-co'], ['/sessions/sess-co']])
    expect(mocks.openPlayground).not.toHaveBeenCalled()
  })

  it('opens a live session on the coordinator conversation before it has one', async () => {
    mocks.openCoordinator.mockResolvedValue({ conversationId: 'conv-co' })
    const [button] = await openPlaygroundButtons()
    await act(async () => button!.click())
    expect(mocks.openPlayground).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }), undefined, {
      conversationId: 'conv-co'
    })
    expect(mocks.push).toHaveBeenCalledWith('/sessions/pg_1')
  })

  it('opens an ordinary session where the daemon does not read Auto', async () => {
    mocks.features = []
    const [button] = await openPlaygroundButtons()
    await act(async () => button!.click())
    expect(mocks.openCoordinator).not.toHaveBeenCalled()
    expect(mocks.openPlayground).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }))
    expect(mocks.push).toHaveBeenCalledWith('/sessions/pg_1')
  })
})
