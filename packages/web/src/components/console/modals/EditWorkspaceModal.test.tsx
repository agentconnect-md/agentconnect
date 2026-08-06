import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const repositoryModal = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path }) }))
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({
  default: (props: Record<string, unknown>) => {
    repositoryModal.props = props
    return <div>repository authorization step</div>
  }
}))

import EditWorkspaceModal from './EditWorkspaceModal'
import type { Agent } from '@/lib/data'

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

describe('EditWorkspaceModal repository access', () => {
  it('manages additional repositories in the main workspace editor', () => {
    const html = renderToStaticMarkup(
      <EditWorkspaceModal
        agent={agent}
        authorized={[
          {
            id: 'repo-auth-1',
            repoFullName: 'acme/shared-tools',
            access: 'write',
            createdBy: 'user-1',
            createdAt: '2026-08-06T00:00:00.000Z'
          }
        ]}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    expect(html).toContain('Additional repositories')
    expect(html).toContain('Authorize repository')
    expect(html).toContain('acme/shared-tools')
    expect(html).toContain('Revoke repository access')
  })

  it('opens contextual shortcuts at the workspace authorization step', () => {
    const html = renderToStaticMarkup(
      <EditWorkspaceModal
        agent={agent}
        authorized={[]}
        initialRepositoryAuthorization={{ repo: 'acme/service', access: 'write' }}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    expect(html).toContain('repository authorization step')
    expect(repositoryModal.props).toMatchObject({
      initialRepo: 'acme/service',
      initialAccess: 'write',
      workspaceContext: true
    })
  })
})
