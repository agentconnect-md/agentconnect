// @vitest-environment happy-dom
// The Azure DevOps workspace tile (azure-devops-integration.md §5): the identity's repositories, an unbound one bound by the save, sent as its canonical clone address.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchRepositories: vi.fn(),
  fetchVisible: vi.fn(),
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
  fetchAzureDevOpsConnections: mocks.fetchConnections,
  fetchAzureDevOpsRepositories: mocks.fetchRepositories,
  fetchAzureDevOpsConnectionRepositories: mocks.fetchVisible,
  setAgentWorkspace: mocks.setAgentWorkspace
}))

const EditWorkspaceModal = (await import('./EditWorkspaceModal')).default

const CONNECTION_ID = '00000000-0000-4000-8000-000000000010'
const REPOSITORY = '00000000-0000-4000-8000-000000000023'
const CLONE_URL = 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo'

const agent = { id: 'agent-a', name: 'build-agent', canEdit: true, workspace: { mode: 'scratch' } } as unknown as Agent

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
  for (const mock of Object.values(mocks)) mock.mockClear()
})

describe('EditWorkspaceModal, Azure DevOps workspace', () => {
  it('saves a repository nothing has bound yet as its clone address — the save binds it', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      deploymentApplication: true,
      connections: [
        { id: CONNECTION_ID, organization: 'example-org', state: 'connected', credentialSource: 'deployment' }
      ]
    })
    mocks.fetchRepositories.mockResolvedValue([])
    mocks.fetchVisible.mockResolvedValue([
      {
        repositoryId: REPOSITORY,
        projectId: '00000000-0000-4000-8000-000000000021',
        path: 'example-org/Example Project/example-repo',
        cloneUrl: CLONE_URL,
        defaultBranch: 'main',
        repoId: null,
        bindingId: null
      }
    ])
    await render()
    expect(mocks.fetchConnections).not.toHaveBeenCalled()
    await act(async () => buttonsNamed('Azure DevOps')[0]?.click())
    expect(mocks.fetchVisible).toHaveBeenCalledWith(CONNECTION_ID)

    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('added on save')
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[data-azure-devops-choice="${REPOSITORY}"]`)?.click()
    )
    await act(async () => buttonsNamed('Replace workspace')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: CLONE_URL,
      gitBranch: 'main',
      access: 'write'
    })
  })

  it('states the absence on a control plane without Azure DevOps', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: false, connections: [], deploymentApplication: false })
    await render()
    await act(async () => buttonsNamed('Azure DevOps')[0]?.click())
    expect(document.body.textContent).toContain('Azure DevOps is not enabled on this deployment')
    expect(mocks.fetchVisible).not.toHaveBeenCalled()
  })
})
