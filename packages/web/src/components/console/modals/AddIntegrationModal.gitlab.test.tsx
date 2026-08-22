// @vitest-environment happy-dom
/**
 * The GitLab trigger kind in the Add-integration wizard. Three things are worth
 * a regression test: the tile is absent — and the project list unrequested —
 * while the flag is off; each "Trigger when" choice compiles to exactly the
 * stored vocabulary the CP validates (`family:*` patterns, note families,
 * labels, mention-only) keyed by the project's numeric id rather than its
 * renameable path; and pushes stay a per-push subscription across the cadence.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  createGitlabHook: vi.fn(async () => ({ id: 'hook-1', agentId: 'agent-a', kind: 'gitlab' })),
  fetchGitlabProjects: vi.fn(),
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
    createGitlabHook: mocks.createGitlabHook,
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  syncGithubInstallations: vi.fn(async () => []),
  fetchGitlabProjects: mocks.fetchGitlabProjects
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
  serviceAccountUsername: 'project_4210_bot',
  webhookInstalled: true,
  credentialEpoch: '1',
  createdAt: '2026-08-01T00:00:00.000Z'
}

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
    root?.render(<AddIntegrationModal agent={agent} onClose={() => undefined} />)
  })
}

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const family = (fam: string) => document.querySelector<HTMLDivElement>(`[data-gitlab-family="${fam}"]`)
const trigger = (mode: string) => document.querySelector<HTMLDivElement>(`[data-gitlab-trigger="${mode}"]`)
// React tracks the DOM value itself, so a plain assignment is invisible to onChange.
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pickProject() {
  await act(async () => tileNamed('GitLab')?.click())
  await act(async () => document.querySelector<HTMLDivElement>('.inp')?.click())
  await act(async () => clickText('acme/platform')?.click())
}

afterEach(async () => {
  setFlags()
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGitlabHook.mockClear()
  mocks.fetchGitlabProjects.mockReset()
  mocks.daemons = []
})

describe('AddIntegrationModal, GitLab trigger', () => {
  it('offers no GitLab tile and asks for no projects while the flag is off', async () => {
    setFlags()
    mocks.fetchGitlabProjects.mockResolvedValue([])
    await render()

    expect(tileNamed('GitHub')).toBeDefined()
    expect(tileNamed('GitLab')).toBeUndefined()
    expect(mocks.fetchGitlabProjects).not.toHaveBeenCalled()
  })

  it('defaults to the updated trigger, scoping replies to the selected subjects', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()

    // No cadence click: the form opens on "updated", merge requests only.
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith({
      agentId: 'agent-a',
      name: 'acme/platform',
      projectId: '4210',
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      labelFilter: [],
      mentionOnly: false
    })
  })

  it('compiles the created trigger to openings with no note subscription', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('first')?.click())

    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith(
      expect.objectContaining({
        events: ['issues:opened', 'merge_request:opened'],
        commentFamilies: [],
        mentionOnly: false
      })
    )
  })

  it('compiles the mention-only trigger to the updated event set plus the flag', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => family('issues')?.click())
    await act(async () => trigger('mention')?.click())
    await act(async () =>
      typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Label filter"]')!, 'needs-review, agent')
    )

    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith({
      agentId: 'agent-a',
      name: 'acme/platform',
      projectId: '4210',
      events: ['issues:*', 'merge_request:*'],
      commentFamilies: ['issues', 'merge_request'],
      labelFilter: ['needs-review', 'agent'],
      mentionOnly: true
    })
  })

  it('keeps pushes a per-push subscription across the cadence, and says so', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([project])
    await render()
    await pickProject()
    await act(async () => family('merge_request')?.click())
    await act(async () => family('push')?.click())

    expect(document.body.textContent).toContain('created and updated behave the same')

    await act(async () => trigger('first')?.click())
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGitlabHook).toHaveBeenCalledWith(
      expect.objectContaining({ events: ['push:*'], commentFamilies: [], mentionOnly: false })
    )
  })

  it('drops the separate comments row and mention checkbox the form used to expose', async () => {
    setFlags('gitlab')
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
    setFlags('gitlab')
    mocks.daemons = [{ daemonId: 'daemon-1', caps: { platforms: ['slack'] } }]
    mocks.fetchGitlabProjects.mockResolvedValue([])
    await render()

    expect(tileNamed('GitLab')?.getAttribute('aria-disabled')).toBe('false')
    expect(tileNamed('GitHub')?.getAttribute('aria-disabled')).toBe('false')
    // Control: a chat platform the daemon does not advertise stays disabled.
    expect(tileNamed('Discord')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('points at the connection surface when no project has been added', async () => {
    setFlags('gitlab')
    mocks.fetchGitlabProjects.mockResolvedValue([])
    await render()
    await act(async () => tileNamed('GitLab')?.click())

    expect(document.body.textContent).toContain('No GitLab projects have been added yet')
    expect(document.querySelector('a[href="/acme/integrations"]')).not.toBeNull()
  })
})
