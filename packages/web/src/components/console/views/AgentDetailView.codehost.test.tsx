// @vitest-environment happy-dom
/**
 * The code-host panes list ONE flat row per `(repo, family)` subscription — no
 * repo header, no group control. A repository's rows sit adjacent with change
 * proposals first, secondary row actions fold into a ⋯ menu, and a family the
 * repo does not watch yet is offered by a + menu on its first row.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  createGithubHook: vi.fn(),
  openModal: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}))
vi.mock('next/link', () => ({ default: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ openPlayground: vi.fn() }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/lib/use-session-list', () => ({ useSessionList: () => ({ sessions: [], total: 0, isLoading: false }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({ runtimes: [] }), acpRuntime: () => null }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [agent],
    getAgent: () => agent,
    getSessions: () => [],
    daemons: [],
    daemonsLoading: false,
    integrations: [],
    agentsLoading: false,
    updateAgent: vi.fn(async () => undefined),
    refresh: vi.fn(),
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => mocks.hooks),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  createGithubHook: mocks.createGithubHook
}))

const agent = {
  id: 'agent-1',
  name: 'pilot',
  model: 'sonnet',
  runtime: 'claude',
  desc: '',
  outputMode: '—',
  showFooter: true,
  showStatusBar: false,
  reasoning: '',
  fastMode: false,
  pause: false,
  memoryProvider: 'none',
  memoryAutoDistill: false,
  status: 'online',
  workspace: { mode: 'scratch', files: [] },
  integrations: [],
  visibility: 'org'
} as unknown as Parameters<typeof Object.freeze>[0]

function githubHook(partial: Record<string, unknown>): unknown {
  return {
    agentId: 'agent-1',
    kind: 'github',
    enabled: true,
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    ...partial
  }
}

// acme/api is watched for EVERY offered subject; acme/web only for issues.
const PR_ROW = githubHook({
  id: 'hook-pr',
  repoId: '1',
  name: 'acme/api',
  repoFullName: 'acme/api',
  family: 'pull_request',
  events: ['pull_request:*', 'issue_comment:created']
})
const ISSUES_ROW = githubHook({
  id: 'hook-issues',
  repoId: '1',
  name: 'acme/api',
  repoFullName: 'acme/api',
  family: 'issues',
  events: ['issues:*', 'issue_comment:created'],
  labelFilter: ['bug', 'p0', 'ux']
})
const DEPLOY_ROW = githubHook({
  id: 'hook-deploy',
  repoId: '1',
  name: 'acme/api',
  repoFullName: 'acme/api',
  family: 'deployment',
  events: ['deployment:created']
})
const WEB_ISSUES_ROW = githubHook({
  id: 'hook-web',
  repoId: '2',
  name: 'acme/web',
  repoFullName: 'acme/web',
  family: 'issues',
  events: ['issues:*', 'issue_comment:created']
})

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentDetailView />
      </SWRConfig>
    )
  })
  return host
}

/** Elements by their tooltip/aria text — the console's own handles on a control. */
function byTitle(scope: HTMLElement, title: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(`[title="${title}"]`)]
}

/** An open flyout's item by label — the menu is body-portaled, so search the document. */
function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button.fopt')].find((el) => el.textContent?.trim() === label)
}

/** The mono spans that name a repository — one per responsive tree, on the block's FIRST row only. */
function repoNames(scope: HTMLElement, repo: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('span.mono')].filter((el) => el.textContent === repo)
}

