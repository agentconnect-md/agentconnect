// @vitest-environment happy-dom
// Completing a capability request saves through the console's own dialog or route, prefilled, and settles only after a save landed.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRequestDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  fetchAgent: vi.fn(),
  updateAgent: vi.fn(),
  editProps: undefined as Record<string, unknown> | undefined,
  skillSources: [] as Array<{ name: string }>,
  fetchRepos: vi.fn(),
  updateRepo: vi.fn(),
  startOauth: vi.fn(),
  githubInstallUrl: vi.fn(),
  startGitlab: vi.fn(),
  openModal: vi.fn(),
  repoProps: undefined as Record<string, unknown> | undefined,
  mcpEditProps: undefined as Record<string, unknown> | undefined,
  mcpProviders: [] as Array<Record<string, unknown>>,
  saveLiveSecret: vi.fn(),
  cronProps: undefined as Record<string, unknown> | undefined,
  crons: [] as Array<Record<string, unknown>>
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: 'agent-1', name: 'pilot', runtime: 'claude-acp', daemon: 'd-1', canEdit: true }],
    daemons: [],
    skillSources: mocks.skillSources,
    mcpProviders: mocks.mcpProviders,
    crons: mocks.crons,
    updateAgent: mocks.updateAgent
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.repoProps = props
    return <div data-repo-modal />
  }
}))
vi.mock('@/components/console/McpServersCard', () => ({
  EditMcpProviderModal: (props: Record<string, unknown>) => {
    mocks.mcpEditProps = props
    return <div data-mcp-edit />
  }
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  settleCapabilityRequest: mocks.settle,
  fetchAgentDto: mocks.fetchAgent,
  fetchAgentRepos: mocks.fetchRepos,
  updateAgentRepo: mocks.updateRepo,
  startMcpProviderOauth: mocks.startOauth,
  fetchGithubInstallUrl: mocks.githubInstallUrl,
  startGitlabOauth: mocks.startGitlab,
  saveAgentLiveSecret: mocks.saveLiveSecret
}))
vi.mock('@/components/console/Scrim', () => ({ Scrim: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/console/modals/EditAgentModal', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.editProps = props
    return <div data-edit-agent />
  }
}))
vi.mock('@/components/console/modals/AddCronModal', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.cronProps = props
    return <div data-cron-modal />
  }
}))
vi.mock('@/components/console/AgentToolsCard', () => ({ AgentToolsCard: () => <div data-tools-card /> }))
vi.mock('@/components/console/AgentSkillsCard', () => ({ AgentSkillsCard: () => <div data-skills-card /> }))
vi.mock('@/components/console/InstallRegistrySkillModal', () => ({
  InstallRegistrySkillModal: ({ initialQuery }: { initialQuery?: string }) => <div data-registry={initialQuery} />
}))

const { CapabilityRequestCompletion } = await import('./CapabilityRequestCompletion')

function request(overrides: Partial<CapabilityRequestDto>): CapabilityRequestDto {
  return {
    id: 'req-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    agentName: 'pilot',
    kind: 'agent-settings',
    target: 'model',
    want: { model: 'opus' },
    summary: '',
    reason: '',
    status: 'open',
    generation: 1,
    createdAt: '2026-10-26T09:00:00.000Z',
    expiresAt: '2026-11-02T09:00:00.000Z',
    settledAt: null,
    settledBy: null,
    outcome: null,
    differs: false,
    note: null,
    origins: [],
    current: {},
    warnings: [],
    viewer: { canComplete: true, canDecline: true, canReopen: false, canForward: false, missing: null, whoCan: [] },
    ...overrides
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined
const onSettled = vi.fn()

const onRefresh = vi.fn()

async function render(dto: CapabilityRequestDto): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(<CapabilityRequestCompletion request={dto} onSettled={onSettled} onRefresh={onRefresh} />)
  )
  return host
}

const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined

