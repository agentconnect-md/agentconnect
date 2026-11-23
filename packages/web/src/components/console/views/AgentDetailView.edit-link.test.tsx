// @vitest-environment happy-dom
// A chat app's out-of-credits notice links `?tab=config&edit=placement`: Edit opens at Runs on once, then the param leaves the URL.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, MemberSetRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: {} as unknown,
  daemons: [] as unknown[],
  memberSets: [] as unknown[],
  tab: 'tab=config',
  openModal: vi.fn(),
  replace: vi.fn()
}))

// The page's routing reads key off the API mode and organization; an empty one makes no request.
vi.mock('@/lib/decisions/provider', () => ({
  useOptionalDecisionsPrototype: () => ({ decisions: [], api: { mode: 'live' }, orgId: '' }),
  useDecisionProviders: () => ({ providers: [], daemonId: null, error: null })
}))
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(mocks.tab),
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace })
}))
vi.mock('next/link', () => ({ default: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ openPlayground: vi.fn() }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/components/console/AssistantModePanel', () => ({ AssistantModePanel: () => null }))
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
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] }))
}))

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

const cache = new Map()
const tree = () => (
  <SWRConfig value={{ provider: () => cache }}>
    <AgentDetailView />
  </SWRConfig>
)

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(tree()))
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.tab = 'tab=config'
  mocks.openModal.mockReset()
  mocks.replace.mockReset()
})

describe('AgentDetailView, edit=placement deep link', () => {
  it('opens Edit at Basics, where Runs on lives, once, and keeps the config tab', async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null, canEdit: true })
    mocks.tab = 'tab=config&edit=placement'
    await render()
    // The URL still reads `edit=placement` here, as the mock does not apply the replace: a re-render must not reopen.
    await act(async () => root!.render(tree()))
    expect(mocks.openModal).toHaveBeenCalledTimes(1)
    expect(mocks.openModal).toHaveBeenCalledWith('editAgent', mocks.agent, { focusSection: 'basics' })
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith('/agents/agent-1?tab=config', { scroll: false })
  })

  it('lands a viewer who cannot edit on the config tab without a dialog', async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null, canEdit: false })
    mocks.tab = 'tab=config&edit=placement'
    await render()
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith('/agents/agent-1?tab=config', { scroll: false })
  })

  it('does nothing without the param', async () => {
    mocks.agent = agentOn({ daemon: 'pool', placementKind: 'set', setId: null, canEdit: true })
    await render()
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
