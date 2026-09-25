// @vitest-environment happy-dom
/** The GitHub arm sends its checkout choice on create; the hook editor's preselected shortcut keeps the Always default. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import type { AgentRepoAuthDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ createAgentRepo: vi.fn() }))
const decisionProviders = vi.hoisted(() => ({ rows: [] as DecisionProviderOption[] }))

const INSTALLATION = { id: 'inst-1', accountLogin: 'example-org', accountType: 'Organization' }
const REPO = {
  fullName: 'example-org/example-repo',
  private: true,
  defaultBranch: 'main',
  description: null,
  updatedAt: null,
  installationId: 'inst-1'
}

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/decisions/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decisions/provider')>()),
  useDecisionProviders: () => ({ providers: decisionProviders.rows, daemonId: null, error: null })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: [INSTALLATION] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [REPO], privateReposHidden: false, failed: false })),
  fetchGithubRepoAccess: vi.fn(async () => ({ gated: false, canRead: true, canWrite: true })),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null })),
  fetchGiteaRepositories: vi.fn(async () => []),
  fetchGiteaConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  createAgentRepo: mocks.createAgentRepo
}))

const AddAgentRepoModal = (await import('./AddAgentRepoModal')).default

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  canEdit: true,
  workspace: { mode: 'scratch' },
  placementKind: 'daemon',
  daemon: 'daemon-1'
} as unknown as Agent

const READY_PROVIDER: DecisionProviderOption = {
  id: 'typesafe',
  daemonId: 'daemon-1',
  memberSetId: null,
  name: 'TypeSafe',
  kind: 'typesafe',
  source: 'byok',
  readiness: { status: 'ready' },
  models: [{ id: 'jev-latest', label: 'Jev latest', questionTypes: ['choice'] }]
}

const grant = (over: Partial<AgentRepoAuthDto>): AgentRepoAuthDto => ({
  id: 'ra-1',
  provider: 'github',
  repoFullName: 'example-org/example-repo',
  access: 'read',
  materialize: 'always',
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(
  props: {
    initialRepo?: string
    initialAccess?: 'read' | 'write'
    repositorySelector?: AgentRepositorySelector | null
  } = {}
) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <AddAgentRepoModal
        agent={agent}
        workspaceRepo={null}
        authorized={[]}
        {...props}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    )
  })
}

const buttonsNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes(text))

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createAgentRepo.mockReset()
  decisionProviders.rows = []
})

describe('AddAgentRepoModal, GitHub checkout', () => {
  it('offers Always, By decision and On demand; By decision waits for a ready provider', async () => {
    await render({ initialRepo: 'example-org/example-repo' })

    const group = document.querySelector('[role="group"][aria-label="Checkout"]')
    const buttons = Array.from(group?.querySelectorAll('button') ?? [])
    expect(buttons.map((button) => button.textContent)).toEqual(['Always', 'By decision', 'On demand'])
    expect(buttons[1]?.disabled).toBe(true)
    expect(buttons[1]?.title).toBe('No Decision provider is ready where this agent runs')
  })

  it('authorizes a repository on demand when that checkout is chosen', async () => {
    mocks.createAgentRepo.mockResolvedValue(grant({ materialize: 'on-demand' }))
    await render()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = buttonsNamed('example-org/example-repo')[0]
    await act(async () => option?.click())
    await act(async () => buttonsNamed('On demand')[0]?.click())
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      repoFullName: 'example-org/example-repo',
      access: 'read',
      materialize: 'on-demand'
    })
  })

  it('keeps the hook editor shortcut on the Always default', async () => {
    mocks.createAgentRepo.mockResolvedValue(grant({ access: 'write' }))
    await render({ initialRepo: 'example-org/example-repo', initialAccess: 'write' })
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      repoFullName: 'example-org/example-repo',
      access: 'write',
      materialize: 'always'
    })
  })

  it('authorizes a repository By decision once a provider is ready and a selector is set', async () => {
    decisionProviders.rows = [READY_PROVIDER]
    mocks.createAgentRepo.mockResolvedValue(grant({ materialize: 'decision' }))
    await render({
      initialRepo: 'example-org/example-repo',
      repositorySelector: { providerId: 'typesafe', model: 'jev-latest' }
    })
    await act(async () => buttonsNamed('By decision')[0]?.click())
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      repoFullName: 'example-org/example-repo',
      access: 'read',
      materialize: 'decision'
    })
  })

  it('keeps By decision unavailable without a repository selector', async () => {
    decisionProviders.rows = [READY_PROVIDER]
    await render({ initialRepo: 'example-org/example-repo', repositorySelector: null })

    const byDecision = buttonsNamed('By decision')[0]
    expect(byDecision?.disabled).toBe(true)
    expect(byDecision?.title).toBe('Set the Repository selector first')
  })
})
