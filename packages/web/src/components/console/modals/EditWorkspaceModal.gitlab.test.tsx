// @vitest-environment happy-dom
/**
 * The GitLab workspace choice is offered on every deployment; a control plane
 * with no GitLab application 404s the routes behind it, which the pane states as
 * an absence instead of a failed load. Where it is configured, the picker offers
 * the organization's added projects — every state except the transient ones —
 * alongside the ones the connected account can still set up, and the save sends the
 * one host-neutral payload every tile produces: the project's clone address on the
 * deployment's instance, plus the requested access.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  fetchGitlabProjects: vi.fn(),
  fetchGitlabConnections: vi.fn(),
  searchGitlabProjects: vi.fn(),
  createGitlabProject: vi.fn(),
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
  fetchGitlabProjects: mocks.fetchGitlabProjects,
  fetchGitlabConnections: mocks.fetchGitlabConnections,
  searchGitlabProjects: mocks.searchGitlabProjects,
  createGitlabProject: mocks.createGitlabProject,
  setAgentWorkspace: mocks.setAgentWorkspace
}))

const EditWorkspaceModal = (await import('./EditWorkspaceModal')).default

const binding = (over: Record<string, unknown>) => ({
  id: `binding-${over.projectId}`,
  projectPath: 'acme/platform',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  accounts: [],
  webhookState: 'installed',
  credentialEpoch: '1',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over
})

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

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.fetchGitlabProjects.mockReset()
  mocks.fetchGitlabConnections.mockReset()
  mocks.searchGitlabProjects.mockReset()
  mocks.createGitlabProject.mockReset()
  mocks.setAgentWorkspace.mockClear()
})

const CONNECTION = {
  id: 'conn-1',
  gitlabUserId: '4711',
  gitlabUsername: 'octo-maintainer',
  state: 'connected' as const,
  scopes: ['api'],
  connectedBy: 'user-1',
  accessExpiresAt: null,
  assignedProjects: 0,
  createdAt: '2026-08-01T00:00:00.000Z'
}

/** One connected account with nothing else to offer, unless a test says otherwise. */
function connected(projects: unknown[] = []) {
  mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
  mocks.searchGitlabProjects.mockResolvedValue({ projects, nextPage: null })
}

/** Candidates are searched on GitLab behind a debounce; let it elapse for real. */
async function settleSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

describe('EditWorkspaceModal, GitLab workspace', () => {
  it('offers the GitLab source and states the absence on an unconfigured deployment', async () => {
    mocks.fetchGitlabProjects.mockRejectedValue(new ApiError('GET /gitlab/projects → 404', 404))
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()

    expect(document.body.textContent).toContain('GitLab')
    // Nothing is asked until the source is picked.
    expect(mocks.fetchGitlabProjects).not.toHaveBeenCalled()

    await act(async () => buttonsNamed('GitLab')[0]?.click())
    expect(document.body.textContent).toContain(
      'GitLab is not enabled on this deployment — no GitLab application is configured.'
    )
    expect(document.body.textContent).not.toContain('Couldn’t load your GitLab projects')
    expect(mocks.searchGitlabProjects).not.toHaveBeenCalled()
  })

  it('lists the added projects and disables the ones still setting up', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([
      binding({ projectId: '1', projectPath: 'acme/platform', state: 'ready' }),
      binding({ projectId: '2', projectPath: 'acme/runtime', state: 'runtime_degraded' }),
      binding({ projectId: '3', projectPath: 'acme/fresh', state: 'provisioning' })
    ])
    // GitLab lists an added project among the account's projects too — it stays one row.
    connected([{ projectId: '1', path: 'acme/platform', defaultBranch: 'main', lastActivityAt: null }])
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())

    const options = Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('acme/')
    )
    expect(options.filter((option) => option.textContent?.includes('acme/platform'))).toHaveLength(1)
    expect(options.find((option) => option.textContent?.includes('acme/fresh'))?.disabled).toBe(true)
    expect(options.find((option) => option.textContent?.includes('acme/runtime'))?.disabled).toBe(false)
    expect(document.body.textContent).toContain('bot access degraded')
  })

  it('saves the picked project as its clone address on the instance', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([binding({ projectId: '4210', projectPath: 'acme/platform' })])
    connected()
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('acme/platform')
    )
    await act(async () => option?.click())
    await act(async () => buttonsNamed('Replace workspace')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'https://gitlab.com/acme/platform',
      gitBranch: 'main',
      access: 'write'
    })
  })

  it('offers the connect action in place when no GitLab account is connected', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())

    expect(buttonsNamed('Connect GitLab').length).toBe(1)
    expect(document.querySelector('a[href="/acme/integrations"]')).toBeNull()
    expect(mocks.searchGitlabProjects).not.toHaveBeenCalled()
  })

  it('sets up a project the organization has not added, then saves it', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    connected([{ projectId: '4210', path: 'acme/platform', defaultBranch: 'main', lastActivityAt: null }])
    let settle: (value: unknown) => void = () => undefined
    mocks.createGitlabProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    await render()
    await act(async () => buttonsNamed('GitLab')[0]?.click())
    await settleSearch()
    expect(mocks.searchGitlabProjects).toHaveBeenCalledWith('conn-1', {})

    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('sets up on pick')
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('acme/platform')
    )
    await act(async () => option?.click())
    expect(mocks.createGitlabProject).toHaveBeenCalledWith({ connectionId: 'conn-1', projectId: '4210' })
    // The saga takes seconds, and the picker says so instead of looking stuck.
    expect(document.body.textContent).toContain('Setting up the project bot and webhook')

    await act(async () => {
      settle(binding({ projectId: '4210', projectPath: 'acme/platform' }))
    })
    await act(async () => buttonsNamed('Replace workspace')[0]?.click())
    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'https://gitlab.com/acme/platform',
      gitBranch: 'main',
      access: 'write'
    })
  })
})