/** The element sitting immediately before one row's trigger control — where the family marker belongs. */
function markerBeforeTrigger(scope: HTMLElement, ariaLabel: string): HTMLElement | null {
  const button = scope.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`)
  const select = button?.closest('span.inline-flex') ?? null
  return (select?.previousElementSibling as HTMLElement | null) ?? null
}

/** Every trigger control in list order, named by the row it belongs to. */
function triggerOrder(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll<HTMLElement>('[aria-label^="Trigger for "]')].map(
    (el) => el.getAttribute('aria-label') ?? ''
  )
}

beforeEach(() => {
  mocks.hooks = [ISSUES_ROW, PR_ROW, DEPLOY_ROW, WEB_ISSUES_ROW]
  mocks.createGithubHook.mockReset()
  mocks.createGithubHook.mockResolvedValue({ id: 'hook-new' })
  mocks.openModal.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('AgentDetailView, code-host repository blocks', () => {
  it('keeps a repository one row per family and names it once', async () => {
    const scope = await render()
    // Three families ⇒ three rows, and exactly one of them names the repo (once per responsive tree).
    expect(repoNames(scope, 'acme/api')).toHaveLength(2)
    expect(repoNames(scope, 'acme/web')).toHaveLength(2)
    // Repos sorted by name, a repo's rows adjacent, change proposals before issues before deployments.
    expect(triggerOrder(scope)).toEqual([
      'Trigger for acme/api PRs',
      'Trigger for acme/api Issues',
      'Trigger for acme/api Deploys',
      'Trigger for acme/web Issues'
    ])
  })

  it('has no repository header or group-level remove', async () => {
    const scope = await render()
    expect(byTitle(scope, 'Remove repository')).toHaveLength(0)
    // Every row's own X is the only removal — a repo goes away one family at a time.
    expect(byTitle(scope, 'Stop watching PRs')).toHaveLength(1)
    expect(byTitle(scope, 'Stop watching Issues')).toHaveLength(2)
    expect(byTitle(scope, 'Stop watching Deploys')).toHaveLength(1)
  })

  it('deletes just one family from the per-row control', async () => {
    const scope = await render()
    const removeIssues = byTitle(scope, 'Stop watching Issues')[0]!
    await act(async () => removeIssues.click())
    expect(mocks.openModal).toHaveBeenCalledWith('deleteHook', expect.objectContaining({ id: 'hook-issues' }))
  })

  it('states the family as a plain label at the head of the row control cluster', async () => {
    const scope = await render()
    for (const [ariaLabel, family] of [
      ['Trigger for acme/api PRs', 'PRs'],
      ['Trigger for acme/api Issues', 'Issues']
    ] as const) {
      const marker = markerBeforeTrigger(scope, ariaLabel)
      expect(marker?.textContent).toBe(family)
      // A label, never a control: no button, no segmented container around it.
      expect(marker?.tagName).toBe('SPAN')
      expect(marker?.querySelector('button')).toBeNull()
      expect(marker?.className).not.toContain('border')
    }
  })

  it('offers a + menu only on a repository missing a family, inline on its first row', async () => {
    const scope = await render()
    // acme/api watches every offered subject, so only acme/web carries the + (once per responsive tree).
    const triggers = byTitle(scope, 'Watch another subject')
    expect(triggers).toHaveLength(2)
    for (const trigger of triggers) {
      expect(trigger.closest('div')!.textContent).toContain('acme/web')
    }
    // The menu (body-portaled) lists only what is missing.
    await act(async () => triggers[0]!.click())
    expect(menuItem('Add Pull requests')).toBeTruthy()
    expect(menuItem('Add Deployments')).toBeTruthy()
    expect(menuItem('Add Issues')).toBeUndefined()
  })

  it('offers the same three cadences on an issues row as on a PR row', async () => {
    const scope = await render()
    // The menu is body-portaled, so read it off the document after opening.
    await act(async () => scope.querySelector<HTMLElement>('[aria-label="Trigger for acme/api Issues"]')!.click())
    expect(menuItem('labeled')).toBeUndefined()
    expect(menuItem('create')).toBeTruthy()
    expect(menuItem('update')).toBeTruthy()
    await act(async () => menuItem('@-mention')!.click())

    await act(async () => scope.querySelector<HTMLElement>('[aria-label="Trigger for acme/api PRs"]')!.click())
    expect(menuItem('labeled')).toBeUndefined()
    expect(menuItem('update')).toBeTruthy()
  })

  it('shows a row’s label filter at rest and settles it in the settings dialog of any thread row', async () => {
    const scope = await render()
    // Two labels and the overflow count at rest; the full list on hover.
    const hint = byTitle(scope, 'Label filter: bug, p0, ux')
    expect(hint).toHaveLength(1)
    expect(hint[0]!.textContent).toContain('bug, p0')
    expect(hint[0]!.textContent).toContain('+1')
    // Settings… is on the issues row too: the label filter is, even though reviews are not.
    await act(async () => scope.querySelector<HTMLElement>('[aria-label="More for acme/api Issues"]')!.click())
    await act(async () => menuItem('Settings…')!.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Issues settings')
    expect(dialog.textContent?.toLowerCase()).not.toContain('review')
    expect(dialog.querySelectorAll('[data-label-filter="open"] [aria-label^="Remove label "]')).toHaveLength(3)
  })

  it('creates the missing family row at the default trigger', async () => {
    // The same default the wizard opens the subject on: every update, for a PR.
    const scope = await render()
    await act(async () => byTitle(scope, 'Watch another subject')[0]!.click())
    await act(async () => menuItem('Add Pull requests')!.click())
    expect(mocks.createGithubHook).toHaveBeenCalledTimes(1)
    expect(mocks.createGithubHook).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        repoFullName: 'acme/web',
        family: 'pull_request',
        events: ['pull_request:*', 'issue_comment:created'],
        commentFamilies: ['pull_request'],
        mentionOnly: false
      })
    )
  })

  it('surfaces a refused create instead of wedging the pane', async () => {
    mocks.createGithubHook.mockRejectedValue(new Error('No GitHub App installation for acme/web'))
    const scope = await render()
    await act(async () => byTitle(scope, 'Watch another subject')[0]!.click())
    await act(async () => menuItem('Add Pull requests')!.click())
    expect(scope.textContent).toContain('No GitHub App installation for acme/web')
    // The + is still there and still clickable — the failure is not terminal.
    expect(byTitle(scope, 'Watch another subject')).toHaveLength(2)
  })

  it('offers settings on every thread row, with the review surface on the PR row alone', async () => {
    const scope = await render()
    // Desktop folds settings into the row's ⋯ menu; mobile keeps an inline icon on each THREAD row —
    // both issues rows and the PR row, never the deployment, which has nothing to settle.
    expect(byTitle(scope, 'Settings')).toHaveLength(3)
    const prMore = scope.querySelector<HTMLElement>('[aria-label="More for acme/api PRs"]')!
    await act(async () => prMore.click())
    await act(async () => menuItem('Settings…')!.click())
    const prDialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(prDialog.textContent).toContain('Pull requests settings')
    expect(prDialog.textContent).toContain('PR review')
    expect(prDialog.textContent).toContain('Only with labels')
    await act(async () => byTitle(prDialog, 'Close')[0]!.click())

    const deployMore = scope.querySelector<HTMLElement>('[aria-label="More for acme/api Deploys"]')!
    await act(async () => deployMore.click())
    expect(menuItem('Settings…')).toBeUndefined()
    expect(menuItem('Recent deliveries')).toBeTruthy()
  })
})
