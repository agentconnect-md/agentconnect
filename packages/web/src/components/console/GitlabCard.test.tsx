// @vitest-environment happy-dom
/**
 * The GitLab card is the console's whole GitLab surface, so what it renders IS
 * the connection state: an unconnected organization gets one entry point, a
 * connected one gets its projects and their lifecycle. The write actions are
 * asserted against the endpoint they call — a repair that silently posted to
 * the wrong binding would still look right on screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitlabConnectionDto, GitlabProjectBindingDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchProjects: vi.fn(),
  searchProjects: vi.fn(),
  createProject: vi.fn(),
  repairProject: vi.fn(),
  deleteProject: vi.fn(),
  disconnect: vi.fn(),
  startOauth: vi.fn()
}))

// One stable org object: the card keys its fetch effect on `activeOrg`, so a
// fresh literal per render would re-run it forever.
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-gitlab' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGitlabConnections: mocks.fetchConnections,
  fetchGitlabProjects: mocks.fetchProjects,
  searchGitlabProjects: mocks.searchProjects,
  createGitlabProject: mocks.createProject,
  repairGitlabProject: mocks.repairProject,
  deleteGitlabProject: mocks.deleteProject,
  disconnectGitlabConnection: mocks.disconnect,
  startGitlabOauth: mocks.startOauth
}))

const GitlabCard = (await import('./GitlabCard')).default

const CONNECTION: GitlabConnectionDto = {
  id: 'conn-1',
  gitlabUserId: '4711',
  gitlabUsername: 'octo-maintainer',
  state: 'connected',
  scopes: ['api'],
  connectedBy: 'user-1',
  accessExpiresAt: null,
  createdAt: '2026-08-01T00:00:00.000Z'
}

const BINDING: GitlabProjectBindingDto = {
  id: 'bind-1',
  projectId: '90210',
  projectPath: 'example-group/example-project',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  serviceAccountUsername: 'project_4711_bot',
  webhookInstalled: true,
  credentialEpoch: '1',
  createdAt: '2026-08-02T00:00:00.000Z'
}

let host: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<GitlabCard canWrite />)
  })
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

async function click(label: string, scope: ParentNode = host): Promise<void> {
  const target = buttonIn(scope, label)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The picker searches server-side behind a debounce; let it elapse for real. */
async function settleSearch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

function modal(): HTMLElement {
  const found = host.querySelector('.modal')
  if (!found) throw new Error('no confirmation modal is open')
  return found as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  mocks.fetchProjects.mockResolvedValue([])
  mocks.searchProjects.mockResolvedValue({ projects: [], nextPage: null })
})

describe('GitlabCard', () => {
  it('offers a single connect entry point when nothing is connected', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    expect(host.textContent).toContain('Not connected')
    expect(buttonIn(host, 'Connect GitLab')).toBeTruthy()
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('shows the connected identity, its projects, and no connect button', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    await render()
    expect(host.textContent).toContain('octo-maintainer')
    expect(host.textContent).toContain('example-group/example-project')
    expect(host.textContent).toContain('ready')
    expect(host.textContent).toContain('project_4711_bot')
    expect(host.textContent).not.toContain('Connect GitLab')
  })

  it('surfaces the reconnect hint when GitLab stopped accepting the connection', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'reauth_required' as const }]
    })
    await render()
    expect(host.textContent).toContain('reconnect needed')
    expect(buttonIn(host, 'Reconnect')).toBeTruthy()
  })

  it('repairs and removes the project it was invoked on', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.repairProject.mockResolvedValue({ ...BINDING, state: 'provisioning' as const })
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await render()

    await click('Repair')
    expect(mocks.repairProject).toHaveBeenCalledWith('bind-1')

    // Removal is confirmed, never fired by the row button itself.
    await click('Remove')
    expect(mocks.deleteProject).not.toHaveBeenCalled()
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('picks the connected account for the picker, not the oldest row', async () => {
    // The repository orders by createdAt ASC and retains stale rows, so the first is often unusable.
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [
        { ...CONNECTION, id: 'conn-old', gitlabUsername: 'former-admin', state: 'disconnected' as const },
        { ...CONNECTION, id: 'conn-new', gitlabUsername: 'current-admin' }
      ]
    })
    await render()
    // Both rows still render; only the usable one drives the picker.
    expect(host.textContent).toContain('former-admin')
    expect(host.textContent).toContain('current-admin')

    await click('Add project')
    await settleSearch()
    expect(mocks.searchProjects).toHaveBeenCalledWith('conn-new', {})
  })

  it('translates known binding reasons and hides unmapped machine categories', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      { ...BINDING, id: 'bind-known', state: 'admin_degraded' as const, stateReason: 'project_not_accessible' },
      {
        ...BINDING,
        id: 'bind-rotation',
        projectPath: 'example-group/rotating',
        state: 'admin_degraded' as const,
        stateReason: 'rotation_gitlab_503'
      },
      {
        ...BINDING,
        id: 'bind-fence',
        projectPath: 'example-group/interrupted',
        state: 'admin_degraded' as const,
        stateReason: 'claim_fence_lost'
      },
      {
        ...BINDING,
        id: 'bind-unknown',
        projectPath: 'example-group/mystery',
        state: 'runtime_degraded' as const,
        stateReason: 'some_future_category'
      }
    ])
    await render()
    expect(host.textContent).toContain('GitLab project is no longer accessible')
    expect(host.textContent).toContain('The project bot credential needs repair')
    // The lease fence also trips on same-org cleanup or a competing repair, so the copy stays neutral.
    expect(host.textContent).toContain('Setup was interrupted')
    expect(host.textContent).not.toContain('Another organization')
    // An unmapped category leaves the state badge alone and says nothing else.
    expect(host.textContent).not.toContain('some_future_category')
    expect(host.textContent).not.toContain('rotation_gitlab_503')
    expect(host.textContent).not.toContain('project_not_accessible')
    expect(host.textContent).toContain('bot access degraded')
  })

  it('binds a searched project through the connection that found it', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.searchProjects.mockResolvedValue({
      projects: [
        { projectId: '90210', path: 'example-group/example-project', defaultBranch: 'main', lastActivityAt: null }
      ],
      nextPage: null
    })
    mocks.createProject.mockResolvedValue(BINDING)
    await render()

    await click('Add project')
    await settleSearch()
    expect(mocks.searchProjects).toHaveBeenCalledWith('conn-1', {})

    const row = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'Add example-group/example-project'
    )
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.createProject).toHaveBeenCalledWith({ connectionId: 'conn-1', projectId: '90210' })
  })
})
