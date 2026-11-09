// @vitest-environment happy-dom
// The Azure DevOps arm (azure-devops-integration.md §5, §8): what the connection's identity sees, unbound rows bound on save, and a grant by GUID through the one connection.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRepoAuthDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchRepositories: vi.fn(),
  fetchVisible: vi.fn(),
  createAgentRepo: vi.fn()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  fetchAzureDevOpsConnections: mocks.fetchConnections,
  fetchAzureDevOpsRepositories: mocks.fetchRepositories,
  fetchAzureDevOpsConnectionRepositories: mocks.fetchVisible,
  createAgentRepo: mocks.createAgentRepo
}))

const AddAgentRepoModal = (await import('./AddAgentRepoModal')).default

const CONNECTION_ID = '00000000-0000-4000-8000-000000000010'
const BOUND = '00000000-0000-4000-8000-000000000020'
const UNBOUND = '00000000-0000-4000-8000-000000000023'
const PROJECT = '00000000-0000-4000-8000-000000000021'

const CONNECTION = {
  id: CONNECTION_ID,
  organization: 'example-org',
  organizationInstanceId: '00000000-0000-4000-8000-000000000011',
  tenantId: '00000000-0000-4000-8000-000000000001',
  identityId: '00000000-0000-4000-8000-000000000012',
  identityName: 'AgentConnect',
  credentialSource: 'deployment',
  clientId: null,
  state: 'connected',
  stateReason: null,
  credentialEpoch: '1',
  boundRepositories: 1,
  connectedBy: 'user-1',
  lastVerifiedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

const visible = (repositoryId: string, name: string, repoId: string | null, bindingId: string | null) => ({
  repositoryId,
  projectId: PROJECT,
  path: `example-org/Example Project/${name}`,
  cloneUrl: `https://dev.azure.com/example-org/Example%20Project/_git/${name}`,
  defaultBranch: 'main',
  repoId,
  bindingId
})

const BINDING = {
  id: 'binding-1',
  connectionId: CONNECTION_ID,
  repoId: '9001',
  repositoryId: BOUND,
  projectId: PROJECT,
  repoPath: 'example-org/Example Project/example-repo',
  cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

const grant = (over: Partial<AgentRepoAuthDto>): AgentRepoAuthDto => ({
  id: 'ra-1',
  provider: 'azure-devops',
  repoId: '9002',
  repoFullName: 'example-org/Example Project/example-second',
  access: 'read',
  createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(authorized: AgentRepoAuthDto[] = []) {
  const agent = {
    id: 'agent-a',
    name: 'build-agent',
    canEdit: true,
    workspace: { mode: 'scratch' }
  } as unknown as Agent
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <AddAgentRepoModal
        agent={agent}
        workspaceRepo={null}
        authorized={authorized}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    )
  })
}

const buttonsNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes(text))

function connected() {
  mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION], deploymentApplication: true })
  mocks.fetchRepositories.mockResolvedValue([BINDING])
  mocks.fetchVisible.mockResolvedValue([
    visible(BOUND, 'example-repo', '9001', 'binding-1'),
    visible(UNBOUND, 'example-second', null, null)
  ])
}

async function pickAzureDevOps() {
  await act(async () => buttonsNamed('Azure DevOps')[0]?.click())
}

async function openPicker() {
  await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('AddAgentRepoModal, Azure DevOps repositories', () => {
  it('offers Azure DevOps beside the other hosts and asks nothing until it is picked', async () => {
    connected()
    await render()
    expect(buttonsNamed('Azure DevOps')).toHaveLength(1)
    expect(mocks.fetchConnections).not.toHaveBeenCalled()
    await pickAzureDevOps()
    expect(mocks.fetchVisible).toHaveBeenCalledWith(CONNECTION_ID)
  })

  it('marks a repository nothing has bound yet as added on save, and grants it by GUID through the connection', async () => {
    connected()
    mocks.createAgentRepo.mockResolvedValue(grant({ access: 'write' }))
    await render()
    await pickAzureDevOps()
    await openPicker()

    const unbound = document.querySelector(`[data-azure-devops-choice="${UNBOUND}"]`)!
    expect(unbound.textContent).toContain('added on save')
    expect(document.querySelector(`[data-azure-devops-choice="${BOUND}"]`)?.textContent).not.toContain('added on save')
    await act(async () => (unbound as HTMLButtonElement).click())

    // Two tiers the proxy enforces, in Azure DevOps's vocabulary; no comment tier.
    expect(document.body.textContent).toContain('Push and open pull requests')
    expect(document.body.textContent).not.toContain('run GitHub Actions')
    const write = Array.from(document.querySelectorAll('div')).find(
      (row) => row.textContent === 'Read & writePush and open pull requests'
    )
    await act(async () => write?.click())
    await act(async () => buttonsNamed('Add')[0]?.click())

    expect(mocks.createAgentRepo).toHaveBeenCalledWith('agent-a', {
      provider: 'azure-devops',
      connectionId: CONNECTION_ID,
      repositoryId: UNBOUND,
      access: 'write',
      materialize: 'always'
    })
  })

  it('names a repository the agent already holds instead of offering it again', async () => {
    connected()
    await render([
      grant({ id: 'ra-held', repoId: '9001', repoFullName: BINDING.repoPath, connectionId: CONNECTION_ID })
    ])
    await pickAzureDevOps()
    await openPicker()
    expect(document.querySelector(`[data-azure-devops-choice="${BOUND}"]`)).toBeNull()
    expect(document.body.textContent).toContain('example-org/Example Project/example-repo is already authorized')
  })

  it('does not offer a bound repository excluded by the personal access check', async () => {
    connected()
    mocks.fetchVisible.mockResolvedValue([visible(UNBOUND, 'example-second', null, null)])
    await render()
    await pickAzureDevOps()
    await openPicker()
    expect(document.querySelector(`[data-azure-devops-choice="${BOUND}"]`)).toBeNull()
    expect(document.querySelector(`[data-azure-devops-choice="${UNBOUND}"]`)).not.toBeNull()
  })

  it('shows the permission-check failure without falling back to bound repositories', async () => {
    connected()
    mocks.fetchVisible.mockRejectedValue(new Error('permission verification unavailable'))
    await render()
    await pickAzureDevOps()
    await openPicker()
    expect(document.body.textContent).toContain('permission verification unavailable')
    expect(document.querySelector('[data-azure-devops-choice]')).toBeNull()
    expect(mocks.createAgentRepo).not.toHaveBeenCalled()
  })

  it('sends the reader to the Integrations card while nothing is connected', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [], deploymentApplication: true })
    await render()
    await pickAzureDevOps()
    expect(document.body.textContent).toContain('Connect Azure DevOps to pick repositories')
    expect(document.querySelector('a[href="/acme/integrations"]')).not.toBeNull()
    expect(mocks.fetchVisible).not.toHaveBeenCalled()
  })
})
