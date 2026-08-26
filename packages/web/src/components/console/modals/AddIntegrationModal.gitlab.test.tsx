// @vitest-environment happy-dom
/**
 * The GitLab trigger kind in the Add-integration wizard. Three things are worth
 * a regression test: a deployment with no GitLab application still offers the
 * tile and states the absence in the pane rather than failing a load; each
 * "Trigger when" choice compiles to exactly the stored vocabulary the CP
 * validates (`family:*` patterns, note families, mention-only) keyed by the
 * project's numeric id rather than its renameable path; and the form offers
 * exactly the two subjects GitHub does, so no reachable selection compiles a
 * push event.
 *
 * A row is `(agent, project, family)`, so a multi-subject pick is one create PER
 * FAMILY and a family the project is already watched for is not on offer.
 *
 * The picker also offers projects the organization has not added yet, because
 * this wizard is now where a project joins the organization.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  // The parameter is declared so `mock.calls` stays typed — the wizard now makes
  // one call per subject family and the tests read those bodies back.
  createGitlabHook: vi.fn(async (_input: { family: string; events: string[] }) => ({
    id: 'hook-1',
    agentId: 'agent-a',
    kind: 'gitlab'
  })),
  fetchGitlabProjects: vi.fn(),
  fetchGitlabConnections: vi.fn(),
  searchGitlabProjects: vi.fn(),
  createGitlabProject: vi.fn(),
  fetchAgentRepos: vi.fn(),
  fetchAgentHooks: vi.fn(async () => [] as unknown[]),
  startGitlabOauth: vi.fn(),
  daemons: [] as unknown[]
}))

/** `window.open` is the connect flow's only visible effect — record it rather than navigate. */
const opened: unknown[][] = []
window.open = ((...args: unknown[]) => {
  opened.push(args)
  return null
}) as typeof window.open

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    daemons: mocks.daemons,
    daemonsLoading: false,
    createIntegration: vi.fn(),
    createHook: vi.fn(),
    createGithubHook: vi.fn(),
    createGitlabHook: mocks.createGitlabHook,
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: mocks.fetchAgentHooks,
  fetchAgentRepos: mocks.fetchAgentRepos,
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  syncGithubInstallations: vi.fn(async () => []),
  fetchGitlabProjects: mocks.fetchGitlabProjects,
  fetchGitlabConnections: mocks.fetchGitlabConnections,
  searchGitlabProjects: mocks.searchGitlabProjects,
  createGitlabProject: mocks.createGitlabProject,
  startGitlabOauth: mocks.startGitlabOauth
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  daemon: 'daemon-1',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

const project = {
  id: 'binding-1',
  projectId: '4210',
  projectPath: 'acme/platform',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  accounts: [],
  webhookState: 'installed',
  credentialEpoch: '1',
  createdAt: '2026-08-01T00:00:00.000Z'
}

const connection = {
  id: 'conn-1',
  gitlabUserId: '4711',
  gitlabUsername: 'octo-maintainer',
  state: 'connected',
  scopes: ['api'],
  connectedBy: 'user-1',
  accessExpiresAt: null,
  assignedProjects: 0,
  createdAt: '2026-08-01T00:00:00.000Z'
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={agent} onClose={() => undefined} />)
  })
}

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const family = (fam: string) => document.querySelector<HTMLDivElement>(`[data-gitlab-family="${fam}"]`)
const trigger = (mode: string) => document.querySelector<HTMLDivElement>(`[data-gitlab-trigger="${mode}"]`)

async function pickProject() {
  await act(async () => tileNamed('GitLab')?.click())
  await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
  await act(async () => clickText('acme/platform')?.click())
}

/** The agent already holds the project a trigger may watch (§8.3) — the precondition
 *  every compilation test is about something else than. */
const authorization = {
  id: 'ra-1',
  provider: 'gitlab' as const,
  repoId: '4210',
  repoFullName: 'acme/platform',
  access: 'read' as const,
  createdBy: null,
  createdAt: '2026-08-01T00:00:00.000Z'
}

/** One usable connection with nothing else on offer; a test that needs another shape overrides it. */
beforeEach(() => {
  mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [connection] })
  mocks.searchGitlabProjects.mockResolvedValue({ projects: [], nextPage: null })
  mocks.fetchAgentRepos.mockResolvedValue([authorization])
  mocks.fetchAgentHooks.mockResolvedValue([])
})

/** Candidates are searched on GitLab behind a debounce; let it elapse for real. */
async function settleSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGitlabHook.mockClear()
  mocks.fetchGitlabProjects.mockReset()
  mocks.fetchGitlabConnections.mockReset()
  mocks.searchGitlabProjects.mockReset()
  mocks.createGitlabProject.mockReset()
  mocks.fetchAgentRepos.mockReset()
  mocks.fetchAgentHooks.mockReset()
  mocks.startGitlabOauth.mockReset()
  opened.length = 0
  mocks.daemons = []
})

