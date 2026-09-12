// @vitest-environment happy-dom
/**
 * Authorizing an additional repository is a choice of code host first. The Gitea
 * arm offers the repositories the organization's ONE bot administers merged with
 * the ones already added, sets up a repository that is not added yet before the
 * selection lands, and submits the numeric repository id — never the owner/repo
 * path, which is not a match key. Repositories the agent already holds are named
 * as taken rather than offered again (gitea-integration.md §5, §6).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRepoAuthDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchGiteaRepositories: vi.fn(),
  fetchGiteaConnections: vi.fn(),
  fetchGiteaConnectionRepositories: vi.fn(),
  createGiteaRepository: vi.fn(),
  createAgentRepo: vi.fn()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null })),
  fetchGiteaRepositories: mocks.fetchGiteaRepositories,
  fetchGiteaConnections: mocks.fetchGiteaConnections,
  fetchGiteaConnectionRepositories: mocks.fetchGiteaConnectionRepositories,
  createGiteaRepository: mocks.createGiteaRepository,
  createAgentRepo: mocks.createAgentRepo
}))

const AddAgentRepoModal = (await import('./AddAgentRepoModal')).default

const binding = (over: Record<string, unknown>) => ({
  id: `binding-${over.repoId}`,
  connectionId: 'conn-1',
  repoPath: 'example-org/example-repo',
  cloneUrl: 'https://gitea.example.test/example-org/example-repo.git',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  webhookState: 'installed',
  lastVerifiedDeliveryAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

const CONNECTION = {
  id: 'conn-1',
  botUserId: '41',
  botUsername: 'agentconnect-bot',
  botDisplayName: 'AgentConnect bot',
  state: 'connected' as const,
  connectedBy: 'user-1',
  credentialEpoch: '1',
  boundRepositories: 1,
  instanceUrl: 'https://gitea.example.test',
  instanceVersion: '1.24.0',
  instanceVersionSupported: true,
  instanceVersionFloor: '1.23',
  requiredScopes: ['read:user', 'write:repository', 'write:issue', 'read:organization'],
  lastVerifiedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z'
}

const grant = (over: Partial<AgentRepoAuthDto>): AgentRepoAuthDto => ({
  id: 'ra-1',
  provider: 'gitea',
  repoId: '7711',
  repoFullName: 'example-org/example-repo',
  access: 'read',
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined
const created: AgentRepoAuthDto[] = []

async function render(options: { agent?: Agent; authorized?: AgentRepoAuthDto[] } = {}) {
  const agent =
    options.agent ??
    ({ id: 'agent-a', name: 'build-agent', canEdit: true, workspace: { mode: 'scratch' } } as unknown as Agent)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <AddAgentRepoModal
        agent={agent}
        workspaceRepo={null}
        authorized={options.authorized ?? []}
        onClose={() => undefined}
        onCreated={(row) => created.push(row)}
      />
    )
  })
}

const buttonsNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes(text))

/** One connected bot with nothing else to offer, unless a test says otherwise. */
function connected(repositories: unknown[] = []) {
  mocks.fetchGiteaConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
  mocks.fetchGiteaConnectionRepositories.mockResolvedValue(repositories)
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  created.length = 0
  mocks.fetchGiteaRepositories.mockReset()
  mocks.fetchGiteaConnections.mockReset()
  mocks.fetchGiteaConnectionRepositories.mockReset()
  mocks.createGiteaRepository.mockReset()
  mocks.createAgentRepo.mockReset()
})

describe('AddAgentRepoModal, Gitea repositories', () => {
  it('offers Gitea beside the other hosts and asks nothing until it is picked', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    connected()
    await render()

    expect(document.body.textContent).toContain('GitHub')
    expect(document.body.textContent).toContain('GitLab')
    expect(document.body.textContent).toContain('Gitea')
    expect(mocks.fetchGiteaRepositories).not.toHaveBeenCalled()

    await act(async () => buttonsNamed('Gitea')[0]?.click())
    expect(mocks.fetchGiteaRepositories).toHaveBeenCalled()
  })

  it('names the repository in Gitea’s vocabulary, not another host’s', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding({ repoId: '7711' })])
    connected()
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())

    expect(document.body.textContent).toContain('Gitea repository')
    expect(document.body.textContent).toContain('Push, open pull requests & request reviews')
    expect(document.body.textContent).toContain('Access applies only to this repository')
    expect(document.body.textContent).not.toContain('run GitHub Actions')
    expect(document.body.textContent).not.toContain('run pipelines')
  })

  it('authorizes the picked repository by its numeric id', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding({ repoId: '7711' })])
    connected()
    mocks.createAgentRepo.mockResolvedValue(grant({}))
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-org/example-repo')
    )
    await act(async () => option?.click())
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      provider: 'gitea',
      repoId: '7711',
      access: 'read'
    })
    expect(created).toHaveLength(1)
  })

  it('sets a repository up before the selection lands, then authorizes it', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    connected([
      {
        repoId: '7712',
        path: 'example-org/example-second',
        cloneUrl: 'https://gitea.example.test/example-org/example-second.git',
        defaultBranch: 'main',
        private: false
      }
    ])
    mocks.createGiteaRepository.mockResolvedValue(binding({ repoId: '7712', repoPath: 'example-org/example-second' }))
    mocks.createAgentRepo.mockResolvedValue(grant({ repoId: '7712' }))
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('sets up on pick')

    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-org/example-second')
    )
    await act(async () => option?.click())
    expect(mocks.createGiteaRepository).toHaveBeenCalledWith({ repoId: '7712' })

    await act(async () => buttonsNamed('Add')[0]?.click())
    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      provider: 'gitea',
      repoId: '7712',
      access: 'read'
    })
  })

  it('says a repository is taken by the workspace or an existing grant instead of offering it', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([
      binding({ repoId: '7711', repoPath: 'example-org/example-repo' }),
      binding({ repoId: '7712', repoPath: 'example-org/example-second' })
    ])
    connected()
    await render({
      agent: {
        id: 'agent-a',
        name: 'build-agent',
        canEdit: true,
        workspace: {
          mode: 'git',
          provider: 'gitea',
          repoId: '7711',
          gitRepo: 'https://gitea.example.test/example-org/example-repo'
        }
      } as unknown as Agent,
      authorized: [grant({ repoId: '7712', repoFullName: 'example-org/example-second' })]
    })
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())

    expect(document.body.textContent).toContain('is the agent’s workspace repository')
    expect(document.body.textContent).toContain('is already authorized for this agent')
    // Neither is selectable, so Add stays inert.
    expect(mocks.createAgentRepo).not.toHaveBeenCalled()
  })

  it('states the absence when the deployment configures no Gitea instance', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    mocks.fetchGiteaConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())

    expect(document.body.textContent).toContain(
      'Gitea is not enabled on this deployment — no Gitea instance is configured.'
    )
    expect(mocks.fetchGiteaConnectionRepositories).not.toHaveBeenCalled()
  })
})
