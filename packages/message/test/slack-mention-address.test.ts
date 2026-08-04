import { describe, it, expect } from 'vitest'
import {
  resolveSlackMentionedAgents,
  slackMentionAddress,
  type AgentMentionIdentity
} from '../src/slack-mention-address.js'

const REVIEWER: AgentMentionIdentity = { agentId: 'agent-reviewer', botUserId: 'U01REVIEWER', name: 'reviewer' }
const DEPLOYER: AgentMentionIdentity = { agentId: 'agent-deployer', botUserId: 'U02DEPLOYER', name: 'deployer' }
// Two agents behind ONE shared Slack app: the bot user id names the app, not an agent.
const SHARED_A: AgentMentionIdentity = {
  agentId: 'agent-shared-a',
  botUserId: 'U09SHARED',
  botShared: true,
  name: 'reviewer'
}
const SHARED_B: AgentMentionIdentity = {
  agentId: 'agent-shared-b',
  botUserId: 'U09SHARED',
  botShared: true,
  name: 'planner'
}

describe('slackMentionAddress (§8.5)', () => {
  it('renders a dedicated bot as a bare mention', () => {
    expect(slackMentionAddress(REVIEWER)).toBe('<@U01REVIEWER>')
  })

  it('renders a shared bot as the app mention plus the agent slug', () => {
    expect(slackMentionAddress(SHARED_A)).toBe('<@U09SHARED> reviewer')
  })

  it('has no address for an agent with no Slack presence in the conversation', () => {
    expect(slackMentionAddress({ agentId: 'a', name: 'memory-only' })).toBeUndefined()
  })

  it('refuses to invent a bare address for a shared bot with no slug', () => {
    // A bare `<@U09SHARED>` would address the APP — i.e. some other agent, or none.
    expect(slackMentionAddress({ agentId: 'a', botUserId: 'U09SHARED', botShared: true })).toBeUndefined()
  })

  it('round-trips: a rendered address resolves back to the agent it names', () => {
    for (const agent of [REVIEWER, SHARED_A, SHARED_B]) {
      const address = slackMentionAddress(agent)!
      expect(resolveSlackMentionedAgents(`${address} please look`, [REVIEWER, SHARED_A, SHARED_B])).toEqual([
        agent.agentId
      ])
    }
  })
})

describe('resolveSlackMentionedAgents (§5.1 / §6)', () => {
  const directory = [REVIEWER, DEPLOYER, SHARED_A, SHARED_B]

  it('resolves dedicated mentions in first-appearance order, deduplicated', () => {
    const text = '<@U02DEPLOYER> ship it, then <@U01REVIEWER> verify — cc <@U02DEPLOYER>'
    expect(resolveSlackMentionedAgents(text, directory)).toEqual(['agent-deployer', 'agent-reviewer'])
  })

  it('tolerates Slack’s display-label form', () => {
    expect(resolveSlackMentionedAgents('<@U01REVIEWER|reviewer> hi', directory)).toEqual(['agent-reviewer'])
  })

  it('selects the named agent behind a shared bot', () => {
    expect(resolveSlackMentionedAgents('<@U09SHARED> planner take this', directory)).toEqual(['agent-shared-b'])
  })

  it('resolves NOTHING for a bare shared-bot mention', () => {
    // §6: a bare shared-bot mention from an agent must not fall back to the channel's
    // default agent. Resolving to nobody here is what makes that guarantee structural.
    expect(resolveSlackMentionedAgents('<@U09SHARED> please take a look', directory)).toEqual([])
  })

  it('resolves nothing for a slug that names no agent in this conversation', () => {
    expect(resolveSlackMentionedAgents('<@U09SHARED> nobody hello', directory)).toEqual([])
  })

  it('ignores mentions of humans and of unrelated bots', () => {
    expect(resolveSlackMentionedAgents('<@U03HUMAN> and <@U04OTHERBOT> hello', directory)).toEqual([])
  })

  it('treats an id with several agents behind it as shared even if the flag is missing', () => {
    // A stale snapshot that dropped `botShared` must not turn a bare app mention into an
    // arbitrary agent — erring toward "needs a slug" only ever resolves fewer agents.
    const stale = [
      { agentId: 'a', botUserId: 'U09SHARED', name: 'reviewer' },
      { agentId: 'b', botUserId: 'U09SHARED', name: 'planner' }
    ]
    expect(resolveSlackMentionedAgents('<@U09SHARED> hello', stale)).toEqual([])
    expect(resolveSlackMentionedAgents('<@U09SHARED> planner hello', stale)).toEqual(['b'])
  })

  it('is case-insensitive on the slug but not on the member id', () => {
    expect(resolveSlackMentionedAgents('<@U09SHARED> Planner go', directory)).toEqual(['agent-shared-b'])
  })
})
