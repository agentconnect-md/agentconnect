// @vitest-environment happy-dom
/**
 * The Gitea trigger kind in the Add-integration wizard. The same three things
 * are worth a regression test as on the GitLab pane: a deployment with no Gitea
 * instance still offers the tile and states the absence in the pane rather than
 * failing a load; each "Trigger when" choice compiles to exactly the stored
 * vocabulary the CP validates (`family:*` patterns, comment families,
 * mention-only) keyed by the repository's numeric id rather than its renameable
 * path; and the form offers exactly the two subjects, so no reachable selection
 * compiles a push event.
 *
 * A row is `(agent, repository, family)`, so a multi-subject pick is one create
 * PER FAMILY and a family the repository is already watched for is not on offer.
 *
 * Gitea's own differences show up twice: the picker offers the repositories the
 * organization's ONE bot administers, in one listing rather than a search; and
 * the pull-request card carries the commit-status disclosure rather than a run
 * note (gitea-integration.md §8, §10.4).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  // The parameter is declared so `mock.calls` stays typed — the wizard makes one
  // call per subject family and the tests read those bodies back.
  createGiteaHook: vi.fn(async (_input: { family: string; events: string[] }) => ({
    id: 'hook-1',
    agentId: 'agent-a',
    kind: 'gitea'
  })),
  fetchGiteaRepositories: vi.fn(),
  fetchGiteaConnections: vi.fn(),
  fetchGiteaConnectionRepositories: vi.fn(),
  createGiteaRepository: vi.fn(),
  fetchAgentRepos: vi.fn(),
  fetchAgentHooks: vi.fn(async () => [] as unknown[]),
  daemons: [] as unknown[]
}))

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
    createGitlabHook: vi.fn(),
    createGiteaHook: mocks.createGiteaHook,
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
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null })),
  fetchGiteaRepositories: mocks.fetchGiteaRepositories,
  fetchGiteaConnections: mocks.fetchGiteaConnections,
  fetchGiteaConnectionRepositories: mocks.fetchGiteaConnectionRepositories,
  createGiteaRepository: mocks.createGiteaRepository
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  daemon: 'daemon-1',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

const binding = {
  id: 'binding-1',
  connectionId: 'conn-1',
  repoId: '7711',
  repoPath: 'example-org/example-repo',
  cloneUrl: 'https://gitea.example.test/example-org/example-repo.git',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  webhookState: 'installed',
  lastVerifiedDeliveryAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z'
}

const connection = {
  id: 'conn-1',
  botUserId: '41',
  botUsername: 'agentconnect-bot',
  botDisplayName: 'AgentConnect bot',
  state: 'connected',
  connectedBy: 'user-1',
  credentialEpoch: '1',
  boundRepositories: 1,
  instanceUrl: 'https://gitea.example.test',
  instanceVersion: '1.24.0',
  instanceVersionSupported: true,
  instanceVersionFloor: '1.23',
  requiredScopes: ['read:user', 'write:repository', 'write:issue', 'read:organization'],
  lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z'
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
const family = (fam: string) => document.querySelector<HTMLDivElement>(`[data-gitea-family="${fam}"]`)
/** Cadence is per subject, so a tile is addressed by (family, mode). */
const trigger = (fam: string, mode: string) =>
  document.querySelector<HTMLButtonElement>(`[data-gitea-trigger="${fam}:${mode}"]`)

async function pickRepository() {
  await act(async () => tileNamed('Gitea')?.click())
  await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
  await act(async () => clickText('example-org/example-repo')?.click())
}

/** The agent already holds the repository a trigger may watch (§8.3) — the precondition
 *  every compilation test is about something else than. */
const authorization = {
  id: 'ra-1',
  provider: 'gitea' as const,
  repoId: '7711',
  repoFullName: 'example-org/example-repo',
  access: 'read' as const,
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z'
}

beforeEach(() => {
  mocks.fetchGiteaConnections.mockResolvedValue({ enabled: true, connections: [connection] })
  mocks.fetchGiteaConnectionRepositories.mockResolvedValue([])
  mocks.fetchAgentRepos.mockResolvedValue([authorization])
  mocks.fetchAgentHooks.mockResolvedValue([])
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGiteaHook.mockClear()
  mocks.fetchGiteaRepositories.mockReset()
  mocks.fetchGiteaConnections.mockReset()
  mocks.fetchGiteaConnectionRepositories.mockReset()
  mocks.createGiteaRepository.mockReset()
  mocks.fetchAgentRepos.mockReset()
  mocks.fetchAgentHooks.mockReset()
  mocks.daemons = []
})

