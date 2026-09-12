// @vitest-environment happy-dom
/**
 * The Gitea workspace choice is offered on every deployment; a control plane
 * with no Gitea instance 404s the routes behind it, which the pane states as an
 * absence instead of a failed load. Where it is configured, the picker offers
 * the organization's added repositories — every state except the transient
 * ones — alongside the ones its bot administers, and the save sends the one
 * host-neutral payload every tile produces: the repository's clone address on
 * the deployment's instance, plus the requested access.
 *
 * The one difference from the GitLab pane is where connecting happens: a Gitea
 * bot is connected by pasting a token on the Integrations card, so the empty
 * state links there instead of offering a connect button of its own.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchGiteaRepositories: vi.fn(),
  fetchGiteaConnections: vi.fn(),
  fetchGiteaConnectionRepositories: vi.fn(),
  createGiteaRepository: vi.fn(),
  setAgentWorkspace: vi.fn(async () => ({}) as Agent)
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null })),
  fetchGiteaRepositories: mocks.fetchGiteaRepositories,
  fetchGiteaConnections: mocks.fetchGiteaConnections,
  fetchGiteaConnectionRepositories: mocks.fetchGiteaConnectionRepositories,
  createGiteaRepository: mocks.createGiteaRepository,
  setAgentWorkspace: mocks.setAgentWorkspace
}))

const EditWorkspaceModal = (await import('./EditWorkspaceModal')).default

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

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <EditWorkspaceModal agent={agent} authorized={[]} onClose={() => undefined} onChanged={() => undefined} />
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
  mocks.fetchGiteaRepositories.mockReset()
  mocks.fetchGiteaConnections.mockReset()
  mocks.fetchGiteaConnectionRepositories.mockReset()
  mocks.createGiteaRepository.mockReset()
  mocks.setAgentWorkspace.mockClear()
})

describe('EditWorkspaceModal, Gitea workspace', () => {
  it('offers the Gitea source and states the absence on an unconfigured deployment', async () => {
    mocks.fetchGiteaRepositories.mockRejectedValue(new ApiError('GET /gitea/repositories → 404', 404))
    mocks.fetchGiteaConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()

    expect(document.body.textContent).toContain('Gitea')
    // Nothing is asked until the source is picked.
    expect(mocks.fetchGiteaRepositories).not.toHaveBeenCalled()

    await act(async () => buttonsNamed('Gitea')[0]?.click())
    expect(document.body.textContent).toContain(
      'Gitea is not enabled on this deployment — no Gitea instance is configured.'
    )
    expect(document.body.textContent).not.toContain('Couldn’t load your Gitea repositories')
    expect(mocks.fetchGiteaConnectionRepositories).not.toHaveBeenCalled()
  })

  it('lists the added repositories and disables the ones still setting up', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([
      binding({ repoId: '1', repoPath: 'example-org/platform', state: 'ready' }),
      binding({ repoId: '2', repoPath: 'example-org/runtime', state: 'runtime_degraded' }),
      binding({ repoId: '3', repoPath: 'example-org/fresh', state: 'provisioning' })
    ])
    // The bot's own listing names an added repository too — it stays one row.
    connected([{ repoId: '1', path: 'example-org/platform', cloneUrl: null, defaultBranch: 'main', private: true }])
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())

    const options = Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('example-org/')
    )
    expect(options.filter((option) => option.textContent?.includes('example-org/platform'))).toHaveLength(1)
    expect(options.find((option) => option.textContent?.includes('example-org/fresh'))?.disabled).toBe(true)
    expect(options.find((option) => option.textContent?.includes('example-org/runtime'))?.disabled).toBe(false)
    expect(document.body.textContent).toContain('bot access degraded')
  })

  it('saves the picked repository as its clone address on the instance', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding({ repoId: '7711' })])
    connected()
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-org/example-repo')
    )
    await act(async () => option?.click())
    await act(async () => buttonsNamed('Replace workspace')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'https://gitea.example.test/example-org/example-repo',
      gitBranch: 'main',
      access: 'write'
    })
  })

  it('sends the reader to the Integrations card when no Gitea bot is connected', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    mocks.fetchGiteaConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())

    expect(document.body.textContent).toContain('Connect Gitea to watch repositories')
    expect(document.querySelector('a[href="/acme/integrations"]')).not.toBeNull()
    expect(mocks.fetchGiteaConnectionRepositories).not.toHaveBeenCalled()
  })

  it('offers a repository the organization has not added and saves it as its address — the save binds it', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    connected([
      {
        repoId: '7711',
        path: 'example-org/example-repo',
        cloneUrl: 'https://gitea.example.test/example-org/example-repo.git',
        defaultBranch: 'main',
        private: true
      }
    ])
    await render()
    await act(async () => buttonsNamed('Gitea')[0]?.click())
    expect(mocks.fetchGiteaConnectionRepositories).toHaveBeenCalledWith('conn-1')

    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('added on save')
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('example-org/example-repo')
    )
    await act(async () => option?.click())
    // Binding on first use (§6): the workspace write binds the repository; the picker sets nothing up.
    expect(mocks.createGiteaRepository).not.toHaveBeenCalled()

    await act(async () => buttonsNamed('Replace workspace')[0]?.click())
    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'https://gitea.example.test/example-org/example-repo',
      gitBranch: 'main',
      access: 'write'
    })
    expect(mocks.createGiteaRepository).not.toHaveBeenCalled()
  })
})
