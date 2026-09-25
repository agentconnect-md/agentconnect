// @vitest-environment happy-dom
// The Workspace card: one Source row, and a repository dropdown that edits access, checkout, and revocation in place.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryDecisionBlock } from '@/lib/repository-selector'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const repos = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const grants = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const role = vi.hoisted(() => ({ value: 'owner' as string }))
const decision = vi.hoisted(() => ({ block: 'provider' as RepositoryDecisionBlock }))
const editor = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
const mocks = vi.hoisted(() => ({
  mutateRepos: vi.fn(),
  mutateGrants: vi.fn(),
  updateAgentRepo: vi.fn(),
  deleteAgentRepo: vi.fn(),
  updateAgentInstallation: vi.fn(),
  deleteAgentInstallation: vi.fn()
}))

vi.mock('swr', () => ({
  default: (key: readonly string[]) => ({
    data: key[0] === 'installations' ? grants.rows : repos.rows,
    error: undefined,
    isLoading: false,
    mutate: key[0] === 'installations' ? mocks.mutateGrants : mocks.mutateRepos
  })
}))
vi.mock('@/lib/api', () => ({
  fetchAgentInstallations: vi.fn(),
  fetchAgentRepos: vi.fn(),
  repoAuthProvider: (row: { provider?: string }) => row.provider ?? 'github',
  repoAuthMaterialize: (row: { materialize?: string }) => row.materialize ?? 'always',
  updateAgentRepo: mocks.updateAgentRepo,
  deleteAgentRepo: mocks.deleteAgentRepo,
  updateAgentInstallation: mocks.updateAgentInstallation,
  deleteAgentInstallation: mocks.deleteAgentInstallation
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/acme/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: role.value }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/repository-selector', () => ({
  useRepositoryDecision: () => ({ providers: [], block: decision.block })
}))
vi.mock('@/lib/swr-keys', () => ({
  consoleKeys: { agentRepos: () => ['repos'], agentInstallations: () => ['installations'] }
}))
vi.mock('@/components/console/modals/EditWorkspaceModal', () => ({
  default: (props: Record<string, unknown>) => {
    editor.props = props
    return <div data-edit-workspace />
  }
}))

import { WorkspaceCard, type WorkspaceHeaderInfo } from './WorkspaceCard'
import type { Agent } from '@/lib/data'

const agent = (workspace: Record<string, unknown>, capabilities: { canEdit?: boolean } = {}) =>
  ({
    id: 'agent-a',
    name: 'deploy-bot',
    canEdit: capabilities.canEdit ?? true,
    repositorySelector: null,
    workspace
  }) as unknown as Agent

// Stored workspaces are host-neutral: one `git` mode plus the credential that vouches for the checkout (§7).
const GITHUB_APP = {
  mode: 'git',
  provider: 'github',
  repoId: '42',
  repo: 'acme/infra',
  gitRepo: 'https://github.com/acme/infra',
  branch: 'main',
  agentDir: '/'
}
// No credential ⇒ an anonymous clone of a public repository on the same host.
const GITHUB_ANON = {
  mode: 'git',
  repo: 'acme/infra',
  gitRepo: 'https://github.com/acme/infra',
  branch: 'main',
  agentDir: '/'
}
const GITLAB = {
  mode: 'git',
  provider: 'gitlab',
  repo: 'example-group/example-project',
  gitRepo: 'https://gitlab.com/example-group/example-project',
  branch: 'main',
  agentDir: '/'
}
const HEADER: WorkspaceHeaderInfo = {
  status: { dot: 'var(--amber-500)', bg: 'var(--status-paused-soft)', text: '#9a6500', label: '2 uncommitted' },
  commit: { sha: 'a3f9c21', time: '2h ago', title: 'Tighten the deploy check' },
  repoUrl: 'https://github.com/acme/infra',
  remoteLabel: 'GitHub',
  onPull: () => undefined
}

const repo = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  repoFullName: 'example-org/tools',
  access: 'read',
  materialize: 'always',
  createdBy: 'u1',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})
const grant = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  provider: 'github',
  installationId: 12345,
  accountLogin: 'acme',
  access: 'read',
  materialize: 'on-demand',
  createdBy: 'u1',
  createdAt: '2026-09-02T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  repos.rows = []
  grants.rows = []
  role.value = 'owner'
  decision.block = 'provider'
  editor.props = null
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  for (const mock of Object.values(mocks)) mock.mockReset()
})

async function render(a: Agent, header?: WorkspaceHeaderInfo) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<WorkspaceCard agent={a} header={header} />))
}

