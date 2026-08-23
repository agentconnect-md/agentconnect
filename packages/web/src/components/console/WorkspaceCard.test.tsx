import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const repos = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const gitlab = vi.hoisted(() => ({ bindings: [] as Array<Record<string, unknown>> }))

vi.mock('swr', () => ({
  default: () => ({ data: repos.rows, error: undefined, isLoading: false, mutate: vi.fn() })
}))
vi.mock('@/lib/api', () => ({
  creatorLabel: () => 'Dana Reyes',
  fetchAgentRepos: vi.fn()
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/acme/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' } }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/swr-keys', () => ({ consoleKeys: { agentRepos: () => ['repos'] } }))
vi.mock('@/components/console/modals/EditWorkspaceModal', () => ({ default: () => null }))
vi.mock('@/lib/use-gitlab-projects', () => ({ useGitlabProjectBindings: () => gitlab.bindings }))

import { WorkspaceCard } from './WorkspaceCard'
import type { Agent } from '@/lib/data'

const agent = (
  workspace: Record<string, unknown>,
  capabilities: { canEdit?: boolean; canManageSharing?: boolean } = {}
) =>
  ({
    id: 'agent-a',
    name: 'deploy-bot',
    canEdit: capabilities.canEdit ?? true,
    canManageSharing: capabilities.canManageSharing ?? true,
    workspace
  }) as unknown as Agent

const GITHUB = { mode: 'github', repo: 'acme/infra', branch: 'main', agentDir: '/' }
const GITLAB = { mode: 'gitlab', repo: 'example-group/example-project', branch: 'main', agentDir: '/' }

const gitlabBinding = (account: Record<string, unknown>) => [
  {
    id: 'b1',
    projectId: '4455667',
    projectPath: 'example-group/example-project',
    defaultBranch: 'main',
    state: 'ready',
    stateReason: null,
    installerConnectionId: 'conn-1',
    accounts: [account],
    webhookInstalled: true,
    credentialEpoch: '1',
    createdAt: '2026-08-20T00:00:00.000Z'
  }
]

const BOT = {
  agentId: 'agent-a',
  username: 'agentconnect-a1-g900',
  displayName: 'deploy-bot',
  userId: '9001',
  state: 'ready',
  stateReason: null
}

it('does not repeat the checkout branch in the Source card', () => {
  repos.rows = []
  const branch = 'release/source-should-not-render'
  const html = renderToStaticMarkup(<WorkspaceCard agent={agent({ ...GITHUB, branch })} />)

  expect(html).not.toContain(branch)
})

// Only an App-backed workspace has implicit authority over its own repository. A
// manual checkout's effective access comes from an explicit agent-repo grant (or
// is none), so an implicit chip there would claim authorization it does not have
// and duplicate the real explicit row when one exists.
describe('workspace repository authority', () => {
  it('shows the workspace repo as an implicit grant when the App backs it', () => {
    repos.rows = []
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent({ ...GITHUB, installationId: 'inst-1' })} />)
    expect(html).toContain('authorized implicitly')
    expect(html).toContain('acme/infra')
    expect(html).not.toContain('None explicitly authorized')
  })

  it('does not claim implicit authority for a manual GitHub checkout', () => {
    repos.rows = []
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITHUB)} />)
    expect(html).not.toContain('authorized implicitly')
    expect(html).toContain('None explicitly authorized')
  })

  it('renders a manual checkout through its explicit grant summary', () => {
    repos.rows = [{ id: 'g1', repoFullName: 'acme/infra', access: 'comment', createdBy: 'u1' }]
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITHUB)} />)
    expect(html).not.toContain('authorized implicitly')
    // The card summarizes the real explicit tier; edits and revocation live in
    // the shared Edit workspace dialog rather than a second inline flow.
    expect(html).not.toContain('Revoke access')
    expect(html).toContain('comment access')
  })

  it('leaves a scratch workspace with no implicit repository', () => {
    repos.rows = []
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent({ mode: 'scratch' })} />)
    expect(html).not.toContain('authorized implicitly')
    expect(html).toContain('None explicitly authorized')
  })

  it('keeps workspace edits available when sharing controls are read-only', () => {
    repos.rows = []
    const html = renderToStaticMarkup(
      <WorkspaceCard agent={agent({ mode: 'scratch' }, { canEdit: true, canManageSharing: false })} />
    )
    expect(html).toContain('Authorize repository')
    expect(html).toContain('Edit workspace')
  })
})

// The workspace pushes as an identity: a GitHub workspace as its App installation, a GitLab one as
// the agent's project bot. The source line names whichever it is (gitlab-com-integration.md §18.1).
describe('workspace push identity', () => {
  it('names the GitLab bot the agent pushes as, with its profile link', () => {
    repos.rows = []
    gitlab.bindings = gitlabBinding(BOT)
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITLAB)} />)

    expect(html).toContain('pushes as')
    expect(html).toContain('deploy-bot')
    expect(html).toContain('@agentconnect-a1-g900')
    expect(html).toContain('https://gitlab.com/agentconnect-a1-g900')
    // A healthy bot is named, not badged — the row stays quiet when nothing is wrong.
    expect(html).not.toContain('bot access degraded')
  })

  it('shows the bot’s health when it is not ready', () => {
    repos.rows = []
    gitlab.bindings = gitlabBinding({ ...BOT, state: 'admin_degraded', stateReason: 'service_account_quota' })
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITLAB)} />)

    expect(html).toContain('setup incomplete')
    expect(html).toContain('limit of bot accounts')
  })

  it('says nothing when this agent has no bot on the workspace project', () => {
    repos.rows = []
    gitlab.bindings = gitlabBinding({ ...BOT, agentId: 'someone-else' })
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITLAB)} />)

    expect(html).not.toContain('pushes as')
    expect(html).not.toContain('agentconnect-a1-g900')
  })

  it('leaves a GitHub workspace naming its installation instead', () => {
    repos.rows = []
    gitlab.bindings = gitlabBinding(BOT)
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent({ ...GITHUB, installationId: 'inst-1' })} />)

    expect(html).toContain('authorized implicitly by the GitHub App installation')
    expect(html).not.toContain('pushes as')
  })
})
