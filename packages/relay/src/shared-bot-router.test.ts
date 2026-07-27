import { describe, it, expect } from 'vitest'
import { SharedBotRouter, arbitrate, type BotAssignment, type RouteTarget } from './shared-bot-router.js'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'

const D1 = 'd1'
const D2 = 'd2'
const ALICE = 'agent-alice'
const BOB = 'agent-bob'
const BOTUSER = 'UBOT'

const assignment = (): BotAssignment => ({
  botId: 'bot-1',
  platform: 'slack',
  secrets: { botToken: 'xoxb', signingSecret: 'ssecret' },
  botUserId: BOTUSER,
  members: [
    { daemonId: D1, agentIds: [ALICE] },
    { daemonId: D2, agentIds: [BOB] }
  ],
  agents: [
    { agentId: ALICE, name: 'Alice' },
    { agentId: BOB, name: 'Bob' }
  ],
  routes: [
    // C1 owned by alice (mention trigger); C2 owned by bob (any trigger).
    { agentId: ALICE, daemonId: D1, integrationId: 'iA', scope: { channel: 'C1' }, match: { kind: 'mention' } },
    { agentId: BOB, daemonId: D2, integrationId: 'iB', scope: { channel: 'C2' }, match: { kind: 'auto' } },
    // keyword rules = agent slug.
    { agentId: ALICE, daemonId: D1, integrationId: 'iA', match: { kind: 'keyword', value: 'alice' } },
    { agentId: BOB, daemonId: D2, integrationId: 'iB', match: { kind: 'keyword', value: 'bob' } }
  ],
  defaultAgentId: ALICE,
  defaultDaemonId: D1
})

const msg = (over: Partial<WireNormalizedMessage>): WireNormalizedMessage => ({
  msgId: 'm1',
  traceId: 't1',
  source: 'user',
  platform: 'slack',
  channel: 'CX',
  thread: 'ts1',
  sender: { id: 'U1', isBot: false },
  text: '',
  mentionedBots: [],
  isDm: false,
  ...over
})