const html = (a: Agent, header?: WorkspaceHeaderInfo) =>
  renderToStaticMarkup(<WorkspaceCard agent={a} header={header} />)
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
const menu = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Additional repos"]')
const open = async () => act(async () => trigger()?.click())
const within = (selector: string) => document.querySelector<HTMLElement>(selector)
const segment = (scope: HTMLElement | null, title: 'Read only' | 'Read & write') =>
  scope?.querySelector<HTMLButtonElement>(`button[title="${title}"]`) ?? null
const buttonWithText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text))

describe('workspace source row', () => {
  it('lays the whole card out as one row in the mockup’s order', () => {
    const markup = html(agent(GITHUB_APP), HEADER)
    const order = [
      '>Source<',
      'acme/infra',
      'lucide-pencil',
      'lucide-key-round',
      'a3f9c21',
      'lucide-git-branch',
      '2 uncommitted',
      'lucide-refresh-cw'
    ].map((marker) => markup.indexOf(marker))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(markup).not.toContain('Authorized repos')
    expect(markup).not.toContain('border-t')
  })

  it('links the repository name to its remote and drops the separate external-link button', async () => {
    await render(agent(GITHUB_APP), HEADER)
    const link = document.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/infra"]')
    expect(link?.textContent).toBe('acme/infra')
    expect(link?.target).toBe('_blank')
    expect(link?.rel).toBe('noopener noreferrer')
    expect(link?.title).toBe('View on GitHub')
    expect(document.body.innerHTML).not.toContain('lucide-external-link')
  })

  it('links the name to the source even while the browser reads an additional root', async () => {
    await render(agent({ ...GITHUB_APP, repoUrl: 'https://github.com/acme/infra' }), {
      ...HEADER,
      repoUrl: 'https://github.com/example-org/tools'
    })
    expect(document.querySelector('a[href="https://github.com/acme/infra"]')?.textContent).toBe('acme/infra')
    expect(document.querySelector('a[href="https://github.com/example-org/tools"]')).toBeNull()
  })

  it('names a scratch workspace without a link or a branch', () => {
    const markup = html(agent({ mode: 'scratch' }), HEADER)
    expect(markup).toContain('Scratch workspace')
    expect(markup).not.toContain('<a ')
    expect(markup).not.toContain('lucide-git-branch')
  })

  it('opens Edit workspace from the pencil on the tile the workspace derives to', async () => {
    await render(agent(GITLAB))
    const pencil = document.querySelector<HTMLButtonElement>('button[aria-label="Edit workspace"]')
    expect(pencil?.title).toBe('Edit workspace')
    expect(pencil?.textContent).toBe('')
    await act(async () => pencil?.click())
    expect(editor.props).toMatchObject({ initialMode: 'gitlab' })
    expect(editor.props).not.toHaveProperty('initialRepositoryAuthorization')
  })

  it('shows no access badge beside the source, only the public badge for an anonymous checkout', () => {
    const anonymous = html(agent(GITHUB_ANON))
    expect(anonymous).toContain('>public<')
    expect(anonymous).not.toContain('>read<')
    const credentialed = html(agent({ ...GITLAB, gitAccess: 'write' }))
    expect(credentialed).not.toContain('>public<')
    expect(credentialed).not.toContain('>write<')
  })

  it('shows the configured branch in its chip', () => {
    expect(html(agent({ ...GITHUB_APP, branch: 'release/next' }))).toContain('>release/next<')
  })

  it('names no bot on a GitLab workspace source line', () => {
    const markup = html(agent(GITLAB))
    expect(markup).not.toContain('pushes as')
    expect(markup).toContain('example-group/example-project')
  })
})

describe('repository dropdown trigger', () => {
  it('counts explicit repositories and installation grants together', () => {
    expect(html(agent({ mode: 'scratch' }))).toContain('>Repos<')
    repos.rows = [repo()]
    expect(html(agent({ mode: 'scratch' }))).toContain('+1 repo<')
    grants.rows = [grant()]
    expect(html(agent({ mode: 'scratch' }))).toContain('+2 repos<')
  })

  it('does not count the App-backed workspace repository, which the source already names', () => {
    const markup = html(agent(GITHUB_APP))
    expect(markup).toContain('>Repos<')
    expect(markup).not.toContain('authorized implicitly')
  })
})

