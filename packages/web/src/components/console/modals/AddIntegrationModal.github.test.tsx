// @vitest-environment happy-dom
/**
 * The GitHub trigger kind in the Add-integration wizard, on the axis its GitLab
 * twin covers too: a hook row is (agent, repo, SUBJECT FAMILY) and each row
 * carries its OWN trigger cadence, so a single pass can watch pull requests on
 * every update while issues answer only an @mention. The wizard's job is to
 * compile that pick into one create per family with that family's own `events`,
 * `commentFamilies` and `mentionOnly`.
 *
 * "Listen for" is a stack of expandable family cards: a card ticked open reveals
 * that subject's own "Trigger when" tiles, and the change-proposal card also
 * carries the review format. An unticked card reveals nothing.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  // Declared parameter keeps `mock.calls` typed — the tests read the bodies back.
  createGithubHook: vi.fn(async (_input: { family: string; events: string[] }) => ({
    id: 'hook-1',
    agentId: 'agent-a',
    kind: 'github'
  })),
  fetchAgentRepos: vi.fn(),
  fetchAgentHooks: vi.fn(async () => [] as unknown[])
}))

const installation = {
  id: 'inst-1',
  installationId: 42,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current' as const,
  pullRequestsPermission: 'write' as const,
  checksPermission: 'write' as const,
  settingsUrl: 'https://github.example.test/settings/installations/42',
  createdAt: '2026-08-01T00:00:00.000Z'
}

const repo = {
  repoId: '990',
  fullName: 'acme/platform',
  private: true,
  defaultBranch: 'main',
  description: null,
  updatedAt: null,
  installationId: 'inst-1'
}

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    daemons: [],
    daemonsLoading: false,
    createIntegration: vi.fn(),
    createHook: vi.fn(),
    createGithubHook: mocks.createGithubHook,
    createGitlabHook: vi.fn(),
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: mocks.fetchAgentHooks,
  fetchAgentRepos: mocks.fetchAgentRepos,
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: [installation] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [repo], privateReposHidden: false, failed: false })),
  syncGithubInstallations: vi.fn(async () => [installation]),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null }))
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

// An App-backed workspace repo at write: the pick is implicit and the review
// settings are unblocked, so every case here is about the cadence rows alone.
const agent = {
  id: 'agent-a',
  name: 'build-agent',
  daemon: 'daemon-1',
  canEdit: true,
  workspace: {
    mode: 'github',
    repo: 'acme/platform',
    repoId: '990',
    installationId: 'inst-1',
    gitAccess: 'write'
  }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

const tileNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLDivElement>('.ptile')).find((tile) => tile.textContent === label)
const clickText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
const family = (fam: string) => document.querySelector<HTMLDivElement>(`[data-github-family="${fam}"]`)
/** Cadence is per subject, so a tile is addressed by (family, mode). */
const trigger = (fam: string, mode: string) =>
  document.querySelector<HTMLButtonElement>(`[data-github-trigger="${fam}:${mode}"]`)
const format = (id: string) => document.querySelector<HTMLButtonElement>(`[data-review-format="${id}"]`)
const checkbox = (label: string) =>
  Array.from(document.querySelectorAll<HTMLLabelElement>('label')).find((row) => row.textContent?.includes(label))
    ?.firstElementChild as HTMLInputElement | undefined

/** Each case renders a DISTINCT agent id — the grant read is cached per agent. */
async function renderAgent(over: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={{ ...agent, ...over } as unknown as Agent} onClose={() => undefined} />)
  })
  await act(async () => tileNamed('GitHub')?.click())
}

beforeEach(() => {
  mocks.fetchAgentRepos.mockResolvedValue([])
  mocks.fetchAgentHooks.mockResolvedValue([])
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.createGithubHook.mockClear()
  mocks.fetchAgentRepos.mockReset()
  mocks.fetchAgentHooks.mockReset()
})