describe('shared-bot arbitration (§10)', () => {
  const empty = () => new Map<string, RouteTarget>()

  it('channel ownership with a mention trigger routes a mentioned message to the owner', () => {
    const t = arbitrate(assignment(), msg({ channel: 'C1', text: '<@UBOT> deploy', mentionedBots: [BOTUSER] }), empty())
    expect(t).toEqual({ agentId: ALICE, daemonId: D1, integrationId: 'iA' })
  })

  it('a mention-trigger channel does NOT route a non-mention message', () => {
    const t = arbitrate(assignment(), msg({ channel: 'C1', text: 'just chatting' }), empty())
    expect(t).toBeNull()
  })

  it('channel ownership with an "any" trigger routes every message to the owner', () => {
    const t = arbitrate(assignment(), msg({ channel: 'C2', text: 'no mention here' }), empty())
    expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
  })

  it('keyword disambiguation routes "@bot bob …" to bob in an un-owned channel', () => {
    const t = arbitrate(
      assignment(),
      msg({ channel: 'CX', text: '<@UBOT> bob ship it', mentionedBots: [BOTUSER] }),
      empty()
    )
    expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
  })

  it('a bare @bot with no slug falls back to the default agent', () => {
    const t = arbitrate(assignment(), msg({ channel: 'CX', text: '<@UBOT> hello', mentionedBots: [BOTUSER] }), empty())
    expect(t).toEqual({ agentId: ALICE, daemonId: D1, integrationId: 'iA' })
  })

  it('a DM with no slug goes to the default agent', () => {
    const t = arbitrate(assignment(), msg({ channel: 'D1', isDm: true, text: 'hi' }), empty())
    expect(t).toEqual({ agentId: ALICE, daemonId: D1, integrationId: 'iA' })
  })

  it('does NOT keyword-route a plain channel message that merely contains a slug', () => {
    // No mention, not a DM, un-owned channel → not addressed → no route.
    const t = arbitrate(assignment(), msg({ channel: 'CX', text: 'tell alice later' }), empty())
    expect(t).toBeNull()
  })

  it('lets a third-party Slack bot enter only by explicit mention and suppresses its own echo', () => {
    const externalBot = { id: 'UPEERBOT', isBot: true, appId: 'AEXTERNAL' }
    expect(
      arbitrate(assignment(), msg({ channel: 'C2', sender: externalBot, text: 'unmentioned' }), empty())
    ).toBeNull()
    expect(
      arbitrate(
        assignment(),
        msg({ channel: 'C2', sender: externalBot, text: '<@UBOT> deploy', mentionedBots: [BOTUSER] }),
        empty()
      )?.agentId
    ).toBe(BOB)
    expect(arbitrate(assignment(), msg({ sender: { id: BOTUSER, isBot: true } }), empty())).toBeNull()
  })

  it('thread continuity carries an un-mentioned follow-up to the prior agent', () => {
    const aff = new Map<string, RouteTarget>([['CX/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
    const t = arbitrate(assignment(), msg({ channel: 'CX', thread: 'ts1', text: 'and then?' }), aff)
    expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
  })

  it('backfills integrationId for an rc/assign-seeded affinity target', () => {
    const aff = new Map<string, RouteTarget>([['CX/ts1', { agentId: BOB, daemonId: D2, integrationId: '' }]])
    const t = arbitrate(assignment(), msg({ channel: 'CX', thread: 'ts1', text: 'more' }), aff)
    expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
  })

  describe('conversation gating (resource-visibility §14)', () => {
    it('thread continuity to a GATED agent is refused when it has no scoped route in the conversation', () => {
      const a = { ...assignment(), gatedAgentIds: [BOB] }
      // BOB's only scoped route is C2; a pre-gate binding in CX must not keep routing.
      const aff = new Map<string, RouteTarget>([['CX/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      const t = arbitrate(a, msg({ channel: 'CX', thread: 'ts1', text: 'and then?' }), aff)
      expect(t).toBeNull()
    })

    it('thread continuity to a GATED agent is honoured inside its enabled conversation', () => {
      const a = { ...assignment(), gatedAgentIds: [BOB] }
      const aff = new Map<string, RouteTarget>([['C2/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      const t = arbitrate(a, msg({ channel: 'C2', thread: 'ts1', text: 'and then?' }), aff)
      expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
    })

    it('a conversation-scoped keyword (DM slug) outranks the scoped auto route', () => {
      const a = assignment()
      a.gatedAgentIds = [ALICE, BOB]
      a.routes = [
        // Both gated agents enabled the same DM: one auto + one slug route each.
        { agentId: ALICE, daemonId: D1, integrationId: 'iA', scope: { channel: 'D9' }, match: { kind: 'auto' } },
        {
          agentId: ALICE,
          daemonId: D1,
          integrationId: 'iA',
          scope: { channel: 'D9' },
          match: { kind: 'keyword', value: 'alice' }
        },
        { agentId: BOB, daemonId: D2, integrationId: 'iB', scope: { channel: 'D9' }, match: { kind: 'auto' } },
        {
          agentId: BOB,
          daemonId: D2,
          integrationId: 'iB',
          scope: { channel: 'D9' },
          match: { kind: 'keyword', value: 'bob' }
        }
      ]
      const slugged = arbitrate(a, msg({ channel: 'D9', isDm: true, text: 'bob check this please' }), empty())
      expect(slugged).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
      const bare = arbitrate(a, msg({ channel: 'D9', isDm: true, text: 'hello' }), empty())
      expect(bare).toEqual({ agentId: ALICE, daemonId: D1, integrationId: 'iA' })
    })

    it('thread continuity to a NON-gated agent is unaffected by gatedAgentIds on others', () => {
      const a = { ...assignment(), gatedAgentIds: [ALICE] }
      const aff = new Map<string, RouteTarget>([['CX/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      const t = arbitrate(a, msg({ channel: 'CX', thread: 'ts1', text: 'and then?' }), aff)
      expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
    })
  })
})

describe('SharedBotRouter — table + live affinity', () => {
  it('records live affinity so a follow-up continues to the same agent', () => {
    const r = new SharedBotRouter()
    r.upsert(assignment())
    // First turn: "@bot bob" → bob, recorded.
    const first = r.route(
      'bot-1',
      msg({ channel: 'CX', thread: 'ts9', text: '<@UBOT> bob start', mentionedBots: [BOTUSER] })
    )
    expect(first?.agentId).toBe(BOB)
    // Follow-up with no mention continues to bob via affinity.
    const next = r.route('bot-1', msg({ channel: 'CX', thread: 'ts9', text: 'continue' }))
    expect(next?.agentId).toBe(BOB)
  })

  it('updateRoutes swaps the table but keeps the resolved botUserId', () => {
    const r = new SharedBotRouter()
    r.upsert(assignment())
    r.setBotUserId('bot-1', BOTUSER)
    r.updateRoutes('bot-1', {
      members: assignment().members,
      agents: assignment().agents,
      routes: [],
      defaultAgentId: undefined,
      defaultDaemonId: undefined
    })
    expect(r.get('bot-1')?.botUserId).toBe(BOTUSER)
    expect(r.get('bot-1')?.routes).toEqual([])
  })

  it('remove drops the assignment', () => {
    const r = new SharedBotRouter()
    r.upsert(assignment())
    r.remove('bot-1')
    expect(r.get('bot-1')).toBeUndefined()
    expect(r.route('bot-1', msg({}))).toBeNull()
  })

  it('resolves status actions only for the exact current agent + integration', () => {
    const r = new SharedBotRouter()
    r.upsert(assignment())
    expect(r.targetForAgent('bot-1', ALICE, 'iA')).toEqual({
      agentId: ALICE,
      daemonId: D1,
      integrationId: 'iA'
    })
    expect(r.targetForAgent('bot-1', ALICE, 'iB')).toBeUndefined()
    expect(r.targetForAgent('bot-1', BOB, 'iA')).toBeUndefined()
    expect(r.targetForAgent('other-bot', ALICE, 'iA')).toBeUndefined()
  })

  it('fails closed when an exact status target maps ambiguously or is no longer a member', () => {
    const ambiguous = assignment()
    ambiguous.members.push({ daemonId: D2, agentIds: [ALICE] })
    ambiguous.routes.push({
      agentId: ALICE,
      daemonId: D2,
      integrationId: 'iA',
      match: { kind: 'keyword', value: 'alice-elsewhere' }
    })
    const r = new SharedBotRouter()
    r.upsert(ambiguous)
    expect(r.targetForAgent('bot-1', ALICE, 'iA')).toBeUndefined()

    const stale = assignment()
    stale.members = stale.members.filter((member) => member.daemonId !== D1)
    r.upsert(stale)
    expect(r.targetForAgent('bot-1', ALICE, 'iA')).toBeUndefined()
  })
})
