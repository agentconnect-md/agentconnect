import { describe, it, expect, vi } from 'vitest'
import { mentionedAgents, participantAgents, routeRules } from '../src/router/routing-table.js'
import { rulesFromAgent, resolveAgentIntegration, type RoutingRule } from '../src/router/routing-rule.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { Agent } from '../src/agents/agent-schema.js'

const noOwner = () => null
function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgId: 'm1',
    traceId: 't1',
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }
}
const rule = (over: Partial<RoutingRule>): RoutingRule => ({
  agentId: 'a',
  integrationId: 'i',
  botUserId: '',
  scope: {},
  match: { kind: 'auto' },
  source: 'config',
  ...over
})

describe('routeRules ladder', () => {
  it('names EVERY mentioned agent, so nothing depends on rule order', () => {
    // A mention JOINS an agent to the thread; it does not pick between agents. The
    // primary-target rung uses `find`, which on a bot serving several agent routes would
    // otherwise make the same event resolve to whichever rule happened to come first.
    // `mentionedAgents` returns the whole named set, and the daemon delivers to all of
    // them plus everyone already in the thread.
    const rules = [
      rule({ agentId: 'first', botUserId: 'B9', match: { kind: 'mention' } }),
      rule({ agentId: 'second', botUserId: 'B9', match: { kind: 'mention' } }),
      rule({ agentId: 'unnamed', botUserId: 'B7', match: { kind: 'mention' } }),
      rule({ agentId: 'auto', match: { kind: 'auto' } })
    ]
    const named = mentionedAgents(msg({ mentionedBots: ['B9'] }), rules)
    expect(new Set(named)).toEqual(new Set(['first', 'second']))
    expect(named).not.toContain('unnamed')

    // The author is never named back to itself.
    expect(mentionedAgents(msg({ mentionedBots: ['B9'] }), rules, 'first')).toEqual(['second'])
    // No mention ⇒ nobody is joined by this route.
    expect(mentionedAgents(msg(), rules)).toEqual([])
  })

  it('keeps every thread participant this connection can serve', () => {
    // Participation outlives the message that created it: once joined, an agent receives
    // what is said next whether or not that message names it, and whoever said it.
    const rules = [
      rule({ agentId: 'joined', match: { kind: 'mention' }, botUserId: 'B9' }),
      rule({ agentId: 'elsewhere', scope: { channel: 'OTHER' }, match: { kind: 'auto' } })
    ]
    const participants = ['joined', 'elsewhere', 'not-served-here']
    expect(participantAgents(msg(), rules, participants)).toEqual(['joined'])
    expect(participantAgents(msg(), rules, participants, 'joined')).toEqual([])

    // An Off channel does not revive its participants — the fence is in the same scope
    // filter every rung uses.
    const muted = [rule({ agentId: 'joined', match: { kind: 'mention' }, mutedChannels: ['C1'] })]
    expect(participantAgents(msg(), muted, ['joined'])).toEqual([])
  })

  it('lets Slack bots enter only through an explicit mention', () => {
    const rules = [
      rule({ agentId: 'mentioned', botUserId: 'B9', match: { kind: 'mention' } }),
      rule({ agentId: 'auto', match: { kind: 'auto' } })
    ]
    const bot = { id: 'UPEERBOT', isBot: true }

    expect(routeRules(msg({ sender: bot }), rules, noOwner)).toBeNull()
    expect(routeRules(msg({ sender: bot, mentionedBots: ['B9'] }), rules, noOwner)).toEqual({
      agentId: 'mentioned',
      integrationId: 'i',
      via: 'mention'
    })
    expect(routeRules(msg({ platform: 'telegram', sender: bot, mentionedBots: ['B9'] }), rules, noOwner)).toBeNull()
  })

  it('keeps verified-agent arbitration independent of provider mention tokens', () => {
    const rules = [
      rule({ agentId: 'mentioned', botUserId: 'B9', match: { kind: 'mention' } }),
      rule({ agentId: 'ordinary', match: { kind: 'auto' } })
    ]
    const bot = { id: 'UAGENT', isBot: true }
    const mentioned = routeRules(msg({ sender: bot, mentionedBots: ['B9'] }), rules, noOwner, undefined, 'author')
    const unmentioned = routeRules(msg({ sender: bot, mentionedBots: [] }), rules, noOwner, undefined, 'author')
    expect(mentioned).toEqual(unmentioned)
    expect(mentioned).toMatchObject({ agentId: 'ordinary', via: 'auto' })
  })

  it('explicit @bot wins across layers (over a CP auto on the same channel)', () => {
    const rules = [
      rule({ agentId: 'cpAgent', source: 'cp', scope: { channel: 'C1' }, match: { kind: 'auto' } }),
      rule({ agentId: 'mentioned', botUserId: 'B9', match: { kind: 'mention' } })
    ]
    const r = routeRules(msg({ mentionedBots: ['B9'] }), rules, noOwner)
    expect(r).toEqual({ agentId: 'mentioned', integrationId: 'i', via: 'mention' })
  })

  it('CP per-sessionKey override beats local for the same channel', () => {
    const rules = [
      rule({ agentId: 'local', source: 'config', scope: { channel: 'C1' }, match: { kind: 'auto' } }),
      rule({ agentId: 'cpAgent', source: 'cp', scope: { channel: 'C1' }, match: { kind: 'auto' } })
    ]
    expect(routeRules(msg(), rules, noOwner)?.agentId).toBe('cpAgent')
  })

  it('thread affinity routes to the owning agent when present', () => {
    const rules = [rule({ agentId: 'owner', match: { kind: 'auto' }, scope: { channel: 'C1' } })]
    const r = routeRules(msg({ thread: 'T1' }), rules, (c, t) => (c === 'C1' && t === 'T1' ? 'owner' : null))
    expect(r?.agentId).toBe('owner')
  })

  it('does not let a Discord channel-root session claim unrelated channel messages', () => {
    const rules = [rule({ agentId: 'owner', botUserId: 'B9', match: { kind: 'mention' }, scope: { channel: 'C1' } })]
    const threadOwner = vi.fn(() => 'owner')

    expect(routeRules(msg({ platform: 'discord', thread: undefined }), rules, threadOwner)).toBeNull()
    expect(threadOwner).not.toHaveBeenCalled()
  })

  it('kind precedence: mention > dm > keyword > auto within a layer', () => {
    const rules = [
      rule({ agentId: 'auto', match: { kind: 'auto' } }),
      rule({ agentId: 'kw', match: { kind: 'keyword', value: 'hello' } }),
      rule({ agentId: 'dm', match: { kind: 'dm' } })
    ]
    // DM message, all three match → dm wins (mention absent)
    expect(routeRules(msg({ isDm: true, text: 'hello' }), rules, noOwner)?.agentId).toBe('dm')
  })

  it('routes a gated Lark DM through its dm rule when the user also @-mentions the bot', () => {
    const rules = [
      rule({
        agentId: 'private-bot',
        integrationId: 'lark-private',
        botUserId: 'ou_bot',
        match: { kind: 'dm' },
        platform: 'feishu'
      })
    ]

    expect(
      routeRules(
        msg({
          platform: 'feishu',
          channel: 'oc_dm',
          isDm: true,
          mentionedBots: ['ou_bot'],
          text: '@private-bot 中文名是啥?'
        }),
        rules,
        noOwner
      )
    ).toEqual({ agentId: 'private-bot', integrationId: 'lark-private', via: 'dm' })
  })

  it('keyword matches case-insensitively on substring', () => {
    const rules = [rule({ agentId: 'kw', match: { kind: 'keyword', value: 'Deploy' } })]
    expect(routeRules(msg({ text: 'please deploy now' }), rules, noOwner)?.agentId).toBe('kw')
  })

  it('returns null when nothing matches', () => {
    const rules = [rule({ scope: { channel: 'OTHER' }, match: { kind: 'auto' } })]
    expect(routeRules(msg(), rules, noOwner)).toBeNull()
  })

  describe('muted channels (per-channel Off)', () => {
    it('silences the unscoped mention default in the muted channel only', () => {
      const rules = [rule({ botUserId: 'B9', match: { kind: 'mention' }, mutedChannels: ['C1'] })]
      expect(routeRules(msg({ channel: 'C1', mentionedBots: ['B9'] }), rules, noOwner)).toBeNull()
      expect(routeRules(msg({ channel: 'C2', mentionedBots: ['B9'] }), rules, noOwner)?.agentId).toBe('a')
    })

    it('silences a thread inside the muted channel, and thread continuity with it', () => {
      const rules = [rule({ agentId: 'A', scope: { channel: 'C1' }, match: { kind: 'auto' }, mutedChannels: ['C1'] })]
      const owner = (c: string, t: string) => (c === 'C1' && t === 'T1' ? 'A' : null)
      expect(routeRules(msg({ channel: 'C1', thread: 'T1' }), rules, owner)).toBeNull()
    })

    it('silences a CP session placement in the muted channel', () => {
      const rules = [
        rule({
          agentId: 'cpAgent',
          source: 'cp',
          scope: { channel: 'C1' },
          match: { kind: 'auto' },
          mutedChannels: ['C1']
        })
      ]
      expect(routeRules(msg({ channel: 'C1' }), rules, noOwner)).toBeNull()
    })

    it('mutes only its OWN integration — a second bot in the channel keeps answering', () => {
      const rules = [
        rule({
          agentId: 'muted',
          integrationId: 'i1',
          botUserId: 'B1',
          match: { kind: 'mention' },
          mutedChannels: ['C1']
        }),
        rule({ agentId: 'live', integrationId: 'i2', botUserId: 'B2', match: { kind: 'mention' } })
      ]
      expect(routeRules(msg({ channel: 'C1', mentionedBots: ['B1'] }), rules, noOwner)).toBeNull()
      expect(routeRules(msg({ channel: 'C1', mentionedBots: ['B2'] }), rules, noOwner)?.agentId).toBe('live')
    })
  })

  it('explicit agentId (webchat) routes directly, bypassing arbitration', () => {
    // No rules match this webchat message, yet an explicit agentId short-circuits the
    // whole ladder — webchat names its target agent, so there is nothing to arbitrate.
    const r = routeRules(
      msg({ platform: 'webchat', channel: 'conv-1', mentionedBots: [] }),
      [],
      noOwner,
      'target-agent'
    )
    expect(r).toEqual({ agentId: 'target-agent', integrationId: '', via: 'mention' })
  })

  it('single-bot thread continuity bypasses the kind filter', () => {
    // A has ONLY a mention rule in C1 (no auto). An un-mentioned follow-up in thread T1
    // still routes to A because it's the sole reachable bot (§8.2 single-candidate continuity).
    const rules = [rule({ agentId: 'A', botUserId: 'BA', scope: { channel: 'C1' }, match: { kind: 'mention' } })]
    const owner = (c: string, t: string) => (c === 'C1' && t === 'T1' ? 'A' : null)
    const r = routeRules(msg({ thread: 'T1', mentionedBots: [] }), rules, owner)
    expect(r?.agentId).toBe('A')
  })

  it('multi-bot channel: a thread owned by one agent continues to that owner un-mentioned', () => {
    // A and B both reachable in C1, but the thread is owned solely by A (one open
    // session) → an un-mentioned follow-up routes to A, not gated by B's presence (§8.5).
    const rules = [
      rule({
        agentId: 'A',
        integrationId: 'iA',
        botUserId: 'BA',
        scope: { channel: 'C1' },
        match: { kind: 'mention' }
      }),
      rule({ agentId: 'B', integrationId: 'iB', botUserId: 'BB', scope: { channel: 'C1' }, match: { kind: 'mention' } })
    ]
    const owner = (c: string, t: string) => (c === 'C1' && t === 'T1' ? 'A' : null)
    const r = routeRules(msg({ thread: 'T1', mentionedBots: [] }), rules, owner)
    expect(r).toEqual({ agentId: 'A', integrationId: 'iA', via: 'thread' })
  })

  it('contended thread (2+ agents with open sessions) is mention-gated → null', () => {
    // threadOwner returns null when multiple agents actively share the thread; an
    // un-mentioned follow-up activates none.
    const rules = [
      rule({ agentId: 'A', botUserId: 'BA', scope: { channel: 'C1' }, match: { kind: 'mention' } }),
      rule({ agentId: 'B', botUserId: 'BB', scope: { channel: 'C1' }, match: { kind: 'mention' } })
    ]
    expect(routeRules(msg({ thread: 'T1', mentionedBots: [] }), rules, noOwner)).toBeNull()
  })

  it('explicit @ of another bot overrides thread affinity', () => {
    // Thread owned by A, but the message @s B → route to B (§8.3 explicit @ wins).
    const rules = [
      rule({ agentId: 'A', botUserId: 'BA', scope: { channel: 'C1' }, match: { kind: 'auto' } }),
      rule({ agentId: 'B', integrationId: 'iB', botUserId: 'BB', scope: { channel: 'C1' }, match: { kind: 'mention' } })
    ]
    const owner = (c: string, t: string) => (c === 'C1' && t === 'T1' ? 'A' : null)
    const r = routeRules(msg({ thread: 'T1', mentionedBots: ['BB'] }), rules, owner)
    expect(r).toEqual({ agentId: 'B', integrationId: 'iB', via: 'mention' })
  })
})

