import { describe, expect, it } from 'vitest'
import type { GithubHookMetadata } from '@agentconnect.md/protocol'
import type { Agent } from '../../src/agents/agent-schema.js'
import { GithubReviewOrchestrator } from '../../src/github/review-orchestrator.js'

// Which workspace root a hook's repository resolves to (multi-repository-workspaces.md decision 6).
// Pure resolution: it reads the agent definition alone, so the host port is never touched.
const orchestrator = new GithubReviewOrchestrator({} as never)

function agentFixture(
  workspace: Partial<Agent['workspace']> & Record<string, unknown> = {},
  additionalRepos: Array<{ repoFullName: string; repoId: string }> = []
): Agent {
  return {
    id: 'bot-review',
    name: 'bot-review',
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: 'git-repo',
      isolation: 'shared',
      path: '/srv/agents/bot-review/workspace',
      gitRepo: 'https://github.com/acme/primary-service.git',
      gitBranch: 'main',
      gitCredential: 'github-app',
      additionalRepos,
      pullOnNewSession: true,
      skills: [],
      ...workspace
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

function hook(repoFullName: string): GithubHookMetadata {
  return {
    repoId: '123',
    repoFullName,
    sourceInstallationId: '456',
    subjectKind: 'pull_request',
    pullNumber: 42
  } as GithubHookMetadata
}

describe('reviewRootFor', () => {
  it('resolves the workspace repository to the primary root', () => {
    expect(orchestrator.reviewRootFor(agentFixture(), hook('acme/primary-service'))).toBe('primary')
  })

  it('resolves an authorized additional repository to its own root, whatever its case or suffix', () => {
    const agent = agentFixture({}, [
      { repoFullName: 'example-co/shared-library', repoId: '815' },
      { repoFullName: 'acme/infra', repoId: '42' }
    ])

    expect(orchestrator.reviewRootFor(agent, hook('Acme/Infra'))).toEqual({ repoFullName: 'acme/infra' })
    expect(orchestrator.reviewRootFor(agent, hook('example-co/shared-library.git'))).toEqual({
      repoFullName: 'example-co/shared-library'
    })
  })

  it('resolves a repository that is neither the workspace nor an authorized row to no root', () => {
    const agent = agentFixture({}, [{ repoFullName: 'acme/infra', repoId: '42' }])

    expect(orchestrator.reviewRootFor(agent, hook('example-co/elsewhere'))).toBeUndefined()
    expect(orchestrator.reviewRootFor(agent, hook('not a repository'))).toBeUndefined()
  })

  it('never reads an anonymous non-GitHub workspace as the hook repository', () => {
    const agent = agentFixture({
      gitRepo: 'https://git.example.test/acme/primary-service.git',
      gitCredential: undefined
    })

    expect(orchestrator.reviewRootFor(agent, hook('acme/primary-service'))).toBeUndefined()
  })

  it('resolves nothing for a workspace that is not a repository at all', () => {
    const agent = agentFixture({ mode: 'from-scratch', gitRepo: undefined }, [
      { repoFullName: 'acme/infra', repoId: '42' }
    ])

    expect(orchestrator.reviewRootFor(agent, hook('acme/primary-service'))).toBeUndefined()
    // A scratch workspace still reviews its authorized repositories against their own roots.
    expect(orchestrator.reviewRootFor(agent, hook('acme/infra'))).toEqual({ repoFullName: 'acme/infra' })
  })
})
