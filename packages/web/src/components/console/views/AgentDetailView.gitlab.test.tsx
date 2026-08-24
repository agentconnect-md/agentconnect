// @vitest-environment happy-dom
/**
 * The GitLab triggers panel names the instance this deployment talks to, read
 * from the connection rather than assumed (gitlab-com-integration.md §24.1).
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  connections: [] as unknown[],
  fetchGitlabConnections: vi.fn()
}))

function answerWithConnections(): void {
  mocks.fetchGitlabConnections.mockImplementation(async () => ({ enabled: true, connections: mocks.connections }))
}
answerWithConnections()

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(),
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
    agents: [agent],
    getAgent: () => agent,
    getSessions: () => [],
    daemons: [],
    daemonsLoading: false,
    integrations: [],
    agentsLoading: false,
    updateAgent: vi.fn(async () => undefined),
    refresh: vi.fn(),
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => [gitlabHook]),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: mocks.fetchGitlabConnections
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

const gitlabHook = {
  id: 'hook-1',
  kind: 'gitlab',
  name: 'group/project',
  repoFullName: 'group/project',
  events: ['issue_comment'],
  commentFamilies: [],
  enabled: true
} as unknown as Parameters<typeof Object.freeze>[0]

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // A fresh cache per render: the instance is read under one key, so test order must not answer for it.
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentDetailView />
      </SWRConfig>
    )
  })
  return host.textContent ?? ''
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.connections = []
  mocks.fetchGitlabConnections.mockReset()
  answerWithConnections()
})

describe('AgentDetailView, GitLab triggers panel', () => {
  it('names the configured self-managed instance', async () => {
    mocks.connections = [{ id: 'c1', state: 'connected', instanceUrl: 'https://gitlab.example.test' }]
    const text = await render()
    expect(text).toContain('gitlab.example.test')
    expect(text).not.toContain('gitlab.com')
  })

  it('names no host while the read is still in flight', async () => {
    mocks.fetchGitlabConnections.mockImplementation(() => new Promise(() => {}))
    const text = await render()
    expect(text).toContain('group/project')
    expect(text).not.toContain('gitlab.')
  })

  it('names no host when the read fails', async () => {
    mocks.fetchGitlabConnections.mockImplementation(async () => {
      throw new Error('unreachable')
    })
    const text = await render()
    expect(text).toContain('group/project')
    expect(text).not.toContain('gitlab.')
  })

  it('names no host when the deployment reports no connection', async () => {
    const text = await render()
    expect(text).toContain('group/project')
    expect(text).not.toContain('gitlab.')
  })
})
