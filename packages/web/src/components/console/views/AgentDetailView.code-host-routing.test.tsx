// @vitest-environment happy-dom
// Every code host's issues and change-request rows carry their scope's decision routing: the entry, the trigger lock, Stop, and Recent evaluations.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubFamilySubscription } from '@/lib/github-events'
import { gitlabFamilySubscription } from '@/lib/gitlab-events'
import { giteaFamilySubscription } from '@/lib/gitea-events'

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
    fetchAgentInstallations: vi.fn(async () => []),
    fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
    fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
    fetchGiteaConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
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

type Provider = 'github' | 'gitlab' | 'gitea'
type Family = 'issues' | 'pull_request' | 'merge_request'
type Mode = 'first' | 'every' | 'mention'
const REPO: Record<Provider, { repoId: string; name: string }> = {
  github: { repoId: '1', name: 'acme/api' },
  gitlab: { repoId: '7', name: 'group/api' },
  gitea: { repoId: '9', name: 'acme/web' }
}

function subscription(provider: Provider, family: Family, mode: Mode) {
  if (provider === 'github') return githubFamilySubscription(family as 'issues' | 'pull_request', mode)
  if (provider === 'gitlab') return gitlabFamilySubscription(family as 'issues' | 'merge_request', mode)
  return giteaFamilySubscription(family as 'issues' | 'merge_request', mode)
}

function row(family: Family, mode: Mode, provider: Provider = 'github'): Record<string, unknown> {
  return {
    id: `hook-${provider}-${family}`,
    agentId: 'agent-1',
    kind: provider,
    enabled: true,
    repoId: REPO[provider].repoId,
    name: REPO[provider].name,
    repoFullName: REPO[provider].name,
    family,
    ...subscription(provider, family, mode),
    labelFilter: [],
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    configRevision: '1'
  }
}

function routing(family: Family, routed: boolean, provider: Provider = 'github') {
  return {
    provider,
    repoId: REPO[provider].repoId,
    repoFullName: REPO[provider].name,
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
    members: [{ agentId: 'agent-1', hookId: `hook-${provider}-${family}`, name: 'pilot' }],
    evaluationAgentId: 'agent-1'
  }
}

const scopeOf = (provider: Provider, family: Family) => ({
  provider,
  repoId: REPO[provider].repoId,
  family,
  repoFullName: REPO[provider].name
})

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
  [...scope.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].map((el) =>
    el.getAttribute('aria-label')
  )

beforeEach(() => {
  mocks.hooks = [row('issues', 'first'), row('pull_request', 'every')]
  mocks.routings = {
    'github|issues': routing('issues', false),
    'github|pull_request': routing('pull_request', true),
    'gitlab|issues': routing('issues', false, 'gitlab'),
    'gitlab|merge_request': routing('merge_request', true, 'gitlab'),
    'gitea|issues': routing('issues', false, 'gitea'),
    'gitea|merge_request': routing('merge_request', true, 'gitea')
  }
  mocks.fetchCodeHostRouting.mockReset()
  mocks.fetchCodeHostRouting.mockImplementation(
    async (scope: { provider: string; family: string }) => mocks.routings[`${scope.provider}|${scope.family}`]
  )
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
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith(scopeOf('github', 'issues'), 'org-1')
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith(scopeOf('github', 'pull_request'), 'org-1')
    // Pull requests order first within a repository.
    expect(entries(scope)).toEqual(['Needs a response', 'Add decision'])
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

  it('offers the empty Decision chip on a row that runs on @-mention', async () => {
    mocks.hooks = [row('issues', 'mention')]
    const scope = await render()
    const add = scope.querySelector<HTMLButtonElement>('button[aria-label="Add decision"]')
    expect(add?.disabled).toBe(false)
  })

  it('stops the routing from the pill with a DELETE, and leaves the row menu without a second stop', async () => {
    const scope = await render()
    await click(scope.querySelector('[aria-label="More for acme/api PRs"]'))
    expect(menuItem('Stop using')).toBeUndefined()
    await click(scope.querySelector('button[aria-label^="Stop using By decision"]'))
    expect(mocks.deleteCodeHostRouting).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', repoId: '1', family: 'pull_request' }),
      'org-1'
    )
    expect(entries(scope)).toEqual(['Add decision', 'Add decision'])
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
    expect(mocks.fetchCodeHostRoutingEvaluations).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', repoId: '1', family: 'pull_request' }),
      { limit: 20 },
      'org-1'
    )
  })
})

describe.each([
  {
    provider: 'gitlab' as const,
    repo: 'group/api',
    change: 'MRs',
    any: 'update',
    modes: ['create', 'update', '@-mention']
  },
  {
    provider: 'gitea' as const,
    repo: 'acme/web',
    change: 'PRs',
    any: 'update',
    modes: ['create', 'update', '@-mention']
  }
])('AgentDetailView, $provider decision routing', ({ provider, repo, change, any, modes }) => {
  beforeEach(() => {
    mocks.hooks = [row('issues', 'first', provider), row('merge_request', 'first', provider)]
  })

  it('reads each family scope by provider and mounts its entry on the issues and change-request rows', async () => {
    const scope = await render()
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith(scopeOf(provider, 'issues'), 'org-1')
    expect(mocks.fetchCodeHostRouting).toHaveBeenCalledWith(scopeOf(provider, 'merge_request'), 'org-1')
    expect(entries(scope).sort()).toEqual(['Add decision', 'Needs a response'])
  })

  it('locks the routed row on Any update and leaves the unrouted row alone', async () => {
    const scope = await render()
    const trigger = scope.querySelector(`[aria-label="Trigger for ${repo} ${change}"]`)
    expect(trigger?.textContent).toContain(any)
    await click(trigger)
    for (const mode of modes) expect(menuItem(mode)?.getAttribute('aria-disabled')).toBe('true')
    await click(trigger)
    await click(scope.querySelector(`[aria-label="Trigger for ${repo} Issues"]`))
    expect(menuItem('@-mention')?.getAttribute('aria-disabled')).toBeNull()
  })

  it('opens Recent evaluations from the row menu and stops the routing from the pill', async () => {
    const scope = await render()
    await click(scope.querySelector(`[aria-label="More for ${repo} Issues"]`))
    expect(menuItem('Recent evaluations')).toBeUndefined()
    await click(scope.querySelector(`[aria-label="More for ${repo} ${change}"]`))
    await click(menuItem('Recent evaluations'))
    const drawer = document.querySelector<HTMLElement>('[data-testid="decision-evaluations"]')!
    expect(drawer.textContent).toContain(`${repo} · ${change}`)
    expect(mocks.fetchCodeHostRoutingEvaluations).toHaveBeenCalledWith(
      expect.objectContaining({ provider, repoId: REPO[provider].repoId, family: 'merge_request' }),
      { limit: 20 },
      'org-1'
    )
    await click(scope.querySelector(`[aria-label="More for ${repo} ${change}"]`))
    expect(menuItem('Stop using')).toBeUndefined()
    await click(scope.querySelector('button[aria-label^="Stop using By decision"]'))
    expect(mocks.deleteCodeHostRouting).toHaveBeenCalledWith(
      expect.objectContaining({ provider, repoId: REPO[provider].repoId, family: 'merge_request' }),
      'org-1'
    )
    expect(entries(scope)).toEqual(['Add decision', 'Add decision'])
  })
})