describe('routeRules platform isolation', () => {
  it('a Slack dm rule does not route a Telegram DM (and vice-versa)', () => {
    const slackDm = rule({ agentId: 'slackbot', match: { kind: 'dm' }, platform: 'slack' })
    const tgDm = rule({ agentId: 'tgbot', match: { kind: 'dm' }, platform: 'telegram' })
    const rules = [slackDm, tgDm]
    expect(routeRules(msg({ isDm: true, platform: 'slack' }), rules, noOwner)?.agentId).toBe('slackbot')
    expect(routeRules(msg({ isDm: true, platform: 'telegram', channel: '-100' }), rules, noOwner)?.agentId).toBe(
      'tgbot'
    )
  })

  it('an unscoped auto rule tagged telegram never matches a slack message', () => {
    const rules = [rule({ agentId: 'tg', match: { kind: 'auto' }, platform: 'telegram' })]
    expect(routeRules(msg({ platform: 'slack' }), rules, noOwner)).toBeNull()
  })

  it("a channel-scoped rule serves that channel's Discord threads", () => {
    const rules = [rule({ agentId: 'a', scope: { channel: 'C1' }, match: { kind: 'auto' }, platform: 'discord' })]
    const inThread = msg({ platform: 'discord', channel: 'C1', thread: 'T9' })
    expect(routeRules(inThread, rules, noOwner)?.agentId).toBe('a')
    // Another channel's thread is still out of scope.
    expect(routeRules({ ...inThread, channel: 'C2' }, rules, noOwner)).toBeNull()
  })

  it('a CP rule scoped to the enclosing channel still overrides a local rule in a thread', () => {
    // The CP-override check uses the same channel coordinate as the scope filter.
    const rules = [
      rule({ agentId: 'local', source: 'config', scope: { channel: 'C1' }, match: { kind: 'auto' } }),
      rule({ agentId: 'cpAgent', source: 'cp', scope: { channel: 'C1' }, match: { kind: 'auto' } })
    ]
    const inThread = msg({ platform: 'discord', channel: 'C1', thread: 'T1' })
    expect(routeRules(inThread, rules, noOwner)?.agentId).toBe('cpAgent')
  })

  it('an UNSCOPED cp rule does not claim the channel layer (local scoped rule still wins)', () => {
    const rules = [
      rule({
        agentId: 'local',
        source: 'config',
        scope: { channel: 'C1' },
        match: { kind: 'keyword', value: 'hello' }
      }),
      rule({ agentId: 'cpGlobal', source: 'cp', scope: {}, match: { kind: 'auto' } })
    ]
    // Keyword outranks auto within the merged layer; a global CP rule must not promote
    // the CP layer just because it matched.
    expect(routeRules(msg(), rules, noOwner)?.agentId).toBe('local')
  })
})

