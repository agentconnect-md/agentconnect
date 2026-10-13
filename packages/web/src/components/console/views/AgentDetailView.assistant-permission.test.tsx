// @vitest-environment happy-dom
// assistant-mode.md §1.8: turning assistant mode on defaults the permission mode, and the page shows the mode it got.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Policy = { enabled: boolean }

const mocks = vi.hoisted(() => ({
  query: 'tab=memory',
  permissionMode: 'default',
  assistantMode: undefined as Policy | undefined,
  updateAgent: vi.fn()
}))

vi.mock('@/lib/decisions/provider', () => ({
  useOptionalDecisionsPrototype: () => ({ decisions: [], api: { mode: 'live' }, orgId: '' })
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
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => id === 'assistant-mode' }))
vi.mock('@/components/console/MemoryPanel', () => ({ MemoryPanel: () => <div data-memory-panel /> }))
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
    members: [
      {
        userId: 'usr-1',
        email: 'ada@example.test',
        name: 'Ada',
        picture: null,
        role: 'owner',
        isCurrentUser: true,
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    agentsLoading: false,
    updateAgent: mocks.updateAgent,
    refresh: vi.fn(),
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentAssistantModeAdmission: vi.fn(async () => ({ admitted: true, refusals: [] })),
  fetchAgentAssistantResponsibleUser: vi.fn(async () => ({ userId: 'usr-1' })),
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
    permissionMode: mocks.permissionMode,
    chatActions: 'approve',
    pause: false,
    memoryProvider: 'managed',
    memoryAutoDistill: false,
    status: 'online',
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
    canEdit: true,
    ...(mocks.assistantMode ? { assistantMode: mocks.assistantMode } : {})
  } as unknown as Parameters<typeof Object.freeze>[0]
}

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<HTMLDivElement> {
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentDetailView />
      </SWRConfig>
    )
  })
  return host
}

const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

/** The value badge of the Configuration tab's permission-mode row. */
const permissionRow = (scope: HTMLElement) =>
  [...scope.querySelectorAll('span')].find((s) => s.textContent === 'Permission mode')?.nextElementSibling?.textContent

beforeEach(() => {
  mocks.query = 'tab=config'
  mocks.permissionMode = 'default'
  mocks.assistantMode = undefined
  // The Control Plane's answer to turning the mode on: the asking mode moved to the runtime's auto mode.
  mocks.updateAgent.mockReset().mockImplementation(async (_id: string, patch: { assistantMode: Policy }) => {
    if (patch.assistantMode.enabled && !mocks.assistantMode?.enabled) mocks.permissionMode = 'auto'
    mocks.assistantMode = patch.assistantMode
  })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('turning assistant mode on', () => {
  it('shows the auto mode it moves to, with no warning about the mode it replaces', async () => {
    const scope = await render()
    const panel = () => scope.querySelector<HTMLElement>('[data-assistant-mode]')!
    await act(async () => button(panel(), 'Edit')?.click())
    await act(async () => panel().querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    // Saving moves the mode, so the draft does not warn that background work will wait.
    expect(scope.querySelector('[data-assistant-mode-ask-warning]')).toBeNull()
    await act(async () => button(panel(), 'Save assistant mode')?.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { assistantMode: { enabled: true } })

    await render()
    expect(scope.querySelector('[data-assistant-mode-ask-warning]')).toBeNull()
    expect(permissionRow(scope)).toBe('Auto')
    expect(panel().textContent).toContain('Fallback: Ada')
  })

  it('warns once an editor later picks a mode that asks', async () => {
    mocks.assistantMode = { enabled: true }
    const scope = await render()
    expect(scope.querySelector('[data-assistant-mode-ask-warning]')?.textContent).toContain('wait for approval')
    expect(permissionRow(scope)).toBe('Manual')
  })
})
