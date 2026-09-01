import { describe, it, expect } from 'vitest'
import {
  BotArbitrationRouter,
  arbitrate,
  type BotAssignment,
  type RouteTarget,
  toBotAssignment
} from './bot-arbitration.js'
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

describe('HTTP-bot arbitration (§10)', () => {
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

  it('does not let a verified agent mention enable shared-bot default selection', () => {
    const author = 'agent-author'
    const mentioned = arbitrate(
      assignment(),
      msg({
        channel: 'CX',
        sender: { id: 'UAGENT', isBot: true },
        text: '<@UBOT> hello',
        mentionedBots: [BOTUSER]
      }),
      empty(),
      author
    )
    const unmentioned = arbitrate(
      assignment(),
      msg({ channel: 'CX', sender: { id: 'UAGENT', isBot: true }, text: 'hello', mentionedBots: [] }),
      empty(),
      author
    )
    expect(mentioned).toEqual(unmentioned)
    expect(mentioned).toBeNull()
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

    it('a public DM slug selects a non-first agent before the scoped auto route', () => {
      const a = assignment()
      a.routes = [
        // Both public agents enabled the same DM: one auto + one slug route each.
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

    it('refuses public DM continuity after that agent loses its scoped route', () => {
      const a = assignment()
      a.routes = []
      a.defaultAgentId = undefined
      a.defaultDaemonId = undefined
      const aff = new Map<string, RouteTarget>([['D9/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      expect(arbitrate(a, msg({ channel: 'D9', thread: 'ts1', isDm: true, text: 'continue' }), aff)).toBeNull()
    })

    it('thread continuity to a NON-gated agent is unaffected by gatedAgentIds on others', () => {
      const a = { ...assignment(), gatedAgentIds: [ALICE] }
      const aff = new Map<string, RouteTarget>([['CX/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      const t = arbitrate(a, msg({ channel: 'CX', thread: 'ts1', text: 'and then?' }), aff)
      expect(t).toEqual({ agentId: BOB, daemonId: D2, integrationId: 'iB' })
    })
  })

  describe('muted channels (per-channel Off)', () => {
    it('resolves nothing in a muted channel, even for an explicit @bot', () => {
      const a = { ...assignment(), mutedChannels: ['C1'] }
      const t = arbitrate(a, msg({ channel: 'C1', text: '<@UBOT> deploy', mentionedBots: [BOTUSER] }), empty())
      expect(t).toBeNull()
    })

    it('shuts off the rungs a missing route cannot: keyword slug and the group default', () => {
      const a = { ...assignment(), mutedChannels: ['CX'] }
      // CX has no scoped route at all, so both of these route today.
      expect(arbitrate(a, msg({ channel: 'CX', text: 'bob ship it', mentionedBots: [BOTUSER] }), empty())).toBeNull()
      expect(arbitrate(a, msg({ channel: 'CX', text: '<@UBOT> hi', mentionedBots: [BOTUSER] }), empty())).toBeNull()
    })

    it('drops thread continuity into a muted channel', () => {
      const a = { ...assignment(), mutedChannels: ['C2'] }
      const aff = new Map<string, RouteTarget>([['C2/ts1', { agentId: BOB, daemonId: D2, integrationId: 'iB' }]])
      expect(arbitrate(a, msg({ channel: 'C2', thread: 'ts1', text: 'and then?' }), aff)).toBeNull()
    })

    it('leaves the bot answering everywhere else', () => {
      const a = { ...assignment(), mutedChannels: ['C1'] }
      expect(arbitrate(a, msg({ channel: 'C2', text: 'anything' }), empty())).toEqual({
        agentId: BOB,
        daemonId: D2,
        integrationId: 'iB'
      })
    })

    // The mixed-bot case the fence exists for: ALICE is gated and owns CX with the
    // channel Off, so it compiles no scoped route — but BOB's unscoped keyword and the
    // group's defaultAgentId are still in the table. Without the mute a bare @bot would
    // quietly activate the PUBLIC agent in a channel the console shows as Off.
    it('a gated owner Off channel does not fall through to the public default', () => {
      const a = { ...assignment(), gatedAgentIds: [ALICE], mutedChannels: ['CX'], gatedOffChannels: ['CX'] }
      expect(arbitrate(a, msg({ channel: 'CX', text: '<@UBOT> hi', mentionedBots: [BOTUSER] }), empty())).toBeNull()
      // …and the slug rung is closed too, so naming the public agent cannot reopen it.
      expect(arbitrate(a, msg({ channel: 'CX', text: 'bob ship it', mentionedBots: [BOTUSER] }), empty())).toBeNull()
    })

    it('the notice-keeping subset does not make a channel routable', () => {
      // gatedOffChannels only steers the notice; arbitration must still refuse.
      const a = { ...assignment(), mutedChannels: ['C2'], gatedOffChannels: ['C2'] }
      expect(arbitrate(a, msg({ channel: 'C2', text: 'anything' }), empty())).toBeNull()
    })
  })
})

describe('BotArbitrationRouter — table + live affinity', () => {
  it('records live affinity so a follow-up continues to the same agent', () => {
    const r = new BotArbitrationRouter()
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
    const r = new BotArbitrationRouter()
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
    const r = new BotArbitrationRouter()
    r.upsert(assignment())
    r.remove('bot-1')
    expect(r.get('bot-1')).toBeUndefined()
    expect(r.route('bot-1', msg({}))).toBeNull()
  })

  it('resolves status actions only for the exact current agent + integration', () => {
    const r = new BotArbitrationRouter()
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
    const r = new BotArbitrationRouter()
    r.upsert(ambiguous)
    expect(r.targetForAgent('bot-1', ALICE, 'iA')).toBeUndefined()

    const stale = assignment()
    stale.members = stale.members.filter((member) => member.daemonId !== D1)
    r.upsert(stale)
    expect(r.targetForAgent('bot-1', ALICE, 'iA')).toBeUndefined()
  })
})

describe('toBotAssignment (§6.7 open secrets reader)', () => {
  const base = {
    botId: '00000000-0000-0000-0000-0000000000b1',
    platform: 'slack',
    members: [],
    agents: [],
    routes: [],
    gatedAgentIds: [],
    mutedChannels: [],
    gatedOffChannels: [],
    noticedDmConversations: []
  }

  it('maps the typed shapes and PRESERVES extra credential keys for the platform module', () => {
    // catchall on the typed variants: a bag satisfying the Slack prefix may still
    // carry fields a newer platform module needs; the mapper keeps the typed pair
    // and the assignment handler forwards the full wire frame when S3 lands.
    const a = toBotAssignment({
      ...base,
      secrets: { botToken: 'xoxb-x', signingSecret: 'sig' }
    } as never)
    expect(a?.secrets).toEqual({ botToken: 'xoxb-x', signingSecret: 'sig' })
    const f = toBotAssignment({
      ...base,
      platform: 'feishu',
      secrets: { verificationToken: 'v', encryptKey: 'k' }
    } as never)
    expect(f?.secrets).toEqual({ verificationToken: 'v', encryptKey: 'k' })
  })

  it('refuses (null) a secret bag no shape matches — log-and-skip, never a throw', () => {
    // No botToken, no verificationToken, no signingSecret: nothing here is a credential the
    // relay knows how to verify with, so the bot is skipped rather than half-installed.
    expect(toBotAssignment({ ...base, secrets: { apiKey: 'k-1' } } as never)).toBeNull()
    expect(toBotAssignment({ ...base, secrets: {} } as never)).toBeNull()
  })

  it('refuses a HALF-FILLED Slack bag rather than promoting it to the signing-secret shape', () => {
    // A present-but-unusable botToken means the projector meant the Slack pair and lost half of
    // it. Falling through to the third shape would install an ingest that can never post.
    expect(toBotAssignment({ ...base, secrets: { botToken: 'xoxb-only' } } as never)).toBeNull()
    expect(toBotAssignment({ ...base, secrets: { botToken: null, signingSecret: 'sig' } } as never)).toBeNull()
  })

  it('maps the signing-secret-ONLY shape, carrying the generic ingress slots the plugin reads', () => {
    // A relay-verified platform whose every write lives on the daemon hands the relay no provider
    // token — only the webhook signing secret, plus the identity core indexes and fences on.
    const a = toBotAssignment({
      ...base,
      platform: 'linear',
      secrets: { signingSecret: 'sig' },
      ingress: { apiAppId: 'client-1', teamId: 'org-1', botUserId: 'app-user-1' }
    } as never)
    expect(a?.secrets).toEqual({ signingSecret: 'sig' })
    expect(a).toMatchObject({ apiAppId: 'client-1', teamId: 'org-1', botUserId: 'app-user-1' })
  })

  it('refuses a signingSecret that is not a string — never a demux key the mapper guessed', () => {
    expect(toBotAssignment({ ...base, secrets: { signingSecret: 42 } } as never)).toBeNull()
    expect(toBotAssignment({ ...base, secrets: { signingSecret: null } } as never)).toBeNull()
  })

  // §6.7: the opaque ingress bag is the ONE carrier of the demux identity. The
  // legacy named top-level twins left the wire schema with the S3 cleanup —
  // there is no fallback to pin any more, only the bag read and its fail-safe
  // omissions. Wrong apiAppId/teamId misroutes inbound webhook demux.
  const secrets = { botToken: 'xoxb-x', signingSecret: 'sig' }

  it('reads demux identity from the ingress bag', () => {
    const a = toBotAssignment({
      ...base,
      secrets,
      ingress: { apiAppId: 'A9', teamId: 'T9', botUserId: 'U9' }
    } as never)
    expect(a).toMatchObject({ apiAppId: 'A9', teamId: 'T9', botUserId: 'U9' })
  })

  it('reads the workspace tenant fence from the ingress bag (ingress-tenant-fence.md §3)', () => {
    // A quick-install bot: no teamId (not a distributed install), but the
    // workspace it belongs to rides the bag so the ladder can fence the
    // signature scan and the learned app-only path.
    const a = toBotAssignment({
      ...base,
      secrets,
      ingress: { apiAppId: 'A9', workspaceId: 'T9' }
    } as never)
    expect(a).toMatchObject({ apiAppId: 'A9', workspaceId: 'T9' })
    expect(a && 'teamId' in a).toBe(false)
  })

  it('IGNORES the retired named top-level fields (deleted from the schema; stripped on decode)', () => {
    // A frame hand-built with the pre-#556 named fields and no bag yields NO
    // demux identity: the bot serves through the bounded verify-scan, exactly
    // like a manual-paste install. Nothing deployed emits this shape.
    const a = toBotAssignment({
      ...base,
      secrets,
      apiAppId: 'A1',
      teamId: 'T1',
      botUserId: 'U1'
    } as never)
    expect(a && 'apiAppId' in a).toBe(false)
    expect(a && 'teamId' in a).toBe(false)
    expect(a && 'botUserId' in a).toBe(false)
  })

  it('reads a non-string bag value per key as ABSENT — never poisoned, never guessed', () => {
    // The bag is z.unknown() on the wire — a malformed value must not become a
    // demux key that misroutes inbound deliveries.
    const a = toBotAssignment({
      ...base,
      secrets,
      ingress: { apiAppId: 42, teamId: null, botUserId: 'U-bag' }
    } as never)
    expect(a).toMatchObject({ botUserId: 'U-bag' })
    expect(a && 'apiAppId' in a).toBe(false)
    expect(a && 'teamId' in a).toBe(false)
  })

  it('omits absent identity fields rather than inventing them', () => {
    const a = toBotAssignment({ ...base, secrets } as never)
    expect(a && 'apiAppId' in a).toBe(false)
    expect(a && 'teamId' in a).toBe(false)
    expect(a && 'botUserId' in a).toBe(false)
  })
})
