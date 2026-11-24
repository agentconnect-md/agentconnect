import { describe, it, expect } from 'vitest'
import type { AgentMentionIdentity } from '../src/slack-mention-address.js'
import { mattermostMentionAddress, resolveMattermostMentionedAgents } from '../src/mattermost-mention-address.js'

const REVIEWER: AgentMentionIdentity = {
  agentId: 'agent-reviewer',
  botUserId: 'mm-u-reviewer',
  botUsername: 'reviewer_bot',
  name: 'reviewer'
}
const DEPLOYER: AgentMentionIdentity = {
  agentId: 'agent-deployer',
  botUserId: 'mm-u-deployer',
  botUsername: 'deployer.bot',
  name: 'deployer'
}
const SHARED_A: AgentMentionIdentity = {
  agentId: 'agent-shared-a',
  botUserId: 'mm-u-shared',
  botUsername: 'sharedbot',
  botShared: true,
  name: 'reviewer'
}
const SHARED_B: AgentMentionIdentity = {
  agentId: 'agent-shared-b',
  botUserId: 'mm-u-shared',
  botUsername: 'sharedbot',
  botShared: true,
  name: 'planner'
}

describe('mattermostMentionAddress', () => {
  it('renders a dedicated bot handle as @handle and trims/strips leading @', () => {
    expect(mattermostMentionAddress(REVIEWER)).toBe('@reviewer_bot')
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: '  @acbot  ' })).toBe('@acbot')
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: 'ops.bot-1' })).toBe('@ops.bot-1')
  })

  it('renders a shared bot as @handle plus the agent slug, and returns undefined without a slug', () => {
    expect(mattermostMentionAddress(SHARED_A)).toBe('@sharedbot reviewer')
    expect(mattermostMentionAddress(SHARED_B)).toBe('@sharedbot planner')
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: 'sharedbot', botShared: true })).toBeUndefined()
  })

  it('returns undefined when botUsername is missing or invalid', () => {
    expect(mattermostMentionAddress({ agentId: 'a', name: 'reviewer' })).toBeUndefined()
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: '' })).toBeUndefined()
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: '@' })).toBeUndefined()
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: 'bad handle' })).toBeUndefined()
    expect(mattermostMentionAddress({ agentId: 'a', botUsername: 'user@bot' })).toBeUndefined()
  })

  it('round-trips rendered addresses back to the exact agent', () => {
    const dir = [REVIEWER, DEPLOYER, SHARED_A, SHARED_B]
    for (const agent of dir) {
      const addr = mattermostMentionAddress(agent)!
      expect(resolveMattermostMentionedAgents(`${addr} please check`, dir)).toEqual([agent.agentId])
    }
  })
})

describe('resolveMattermostMentionedAgents', () => {
  const directory = [REVIEWER, DEPLOYER, SHARED_A, SHARED_B]

  it('resolves dedicated handles case-insensitively in deduplicated first-appearance order', () => {
    const text = 'Hey @Deployer.Bot check this, then @REVIEWER_BOT verify — cc @deployer.bot'
    expect(resolveMattermostMentionedAgents(text, directory)).toEqual(['agent-deployer', 'agent-reviewer'])
  })

  it('ignores email-like substrings and partial prefix matches (boundary-aware)', () => {
    expect(resolveMattermostMentionedAgents('mail user@reviewer_bot or foo@deployer.bot.com', directory)).toEqual([])
    expect(resolveMattermostMentionedAgents('ping @reviewer_bot2 and @reviewer_bot.extra', directory)).toEqual([])
  })

  it('handles sentence punctuation around @handles cleanly', () => {
    expect(resolveMattermostMentionedAgents('ping @reviewer_bot.', directory)).toEqual(['agent-reviewer'])
    expect(resolveMattermostMentionedAgents('(@deployer.bot), please inspect', directory)).toEqual(['agent-deployer'])
  })

  it('disambiguates shared handles with trailing slug case-insensitively and drops bare mentions', () => {
    expect(resolveMattermostMentionedAgents('@sharedbot please check', directory)).toEqual([])
    expect(resolveMattermostMentionedAgents('@sharedbot\nplanner go', directory)).toEqual([])
    expect(resolveMattermostMentionedAgents('@SharedBot Planner go', directory)).toEqual(['agent-shared-b'])
    expect(resolveMattermostMentionedAgents('Ask @sharedbot reviewer.', directory)).toEqual(['agent-shared-a'])
    expect(resolveMattermostMentionedAgents('@sharedbot. reviewer should see', directory)).toEqual([])
  })

  it('treats agents sharing a handle or botUserId as shared even when botShared or peer botUsername is omitted', () => {
    const sharedByHandle = [
      { agentId: 'a', botUsername: 'team_bot', name: 'alpha' },
      { agentId: 'b', botUsername: 'team_bot', name: 'beta' }
    ]
    expect(resolveMattermostMentionedAgents('@team_bot hello', sharedByHandle)).toEqual([])
    expect(resolveMattermostMentionedAgents('@team_bot BETA check', sharedByHandle)).toEqual(['b'])

    const sharedByBotUserId = [
      { agentId: 'a', botUserId: 'mm-u-1', botUsername: 'team_bot', name: 'alpha' },
      { agentId: 'b', botUserId: 'mm-u-1', name: 'beta' }
    ]
    expect(resolveMattermostMentionedAgents('@team_bot hello', sharedByBotUserId)).toEqual([])
    expect(resolveMattermostMentionedAgents('@team_bot beta check', sharedByBotUserId)).toEqual(['b'])
  })

  it('resolves a sole candidate even if a stale botShared flag is present', () => {
    expect(
      resolveMattermostMentionedAgents('@solo_bot hi', [
        { agentId: 'solo', botUsername: 'solo_bot', botShared: true, name: 'solo' }
      ])
    ).toEqual(['solo'])
  })
})
