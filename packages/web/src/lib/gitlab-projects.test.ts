/**
 * An agent's GitLab identity is read off the project's member list — the bot rows the project
 * binding already carries (gitlab-com-integration.md §18.1). No surface reads it per agent.
 */
import { describe, expect, it } from 'vitest'
import { gitlabAgentBot } from './gitlab-projects'
import type { GitlabProjectAccountDto, GitlabProjectBindingDto } from './api'

const account = (over: Partial<GitlabProjectAccountDto> = {}): GitlabProjectAccountDto => ({
  agentId: 'agent-a',
  username: 'agentconnect-a1-g900',
  displayName: 'reviewer',
  userId: '9001',
  state: 'ready',
  stateReason: null,
  ...over
})

const binding = (
  projectId: string,
  projectPath: string,
  accounts: GitlabProjectAccountDto[]
): GitlabProjectBindingDto => ({
  id: `b-${projectId}`,
  projectId,
  projectPath,
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  installerConnectionId: 'conn-1',
  accounts,
  webhookInstalled: true,
  credentialEpoch: '1',
  createdAt: '2026-08-20T00:00:00.000Z'
})

describe('gitlabAgentBot', () => {
  const bindings = [
    binding('4455667', 'example-group/example-project', [
      account({ agentId: 'agent-b', username: 'agentconnect-b1-g900', displayName: 'triage' }),
      account()
    ]),
    binding('7788990', 'other-group/other-project', [account({ username: 'agentconnect-a1-g901' })])
  ]

  it('picks the bot this agent acts as on the project the row names', () => {
    expect(gitlabAgentBot(bindings, { projectId: '4455667' }, 'agent-a')).toMatchObject({
      username: 'agentconnect-a1-g900',
      displayName: 'reviewer'
    })
    // The account is per top-level group, so the same agent is a different bot on another group's project.
    expect(gitlabAgentBot(bindings, { projectId: '7788990' }, 'agent-a')?.username).toBe('agentconnect-a1-g901')
  })

  // A GitLab project can be renamed under us: the binding path follows, a stored hook path does not.
  it('follows a renamed project by its numeric id, never by the stale path', () => {
    const project = { projectId: '4455667', projectPath: 'example-group/old-name' }
    expect(gitlabAgentBot(bindings, project, 'agent-a')?.username).toBe('agentconnect-a1-g900')
    // The id decides even when some other project has since taken the old path.
    const reused = [binding('1112223', 'example-group/old-name', [account({ username: 'someone-else' })]), ...bindings]
    expect(gitlabAgentBot(reused, project, 'agent-a')?.username).toBe('agentconnect-a1-g900')
  })

  it('falls back to the project path for a row that carries no id', () => {
    expect(gitlabAgentBot(bindings, { projectPath: 'example-group/example-project' }, 'agent-a')?.username).toBe(
      'agentconnect-a1-g900'
    )
    // Paths are compared case-insensitively; GitLab keeps the namespace lowercase but display copy need not.
    expect(gitlabAgentBot(bindings, { projectPath: 'Example-Group/Example-Project' }, 'agent-a')?.username).toBe(
      'agentconnect-a1-g900'
    )
  })

  it('never returns another agent’s bot from the same project', () => {
    expect(gitlabAgentBot(bindings, { projectId: '4455667' }, 'agent-c')).toBeNull()
  })

  it('is absent for an unbound project and for no project identity at all', () => {
    expect(gitlabAgentBot(bindings, { projectId: '9999999' }, 'agent-a')).toBeNull()
    expect(gitlabAgentBot(bindings, { projectPath: 'example-group/unbound' }, 'agent-a')).toBeNull()
    expect(gitlabAgentBot(bindings, {}, 'agent-a')).toBeNull()
  })
})