describe('AddIntegrationModal, Gitea trigger', () => {
  it('offers the Gitea tile beside the other hosts and states the absence on an unconfigured deployment', async () => {
    // Availability is the API's answer, not the picker's: the tile is always offered and the
    // pane it opens says why there is nothing to pick.
    mocks.fetchGiteaRepositories.mockRejectedValue(new ApiError('GET /gitea/repositories → 404', 404))
    mocks.fetchGiteaConnections.mockResolvedValue({ enabled: false, connections: [] })
    await renderAgent()

    expect(tileNamed('GitHub')).toBeDefined()
    expect(tileNamed('GitLab')).toBeDefined()
    expect(tileNamed('Gitea')).toBeDefined()
    // Nothing is asked before the pane is opened.
    expect(mocks.fetchGiteaRepositories).not.toHaveBeenCalled()

    await act(async () => tileNamed('Gitea')?.click())
    expect(document.body.textContent).toContain(
      'Gitea is not enabled on this deployment — no Gitea instance is configured.'
    )
    expect(document.body.textContent).not.toContain('Couldn’t load your Gitea repositories')
    expect(mocks.fetchGiteaConnectionRepositories).not.toHaveBeenCalled()
  })

  it('sends an organization with no connected bot to the Integrations card', async () => {
    // Connecting Gitea is a token paste on the card, so a picker cannot finish the job —
    // it names where the job is done instead of offering a button that could not.
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    mocks.fetchGiteaConnections.mockResolvedValue({ enabled: true, connections: [] })
    await renderAgent({ id: 'agent-unconnected' })
    await act(async () => tileNamed('Gitea')?.click())

    expect(document.body.textContent).toContain('Connect Gitea to watch repositories')
    expect(document.querySelector('a[href="/acme/integrations"]')).not.toBeNull()
    expect(mocks.fetchGiteaConnectionRepositories).not.toHaveBeenCalled()
  })

  it('defaults a pull-request subject to the any-update trigger, comments included', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    await renderAgent({ id: 'agent-default' })
    await pickRepository()

    // No cadence click: the form opens on "any update", pull requests only.
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGiteaHook).toHaveBeenCalledWith({
      agentId: 'agent-default',
      name: 'example-org/example-repo',
      // The numeric id, never the renameable path.
      repoId: '7711',
      family: 'merge_request',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: false,
      // The review format opens on the full set, and Gitea reports the run state as a commit status.
      reviewPolicy: 'full',
      reportingMode: 'status'
    })
  })

  it('compiles the opened trigger to openings with no comment subscription', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    await renderAgent({ id: 'agent-opened' })
    await pickRepository()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('issues', 'first')?.click())
    await act(async () => trigger('merge_request', 'first')?.click())

    await act(async () => clickText('Connect')?.click())

    // One row per subject family — each carries its own single-family events.
    expect(mocks.createGiteaHook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ family: 'issues', events: ['issues:opened'], commentFamilies: [], mentionOnly: false })
    )
    expect(mocks.createGiteaHook).toHaveBeenNthCalledWith(
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
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    await renderAgent({ id: 'agent-mention' })
    await pickRepository()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('issues', 'mention')?.click())
    await act(async () => trigger('merge_request', 'mention')?.click())

    await act(async () => clickText('Connect')?.click())

    // Reviews and the commit status ride the pull-request row; the issues row carries neither.
    expect(mocks.createGiteaHook).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-mention',
      name: 'example-org/example-repo',
      repoId: '7711',
      family: 'issues',
      events: ['issues:*'],
      commentFamilies: ['issues'],
      mentionOnly: true,
      reviewPolicy: 'off',
      reportingMode: 'off'
    })
    expect(mocks.createGiteaHook).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-mention',
      name: 'example-org/example-repo',
      repoId: '7711',
      family: 'merge_request',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: true,
      reviewPolicy: 'full',
      reportingMode: 'status'
    })
  })

  it('states what a subscription does once, where every code host states it', async () => {
    // The footer under the form carries that sentence for all three hosts; the Gitea pane
    // printed it a second time of its own.
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    await renderAgent({ id: 'agent-hint' })
    await pickRepository()

    const hint = 'reply on the same issue, pull request or push thread'
    expect((document.body.textContent ?? '').split(hint)).toHaveLength(2)
  })

  it('offers the two subjects only — nothing reachable compiles a push event', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    await renderAgent({ id: 'agent-subjects' })
    await pickRepository()

    expect(family('issues')).not.toBeNull()
    expect(family('merge_request')).not.toBeNull()
    expect(family('push')).toBeNull()

    await act(async () => family('issues')?.click())
    await act(async () => clickText('Connect')?.click())
    for (const call of mocks.createGiteaHook.mock.calls) {
      expect(call[0]!.events.some((event) => event.startsWith('push'))).toBe(false)
    }
  })

  it('refuses a repository the agent is not authorized for, and names the fix', async () => {
    // A trigger never creates a grant (§8.3): the repository must already be the workspace
    // repository or an authorized additional one, so the wizard says so rather than letting
    // the create reach the same refusal from the server.
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    mocks.fetchAgentRepos.mockResolvedValue([])
    await renderAgent({ id: 'agent-unauthorized' })
    await pickRepository()

    expect(document.body.textContent).toContain('is not authorized for')
    expect(document.body.textContent).toContain('Workspace tab')

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGiteaHook).not.toHaveBeenCalled()
  })

  it('accepts the agent’s own workspace repository without a separate grant', async () => {
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    mocks.fetchAgentRepos.mockResolvedValue([])
    await renderAgent({
      id: 'agent-workspace-repo',
      workspace: { mode: 'git', provider: 'gitea', repoId: '7711', repo: 'example-org/example-repo' }
    })
    await pickRepository()

    expect(document.body.textContent).not.toContain('is not authorized for')
    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGiteaHook).toHaveBeenCalledWith(expect.objectContaining({ repoId: '7711' }))
  })

  it('takes an already-watched family out of the offer instead of blocking the repository', async () => {
    // A row is (agent, repository, family), so watching pull requests leaves issues free.
    mocks.fetchGiteaRepositories.mockResolvedValue([binding])
    mocks.fetchAgentHooks.mockResolvedValue([
      { id: 'hook-pr', kind: 'gitea', repoId: '7711', family: 'merge_request', events: ['merge_request:*'] }
    ])
    await renderAgent({ id: 'agent-half-watched' })
    await pickRepository()

    expect(family('merge_request')?.getAttribute('aria-disabled')).toBe('true')
    expect(family('issues')?.getAttribute('aria-disabled')).toBe('false')

    await act(async () => family('issues')?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGiteaHook).toHaveBeenCalledTimes(1)
    expect(mocks.createGiteaHook).toHaveBeenCalledWith(expect.objectContaining({ family: 'issues' }))
  })

  it('sets up a repository the organization has not added yet, then keys the hook on its id', async () => {
    // The wizard is where a repository joins the organization (§6): picking an unadded one
    // installs its webhook first, and the create that follows carries the numeric id.
    mocks.fetchGiteaRepositories.mockResolvedValue([])
    mocks.fetchGiteaConnectionRepositories.mockResolvedValue([
      {
        repoId: '7711',
        path: 'example-org/example-repo',
        cloneUrl: 'https://gitea.example.test/example-org/example-repo.git',
        defaultBranch: 'main',
        private: true
      }
    ])
    mocks.createGiteaRepository.mockResolvedValue(binding)
    await renderAgent({ id: 'agent-fresh-repo' })

    await act(async () => tileNamed('Gitea')?.click())
    expect(mocks.fetchGiteaConnectionRepositories).toHaveBeenCalledWith('conn-1')
    await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
    expect(document.body.textContent).toContain('sets up on pick')
    await act(async () => clickText('example-org/example-repo')?.click())
    expect(mocks.createGiteaRepository).toHaveBeenCalledWith({ repoId: '7711' })

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGiteaHook).toHaveBeenCalledWith(expect.objectContaining({ repoId: '7711' }))
  })
})
