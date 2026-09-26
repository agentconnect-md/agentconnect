// @vitest-environment happy-dom
// "All of <account>" in the GitHub picker creates installation-wide triggers (webhook-triggers-and-github-events.md, Installation-Wide Rows).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  createGithubHook: vi.fn(async () => ({ id: 'hook-1', agentId: 'agent-a', kind: 'github' })),
  fetchAgentInstallations: vi.fn(),
  updateAgentInstallation: vi.fn(),
  workspaceEditor: vi.fn(),
  role: { value: 'member' as 'owner' | 'member' }
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

const grant = (access: 'read' | 'write') => ({
  id: 'grant-1',
  provider: 'github',
  installationId: 12345,
  accountLogin: 'acme',
  access,
  materialize: 'on-demand'
})

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}`, myRole: mocks.role.value })
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
  updateAgentInstallation: mocks.updateAgentInstallation,
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

const agent = { id: 'agent-a', name: 'build-agent', daemon: 'daemon-1', canEdit: true, workspace: { mode: 'scratch' } }

let root: Root | undefined
let host: HTMLDivElement | undefined

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const installationRow = () => document.querySelector<HTMLButtonElement>('button.fopt[data-installation="12345"]')

/** Each case renders a DISTINCT agent id: the grant reads are cached per agent. */
async function openPicker(id: string) {
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
  return installationRow()
}

beforeEach(() => {
  mocks.fetchAgentInstallations.mockResolvedValue([])
  mocks.role.value = 'member'
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGithubHook.mockClear()
  mocks.fetchAgentInstallations.mockReset()
  mocks.updateAgentInstallation.mockReset()
  mocks.workspaceEditor.mockClear()
})

describe('AddIntegrationModal, all repositories of an installation', () => {
  it('offers the installation at its grant’s tier and creates each trigger by account', async () => {
    mocks.fetchAgentInstallations.mockResolvedValue([grant('write')])
    const row = await openPicker('agent-granted')

    expect(row?.textContent).toContain('All of acme')
    expect(row?.textContent).toContain('write')
    expect(row?.disabled).toBe(false)
    await act(async () => row?.click())
    expect(document.querySelector('.inp')?.textContent).toContain('All of acme')
    await act(async () => clickText('Connect')?.click())

    expect(mocks.workspaceEditor).not.toHaveBeenCalled()
    expect(mocks.createGithubHook).toHaveBeenCalled()
    for (const [input] of mocks.createGithubHook.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(input).toMatchObject({ githubAccount: 'acme', name: 'acme/*' })
      expect(input).not.toHaveProperty('repoFullName')
    }
  })

  it('sends an owner without a grant to authorize the installation itself', async () => {
    mocks.role.value = 'owner'
    const row = await openPicker('agent-owner')

    expect(row?.textContent).toContain('authorize')
    await act(async () => row?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGithubHook).not.toHaveBeenCalled()
    expect(mocks.workspaceEditor).toHaveBeenCalledWith(
      expect.objectContaining({ initialRepositoryAuthorization: { installationId: 12345, access: 'write' } })
    )
  })

  it('keeps an ungranted installation out of reach of a member who is not an owner', async () => {
    const row = await openPicker('agent-member')

    expect(row?.disabled).toBe(true)
    expect(row?.textContent).toContain('Ask an organization owner to authorize all its repositories')
  })

  it('raises a read grant in place for an owner, once the reviews need write', async () => {
    mocks.role.value = 'owner'
    mocks.fetchAgentInstallations.mockResolvedValue([grant('read')])
    mocks.updateAgentInstallation.mockResolvedValue(grant('write'))
    const row = await openPicker('agent-raise')

    await act(async () => row?.click())
    await act(async () => clickText('Upgrade access')?.click())

    expect(mocks.updateAgentInstallation).toHaveBeenCalledWith('agent-raise', 'grant-1', { access: 'write' })
    expect(mocks.workspaceEditor).not.toHaveBeenCalled()
  })
})