describe('AddIntegrationModal, GitHub trigger cadence', () => {
  it('defaults every selected subject to the opened cadence', async () => {
    await renderAgent({ id: 'agent-default' })

    // No cadence click: the form opens on "opened", pull requests only.
    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGithubHook).toHaveBeenCalledTimes(1)
    expect(mocks.createGithubHook).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'pull_request',
        events: ['pull_request:opened'],
        commentFamilies: ['pull_request'],
        mentionOnly: false
      })
    )
  })

  it('opens a subject card on tick and reveals nothing while it is unticked', async () => {
    await renderAgent({ id: 'agent-cards' })

    // Pull requests ride the default selection; issues start closed.
    expect(trigger('pull_request', 'first')).not.toBeNull()
    expect(document.querySelectorAll('[data-github-trigger^="issues:"]')).toHaveLength(0)

    await act(async () => family('issues')?.click())
    expect(trigger('issues', 'first')).not.toBeNull()

    // Untick and the whole body folds away again.
    await act(async () => family('issues')?.click())
    expect(document.querySelectorAll('[data-github-trigger^="issues:"]')).toHaveLength(0)
  })

  it('offers each subject its own three cadences — label events on issues alone', async () => {
    await renderAgent({ id: 'agent-per-family-tiles' })
    await act(async () => family('issues')?.click())

    expect(trigger('pull_request', 'every')).not.toBeNull()
    expect(trigger('pull_request', 'labeled')).toBeNull()
    expect(trigger('issues', 'labeled')).not.toBeNull()
    // Issues trade "any update" for the label cadence in the wizard.
    expect(trigger('issues', 'every')).toBeNull()
    expect(document.querySelectorAll('[data-github-trigger]')).toHaveLength(6)
  })

  it('gives each selected subject its own cadence in a single pass', async () => {
    await renderAgent({ id: 'agent-mixed' })
    await act(async () => family('issues')?.click())
    // Pull requests move to every update; issues answer an @mention only.
    await act(async () => trigger('pull_request', 'every')?.click())
    await act(async () => trigger('issues', 'mention')?.click())

    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGithubHook).toHaveBeenCalledTimes(2)
    expect(mocks.createGithubHook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        family: 'pull_request',
        events: ['pull_request:*', 'issue_comment:created'],
        commentFamilies: ['pull_request'],
        mentionOnly: false,
        // Reviews and Checks ride the pull-request row only.
        reviewPolicy: 'full',
        reportingMode: 'check'
      })
    )
    expect(mocks.createGithubHook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        family: 'issues',
        events: ['issues:*', 'issue_comment:created'],
        commentFamilies: ['issues'],
        mentionOnly: true,
        reviewPolicy: 'off',
        reportingMode: 'off'
      })
    )
  })

  it('compiles the label cadence to the bare label event with no reply scope', async () => {
    await renderAgent({ id: 'agent-labeled' })
    await act(async () => family('issues')?.click())
    await act(async () => trigger('issues', 'labeled')?.click())

    await act(async () => clickText('Connect')?.click())

    expect(mocks.createGithubHook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        family: 'issues',
        events: ['issues:labeled'],
        commentFamilies: [],
        mentionOnly: false
      })
    )
  })

  it('offers a cadence row per selected subject and none for an already-watched one', async () => {
    mocks.fetchAgentHooks.mockResolvedValue([
      {
        id: 'hook-pr',
        kind: 'github',
        repoFullName: 'acme/platform',
        family: 'pull_request',
        events: ['pull_request:*']
      }
    ])
    await renderAgent({ id: 'agent-half-watched' })

    expect(family('pull_request')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => family('issues')?.click())
    expect(document.querySelectorAll('[data-github-trigger]')).toHaveLength(3)
    expect(trigger('issues', 'first')).not.toBeNull()
    expect(trigger('pull_request', 'first')).toBeNull()

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGithubHook).toHaveBeenCalledTimes(1)
    expect(mocks.createGithubHook).toHaveBeenCalledWith(expect.objectContaining({ family: 'issues' }))
  })
})

describe('AddIntegrationModal, GitHub review format', () => {
  it('lives in the pull-request card, opens on Details, and offers no None', async () => {
    await renderAgent({ id: 'agent-format' })

    expect(document.body.textContent).toContain('Review format')
    expect(format('brief')).not.toBeNull()
    expect(format('details')?.getAttribute('aria-pressed')).toBe('true')
    expect(format('custom')).not.toBeNull()
    expect(format('none')).toBeNull()
    // Details is the whole set, so the manual checkboxes stay hidden.
    expect(checkbox('Inline comments')).toBeUndefined()

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGithubHook).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPolicy: 'full', reportingMode: 'check' })
    )
  })

  it('folds the format away with the pull-request card', async () => {
    await renderAgent({ id: 'agent-format-folds' })
    await act(async () => family('pull_request')?.click())

    expect(document.body.textContent).not.toContain('Review format')
  })

  it('sends the Brief mapping the preset already had', async () => {
    await renderAgent({ id: 'agent-brief' })
    await act(async () => format('brief')?.click())

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGithubHook).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPolicy: 'comment', reportingMode: 'off' })
    )
  })

  it('reveals the four capabilities on Custom, and an all-off Custom is the no-review state', async () => {
    await renderAgent({ id: 'agent-custom' })
    await act(async () => format('custom')?.click())

    // Custom only discloses — the value is still whatever Details left.
    expect(checkbox('Inline comments')?.checked).toBe(true)
    expect(checkbox('Status check')?.checked).toBe(true)

    // Inline comments carries the other two review capabilities down with it.
    await act(async () => checkbox('Inline comments')?.click())
    await act(async () => checkbox('Status check')?.click())
    expect(checkbox('Approve')?.checked).toBe(false)
    expect(checkbox('Request changes')?.checked).toBe(false)

    await act(async () => clickText('Connect')?.click())
    expect(mocks.createGithubHook).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPolicy: 'off', reportingMode: 'off' })
    )
  })
})
