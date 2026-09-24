// @vitest-environment happy-dom
// A github repository's issues and pull-request rows carry their scope's decision routing: the entry, the mention lock, Stop, and Recent evaluations.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubFamilySubscription } from '@/lib/github-events'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  routings: {} as Record<string, unknown>,
  fetchCodeHostRouting: vi.fn(),
  deleteCodeHostRouting: vi.fn(),
  fetchCodeHostRoutingEvaluations: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  usePathname: () => '/agents/agent-1',
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
vi.mock('@/components/console/TrustedUsersField', () => ({ TrustedUsersField: () => null }))
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
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const { createDecisionMockApi } = await import('@/lib/decisions/mock-api')
  return {
    ...actual,
    // The mock catalog behind a live-mode API, so routings take the routing routes below.
    createDecisionApi: () => ({ ...createDecisionMockApi(), mode: 'live' as const }),
    fetchAgentHooks: vi.fn(async () => mocks.hooks),
    fetchAgentRepos: vi.fn(async () => []),
    fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
    fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
    fetchCodeHostRouting: mocks.fetchCodeHostRouting,
    deleteCodeHostRouting: mocks.deleteCodeHostRouting,
    fetchCodeHostRoutingEvaluations: mocks.fetchCodeHostRoutingEvaluations
  }
})

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

function row(family: 'issues' | 'pull_request', mode: 'first' | 'every' | 'mention'): Record<string, unknown> {
  return {
    id: `hook-${family}`,
    agentId: 'agent-1',
    kind: 'github',
    enabled: true,
    repoId: '1',
    name: 'acme/api',
    repoFullName: 'acme/api',
    family,
    ...githubFamilySubscription(family, mode),
    labelFilter: [],
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    configRevision: '1'
  }
}

function routing(family: 'issues' | 'pull_request', routed: boolean) {
  return {
    repoId: '1',
    repoFullName: 'acme/api',
    family,
    config: routed
      ? {
          enabled: true,
          decisionId: 'needs-response',
          rules: [
            { id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: 'agent-1' } }
          ],
          otherwise: { type: 'default_agent' }
        }
      : null,
    status: routed ? 'enabled' : null,
    members: [{ agentId: 'agent-1', hookId: `hook-${family}`, name: 'pilot' }],
    evaluationAgentId: 'agent-1'
  }
}

const { DecisionsPrototypeProvider } = await import('@/lib/decisions/provider')
const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function settle() {
  await act(async () => {})
  await act(async () => {})
  await act(async () => {})
}

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <AgentDetailView />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await settle()
  return host
}

async function click(node: Element | null | undefined) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button.fopt')].find((el) => el.textContent?.trim().startsWith(label))
const entries = (scope: ParentNode) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].map((el) => el.textContent?.trim())

beforeEach(() => {
  mocks.hooks = [row('issues', 'first'), row('pull_request', 'every')]
  mocks.routings = { issues: routing('issues', false), pull_request: routing('pull_request', true) }
  mocks.fetchCodeHostRouting.mockReset()
  mocks.fetchCodeHostRouting.mockImplementation(async (_repoId: string, family: string) => mocks.routings[family])
  mocks.deleteCodeHostRouting.mockReset()
  mocks.deleteCodeHostRouting.mockResolvedValue(undefined)
  mocks.fetchCodeHostRoutingEvaluations.mockReset()
  mocks.fetchCodeHostRoutingEvaluations.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('AgentDetailView, github decision routing', () => {
  it('reads each family scope and mounts its entry on the issues and pull-request rows', async () => {
    const scope = await render()
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith('1', 'issues', 'org-1')
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith('1', 'pull_request', 'org-1')
    // Pull requests order first within a repository.
    expect(entries(scope)).toEqual(['Needs a response', 'Decision'])
  })

  it('locks every trigger of the routed scope on Any update, and leaves the unrouted scope alone', async () => {
    const scope = await render()
    await click(scope.querySelector('[aria-label="Trigger for acme/api PRs"]'))
    for (const mode of ['Opened', 'Any update', '@-mention'])
      expect(menuItem(mode)?.getAttribute('aria-disabled')).toBe('true')
    await click(scope.querySelector('[aria-label="Trigger for acme/api PRs"]'))
    await click(scope.querySelector('[aria-label="Trigger for acme/api Issues"]'))
    expect(menuItem('@-mention')?.getAttribute('aria-disabled')).toBeNull()
  })

  it('offers + Decision on a row that runs on @-mention', async () => {
    mocks.hooks = [row('issues', 'mention')]
    const scope = await render()
    const add = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent?.trim() === 'Decision'
    )
    expect(add?.disabled).toBe(false)
  })

  it('stops the routing from the row menu with a DELETE', async () => {
    const scope = await render()
    await click(scope.querySelector('[aria-label="More for acme/api PRs"]'))
    await click(menuItem('Stop using decision'))
    expect(mocks.deleteCodeHostRouting).toHaveBeenCalledWith('1', 'pull_request', 'org-1')
    expect(entries(scope)).toEqual(['Decision', 'Decision'])
  })

  it('opens Recent evaluations from the row menu through the routing evaluation routes', async () => {
    const scope = await render()
    await click(scope.querySelector('[aria-label="More for acme/api Issues"]'))
    expect(menuItem('Recent evaluations')).toBeUndefined()
    await click(scope.querySelector('[aria-label="More for acme/api PRs"]'))
    await click(menuItem('Recent evaluations'))
    const drawer = document.querySelector<HTMLElement>('[data-testid="decision-evaluations"]')!
    expect(drawer.textContent).toContain('acme/api · PRs')
    expect(drawer.textContent).toContain('judged for this repository appear here')
    expect(mocks.fetchCodeHostRoutingEvaluations).toHaveBeenCalledWith('1', 'pull_request', { limit: 20 }, 'org-1')
  })
})
