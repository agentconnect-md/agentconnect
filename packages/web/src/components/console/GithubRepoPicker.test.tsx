// @vitest-environment happy-dom
/**
 * The shared GitHub repository picker (`useGithubRepoPicker` +
 * `GithubRepoPickerOptions`), through both surfaces that mount it. The App is
 * asked before public GitHub, so a private repo past the roster's pages keeps
 * its credentials; a repository no installation grants is offered as an
 * anonymous checkout, badged `public` and pinned to read.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  fetchGithubInstallations: vi.fn(),
  fetchGithubRepoRoster: vi.fn(),
  fetchGithubInstallationRepo: vi.fn(),
  fetchGithubBranches: vi.fn(),
  fetchGithubRepoAccess: vi.fn(),
  setAgentWorkspace: vi.fn(async () => ({}) as Agent),
  createAgent: vi.fn(async () => undefined)
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', defaultAgentVisibility: 'all' }, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'user-1' } }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    createAgent: mocks.createAgent,
    daemons: [],
    agents: [],
    members: [],
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({ default: () => <div /> }))
vi.mock('@/lib/use-gitlab-projects', () => ({
  useGitlabProjects: () => ({
    choices: [],
    empty: true,
    loading: false,
    reloading: false,
    connected: false,
    enabled: false,
    error: null,
    provisionError: null,
    provisioning: null,
    provision: async () => false,
    connect: async () => undefined,
    reload: () => undefined
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: mocks.fetchGithubInstallations,
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: mocks.fetchGithubRepoRoster,
  fetchGithubInstallationRepo: mocks.fetchGithubInstallationRepo,
  fetchGithubBranches: mocks.fetchGithubBranches,
  fetchGithubRepoAccess: mocks.fetchGithubRepoAccess,
  setAgentWorkspace: mocks.setAgentWorkspace
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AddAgentModal = (await import('@/components/console/modals/AddAgentModal')).default
const EditWorkspaceModal = (await import('@/components/console/modals/EditWorkspaceModal')).default

const PUBLIC_REPO = {
  full_name: 'github/docs',
  private: false,
  default_branch: 'main',
  description: 'The GitHub documentation',
  updated_at: null
}
const agent = {
  id: 'agent-a',
  name: 'public-reviewer',
  canEdit: true,
  workspace: {
    mode: 'git',
    provider: 'github',
    repo: 'acme/infra',
    gitRepo: 'https://github.com/acme/infra',
    branch: 'main',
    agentDir: '/',
    worktree: true
  }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(node: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(node))
}

const buttonsNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes(text))

/** React tracks the DOM value it wrote, so a raw assignment is swallowed. */
async function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Type an exact owner/repo and let the debounced anonymous lookups elapse. */
async function typeRepo(value: string) {
  const search = document.querySelector<HTMLInputElement>('.fmenu input')
  if (!search) throw new Error('the repository search box is not open')
  await fill(search, value)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

const openPicker = () =>
  act(async () =>
    Array.from(document.querySelectorAll<HTMLDivElement>('.inp'))
      .find((element) => element.textContent?.includes('Pick a repository') || element.textContent?.includes('acme/'))
      ?.click()
  )

beforeEach(() => {
  mocks.fetchGithubInstallations.mockResolvedValue({
    enabled: true,
    installations: [{ id: 'ins-1', accountLogin: 'acme', accountType: 'Organization', suspended: false }]
  })
  mocks.fetchGithubRepoRoster.mockResolvedValue({
    repos: [
      {
        fullName: 'acme/infra',
        private: true,
        defaultBranch: 'main',
        description: null,
        updatedAt: null,
        installationId: 'ins-1'
      }
    ],
    privateReposHidden: false,
    failed: false
  })
  // Mirrors the route: an installation resolves only its own account's repos.
  mocks.fetchGithubInstallationRepo.mockImplementation(async (_id: string, owner: string, repo: string) => {
    if (owner !== 'acme') throw new Error('404')
    return { fullName: `${owner}/${repo}`, private: true, defaultBranch: 'main', description: null, updatedAt: null }
  })
  mocks.fetchGithubBranches.mockResolvedValue(['main'])
  mocks.fetchGithubRepoAccess.mockResolvedValue({ gated: false, canRead: true, canWrite: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/search/repositories')) return Response.json({ items: [PUBLIC_REPO] })
      if (url.includes('/repos/github/docs/branches')) return Response.json([{ name: 'main' }])
      if (url.endsWith('/repos/github/docs')) return Response.json(PUBLIC_REPO)
      return Response.json({ message: 'Not Found' }, { status: 404 })
    })
  )
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('shared GitHub repository picker', () => {
  it('offers a public repository in the creation wizard, and keeps the roster App-backed', async () => {
    await render(<AddAgentModal onClose={() => undefined} />)
    await act(async () => buttonsNamed('GitHub')[0]?.click())
    await openPicker()

    // A synced row still resolves through its installation.
    await act(async () => buttonsNamed('acme/infra')[0]?.click())
    expect(mocks.fetchGithubBranches).toHaveBeenCalledWith('ins-1', 'acme', 'infra')
    expect(document.body.textContent).not.toContain('Public repository — read-only clone.')

    // An exact name on the installation's own account is resolved through it, so a
    // private repo past the roster's pages keeps its App credentials.
    await openPicker()
    await typeRepo('acme/hidden')
    expect(mocks.fetchGithubInstallationRepo).toHaveBeenCalledWith('ins-1', 'acme', 'hidden', expect.anything())
    expect(buttonsNamed('acme/hidden')[0]?.textContent).toContain('Available through the GitHub App')

    await typeRepo('github/docs')
    // An installation token reads any PUBLIC repo, so probing an installation on
    // another account reported one as App-backed and the create then failed the
    // owner check. Only the owner's own installations may be asked.
    expect(mocks.fetchGithubInstallationRepo).not.toHaveBeenCalledWith(
      expect.anything(),
      'github',
      'docs',
      expect.anything()
    )
    const option = buttonsNamed('github/docs')[0]
    expect(option?.textContent).toContain('Use public repository')

    await act(async () => option?.click())
    expect(document.body.textContent).toContain('Public repository — read-only clone.')
    expect(document.body.textContent).toContain('Read only')
  })

  it('replaces a workspace with a public repository, read-only', async () => {
    await render(
      <EditWorkspaceModal agent={agent} authorized={[]} onClose={() => undefined} onChanged={() => undefined} />
    )
    await openPicker()
    await typeRepo('github/docs')
    await act(async () => buttonsNamed('github/docs')[0]?.click())

    expect(document.body.textContent).toContain('Public repository — read-only clone.')
    expect(document.body.textContent).not.toContain('No GitHub App installation covers')

    await act(async () => buttonsNamed('Replace workspace')[0]?.click())
    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'github/docs',
      gitBranch: 'main',
      access: 'read'
    })
  })

  it('edits an anonymous workspace on a deployment with no App installed', async () => {
    // The fields used to be nested under "App enabled and at least one installation",
    // so an anonymous workspace was uneditable exactly where it is the only kind.
    mocks.fetchGithubInstallations.mockResolvedValue({ enabled: true, installations: [] })
    await render(
      <EditWorkspaceModal
        agent={
          {
            ...agent,
            workspace: {
              mode: 'git',
              repo: 'github/docs',
              gitRepo: 'https://github.com/github/docs',
              branch: 'main',
              agentDir: '/',
              worktree: true
            }
          } as unknown as Agent
        }
        authorized={[]}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    // The install prompt still offers the App; the repository fields render anyway.
    expect(document.body.textContent).toContain('Install')
    expect(document.body.textContent).toContain('Public repository — read-only clone.')
    await fill(document.querySelector<HTMLInputElement>('input[aria-label="Working subdirectory"]')!, 'content')
    await act(async () => buttonsNamed('Save')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'github/docs',
      gitBranch: 'main',
      agentDir: 'content',
      access: 'read'
    })
  })

  it('keeps editing a workspace that already has no installation', async () => {
    // The uncovered-owner notice used to disable the save for these agents, so a
    // public-repo workspace could not even change its working subdirectory.
    await render(
      <EditWorkspaceModal
        agent={
          {
            ...agent,
            workspace: {
              mode: 'git',
              repo: 'github/docs',
              gitRepo: 'https://github.com/github/docs',
              branch: 'main',
              agentDir: '/',
              worktree: true
            }
          } as unknown as Agent
        }
        authorized={[]}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    expect(document.body.textContent).not.toContain('No GitHub App installation covers')
    await fill(document.querySelector<HTMLInputElement>('input[aria-label="Working subdirectory"]')!, 'content')
    await act(async () => buttonsNamed('Save')[0]?.click())

    expect(mocks.setAgentWorkspace).toHaveBeenCalledWith('agent-a', {
      mode: 'git',
      worktree: true,
      gitRepo: 'github/docs',
      gitBranch: 'main',
      agentDir: 'content',
      access: 'read'
    })
  })
})
