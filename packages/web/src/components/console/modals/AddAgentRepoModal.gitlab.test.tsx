// @vitest-environment happy-dom
/**
 * Authorizing an additional repository is a choice of code host first
 * (gitlab-com-integration.md §18.1). The GitLab arm offers the connection's
 * Maintainer-or-Owner projects merged with the ones already added, sets up a
 * project that is not added yet before the selection lands, and submits the
 * numeric project id — never the namespaced path, which is not a match key.
 * Projects the agent already holds are named as taken rather than offered again.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRepoAuthDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  fetchGitlabProjects: vi.fn(),
  fetchGitlabConnections: vi.fn(),
  searchGitlabProjects: vi.fn(),
  createGitlabProject: vi.fn(),
  createAgentRepo: vi.fn()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  fetchGitlabProjects: mocks.fetchGitlabProjects,
  fetchGitlabConnections: mocks.fetchGitlabConnections,
  searchGitlabProjects: mocks.searchGitlabProjects,
  createGitlabProject: mocks.createGitlabProject,
  createAgentRepo: mocks.createAgentRepo
}))

const AddAgentRepoModal = (await import('./AddAgentRepoModal')).default

const binding = (over: Record<string, unknown>) => ({
  id: `binding-${over.projectId}`,
  projectPath: 'example-group/example-project',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  accounts: [],
  webhookState: 'installed',
  credentialEpoch: '1',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over
})

const CONNECTION = {
  id: 'conn-1',
  gitlabUserId: '4711',
  gitlabUsername: 'example-maintainer',
  state: 'connected' as const,
  scopes: ['api'],
  connectedBy: 'user-1',
  accessExpiresAt: null,
  assignedProjects: 0,
  createdAt: '2026-08-01T00:00:00.000Z'
}

const grant = (over: Partial<AgentRepoAuthDto>): AgentRepoAuthDto => ({
  id: 'ra-1',
  provider: 'gitlab',
  repoId: '4455667',
  repoFullName: 'example-group/example-project',
  access: 'read',
  createdBy: null,
  createdAt: '2026-08-01T00:00:00.000Z',
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

/** Candidates are searched on GitLab behind a debounce; let it elapse for real. */
async function settleSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

/** One connected account with nothing else to offer, unless a test says otherwise. */
function connected(projects: unknown[] = []) {
  mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
  mocks.searchGitlabProjects.mockResolvedValue({ projects, nextPage: null })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  created.length = 0
  mocks.fetchGitlabProjects.mockReset()
  mocks.fetchGitlabConnections.mockReset()
  mocks.searchGitlabProjects.mockReset()
  mocks.createGitlabProject.mockReset()
  mocks.createAgentRepo.mockReset()
})

describe('AddAgentRepoModal, GitLab projects', () => {
  it('offers GitLab beside GitHub and asks nothing until it is picked', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    connected()
    await render()

    expect(document.body.textContent).toContain('GitHub')
    expect(document.body.textContent).toContain('GitLab')
    expect(mocks.fetchGitlabProjects).not.toHaveBeenCalled()

    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    expect(mocks.fetchGitlabProjects).toHaveBeenCalled()
  })

  it('names the project in GitLab’s vocabulary, not the repository one', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([binding({ projectId: '4455667' })])
    connected()
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()

    expect(document.body.textContent).toContain('GitLab project')
    expect(document.body.textContent).toContain('Push, open merge requests & run pipelines')
    expect(document.body.textContent).toContain('Access applies only to this project')
    expect(document.body.textContent).not.toContain('run GitHub Actions')
  })

  it('authorizes the picked project by its numeric id', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([binding({ projectId: '4455667' })])
    connected()
    mocks.createAgentRepo.mockResolvedValue(grant({}))
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-group/example-project')
    )
    await act(async () => option?.click())
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      provider: 'gitlab',
      projectId: '4455667',
      access: 'read'
    })
    expect(created).toHaveLength(1)
  })

  it('sets a project up before the selection lands, then authorizes it', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    connected([
      { projectId: '4455668', path: 'example-group/example-second', defaultBranch: 'main', lastActivityAt: null }
    ])
    mocks.createGitlabProject.mockResolvedValue(
      binding({ projectId: '4455668', projectPath: 'example-group/example-second' })
    )
    mocks.createAgentRepo.mockResolvedValue(grant({ repoId: '4455668' }))
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('sets up on pick')

    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-group/example-second')
    )
    await act(async () => option?.click())
    expect(mocks.createGitlabProject).toHaveBeenCalledWith({ connectionId: 'conn-1', projectId: '4455668' })

    await act(async () => buttonsNamed('Add')[0]?.click())
    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      provider: 'gitlab',
      projectId: '4455668',
      access: 'read'
    })
  })

  it('says a project is taken by the workspace or an existing grant instead of offering it', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([
      binding({ projectId: '4455667', projectPath: 'example-group/example-project' }),
      binding({ projectId: '4455668', projectPath: 'example-group/example-second' })
    ])
    connected()
    await render({
      agent: {
        id: 'agent-a',
        name: 'build-agent',
        canEdit: true,
        workspace: { mode: 'git', provider: 'gitlab', repoId: '4455667', gitRepo: 'https://gitlab.com/acme/analytics' }
      } as unknown as Agent,
      authorized: [grant({ repoId: '4455668', repoFullName: 'example-group/example-second' })]
    })
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())

    expect(document.body.textContent).toContain('is the agent’s workspace project')
    expect(document.body.textContent).toContain('is already authorized for this agent')
    // Neither is selectable, so Add stays inert.
    expect(mocks.createAgentRepo).not.toHaveBeenCalled()
  })

  it('states the absence when the deployment configures no GitLab application', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()

    expect(document.body.textContent).toContain(
      'GitLab is not enabled on this deployment — no GitLab application is configured.'
    )
    expect(mocks.searchGitlabProjects).not.toHaveBeenCalled()
  })
})
