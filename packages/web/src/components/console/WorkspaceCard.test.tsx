import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const repos = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('swr', () => ({
  default: () => ({ data: repos.rows, error: undefined, isLoading: false, mutate: vi.fn() })
}))
vi.mock('@/lib/api', () => ({
  creatorLabel: () => 'Dana Reyes',
  deleteAgentRepo: vi.fn(),
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
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({ default: () => null }))
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

  it('renders a manual checkout through its explicit grant, without duplicating it', () => {
    repos.rows = [{ id: 'g1', repoFullName: 'acme/infra', access: 'comment', createdBy: 'u1' }]
    const html = renderToStaticMarkup(<WorkspaceCard agent={agent(GITHUB)} />)
    expect(html).not.toContain('authorized implicitly')
    // Exactly one chip for the repo — the explicit, revocable one, carrying its
    // real tier. A second, non-removable implicit chip would show no Revoke.
    expect(html.match(/Revoke access/g)).toHaveLength(1)
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
