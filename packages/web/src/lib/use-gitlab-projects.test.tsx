// @vitest-environment happy-dom
/**
 * The picker's load must survive a lifecycle that starts twice. React Strict
 * Mode deliberately runs setup → cleanup → setup on mount, and a user can leave
 * the GitLab pane mid-request and come back; both abandon the first request. A
 * one-shot "already started" flag made the second lifecycle skip its own fetch
 * and wait forever on an answer nobody was listening for — a spinner that never
 * ends. Each active lifecycle owns a fresh request.
 */
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GitlabConnectionDto, type GitlabProjectBindingDto } from '@/lib/api'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  fetchConnections: vi.fn(),
  searchProjects: vi.fn(),
  createProject: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGitlabProjects: mocks.fetchProjects,
  fetchGitlabConnections: mocks.fetchConnections,
  searchGitlabProjects: mocks.searchProjects,
  createGitlabProject: mocks.createProject
}))

const { useGitlabProjects } = await import('./use-gitlab-projects')

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
  accounts: [],
  webhookState: 'installed',
  credentialEpoch: '1',
  createdAt: '2026-08-02T00:00:00.000Z'
}

/** Renders the hook's visible outcome: the spinner, or the paths it offers. */
function Probe({ active }: { active: boolean }) {
  const gl = useGitlabProjects(active, '')
  return <span>{gl.loading ? 'loading' : gl.choices.map((choice) => choice.projectPath).join(',')}</span>
}

/** Renders the availability answer the panes branch on. */
function AvailabilityProbe() {
  const gl = useGitlabProjects(true, '')
  return <span>{`${gl.enabled}|${gl.empty}|${gl.error ?? 'none'}`}</span>
}

let host: HTMLDivElement
let root: Root

async function mount(node: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
}

async function rerender(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  mocks.searchProjects.mockResolvedValue({ projects: [], nextPage: null })
})

describe('useGitlabProjects lifecycle', () => {
  it('loads under Strict Mode, whose mount runs setup, cleanup, then setup again', async () => {
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })

    await mount(
      <StrictMode>
        <Probe active />
      </StrictMode>
    )

    expect(host.textContent).toBe('example-group/example-project')
  })

  it('reads a deployment with no GitLab application as absence, not a load failure', async () => {
    // The whole surface 404s there; the panes must say so rather than render an error.
    mocks.fetchProjects.mockRejectedValue(new ApiError('GET /gitlab/projects → 404', 404))
    mocks.fetchConnections.mockResolvedValue({ enabled: false, connections: [] })

    await mount(<AvailabilityProbe />)

    expect(host.textContent).toBe('false|true|none')
  })

  it('still reports a real read failure', async () => {
    mocks.fetchProjects.mockRejectedValue(new ApiError('GET /gitlab/projects → 503', 503))
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })

    await mount(<AvailabilityProbe />)

    expect(host.textContent).toBe('true|true|GET /gitlab/projects → 503')
  })

  it('a visit that leaves mid-load and returns loads on the second visit', async () => {
    let settle: (bindings: GitlabProjectBindingDto[]) => void = () => undefined
    mocks.fetchProjects.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })

    await mount(<Probe active />)
    expect(host.textContent).toBe('loading')

    // Leave the pane, then let the abandoned first answer arrive with nobody listening.
    await rerender(<Probe active={false} />)
    await act(async () => {
      settle([])
    })

    await rerender(<Probe active />)
    expect(host.textContent).toBe('example-group/example-project')
  })
})
