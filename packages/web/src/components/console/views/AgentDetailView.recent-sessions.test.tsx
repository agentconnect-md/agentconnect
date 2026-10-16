// @vitest-environment happy-dom
// The agent page's Recent card and header count leave tasks out, as All sessions does.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const row = (over: Record<string, unknown>) => ({
  agentId: 'agent-1',
  platform: 'slack',
  channel: '#eng',
  time: '2m',
  status: 'idle',
  steps: [],
  ...over
})
const mocks = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
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
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ openPlayground: vi.fn() }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
// Answers as the Control Plane does: `tasks=exclude` leaves the `subsession` rows out of the rows and the total.
vi.mock('@/lib/use-session-list', () => ({
  useSessionList: (orgId: string | null | undefined, filters: { excludeTasks?: boolean } = {}) => {
    const sessions = orgId ? mocks.rows.filter((r) => !(filters.excludeTasks && r.subsession)) : []
    return { sessions, total: sessions.length, isLoading: false }
  }
}))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({ runtimes: [] }), acpRuntime: () => null }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    getAgent: () => agent,
    getSessions: () => mocks.rows,
    daemons: [],
    daemonsLoading: false,
    integrations: [],
    bots: [],
    crons: [],
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

const agent = {
  id: 'agent-1',
  name: 'pilot',
  model: 'sonnet',
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
  workspace: { mode: 'scratch', files: [] },
  integrations: [],
  visibility: 'org'
} as unknown as Parameters<typeof Object.freeze>[0]

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

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the agent page without tasks', () => {
  it('lists and counts real sessions only', async () => {
    mocks.rows = [
      row({ id: 's-task', title: 'Follow-up check on the release', subsession: true }),
      row({ id: 's-real', title: 'Release checklist' })
    ]
    const scope = await render()
    expect(scope.textContent).toContain('Release checklist')
    expect(scope.textContent).not.toContain('Follow-up check on the release')
    expect(scope.textContent).toContain('1 session')
    expect(scope.textContent).not.toContain('2 sessions')
  })
})
