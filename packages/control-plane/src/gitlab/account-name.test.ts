/**
 * Agent service-account naming (gitlab-com-integration.md §7.2): the username is
 * the rename-stable machine identity of one (agent, top-level group), the
 * display name is the agent's own name.
 */
import { describe, expect, it } from 'vitest'
import { gitlabAgentAccountDisplayName, gitlabAgentAccountUsername } from './api.js'

const AGENT = '3f6a1c2e-8b4d-4f7a-9c11-2d5e6f7a8b90'
const USERNAME = 'agentconnect-a3f6a1c2e8b4d4f7a9c112d5e6f7a8b90-g12345'

describe('gitlabAgentAccountUsername', () => {
  it('is deterministic from the agent uuid and the top-level group id', () => {
    expect(gitlabAgentAccountUsername(AGENT, 12345n)).toBe(USERNAME)
  })

  it('gives one agent a distinct account per top-level group', () => {
    expect(gitlabAgentAccountUsername(AGENT, 12345n)).not.toBe(gitlabAgentAccountUsername(AGENT, 999n))
  })

  it('is rename-stable and carries nothing a person chose', () => {
    expect(gitlabAgentAccountUsername(AGENT, 12345n)).toMatch(/^agentconnect-a[0-9a-f]{32}-g\d+$/)
  })
})

describe('gitlabAgentAccountDisplayName', () => {
  it('names the account after the agent', () => {
    expect(gitlabAgentAccountDisplayName('Release Robot', USERNAME)).toBe('Release-Robot')
    expect(gitlabAgentAccountDisplayName('reviewer', USERNAME)).toBe('reviewer')
  })

  it('folds anything outside the safe set and caps the name', () => {
    expect(gitlabAgentAccountDisplayName('prêt <à> porter', USERNAME)).toBe('pr-t-porter')
    expect(gitlabAgentAccountDisplayName('a'.repeat(120), USERNAME)).toBe('a'.repeat(48))
  })

  it('falls back to the machine username when nothing survives', () => {
    expect(gitlabAgentAccountDisplayName('***', USERNAME)).toBe(USERNAME)
    expect(gitlabAgentAccountDisplayName('', USERNAME)).toBe(USERNAME)
  })
})
