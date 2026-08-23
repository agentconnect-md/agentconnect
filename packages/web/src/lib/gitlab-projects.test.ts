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

const binding = (projectPath: string, accounts: GitlabProjectAccountDto[]): GitlabProjectBindingDto => ({
  id: `b-${projectPath}`,
  projectId: '4455667',
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
    binding('example-group/example-project', [
      account({ agentId: 'agent-b', username: 'agentconnect-b1-g900', displayName: 'triage' }),
      account()
    ]),
    binding('other-group/other-project', [account({ username: 'agentconnect-a1-g901' })])
  ]

  it('picks the bot this agent acts as on the project the row names', () => {
    expect(gitlabAgentBot(bindings, 'example-group/example-project', 'agent-a')).toMatchObject({
      username: 'agentconnect-a1-g900',
      displayName: 'reviewer'
    })
    // The account is per top-level group, so the same agent is a different bot on another group's project.
    expect(gitlabAgentBot(bindings, 'other-group/other-project', 'agent-a')?.username).toBe('agentconnect-a1-g901')
  })

  it('never returns another agent’s bot from the same project', () => {
    expect(gitlabAgentBot(bindings, 'example-group/example-project', 'agent-c')).toBeNull()
  })

  it('is absent for an unbound project and for no project at all', () => {
    expect(gitlabAgentBot(bindings, 'example-group/unbound', 'agent-a')).toBeNull()
    expect(gitlabAgentBot(bindings, null, 'agent-a')).toBeNull()
  })

  it('matches the project path regardless of case', () => {
    expect(gitlabAgentBot(bindings, 'Example-Group/Example-Project', 'agent-a')?.username).toBe('agentconnect-a1-g900')
  })
})
