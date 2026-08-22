// @vitest-environment happy-dom
/**
 * The GitLab workspace choice is a standing switch: with the flag off the mode
 * tile must not exist AND the project list must never be requested, because a
 * deployment without a GitLab application does not serve that route. With it on,
 * the picker offers the organization's added projects — every state except the
 * transient ones — and the save sends the numeric project id, never the path.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  fetchGitlabProjects: vi.fn(),
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
  setAgentWorkspace: mocks.setAgentWorkspace
}))

const EditWorkspaceModal = (await import('./EditWorkspaceModal')).default

const binding = (over: Record<string, unknown>) => ({
  id: `binding-${over.projectId}`,
  projectPath: 'acme/platform',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  serviceAccountUsername: 'project_1_bot',
  webhookInstalled: true,
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

const setFlags = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

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
  setFlags()
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.fetchGitlabProjects.mockReset()
  mocks.setAgentWorkspace.mockClear()
})

describe('EditWorkspaceModal, GitLab workspace', () => {
  it('offers no GitLab source and asks for no projects while the flag is off', async () => {
    setFlags()
    mocks.fetchGitlabProjects.mockResolvedValue([binding({ projectId: '1' })])
    await render()

    expect(document.body.textContent).not.toContain('From GitLab')
    expect(mocks.fetchGitlabProjects).not.toHaveBeenCalled()
  })

  it('lists the added projects and disables the ones still setting up', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([
      binding({ projectId: '1', projectPath: 'acme/platform', state: 'ready' }),
      binding({ projectId: '2', projectPath: 'acme/runtime', state: 'runtime_degraded' }),
      binding({ projectId: '3', projectPath: 'acme/fresh', state: 'provisioning' })
    ])
    await render()
    await act(async () => buttonsNamed('From GitLab')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())

    const options = Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('acme/')
    )
    expect(options.map((option) => option.textContent?.includes('acme/platform'))).toContain(true)
    expect(options.find((option) => option.textContent?.includes('acme/fresh'))?.disabled).toBe(true)
    expect(options.find((option) => option.textContent?.includes('acme/runtime'))?.disabled).toBe(false)
    expect(document.body.textContent).toContain('bot access degraded')
  })

  it('saves the picked project by its numeric id', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([binding({ projectId: '4210', projectPath: 'acme/platform' })])
    await render()
    await act(async () => buttonsNamed('From GitLab')[0]?.click())
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    const option = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('acme/platform')
    )
    await act(async () => option?.click())
    await act(async () => buttonsNamed('Replace workspace')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'gitlab',
      worktree: true,
      projectId: '4210',
      gitBranch: 'main',
      gitAccess: 'write'
    })
  })

  it('points at the connection surface when no project has been added', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([])
    await render()
    await act(async () => buttonsNamed('From GitLab')[0]?.click())

    expect(document.body.textContent).toContain('No GitLab projects have been added yet')
    expect(document.querySelector('a[href="/acme/integrations"]')).not.toBeNull()
  })
})