beforeEach(() => {
  mocks.settle.mockReset()
  mocks.fetchAgent.mockReset()
  mocks.updateAgent.mockReset()
  mocks.editProps = undefined
  mocks.skillSources = []
  for (const fn of [mocks.fetchRepos, mocks.updateRepo, mocks.startOauth, mocks.githubInstallUrl, mocks.startGitlab])
    fn.mockReset()
  mocks.openModal.mockReset()
  mocks.saveLiveSecret.mockReset()
  mocks.repoProps = undefined
  mocks.mcpEditProps = undefined
  mocks.mcpProviders = []
  mocks.cronProps = undefined
  mocks.crons = []
  onSettled.mockReset()
  onRefresh.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('completing a capability request', () => {
  it('opens the agent configuration dialog on its runtime settings, prefilled, and settles as the task it saved', async () => {
    const settled = request({ status: 'completed' })
    mocks.settle.mockResolvedValue(settled)
    const scope = await render(request({ want: { model: 'opus', fastMode: true } }))
    expect(scope.querySelector('[data-edit-agent]')).toBeNull()
    await act(async () => button(scope, 'Review and save settings')!.click())
    expect(scope.querySelector('[data-edit-agent]')).not.toBeNull()
    expect(mocks.editProps).toMatchObject({ focusSection: 'runtime', prefill: { model: 'opus', fastMode: true } })
    expect(mocks.settle).not.toHaveBeenCalled()
    await act(async () => (mocks.editProps!.onSaved as () => void)())
    expect(mocks.settle).toHaveBeenCalledWith('req-1', 'org-1', undefined)
    expect(onSettled).toHaveBeenCalledWith(settled)
  })

  it('opens the cron dialog on this agent with the asked schedule and prompt, and settles as the task it saved', async () => {
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const want = { schedule: '0 9 * * 1', timezone: 'Asia/Tokyo', trigger: 'send the report' }
    const scope = await render(request({ kind: 'cron', target: 'new:0 9 * * 1:Asia/Tokyo:', want }))
    await act(async () => button(scope, 'Review and save the scheduled task')!.click())
    expect(mocks.cronProps).toMatchObject({ cron: null, prefill: { agentId: 'agent-1', ...want } })
    const saved = '2c3d4e5f-6071-4829-93a4-b5c6d7e8f9a0'
    await act(async () => (mocks.cronProps!.onSaved as (cronId: string) => void)(saved))
    expect(mocks.settle).toHaveBeenCalledWith('req-1', 'org-1', { cronId: saved })
  })

  it('opens a change on the agent’s own cron, and refuses one that no longer exists', async () => {
    const cronId = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
    const want = { cronId, schedule: '0 10 * * 1', trigger: 'send the report' }
    const gone = await render(request({ kind: 'cron', target: `cron:${cronId}`, want }))
    expect(button(gone, 'Review and save the scheduled task')!.disabled).toBe(true)
    await act(async () => root!.unmount())
    host?.remove()
    mocks.crons = [{ id: cronId, agentId: 'agent-1', schedule: '0 9 * * 1', trigger: 'send the report' }]
    const scope = await render(request({ kind: 'cron', target: `cron:${cronId}`, want }))
    await act(async () => button(scope, 'Review and save the scheduled task')!.click())
    expect(mocks.cronProps).toMatchObject({ cron: { id: cronId }, prefill: { schedule: '0 10 * * 1' } })
  })

  it('attaches the server beside the agent’s others, then settles', async () => {
    mocks.fetchAgent.mockResolvedValue({ mcpServers: ['grafana'], skills: [] })
    mocks.updateAgent.mockResolvedValue(undefined)
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: true } })
    )
    await act(async () => button(scope, 'Add Linear')!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['grafana', 'Linear'] })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
  })

  it('does not settle when the save was refused', async () => {
    mocks.fetchAgent.mockResolvedValue({ mcpServers: [], skills: [] })
    mocks.updateAgent.mockRejectedValue(new Error('not an editor'))
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: true } })
    )
    await act(async () => button(scope, 'Add Linear')!.click())
    expect(mocks.settle).not.toHaveBeenCalled()
    expect(scope.querySelector('[role="alert"]')?.textContent).toBe('not an editor')
  })

  it('points to Tools & Skills for a server the organization never registered', async () => {
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: false } })
    )
    expect(button(scope, 'Add Linear')).toBeUndefined()
    expect(scope.querySelector('a[href="/acme/tools"]')).not.toBeNull()
  })

  it('enables a skill from a source in the library, and searches the registry otherwise', async () => {
    mocks.skillSources = [{ name: 'acme' }]
    mocks.fetchAgent.mockResolvedValue({ mcpServers: [], skills: ['other/*'] })
    mocks.updateAgent.mockResolvedValue(undefined)
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(request({ kind: 'skill', want: { skill: 'acme/lint' }, current: { installed: false } }))
    await act(async () => button(scope, 'Install acme/lint')!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { skills: ['other/*', 'acme/lint'] })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
    await act(async () => root!.unmount())
    host?.remove()

    mocks.skillSources = []
    const fresh = await render(request({ kind: 'skill', want: { skill: 'acme/lint' }, current: { installed: false } }))
    expect(fresh.textContent).toContain('The skill library has no source named acme yet.')
    await act(async () => button(fresh, 'Find it in the skill registry')!.click())
    expect(fresh.querySelector('[data-registry]')?.getAttribute('data-registry')).toBe('lint')
  })

  it('raises an existing read grant to write in place, then settles', async () => {
    mocks.fetchRepos.mockResolvedValue([
      {
        id: 'grant-1',
        provider: 'github',
        repoFullName: 'Acme/Widgets',
        access: 'read',
        createdBy: null,
        createdAt: ''
      }
    ])
    mocks.updateRepo.mockResolvedValue({})
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(
      request({
        kind: 'repository',
        want: { provider: 'github', repository: 'acme/widgets', access: 'write' },
        current: { authorized: 'read', repoId: '7', installationId: null }
      })
    )
    await act(async () => button(scope, 'Raise acme/widgets to read & write')!.click())
    expect(mocks.updateRepo).toHaveBeenCalledWith('agent-1', 'grant-1', { access: 'write' })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
  })

  it('opens the repository dialog on the asked code host, repository and tier', async () => {
    mocks.fetchRepos.mockResolvedValue([])
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(
      request({
        kind: 'repository',
        want: { provider: 'gitlab', repository: 'group/project', access: 'read' },
        current: { authorized: 'none', repoId: null, installationId: null }
      })
    )
    await act(async () => button(scope, 'Authorize group/project')!.click())
    expect(mocks.repoProps).toMatchObject({
      initialProvider: 'gitlab',
      initialSearch: 'group/project',
      initialAccess: 'read'
    })
    await act(async () => (mocks.repoProps!.onCreated as (row: unknown) => void)({ id: 'grant-2' }))
    expect(mocks.settle).toHaveBeenCalledTimes(1)
  })

  it('starts the server’s OAuth with a return to this request, and looks again instead of settling', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    mocks.startOauth.mockResolvedValue({ url: 'https://auth.example.test/start' })
    const scope = await render(
      request({
        id: 'req-9',
        kind: 'connection',
        want: { type: 'mcp-oauth', server: 'Linear' },
        current: { providerId: 'prov-1', connected: false }
      })
    )
    await act(async () => button(scope, 'Connect Linear')!.click())
    expect(mocks.startOauth).toHaveBeenCalledWith('prov-1', { returnPath: '/acme/requests/req-9' })
    expect(open).toHaveBeenCalledWith('https://auth.example.test/start', 'mcp_provider_oauth', expect.any(String))
    expect(scope.textContent).toContain('Waiting for the connection to finish')
    await act(async () => button(scope, 'Check again')!.click())
    expect(onRefresh).toHaveBeenCalled()
    expect(mocks.settle).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('opens the add-integration dialog for the agent on the asked platform', async () => {
    const scope = await render(
      request({
        kind: 'connection',
        want: { type: 'chat-integration', platform: 'discord' },
        current: { connected: false }
      })
    )
    await act(async () => button(scope, 'Add a discord integration')!.click())
    expect(mocks.openModal).toHaveBeenCalledWith('integration', expect.objectContaining({ id: 'agent-1' }), {
      platform: 'discord'
    })
  })

  it('asks for a header in the server’s own edit dialog and settles as the task it saved', async () => {
    mocks.mcpProviders = [{ id: 'prov-2', name: 'Grafana', auth: 'headers', canEdit: true, headerNames: ['X-Org'] }]
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(
      request({
        kind: 'secret',
        want: { name: 'X-Api-Key', description: 'Grafana key', use: { route: 'mcp-header', server: 'Grafana' } },
        current: { providerId: 'prov-2', present: false }
      })
    )
    expect(scope.textContent).toContain('The agent never sees it')
    await act(async () => button(scope, 'Set X-Api-Key')!.click())
    expect(mocks.mcpEditProps).toMatchObject({ requestedHeader: 'X-Api-Key' })
    await act(async () => (mocks.mcpEditProps!.onSaved as () => void)())
    expect(mocks.settle).toHaveBeenCalledTimes(1)
  })

  describe('a live secret', () => {
    const live = (present = false) =>
      request({
        kind: 'secret',
        want: { name: 'GRAFANA_TOKEN', description: 'A Grafana API token', use: { route: 'live' } },
        current: { present }
      })
    const field = (scope: HTMLElement) => scope.querySelector<HTMLTextAreaElement>('[data-live-secret-field]')!
    const type = (input: HTMLTextAreaElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    it('takes the value write-only, says the agent can read it, saves it, clears it and settles', async () => {
      mocks.saveLiveSecret.mockResolvedValue(undefined)
      mocks.settle.mockResolvedValue(request({ status: 'completed' }))
      const scope = await render(live())
      expect(scope.textContent).toContain('The agent can read this value.')
      expect(scope.textContent).toContain('A Grafana API token')
      expect(button(scope, 'Save GRAFANA_TOKEN')!.disabled).toBe(true)
      // A multi-line credential (a kubeconfig, a PEM key) keeps its line breaks.
      await act(async () => type(field(scope), 'glsa_secret\nsecond line'))
      await act(async () => button(scope, 'Save GRAFANA_TOKEN')!.click())
      expect(mocks.saveLiveSecret).toHaveBeenCalledWith(
        'agent-1',
        { name: 'GRAFANA_TOKEN', value: 'glsa_secret\nsecond line', description: 'A Grafana API token' },
        'org-1'
      )
      expect(mocks.settle).toHaveBeenCalledTimes(1)
      expect(field(scope).value).toBe('')
      expect(scope.innerHTML).not.toContain('glsa_secret')
    })

    it('shows a name collision and does not settle', async () => {
      const { ApiError } = await import('@/lib/api')
      mocks.saveLiveSecret.mockRejectedValue(new ApiError('GRAFANA_TOKEN is already an environment variable', 409))
      const scope = await render(live(true))
      expect(scope.textContent).toContain('already set; saving replaces it')
      await act(async () => type(field(scope), 'v'))
      await act(async () => button(scope, 'Save GRAFANA_TOKEN')!.click())
      expect(scope.querySelector('[role="alert"]')?.textContent).toBe(
        'GRAFANA_TOKEN is already an environment variable'
      )
      expect(mocks.settle).not.toHaveBeenCalled()
    })
  })
})
