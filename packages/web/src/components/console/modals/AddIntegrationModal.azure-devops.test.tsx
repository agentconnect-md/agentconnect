// @vitest-environment happy-dom
// The Azure DevOps trigger kind in the Add-integration wizard (azure-devops-integration.md §11.4): bound repositories only, pull requests only, and no label filter.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  createAzureDevOpsHook: vi.fn(async (_input: { family: string; events: string[] }) => ({
    id: 'hook-1',
    agentId: 'agent-a',
    kind: 'azure-devops'
  })),
  fetchAzureDevOpsConnections: vi.fn(),
  fetchAzureDevOpsRepositories: vi.fn(),
  fetchAzureDevOpsConnectionRepositories: vi.fn(),
  fetchAgentRepos: vi.fn(),
  fetchAgentHooks: vi.fn(async () => [] as unknown[])
}))

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
    createGithubHook: vi.fn(),
    createGitlabHook: vi.fn(),
    createGiteaHook: vi.fn(),
    createAzureDevOpsHook: mocks.createAzureDevOpsHook,
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: mocks.fetchAgentHooks,
  fetchAgentRepos: mocks.fetchAgentRepos,
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  syncGithubInstallations: vi.fn(async () => []),
  fetchAzureDevOpsConnections: mocks.fetchAzureDevOpsConnections,
  fetchAzureDevOpsRepositories: mocks.fetchAzureDevOpsRepositories,
  fetchAzureDevOpsConnectionRepositories: mocks.fetchAzureDevOpsConnectionRepositories
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  daemon: 'daemon-1',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

const REPOSITORY = '00000000-0000-4000-8000-000000000020'
const binding = {
  id: 'binding-1',
  connectionId: 'conn-1',
  repoId: '9001',
  repositoryId: REPOSITORY,
  projectId: '00000000-0000-4000-8000-000000000021',
  repoPath: 'example-org/Example Project/example-repo',
  cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  hookReason: null,
  lastVerifiedDeliveryAt: null,
  subscriptions: [],
  createdAt: '2026-11-01T00:00:00.000Z'
}
const unbound = {
  repositoryId: '00000000-0000-4000-8000-000000000029',
  projectId: binding.projectId,
  path: 'example-org/Example Project/unbound-repo',
  cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/unbound-repo',
  defaultBranch: 'main',
  repoId: null,
  bindingId: null
}
const authorization = {
  id: 'ra-1',
  provider: 'azure-devops' as const,
  repoId: '9001',
  repoFullName: binding.repoPath,
  access: 'read' as const,
  createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function renderAgent(over: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={{ ...agent, ...over } as unknown as Agent} onClose={() => undefined} />)
  })
}

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const family = (fam: string) => document.querySelector<HTMLDivElement>(`[data-azure-devops-family="${fam}"]`)
const trigger = (fam: string, mode: string) =>
  document.querySelector<HTMLButtonElement>(`[data-azure-devops-trigger="${fam}:${mode}"]`)

async function openPane() {
  await act(async () => tileNamed('Azure DevOps')?.click())
}

async function pickRepository() {
  await openPane()
  await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
  await act(async () => clickText('example-org/Example Project/example-repo')?.click())
}

beforeEach(() => {
  mocks.fetchAzureDevOpsConnections.mockResolvedValue({
    enabled: true,
    connections: [{ id: 'conn-1' }],
    deploymentApplication: true
  })
  mocks.fetchAzureDevOpsRepositories.mockResolvedValue([binding])
  mocks.fetchAzureDevOpsConnectionRepositories.mockResolvedValue([
    {
      repositoryId: binding.repositoryId,
      projectId: binding.projectId,
      path: binding.repoPath,
      cloneUrl: binding.cloneUrl,
      defaultBranch: binding.defaultBranch,
      repoId: binding.repoId,
      bindingId: binding.id
    },
    unbound
  ])
  mocks.fetchAgentRepos.mockResolvedValue([authorization])
  mocks.fetchAgentHooks.mockResolvedValue([])
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.clearAllMocks()
})

describe('AddIntegrationModal, Azure DevOps trigger', () => {
  it('offers the Azure DevOps tile and only the repositories already in use', async () => {
    await renderAgent()
    expect(tileNamed('Azure DevOps')).toBeDefined()
    await openPane()
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('example-org/Example Project/example-repo')
    // A trigger never binds: an unbound repository is not on offer.
    expect(document.body.textContent).not.toContain('unbound-repo')
  })

  it('says to authorize a repository first when none is in use', async () => {
    mocks.fetchAzureDevOpsRepositories.mockResolvedValue([])
    await renderAgent({ id: 'agent-none' })
    await openPane()
    expect(document.querySelector('[data-azure-devops-no-bound]')?.textContent).toContain(
      'No Azure DevOps repository is in use yet.'
    )
  })

  it('defaults to pull requests on any update, comments included, with no label filter, full reviews and a pull-request status', async () => {
    await renderAgent({ id: 'agent-default' })
    await pickRepository()
    expect(family('merge_request')).not.toBeNull()
    expect(family('issues')).toBeNull()
    expect(family('push')).toBeNull()
    expect(document.body.textContent).not.toContain('Label filter')

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createAzureDevOpsHook).toHaveBeenCalledWith({
      agentId: 'agent-default',
      name: 'example-org/Example Project/example-repo',
      repoId: '9001',
      family: 'merge_request',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: false,
      reviewPolicy: 'full',
      reportingMode: 'status'
    })
  })

  it('compiles the opened and the mention triggers', async () => {
    await renderAgent({ id: 'agent-opened' })
    await pickRepository()
    await act(async () => trigger('merge_request', 'first')?.click())
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createAzureDevOpsHook).toHaveBeenLastCalledWith(
      expect.objectContaining({ events: ['merge_request:opened'], commentFamilies: [], mentionOnly: false })
    )

    await act(async () => root?.unmount())
    host?.remove()
    await renderAgent({ id: 'agent-mention' })
    await pickRepository()
    await act(async () => trigger('merge_request', 'mention')?.click())
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createAzureDevOpsHook).toHaveBeenLastCalledWith(
      expect.objectContaining({
        events: ['merge_request:*'],
        commentFamilies: ['merge_request'],
        mentionOnly: true
      })
    )
  })

  it('refuses a repository the agent is not authorized for before asking the server', async () => {
    mocks.fetchAgentRepos.mockResolvedValue([])
    await renderAgent({ id: 'agent-unauthorized' })
    await pickRepository()
    expect(document.body.textContent).toContain('build-agent is not authorized for')
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createAzureDevOpsHook).not.toHaveBeenCalled()
  })
})
