// @vitest-environment happy-dom
// A repository its owner's installation grant covers is authorized in the GitHub hook editor (decision 10).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  createGithubHook: vi.fn(async () => ({ id: 'hook-1', agentId: 'agent-a', kind: 'github' })),
  fetchAgentInstallations: vi.fn(),
  workspaceEditor: vi.fn()
}))

const installation = {
  id: 'inst-1',
  installationId: 12345,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current' as const,
  pullRequestsPermission: 'write' as const,
  checksPermission: 'write' as const,
  settingsUrl: 'https://github.example.test/settings/installations/12345',
  createdAt: '2026-09-01T00:00:00.000Z'
}

const repo = {
  repoId: '990',
  fullName: 'acme/platform',
  private: true,
  defaultBranch: 'main',
  description: null,
  updatedAt: null,
  installationId: 'inst-1'
}

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    daemons: [],
    daemonsLoading: false,
    createIntegration: vi.fn(),
    createHook: vi.fn(),
    createGithubHook: mocks.createGithubHook,
    createGitlabHook: vi.fn(),
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchAgentInstallations: mocks.fetchAgentInstallations,
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: [installation] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [repo], privateReposHidden: false, failed: false })),
  syncGithubInstallations: vi.fn(async () => [installation]),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null }))
}))
vi.mock('./EditWorkspaceModal', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.workspaceEditor(props)
    return <div>repository authorization step</div>
  }
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

// Scratch has no implicit repository, so every GitHub repository needs an authorization.
const agent = { id: 'agent-a', name: 'build-agent', daemon: 'daemon-1', canEdit: true, workspace: { mode: 'scratch' } }

let root: Root | undefined
let host: HTMLDivElement | undefined

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const repoRow = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button.fopt')).find((row) =>
    row.textContent?.includes('acme/platform')
  )

/** Each case renders a DISTINCT agent id — the grant reads are cached per agent. */
async function pickRepository(id: string) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={{ ...agent, id } as unknown as Agent} onClose={() => undefined} />)
  })
  await act(async () => tileNamed('GitHub')?.click())
  await act(async () =>
    Array.from(document.querySelectorAll<HTMLDivElement>('.inp'))
      .find((field) => field.textContent?.includes('Pick a repository'))
      ?.click()
  )
  return repoRow()
}

beforeEach(() => {
  mocks.fetchAgentInstallations.mockResolvedValue([])
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGithubHook.mockClear()
  mocks.fetchAgentInstallations.mockReset()
  mocks.workspaceEditor.mockClear()
})

describe('AddIntegrationModal, GitHub repository covered by an installation grant', () => {
  it('lists the covered repository with the grant’s tier and connects without the authorize step', async () => {
    mocks.fetchAgentInstallations.mockResolvedValue([
      { id: 'grant-1', provider: 'github', installationId: 12345, accountLogin: 'Acme', access: 'write' }
    ])
    const row = await pickRepository('agent-covered')

    expect(row?.textContent).toContain('write')
    expect(row?.textContent).not.toContain('authorize')
    await act(async () => row?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.workspaceEditor).not.toHaveBeenCalled()
    expect(mocks.createGithubHook).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: 'acme/platform' }))
  })

  it('still sends an uncovered repository through the authorize step', async () => {
    mocks.fetchAgentInstallations.mockResolvedValue([
      { id: 'grant-2', provider: 'github', installationId: 23456, accountLogin: 'example-org', access: 'write' }
    ])
    const row = await pickRepository('agent-uncovered')

    expect(row?.textContent).toContain('authorize')
    await act(async () => row?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGithubHook).not.toHaveBeenCalled()
    expect(mocks.workspaceEditor).toHaveBeenCalledWith(
      expect.objectContaining({ initialRepositoryAuthorization: { repo: 'acme/platform', access: 'write' } })
    )
  })
})