describe('AddIntegrationModal, GitLab trigger', () => {
  it('offers the GitLab tile beside GitHub and states the absence on an unconfigured deployment', async () => {
    // Availability is the API's answer, not the picker's: the tile is always
    // offered and the pane it opens says why there is nothing to pick.
    mocks.fetchGitlabProjects.mockRejectedValue(new ApiError('GET /gitlab/projects → 404', 404))
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()

    expect(tileNamed('GitHub')).toBeDefined()
    expect(tileNamed('GitLab')).toBeDefined()
    // Nothing is asked before the pane is opened.
    expect(mocks.fetchGitlabProjects).not.toHaveBeenCalled()

    await act(async () => tileNamed('GitLab')?.click())
    expect(document.body.textContent).toContain(
      'GitLab is not enabled on this deployment — no GitLab application is configured.'
    )
    expect(document.body.textContent).not.toContain('Couldn’t load your GitLab projects')
  })

  it('defaults to the updated trigger, scoping replies to the selected subjects', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()

    // No cadence click: the form opens on "updated", merge requests only.
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith({
      agentId: 'agent-a',
      name: 'acme/platform',
      projectId: '4210',
      family: 'merge_request',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: false,
      // The review disclosure opens on the full preset, exactly like the github pane.
      reviewPolicy: 'full',
      reportingMode: 'check'
    })
  })

  it('compiles the created trigger to openings with no note subscription', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('first')?.click())

    await act(async () => clickText('Connect')?.click())

    // One row per subject family — each carries its own single-family events.
    expect(mocks.createGitlabHook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ family: 'issues', events: ['issues:opened'], commentFamilies: [], mentionOnly: false })
    )
    expect(mocks.createGitlabHook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        family: 'merge_request',
        events: ['merge_request:opened'],
        commentFamilies: [],
        mentionOnly: false
      })
    )
  })

  it('compiles the mention-only trigger to the updated event set plus the flag', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('mention')?.click())

    await act(async () => clickText('Connect')?.click())

    // Reviews and the run note ride the merge-request row; the issues row is off.
    expect(mocks.createGitlabHook).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-a',
      name: 'acme/platform',
      projectId: '4210',
      family: 'issues',
      events: ['issues:*'],
      commentFamilies: ['issues'],
      mentionOnly: true,
      reviewPolicy: 'off',
      reportingMode: 'off'
    })
    expect(mocks.createGitlabHook).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-a',
      name: 'acme/platform',
      projectId: '4210',
      family: 'merge_request',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: true,
      reviewPolicy: 'full',
      reportingMode: 'check'
    })
  })

  it('offers the review disclosure and sends whichever preset is chosen', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()

    // The section exists on the GitLab pane, worded for merge requests.
    const disclosure = clickText('MR review')
    expect(disclosure).toBeDefined()
    await act(async () => disclosure?.click())
    expect(document.body.textContent).toContain('Run note')

    // "None" turns both axes off in one click.
    await act(async () => clickText('None')?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPolicy: 'off', reportingMode: 'off' })
    )
  })

  it('names GitLab tier semantics in the review copy, not GitHub ones', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => clickText('MR review')?.click())

    const help = Array.from(document.querySelectorAll('label[title]')).map((row) => row.getAttribute('title') ?? '')
    // §15.3: request-changes needs the bot to be a current reviewer; approval is its own act.
    expect(help.some((text) => text.includes('current reviewer'))).toBe(true)
    expect(help.some((text) => text.includes('separate act from a review'))).toBe(true)
    expect(help.join(' ')).not.toContain('Check Run')
    expect(help.join(' ')).not.toContain('CODEOWNERS')
  })

  it('offers exactly the two subjects GitHub offers, and never emits a push event', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()

    expect(document.querySelectorAll('[data-gitlab-family]')).toHaveLength(2)
    expect(family('issues')).not.toBeNull()
    expect(family('merge_request')).not.toBeNull()
    expect(family('push')).toBeNull()

    // Selecting everything reachable still compiles no push event; the exact
    // per-cadence arrays are asserted by the three cases above.
    await act(async () => family('issues')?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook.mock.calls.map(([body]) => body.family)).toEqual(['issues', 'merge_request'])
    expect(mocks.createGitlabHook.mock.calls.flatMap(([body]) => body.events)).toEqual(['issues:*', 'merge_request:*'])
  })

  it('drops the separate comments row and mention checkbox the form used to expose', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()

    expect(document.body.textContent).toContain('Listen for')
    expect(document.body.textContent).toContain('Trigger when')
    expect(document.body.textContent).not.toContain('Also run on comments in')
    expect(document.querySelector('input[aria-label="Mention only"]')).toBeNull()
  })

  it('keeps the GitLab tile enabled on a placed daemon that advertises no such adapter', async () => {
    // GitLab is a relay-backed trigger kind, not a chat platform: the owning daemon's
    // adapter list has no say over it. Naming only webhook and github in that set left
    // this tile — and the agent page's empty-state twin — disabled for a placed agent.
    mocks.daemons = [{ daemonId: 'daemon-1', caps: { platforms: ['slack'] } }]
    mocks.fetchGitlabProjects.mockResolvedValue([])
    await render()

    expect(tileNamed('GitLab')?.getAttribute('aria-disabled')).toBe('false')
    expect(tileNamed('GitHub')?.getAttribute('aria-disabled')).toBe('false')
    // Control: a chat platform the daemon does not advertise stays disabled.
    expect(tileNamed('Discord')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('connects GitLab in place instead of sending the user to another surface', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [] })
    mocks.startGitlabOauth.mockResolvedValue('https://gitlab.example.test/oauth/authorize?state=one-shot')
    await render()
    await act(async () => tileNamed('GitLab')?.click())

    expect(document.querySelector('a[href="/acme/integrations"]')).toBeNull()
    // Nothing to search through: an unusable connection never reaches the picker.
    expect(mocks.searchGitlabProjects).not.toHaveBeenCalled()

    await act(async () => clickText('Connect GitLab')?.click())
    expect(mocks.startGitlabOauth).toHaveBeenCalled()
    expect(opened).toEqual([['https://gitlab.example.test/oauth/authorize?state=one-shot', '_blank', 'noopener']])
  })

  it('re-reads the picker when the user reports having connected', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    await act(async () => tileNamed('GitLab')?.click())
    expect(mocks.fetchGitlabConnections).toHaveBeenCalledTimes(1)

    mocks.fetchGitlabProjects.mockResolvedValue([project])
    mocks.fetchGitlabConnections.mockResolvedValue({ enabled: true, connections: [connection] })
    await act(async () => clickText('I’ve connected it — sync')?.click())

    expect(mocks.fetchGitlabConnections).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('Connect GitLab to watch projects')
  })

  it('sets up a project the organization has not added, then picks it', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([])
    mocks.searchGitlabProjects.mockResolvedValue({
      projects: [{ projectId: '4210', path: 'acme/platform', defaultBranch: 'main', lastActivityAt: null }],
      nextPage: null
    })
    let settle: (binding: typeof project) => void = () => undefined
    mocks.createGitlabProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    await render()
    await act(async () => tileNamed('GitLab')?.click())
    await settleSearch()
    expect(mocks.searchGitlabProjects).toHaveBeenCalledWith('conn-1', {})

    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    // The candidate says what picking it will do before the click.
    expect(document.body.textContent).toContain('sets up on pick')
    await act(async () => clickText('acme/platform')?.click())
    expect(mocks.createGitlabProject).toHaveBeenCalledWith({ connectionId: 'conn-1', projectId: '4210' })
    // The saga takes seconds; the option says so while it runs.
    expect(document.body.textContent).toContain('Setting up the project bot and webhook')

    await act(async () => {
      settle(project)
    })
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGitlabHook).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-a', name: 'acme/platform', projectId: '4210' })
    )
  })

  // Each case renders a DISTINCT agent id: the grant read is cached per agent, so
  // reusing one would serve the previous case's authorization set.
  async function renderAgent(over: Record<string, unknown>) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<AddIntegrationModal agent={{ ...agent, ...over } as unknown as Agent} onClose={() => undefined} />)
    })
  }

  it('refuses a project the agent is not authorized for, and names the fix', async () => {
    // A trigger never creates a grant (§8.3): the project must already be the
    // workspace project or an authorized additional one, so the wizard says so
    // rather than letting the create reach the same refusal from the server.
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    mocks.fetchAgentRepos.mockResolvedValue([])
    await renderAgent({ id: 'agent-unauthorized' })
    await pickProject()
    await settleSearch()

    expect(document.body.textContent).toContain('isn’t authorized for')
    expect(document.body.textContent).toContain('Workspace tab')

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGitlabHook).not.toHaveBeenCalled()
  })

  it('takes an already-watched family out of the offer instead of blocking the project', async () => {
    // A row is (agent, project, family), so watching merge requests leaves
    // issues free — the old repo-level block refused the whole project.
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    mocks.fetchAgentHooks.mockResolvedValue([
      { id: 'hook-mr', kind: 'gitlab', repoId: '4210', family: 'merge_request', events: ['merge_request:*'] }
    ])
    await renderAgent({ id: 'agent-half-watched' })
    await pickProject()

    expect(family('merge_request')?.getAttribute('aria-disabled')).toBe('true')
    expect(family('issues')?.getAttribute('aria-disabled')).toBe('false')

    await act(async () => family('issues')?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledTimes(1)
    expect(mocks.createGitlabHook).toHaveBeenCalledWith(expect.objectContaining({ family: 'issues' }))
  })

  it('accepts the agent’s own workspace project without a separate grant', async () => {
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    mocks.fetchAgentRepos.mockResolvedValue([])
    await renderAgent({ id: 'agent-workspace', workspace: { mode: 'gitlab', projectId: '4210' } })
    await pickProject()
    await settleSearch()

    expect(document.body.textContent).not.toContain('isn’t authorized for')
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGitlabHook).toHaveBeenCalledWith(expect.objectContaining({ projectId: '4210' }))
  })
})
