import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const repos = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('swr', () => ({
  default: () => ({ data: repos.rows, error: undefined, isLoading: false, mutate: vi.fn() })
}))
vi.mock('@/lib/api', () => ({
  creatorLabel: () => 'Dana Reyes',
  fetchAgentRepos: vi.fn(),
  repoAuthProvider: (row: { provider?: string }) => row.provider ?? 'github'
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

// A GitLab workspace names no identity on its source line, exactly as a GitHub one does not: the
// agent page carries no GitLab identity surface at all (gitlab-com-integration.md §18.1).
describe('workspace push identity', () => {
  it('names no bot on a GitLab workspace source line', () => {
    repos.rows = []
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITLAB)} />)

    expect(html).not.toContain('pushes as')
    expect(html).not.toContain('agentconnect-a1-g900')
    // The line still says what it is for: the project, and the access the agent has on it.
    expect(html).toContain('example-group/example-project')
  })

  it('leaves a GitHub workspace naming its installation instead', () => {
    repos.rows = []
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent({ ...GITHUB, installationId: 'inst-1' })} />)

    expect(html).toContain('authorized implicitly by the GitHub App installation')
    expect(html).not.toContain('pushes as')
  })
})
