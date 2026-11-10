// @vitest-environment happy-dom
// The Azure DevOps workspace tile (azure-devops-integration.md §5): the identity's repositories, an unbound one bound by the save, sent as its canonical clone address.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import { ApiError } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchRepositories: vi.fn(),
  fetchVisible: vi.fn(),
  startIdentity: vi.fn(),
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
  startAzureDevOpsUserIdentity: mocks.startIdentity,
  setAgentWorkspace: mocks.setAgentWorkspace
}))

const EditWorkspaceModal = (await import('./EditWorkspaceModal')).default

const CONNECTION_ID = '00000000-0000-4000-8000-000000000010'
const REPOSITORY = '00000000-0000-4000-8000-000000000023'
const CLONE_URL = 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo'

const agent = { id: 'agent-a', name: 'build-agent', canEdit: true, workspace: { mode: 'scratch' } } as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(currentAgent: Agent = agent) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <EditWorkspaceModal agent={currentAgent} authorized={[]} onClose={() => undefined} onChanged={() => undefined} />
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
  it.each(['message', 'focus'] as const)(
    'reloads the verified catalog on %s without saving the form',
    async (returned) => {
      mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [{ id: CONNECTION_ID }] })
      mocks.fetchRepositories.mockResolvedValue([])
      mocks.fetchVisible.mockRejectedValueOnce(
        new ApiError('verification required', 403, 'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED')
      )
      mocks.startIdentity.mockResolvedValue({ authorizeUrl: 'https://login.microsoftonline.com/example' })
      const popup = { location: { href: '' }, close: vi.fn() } as unknown as Window
      const opened = vi.spyOn(window, 'open').mockReturnValue(popup)
      try {
        await render()
        await act(async () => buttonsNamed('Azure DevOps')[0]?.click())
        expect(buttonsNamed('Verify Microsoft access')).toHaveLength(1)
        await act(async () => buttonsNamed('Verify Microsoft access')[0]!.click())
        expect(mocks.startIdentity).toHaveBeenCalledWith(CONNECTION_ID)
        expect(popup.location.href).toBe('https://login.microsoftonline.com/example')
        mocks.fetchVisible.mockResolvedValue([])
        await act(async () =>
          window.dispatchEvent(
            returned === 'focus'
              ? new Event('focus')
              : new MessageEvent('message', {
                  origin: window.location.origin,
                  source: popup,
                  data: { type: 'azure-devops-identity-verified' }
                })
          )
        )
        expect(mocks.fetchVisible).toHaveBeenCalledTimes(2)
        await act(async () => window.dispatchEvent(new Event('focus')))
        expect(mocks.fetchVisible).toHaveBeenCalledTimes(2)
        expect(mocks.setAgentWorkspace).not.toHaveBeenCalled()
      } finally {
        opened.mockRestore()
      }
    }
  )

  it('can save an unchanged Azure workspace to reauthorize it', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ id: CONNECTION_ID, organization: 'example-org', state: 'connected' }]
    })
    mocks.fetchRepositories.mockResolvedValue([])
    mocks.fetchVisible.mockResolvedValue([
      {
        repositoryId: REPOSITORY,
        projectId: '00000000-0000-4000-8000-000000000021',
        path: 'example-org/Example Project/example-repo',
        cloneUrl: CLONE_URL,
        defaultBranch: 'main',
        repoId: '7',
        bindingId: 'binding-1'
      }
    ])
    await render({
      ...agent,
      workspace: {
        mode: 'git',
        provider: 'azure-devops',
        gitRepo: CLONE_URL,
        repo: 'example-org/Example Project/example-repo',
        repoId: '7',
        branch: 'main',
        gitAccess: 'write',
        worktree: true,
        agentDir: '/',
        lastPull: '',
        commit: '',
        commitMsg: '',
        commitTime: '',
        clean: true,
        files: []
      }
    } as Agent)
    const save = buttonsNamed('Save')[0]!
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ gitRepo: CLONE_URL, access: 'write' })
    )
  })

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