describe('repository dropdown', () => {
  it('lists repositories and grants, linking a GitHub row to its page', async () => {
    repos.rows = [repo(), repo({ id: 'r2', provider: 'gitlab', repoFullName: 'example-group/docs' })]
    grants.rows = [grant({ access: 'write' })]
    await render(agent({ mode: 'scratch' }))
    expect(menu()).toBeNull()
    await open()

    expect(menu()?.textContent).toContain('Additional repos')
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true')
    const github = within('[data-repository-authorization="r1"]')
    expect(github?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example-org/tools')
    expect(segment(github, 'Read only')?.getAttribute('aria-pressed')).toBe('true')
    expect(segment(github, 'Read & write')?.getAttribute('aria-pressed')).toBe('false')
    expect(github?.querySelector('button[aria-label="Checkout for example-org/tools"]')?.textContent).toBe('Always')
    // A GitLab row has no instance URL on the card to link to.
    const gitlab = within('[data-repository-authorization="r2"]')
    expect(gitlab?.querySelector('a')).toBeNull()
    expect(gitlab?.textContent).toContain('example-group/docs')
    const installation = within('[data-installation-grant="12345"]')
    expect(installation?.textContent).toContain('All repositories in acme')
    expect(segment(installation, 'Read & write')?.getAttribute('aria-pressed')).toBe('true')
    expect(installation?.querySelector('button[aria-label="Checkout for acme"]')?.textContent).toBe('On demand')
  })

  it('says so when there is nothing to list', async () => {
    await render(agent({ mode: 'scratch' }))
    await open()
    expect(menu()?.textContent).toContain('No additional repositories authorized.')
  })

  it('raises a repository’s access with an access-only PATCH, and ignores the pressed segment', async () => {
    repos.rows = [repo()]
    mocks.updateAgentRepo.mockResolvedValue(repo({ access: 'write' }))
    await render(agent({ mode: 'scratch' }))
    await open()

    await act(async () => segment(within('[data-repository-authorization="r1"]'), 'Read only')?.click())
    expect(mocks.updateAgentRepo).not.toHaveBeenCalled()
    await act(async () => segment(within('[data-repository-authorization="r1"]'), 'Read & write')?.click())
    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'r1', { access: 'write' })
    expect(mocks.mutateRepos).toHaveBeenCalledWith([repo({ access: 'write' })], { revalidate: false })
  })

  it('lowers a repository’s access with an access-only PATCH', async () => {
    repos.rows = [repo({ access: 'write' })]
    mocks.updateAgentRepo.mockResolvedValue(repo())
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () => segment(within('[data-repository-authorization="r1"]'), 'Read only')?.click())

    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'r1', { access: 'read' })
    expect(mocks.mutateRepos).toHaveBeenCalledWith([repo()], { revalidate: false })
  })

  it('names a refused change in the dropdown’s error line', async () => {
    repos.rows = [repo({ access: 'write' })]
    mocks.updateAgentRepo.mockRejectedValue(new Error('turn off formal reviews on example-org/tools first'))
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () => segment(within('[data-repository-authorization="r1"]'), 'Read only')?.click())

    expect(menu()?.textContent).toContain('turn off formal reviews on example-org/tools first')
    expect(mocks.mutateRepos).not.toHaveBeenCalled()
  })

  it('presses neither segment for a legacy comment row, and either one saves', async () => {
    repos.rows = [repo({ access: 'comment' })]
    mocks.updateAgentRepo.mockResolvedValue(repo({ access: 'write' }))
    await render(agent({ mode: 'scratch' }))
    await open()
    const row = within('[data-repository-authorization="r1"]')
    expect(row?.querySelectorAll('button[aria-pressed="true"]').length).toBe(0)
    await act(async () => segment(row, 'Read & write')?.click())
    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'r1', { access: 'write' })
  })

  it('switches a repository’s checkout with a materialize-only PATCH', async () => {
    repos.rows = [repo()]
    mocks.updateAgentRepo.mockResolvedValue(repo({ materialize: 'on-demand' }))
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Checkout for example-org/tools"]')?.click()
    )
    const choice = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
      (item) => item.textContent === 'On demand'
    )
    await act(async () => choice?.click())

    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'r1', { materialize: 'on-demand' })
    expect(mocks.mutateRepos).toHaveBeenCalledWith([repo({ materialize: 'on-demand' })], { revalidate: false })
    // The outer dropdown stays open for the next edit.
    expect(menu()).not.toBeNull()
  })

  it('revokes a repository without a confirmation step', async () => {
    repos.rows = [repo(), repo({ id: 'r2', repoFullName: 'example-org/docs' })]
    mocks.deleteAgentRepo.mockResolvedValue(undefined)
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () =>
      within('[data-repository-authorization="r1"]')
        ?.querySelector<HTMLButtonElement>('button[aria-label="Revoke repository access"]')
        ?.click()
    )

    expect(mocks.deleteAgentRepo).toHaveBeenCalledWith('agent-a', 'r1')
    expect(mocks.mutateRepos).toHaveBeenCalledWith([repo({ id: 'r2', repoFullName: 'example-org/docs' })], {
      revalidate: false
    })
  })

  it('runs one edit at a time', async () => {
    repos.rows = [repo(), repo({ id: 'r2', repoFullName: 'example-org/docs' })]
    mocks.updateAgentRepo.mockReturnValue(new Promise(() => undefined))
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () => segment(within('[data-repository-authorization="r1"]'), 'Read & write')?.click())

    const other = within('[data-repository-authorization="r2"]')
    expect(segment(other, 'Read & write')?.disabled).toBe(true)
    expect(other?.querySelector<HTMLButtonElement>('button[aria-label="Revoke repository access"]')?.disabled).toBe(
      true
    )
    expect(mocks.updateAgentRepo).toHaveBeenCalledTimes(1)
  })

  it('lets an owner change and revoke an installation grant', async () => {
    grants.rows = [grant()]
    mocks.updateAgentInstallation.mockResolvedValue(grant({ access: 'write' }))
    mocks.deleteAgentInstallation.mockResolvedValue(undefined)
    await render(agent({ mode: 'scratch' }))
    await open()
    const row = within('[data-installation-grant="12345"]')
    await act(async () => segment(row, 'Read & write')?.click())
    expect(mocks.updateAgentInstallation).toHaveBeenCalledWith('agent-a', 'i1', { access: 'write' })
    expect(mocks.mutateGrants).toHaveBeenCalledWith([grant({ access: 'write' })], { revalidate: false })

    await act(async () =>
      row?.querySelector<HTMLButtonElement>('button[aria-label="Revoke installation access"]')?.click()
    )
    expect(mocks.deleteAgentInstallation).toHaveBeenCalledWith('agent-a', 'i1')
    expect(mocks.mutateGrants).toHaveBeenLastCalledWith([], { revalidate: false })
  })

  it('shows a grant to an editor who is not an owner with every control disabled and the role named', async () => {
    role.value = 'admin'
    grants.rows = [grant()]
    await render(agent({ mode: 'scratch' }))
    await open()
    const row = within('[data-installation-grant="12345"]')

    expect(segment(row, 'Read & write')?.disabled).toBe(true)
    expect(segment(row, 'Read & write')?.closest('[role="group"]')?.parentElement?.title).toBe(
      'Only organization owners can authorize or revoke an installation'
    )
    expect(row?.querySelector<HTMLButtonElement>('button[aria-label="Checkout for acme"]')?.disabled).toBe(true)
    const revoke = row?.querySelector<HTMLButtonElement>('button[aria-label="Revoke installation access"]')
    expect(revoke?.disabled).toBe(true)
    expect(revoke?.parentElement?.title).toBe('Only organization owners can authorize or revoke an installation')
  })

  it('closes and opens Edit workspace at its authorization step', async () => {
    await render(agent({ mode: 'scratch' }))
    await open()
    await act(async () => buttonWithText('Authorize repository')?.click())

    expect(menu()).toBeNull()
    expect(editor.props).toMatchObject({ initialMode: 'scratch', initialRepositoryAuthorization: {} })
  })

  it('opens a manual checkout with its own grant in the editor rather than the authorization step', async () => {
    repos.rows = [repo({ repoFullName: 'acme/infra' })]
    await render(agent(GITHUB_ANON))
    await open()
    await act(async () => buttonWithText('Manage repository')?.click())

    expect(editor.props).toMatchObject({ initialMode: 'github' })
    expect(editor.props).not.toHaveProperty('initialRepositoryAuthorization')
  })

  it('shows a viewer every row with its controls disabled and nothing to revoke or add', async () => {
    repos.rows = [repo()]
    grants.rows = [grant()]
    await render(agent({ mode: 'scratch' }, { canEdit: false }))
    expect(document.querySelector('button[aria-label="Edit workspace"]')).toBeNull()
    await open()

    const repository = within('[data-repository-authorization="r1"]')
    const installation = within('[data-installation-grant="12345"]')
    for (const row of [repository, installation]) {
      expect(segment(row, 'Read only')?.disabled).toBe(true)
      expect(segment(row, 'Read & write')?.disabled).toBe(true)
    }
    expect(repository?.querySelector<HTMLButtonElement>('button[aria-label^="Checkout for"]')?.disabled).toBe(true)
    expect(installation?.querySelector<HTMLButtonElement>('button[aria-label^="Checkout for"]')?.disabled).toBe(true)
    expect(menu()?.querySelector('button[aria-label^="Revoke"]')).toBeNull()
    expect(buttonWithText('Authorize repository')).toBeUndefined()
  })
})
