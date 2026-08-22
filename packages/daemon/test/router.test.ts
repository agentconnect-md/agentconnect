import { describe, it, expect } from 'vitest'
import { routeRules } from '../src/router/routing-table.js'
import { rulesFromAgent } from '../src/router/routing-rule.js'
import type { Agent } from '../src/agents/agent-schema.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

// The routeRules arbitration ladder is exercised exhaustively in test/route-rules.test.ts.
// This file covers the daemon-level seam: agent.json `bindRules` → rulesFromAgent (local
// layer) → routeRules, mirroring the scenarios the legacy routing-table test
// covered (subscribed-all, trigger=mention, thread affinity, explicit-@ override, DM, gates).

function agent(id: string, bindRules: Agent['integrations'][number]['core']['bindRules']): Agent {
  return {
    id,
    name: id,
    status: 'active',
    runtime: 'claude',
    workspace: { mode: 'from-scratch', path: '/tmp/x', gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [
      {
        id: `${id}-int`,
        platform: 'slack',
        core: { bindRules },
        config: { botToken: 'x', appToken: 'x' }
      }
    ],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  msgId: 'm',
  traceId: 't',
  source: 'user',
  platform: 'slack',
  channel: 'C1',
  thread: '100.1',
  sender: { id: 'U1', isBot: false },
  text: '',
  mentionedBots: [],
  isDm: false,
  ...over
})

const noOwner = () => null

describe('local-layer routing (bindRules → rulesFromAgent → routeRules)', () => {
  it('routes a channel-scoped auto bindRule without a mention', () => {
    const rules = rulesFromAgent(agent('bot-a', [{ channel: 'C1', match: { kind: 'auto' } }]), { 'bot-a-int': 'BOTA' })
    expect(routeRules(msg({ text: 'anything' }), rules, noOwner)).toEqual({
      agentId: 'bot-a',
      integrationId: 'bot-a-int',
      via: 'auto'
    })
  })

  it('a mention bindRule only fires when the bot is @-mentioned', () => {
    const rules = rulesFromAgent(agent('bot-a', [{ channel: 'C1', match: { kind: 'mention' } }]), {
      'bot-a-int': 'BOTA'
    })
    expect(routeRules(msg({ text: 'hello' }), rules, noOwner)).toBeNull()
    expect(routeRules(msg({ text: '<@BOTA> hi', mentionedBots: ['BOTA'] }), rules, noOwner)).toEqual({
      agentId: 'bot-a',
      integrationId: 'bot-a-int',
      via: 'mention'
    })
  })

  it('thread affinity routes follow-ups to the owning agent (auto rule scopes the channel)', () => {
    // routeRules filters by kind first, so the owning agent needs a rule that matches a
    // plain follow-up (auto). The legacy router had a separate thread branch; the unified
    // ladder folds thread affinity in after the kind filter.
    const rules = rulesFromAgent(agent('bot-a', [{ channel: 'C1', match: { kind: 'auto' } }]), { 'bot-a-int': 'BOTA' })
    const owner = (_c: string, _t: string) => 'bot-a'
    expect(routeRules(msg({ text: 'follow up no mention' }), rules, owner)).toEqual({
      agentId: 'bot-a',
      integrationId: 'bot-a-int',
      via: 'thread'
    })
  })

  it('does not route a foreign bot mention through local thread affinity', () => {
    const rules = rulesFromAgent(agent('bot-a', [{ channel: 'C1', match: { kind: 'mention' } }]), {
      'bot-a-int': 'BOTA'
    })
    const owner = () => 'bot-a'
    expect(routeRules(msg({ text: '<@BOTB> only you', mentionedBots: ['BOTB'] }), rules, owner)).toBeNull()
  })

  it('explicit @ of another bot overrides thread affinity', () => {
    const rules = [
      ...rulesFromAgent(agent('bot-a', [{ channel: 'C1', match: { kind: 'auto' } }]), { 'bot-a-int': 'BOTA' }),
      ...rulesFromAgent(agent('bot-b', [{ match: { kind: 'mention' } }]), { 'bot-b-int': 'BOTB' })
    ]
    const owner = () => 'bot-a'
    expect(routeRules(msg({ text: '<@BOTB> take over', mentionedBots: ['BOTB'] }), rules, owner)).toEqual({
      agentId: 'bot-b',
      integrationId: 'bot-b-int',
      via: 'mention'
    })
  })

  it('DM routes to the agent with a dm bindRule', () => {
    const rules = rulesFromAgent(agent('bot-a', [{ match: { kind: 'dm' } }]), { 'bot-a-int': 'BOTA' })
    expect(routeRules(msg({ isDm: true, channel: 'D1', text: 'hey' }), rules, noOwner)).toEqual({
      agentId: 'bot-a',
      integrationId: 'bot-a-int',
      via: 'dm'
    })
  })
})
