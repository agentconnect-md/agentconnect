import { describe, expect, it } from 'vitest'
import { OrgId } from '../domain/ids.js'
import { collectGiteaReferences, describeGiteaReferences } from './references.js'

const REPO = 556677n

describe('describeGiteaReferences', () => {
  it('names every kind of consumer in the operator’s words', () => {
    expect(
      describeGiteaReferences('example-org/example-repo', [
        { kind: 'workspace', agentName: 'builder' },
        { kind: 'additional_repository', agentName: 'reviewer' },
        { kind: 'trigger', hookName: 'example-org/example-repo', agentName: 'reviewer' }
      ])
    ).toBe(
      'example-org/example-repo is still in use — the workspace of agent builder, an additional repository of agent reviewer, trigger “example-org/example-repo” of agent reviewer — remove those first'
    )
  })

  it('counts what it does not name past the fourth reference', () => {
    const references = Array.from({ length: 6 }, (_, i) => ({ kind: 'workspace' as const, agentName: `agent-${i}` }))
    const text = describeGiteaReferences('example-org/example-repo', references)
    expect(text).toContain('agent-3')
    expect(text).not.toContain('agent-4')
    expect(text).toContain('and 2 more')
  })
})

describe('collectGiteaReferences', () => {
  it('reads workspaces, grants and triggers of the repository only, keyed by the gitea credential', async () => {
    const agents = [
      {
        id: 'a1',
        name: 'builder',
        workspaceRepoId: REPO,
        workspace: { mode: 'git', gitRepo: 'x', credential: { provider: 'gitea', access: 'write' } }
      },
      // The same numeric id on another host is a different repository (§8.1).
      {
        id: 'a2',
        name: 'other-host',
        workspaceRepoId: REPO,
        workspace: { mode: 'git', gitRepo: 'y', credential: { provider: 'gitlab', access: 'write' } }
      },
      { id: 'a3', name: 'scratch', workspace: { mode: 'scratch' } }
    ]
    const references = await collectGiteaReferences(
      {
        agent: { list: async () => agents as never },
        agentRepoAuth: { listForRepository: async () => [{ agentId: 'a3', repoId: REPO }] as never },
        hook: {
          listForOrgKind: async () =>
            [
              { repoId: REPO, agentId: 'a3', name: 'watch' },
              { repoId: 1n, agentId: 'a3', name: 'elsewhere' },
              { repoId: REPO, agentId: null, name: 'legacy' }
            ] as never
        }
      },
      OrgId('org-1'),
      REPO
    )
    expect(references).toEqual([
      { kind: 'workspace', agentName: 'builder' },
      { kind: 'additional_repository', agentName: 'scratch' },
      { kind: 'trigger', hookName: 'watch', agentName: 'scratch' }
    ])
  })
})
