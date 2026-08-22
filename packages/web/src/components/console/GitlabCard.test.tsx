// @vitest-environment happy-dom
/**
 * The GitLab card is the console's GitLab MANAGEMENT surface: an unconnected
 * organization gets one entry point, a connected one gets its connection
 * lifecycle and the health of the projects already set up. Picking a project is
 * deliberately not here — that happens where the project is used. The write
 * actions are asserted against the endpoint they call: a repair that silently
 * posted to the wrong binding would still look right on screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GitlabConnectionDto, type GitlabProjectBindingDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchProjects: vi.fn(),
  repairProject: vi.fn(),
  deleteProject: vi.fn(),
  transferProject: vi.fn(),
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
  repairGitlabProject: mocks.repairProject,
  deleteGitlabProject: mocks.deleteProject,
  transferGitlabProject: mocks.transferProject,
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
  mine: true,
  accessExpiresAt: null,
  assignedProjects: 0,
  createdAt: '2026-08-01T00:00:00.000Z'
}

const BINDING: GitlabProjectBindingDto = {
  id: 'bind-1',
  projectId: '90210',
  projectPath: 'example-group/example-project',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  installerConnectionId: 'conn-1',
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

/** One connection row and everything the card renders under it. */
function connectionRow(id: string): HTMLElement {
  const found = host.querySelector(`[data-gitlab-connection="${id}"]`)
  if (!found) throw new Error(`no connection row: ${id}`)
  return found as HTMLElement
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

  it('offers Disconnect, not Remove, while the connection is still live', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.disconnect.mockResolvedValue({
      removed: false,
      connection: { ...CONNECTION, state: 'disconnected' as const }
    })
    await render()
    const row = connectionRow('conn-1')
    expect(buttonIn(row, 'Disconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Remove')).toThrow()

    // Disconnect is confirmed, and the row survives it — in its released state.
    await click('Disconnect')
    expect(mocks.disconnect).not.toHaveBeenCalled()
    await click('Disconnect', modal())
    expect(mocks.disconnect).toHaveBeenCalledWith('conn-1')
    expect(host.textContent).toContain('disconnected')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(1)
  })

  it('finishes a released connection that administers nothing: Remove instead of Disconnect', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 0 }]
    })
    mocks.disconnect.mockResolvedValue({ removed: true, connection: null })
    await render()
    const row = connectionRow('conn-1')
    expect(buttonIn(row, 'Reconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Disconnect')).toThrow()

    await click('Remove')
    expect(mocks.disconnect).not.toHaveBeenCalled()
    await click('Remove', modal())
    expect(mocks.disconnect).toHaveBeenCalledWith('conn-1')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(0)
  })

  it('explains why a released connection with projects still assigned cannot go', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 2 }]
    })
    await render()
    const row = connectionRow('conn-1')
    expect(row.textContent).toContain('still administers 2 projects')
    expect(buttonIn(row, 'Reconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Remove')).toThrow()
    expect(() => buttonIn(row, 'Disconnect')).toThrow()
    // The blocking count is stated in words, never as a machine code.
    expect(row.textContent).not.toContain('assignedProjects')
  })

  it('breaks the removal deadlock: transfer first, then the blocked line clears', async () => {
    // The account that set the project up is gone, so removing the project would
    // need an administering account it no longer has: takeover is the way out.
    const stale = { ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }
    const mine = { ...CONNECTION, id: 'conn-2', gitlabUsername: 'current-admin', assignedProjects: 0 }
    mocks.fetchConnections.mockResolvedValueOnce({ enabled: true, connections: [stale, mine] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    await render()

    expect(connectionRow('conn-1').textContent).toContain('still administers 1 project')
    expect(connectionRow('conn-1').textContent).toContain('Transfer that project')
    expect(() => buttonIn(connectionRow('conn-1'), 'Remove')).toThrow()

    // Remove is explained, not attempted: the saga would fail halfway at GitLab.
    await click('Remove', host.querySelector('[data-gitlab-project]')!)
    expect(modal().textContent).toContain('no longer connected')
    expect(() => buttonIn(modal(), 'Remove')).toThrow()
    expect(mocks.deleteProject).not.toHaveBeenCalled()
    await click('Close', modal())

    // Take it over, and the counts both sides show move with it.
    mocks.transferProject.mockResolvedValue({ ...BINDING, installerConnectionId: 'conn-2' })
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [
        { ...stale, assignedProjects: 0 },
        { ...mine, assignedProjects: 1 }
      ]
    })
    await click('Transfer', host.querySelector('[data-gitlab-project]')!)
    expect(mocks.transferProject).not.toHaveBeenCalled()
    await click('Transfer', modal())
    expect(mocks.transferProject).toHaveBeenCalledWith('bind-1')
    expect(connectionRow('conn-1').textContent).not.toContain('still administers')
    expect(buttonIn(connectionRow('conn-1'), 'Remove')).toBeTruthy()

    // And removal now runs for real, under the account that took it over.
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await click('Remove', host.querySelector('[data-gitlab-project]')!)
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('offers Transfer only where administration is stuck', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      BINDING,
      { ...BINDING, id: 'bind-degraded', projectPath: 'example-group/degraded', state: 'admin_degraded' as const }
    ])
    await render()

    const healthy = host.querySelector('[data-gitlab-project="bind-1"]')!
    const degraded = host.querySelector('[data-gitlab-project="bind-degraded"]')!
    // A ready project its own connected account manages has nothing to take over.
    expect(() => buttonIn(healthy, 'Transfer')).toThrow()
    expect(buttonIn(degraded, 'Transfer')).toBeTruthy()
  })

  it('offers Transfer on a project awaiting cleanup, connected installer and all', async () => {
    // A removal that failed halfway leaves cleanup_pending under a connected account:
    // the takeover is what lets someone else finish it.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([{ ...BINDING, state: 'cleanup_pending' as const }])
    await render()
    expect(buttonIn(host.querySelector('[data-gitlab-project]')!, 'Transfer')).toBeTruthy()
  })

  it('keeps a connect action reachable for a caller who owns none of the connections', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs] })
    await render()
    // Every listed account belongs to someone else, so the caller can still start their own.
    expect(buttonIn(host, 'Connect my account')).toBeTruthy()
  })

  it('drops that action once the caller has an own connected account', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs, CONNECTION] })
    await render()
    expect(() => buttonIn(host, 'Connect my account')).toThrow()
    expect(() => buttonIn(host, 'Connect GitLab')).toThrow()
  })

  it('points a takeover refused for want of an own account at that action', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, mine: false, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.transferProject.mockRejectedValue(new ApiError('no own connection', 409, 'GITLAB_NO_OWN_CONNECTION'))
    await render()

    await click('Transfer', host.querySelector('[data-gitlab-project]')!)
    await click('Transfer', modal())
    // The refusal names the affordance, and that affordance is on screen.
    expect(host.textContent).toContain('Connect my account')
    expect(buttonIn(host, 'Connect my account')).toBeTruthy()
  })

  it('says why a takeover was refused, in GitLab terms', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.transferProject.mockRejectedValue(new ApiError('gitlab: nope', 403, 'GITLAB_NOT_MAINTAINER'))
    await render()

    await click('Transfer', host.querySelector('[data-gitlab-project]')!)
    await click('Transfer', modal())
    expect(host.textContent).toContain('Maintainer or Owner access')
    // The refusal is readable: the dialog is gone and no machine code is shown.
    expect(host.querySelector('.modal')).toBeNull()
    expect(host.textContent).not.toContain('GITLAB_NOT_MAINTAINER')
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

  it('lists every retained connection, stale ones included', async () => {
    // The repository orders by createdAt ASC and retains stale rows, so the first is often unusable.
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [
        { ...CONNECTION, id: 'conn-old', gitlabUsername: 'former-admin', state: 'disconnected' as const },
        { ...CONNECTION, id: 'conn-new', gitlabUsername: 'current-admin' }
      ]
    })
    await render()
    expect(host.textContent).toContain('former-admin')
    expect(host.textContent).toContain('current-admin')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(2)
  })

  it('manages bindings but never picks a project: no add-project surface', async () => {
    // Authorization lives at the point of use; the card is the health list, like GitHub's.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    await render()

    expect(() => buttonIn(host, 'Add project')).toThrow()
    expect(host.querySelector('input[aria-label="Search GitLab projects"]')).toBeNull()
    // The health list itself is untouched: the project, its state, and its repairs.
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(1)
    expect(buttonIn(host, 'Repair')).toBeTruthy()
  })

  it('links the bot chip to the service account’s GitLab profile', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    await render()

    const chip = host.querySelector('[data-gitlab-project] a') as HTMLAnchorElement
    expect(chip.textContent).toBe('bot @project_4711_bot')
    expect(chip.getAttribute('href')).toBe('https://gitlab.com/project_4711_bot')
    // A new tab, and never one that can reach back into the console.
    expect(chip.getAttribute('target')).toBe('_blank')
    expect(chip.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('says where projects come from when a connection has none', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    await render()
    expect(host.textContent).toContain('No projects are set up yet')
    expect(host.textContent).toContain('agent workspace')
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
})