const tgAgent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    integrations: [
      {
        id: 'i-tg',
        platform: 'telegram',
        core: { bindRules: [{ match: { kind: 'mention' } }, { channel: '-100', match: { kind: 'auto' } }] },
        config: { botToken: '123:abc', botUsername: 'mybot' }
      }
    ],
    ...over
  }) as unknown as Agent

describe('rulesFromAgent / resolveAgentIntegration (Telegram)', () => {
  it('emits telegram-tagged rules from a telegram integration, honoring the botUserIds override', () => {
    const rules = rulesFromAgent(tgAgent(), { 'i-tg': 'mybot' })
    expect(rules).toHaveLength(2)
    for (const r of rules) {
      expect(r.platform).toBe('telegram')
      expect(r.integrationId).toBe('i-tg')
      expect(r.botUserId).toBe('mybot')
    }
    expect(rules[1]!.scope).toEqual({ channel: '-100' })
  })

  it("a Telegram @username mention (in mentionedBots) routes via the bot's username", () => {
    const rules = rulesFromAgent(tgAgent(), { 'i-tg': 'mybot' })
    const r = routeRules(
      msg({ platform: 'telegram', channel: '-100', sender: { id: '77', isBot: false }, mentionedBots: ['mybot'] }),
      rules,
      noOwner
    )
    expect(r).toMatchObject({ agentId: 'a1', integrationId: 'i-tg', via: 'mention' })
  })

  it('resolveAgentIntegration returns the telegram integration + platform + resolved username', () => {
    expect(resolveAgentIntegration(tgAgent(), { 'i-tg': 'mybot' })).toEqual({
      integrationId: 'i-tg',
      botUserId: 'mybot',
      platform: 'telegram',
      mutedChannels: []
    })
    expect(resolveAgentIntegration(undefined, {})).toBeNull()
  })
})
