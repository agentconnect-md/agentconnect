import { describe, it, expect, beforeEach } from 'vitest'
import { SharedBotOrchestrator } from './sharedBot.js'
import { RelayRegistry, type RelayChannel } from '../ws/relay-registry.js'
import type { RcBotAssign, RelayCpFrameType } from '@agentconnect.md/protocol'
import { AgentId, BotId, IntegrationId, OrgId } from '../domain/ids.js'
import type {
  BotRepo,
  BotRecord,
  BotSecretStore,
  IntegrationRepo,
  IntegrationRecord,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  AgentRepo,
  AgentRecord,
  ThreadAffinityStore,
  SessionRepo
} from '../persistence/ports.js'

// ── ids ──────────────────────────────────────────────────────────────────────
const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('22222222-2222-4222-8222-222222222222')
const RELAY = '55555555-5555-4555-8555-555555555555'
const D1 = '33333333-3333-4333-8333-333333333331'
const D2 = '33333333-3333-4333-8333-333333333332'
const ALICE = AgentId('44444444-4444-4444-8444-444444444441')
const BOB = AgentId('44444444-4444-4444-8444-444444444442')
const INT_A = IntegrationId('66666666-6666-4666-8666-666666666661')
const INT_B = IntegrationId('66666666-6666-4666-8666-666666666662')

// ── a recording relay channel + a control-sender spy ──────────────────────────
class FakeChannel implements RelayChannel {
  sends: { type: RelayCpFrameType; payload: unknown }[] = []
  constructor(readonly relayId: string) {}
  send(type: RelayCpFrameType, payload: unknown): void {
    this.sends.push({ type, payload })
  }
  close(): void {}
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BOT,
    orgId: ORG,
    platform: 'slack',
    name: 'support-bot',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    shareable: true,
    transport: 'http',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [ALICE, BOB],
    inUseByAgentId: null,
    createdAt: new Date(0),
    ...over
  }
}

function integration(id: IntegrationId, agentId: AgentId): IntegrationRecord {
  return {
    id,
    orgId: ORG,
    agentId,
    botId: BOT,
    platform: 'slack',
    name: 'support-bot',
    status: 'active',
    createdAt: new Date(0)
  }
}

function agent(id: AgentId, name: string, daemonId: string | null): AgentRecord {
  // Only the fields the orchestrator reads.
  return { id, name, daemonId } as unknown as AgentRecord
}

function channel(over: Partial<IntegrationChannelRecord>): IntegrationChannelRecord {
  return {
    integrationId: INT_B,
    channelId: 'C1',
    name: '#deploys',
    isPrivate: false,
    trigger: 'mention',
    agentId: null,
    ...over
  }
}

describe('SharedBotOrchestrator — attributed route compilation (§10)', () => {
  let relayReg: RelayRegistry
  let ch: FakeChannel
  let botRow: BotRecord
  let integrations: IntegrationRecord[]
  let channels: IntegrationChannelRecord[]
  let upserts: { daemonId: string; spec: { platform: string; slack?: { mode?: string } } }[]
  // Drives the SessionRepo.findThreadOwner fallback in lookupThread (null = no daemon session).
  let threadOwner: { agentId: string; daemonId: string } | null

  function makeOrch(): SharedBotOrchestrator {
    const agents: Record<string, AgentRecord> = {
      [ALICE]: agent(ALICE, 'alice', D1),
      [BOB]: agent(BOB, 'bob', D2)
    }
    const bots: Pick<BotRepo, 'get' | 'listHttpActive'> = {
      get: async () => botRow,
      listHttpActive: async () => [botRow]
    }
    const botSecret: Pick<BotSecretStore, 'get'> = {
      get: async () => ({ botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' })
    }
    const threads: ThreadAffinityStore = {
      upsert: async () => {},
      get: async () => null,
      listForBot: async () => []
    }
    const intRepo: Pick<IntegrationRepo, 'listForBot'> = { listForBot: async () => integrations }
    const chRepo: Pick<IntegrationChannelRepo, 'listForBot' | 'replaceSnapshot' | 'setAgent' | 'upsertAgent'> = {
      listForBot: async () => channels,
      replaceSnapshot: async (integrationId, reported) => {
        channels = channels.filter(
          (row) => row.integrationId !== integrationId || reported.some((candidate) => candidate.id === row.channelId)
        )
        for (const candidate of reported) {
          let row = channels.find((item) => item.integrationId === integrationId && item.channelId === candidate.id)
          if (!row) {
            row = channel({ integrationId, channelId: candidate.id })
            channels.push(row)
          }
          row.name = candidate.name ?? null
          row.isPrivate = candidate.isPrivate ?? false
        }
      },
      setAgent: async (integrationId, channelId, agentId) => {
        const row = channels.find((c) => c.integrationId === integrationId && c.channelId === channelId)
        if (!row) return null
        row.agentId = agentId
        return row
      },
      upsertAgent: async (integrationId, channelId, agentId) => {
        let row = channels.find((c) => c.integrationId === integrationId && c.channelId === channelId)
        if (!row) {
          row = channel({ integrationId, channelId, agentId })
          channels.push(row)
        } else row.agentId = agentId
        return row
      }
    }
    const agentRepo: Pick<AgentRepo, 'get'> = { get: async (id) => agents[id] ?? null }
    const control = {
      integrationUpsert: async (daemonId: string, spec: unknown) => void upserts.push({ daemonId, spec: spec as never })
    }
    const sessions: Pick<SessionRepo, 'findThreadOwner'> = {
      findThreadOwner: async () => threadOwner
    }
    return new SharedBotOrchestrator(
      bots as BotRepo,
      botSecret as BotSecretStore,
      intRepo as IntegrationRepo,
      chRepo as IntegrationChannelRepo,
      agentRepo as AgentRepo,
      relayReg,
      control as never,
      threads,
      sessions as SessionRepo,
      { info() {}, warn() {}, debug() {} }
    )
  }

  beforeEach(() => {
    relayReg = new RelayRegistry()
    ch = new FakeChannel(RELAY)
    relayReg.add(ch)
    botRow = bot()
    integrations = [integration(INT_A, ALICE), integration(INT_B, BOB)]
    channels = [channel({ integrationId: INT_B, channelId: 'C1', agentId: BOB, trigger: 'mention' })]
    upserts = []
    threadOwner = null
  })

  describe('lookupThread — SessionMeta fallback on affinity miss (§7.2 case 2a)', () => {
    const SK = 'C1/1784297789.871789' // sessionKeyOf({channel:'C1', thread:'1784297789.871789'})

    // The fake ThreadAffinityStore.get always returns null, so every lookup here exercises the
    // fallback: a daemon-created thread (an agent's own channel-root post) that never went through
    // the relay's REPORT leg is still resolved from the daemon-reported SessionMeta.
    it('falls back to the daemon-reported SessionMeta owner (channel/thread parsed from sessionKey)', async () => {
      const orch = makeOrch()
      threadOwner = { agentId: ALICE, daemonId: D1 }
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res).toEqual({ botId: BOT, sessionKey: SK, target: { agentId: ALICE, daemonId: D1 } })
    })

    it('returns null when neither affinity nor a SessionMeta owner exists', async () => {
      const orch = makeOrch()
      threadOwner = null
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res.target).toBeNull()
    })
  })

  it('assigns the bot to a relay and compiles channel-owner + keyword routes + default', async () => {
    await makeOrch().syncBot(BOT)

    const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign).toBeTruthy() // broadcast to the connected relay pool

    // members: one entry per daemon, agents grouped.
    const members = Object.fromEntries(assign.members.map((m) => [m.daemonId, m.agentIds.sort()]))
    expect(members[D1]).toEqual([ALICE])
    expect(members[D2]).toEqual([BOB])

    // channel ownership rule comes FIRST (so it wins arbitration), scoped + mention.
    expect(assign.routes[0]).toMatchObject({
      agentId: BOB,
      daemonId: D2,
      scope: { channel: 'C1' },
      match: { kind: 'mention' }
    })
    // one keyword rule per agent = its slug.
    const keywords = assign.routes
      .filter((r) => r.match.kind === 'keyword')
      .map((r) => (r.match as { value: string }).value)
      .sort()
    expect(keywords).toEqual(['alice', 'bob'])
    // NO unscoped mention rule (would starve keyword disambiguation, §10.4).
    expect(assign.routes.some((r) => r.match.kind === 'mention' && !r.scope)).toBe(false)
    // default agent = earliest install (alice), delivered out-of-band, not as a route.
    expect(assign.defaultAgentId).toBe(ALICE)
    expect(assign.defaultDaemonId).toBe(D1)

    // send-only spec pushed to BOTH member daemons.
    expect(upserts.map((u) => u.daemonId).sort()).toEqual([D1, D2].sort())
    for (const u of upserts) expect(u.spec.slack?.mode).toBe('shared')
    // signing secret rides to the relay (to HMAC-verify inbound Events API POSTs), NOT the daemons.
    expect(assign.secrets.signingSecret).toBe('shh-x')
    // member directory (id→name) for the config modal's selector.
    expect(Object.fromEntries(assign.agents.map((a) => [a.agentId, a.name]))).toEqual({
      [ALICE]: 'alice',
      [BOB]: 'bob'
    })
  })

  it('a channel with trigger "any" compiles an auto rule for its owner', async () => {
    channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'any' })]
    await makeOrch().syncBot(BOT)
    const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
    expect(assign.routes[0]).toMatchObject({ agentId: ALICE, scope: { channel: 'C9' }, match: { kind: 'auto' } })
  })

  it('releases the bot (rc/bot-unassign) when transport is socket (no relay ingress)', async () => {
    botRow = bot({ transport: 'socket' })
    await makeOrch().syncBot(BOT)
    expect(ch.sends.some((s) => s.type === 'rc/bot-unassign')).toBe(true)
  })

  it('setChannelAgent makes the pick the sole owner of the channel + pushes rc/routes', async () => {
    botRow = bot()
    // Start with C7 owned by alice (on alice's install); no row on bob's install.
    channels = [channel({ integrationId: INT_A, channelId: 'C7', agentId: ALICE, trigger: 'mention' })]
    const orch = makeOrch()
    // Operator picks BOB as C7's default in the modal.
    await orch.setChannelAgent(BOT, 'C7', BOB)

    // alice's row for C7 is cleared; bob's install now owns C7.
    const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'C7')
    const bobRow = channels.find((c) => c.integrationId === INT_B && c.channelId === 'C7')
    expect(aliceRow?.agentId).toBeNull()
    expect(bobRow?.agentId).toBe(BOB)

    // and the relay got a hot rc/routes with C7 scoped to bob.
    const routes = ch.sends.filter((s) => s.type === 'rc/routes')
    expect(routes.length).toBeGreaterThan(0)
    const last = routes[routes.length - 1]!.payload as { routes: { agentId: string; scope?: { channel?: string } }[] }
    expect(last.routes.some((r) => r.scope?.channel === 'C7' && r.agentId === BOB)).toBe(true)
  })

  it('fans an HTTP Slack channel snapshot across every install and preserves channel ownership', async () => {
    channels = [
      channel({ integrationId: INT_A, channelId: 'C-old', name: 'old', agentId: null }),
      channel({ integrationId: INT_B, channelId: 'C1', name: null, agentId: BOB })
    ]
    const orch = makeOrch()

    await orch.replaceChannels(BOT, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'ops', isPrivate: true }
    ])

    expect(channels).toHaveLength(4)
    expect(channels.some((row) => row.channelId === 'C-old')).toBe(false)
    for (const integrationId of [INT_A, INT_B]) {
      expect(channels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ integrationId, channelId: 'C1', name: 'deploys', isPrivate: false }),
          expect.objectContaining({ integrationId, channelId: 'C2', name: 'ops', isPrivate: true })
        ])
      )
    }
    expect(channels.find((row) => row.integrationId === INT_B && row.channelId === 'C1')?.agentId).toBe(BOB)
    // C2 was newly invited → seeded to alice (the creating/earliest install) as its
    // default owner, on alice's row only; bob's row for C2 stays un-owned.
    expect(channels.find((row) => row.integrationId === INT_A && row.channelId === 'C2')?.agentId).toBe(ALICE)
    expect(channels.find((row) => row.integrationId === INT_B && row.channelId === 'C2')?.agentId).toBeNull()
    expect(ch.sends.some((send) => send.type === 'rc/routes')).toBe(true)
  })

  it('seeds a newly-invited channel with the creating (earliest) agent as its default owner', async () => {
    channels = [channel({ integrationId: INT_B, channelId: 'C1', agentId: BOB, trigger: 'mention' })]
    await makeOrch().replaceChannels(BOT, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'ops' }
    ])
    // C2 (brand new) → owned by alice, the bot's creating agent; one owner per channel.
    expect(channels.find((c) => c.integrationId === INT_A && c.channelId === 'C2')?.agentId).toBe(ALICE)
    expect(channels.find((c) => c.integrationId === INT_B && c.channelId === 'C2')?.agentId).toBeNull()
    // C1 (already known, owned by bob) is left untouched.
    expect(channels.find((c) => c.integrationId === INT_B && c.channelId === 'C1')?.agentId).toBe(BOB)
  })

  it('does not re-seed a known channel the operator cleared to "No default"', async () => {
    // C1 exists on both installs, un-owned (operator cleared it). A re-reported snapshot
    // must NOT re-seed it — only genuinely new channels get the creating-agent default.
    channels = [
      channel({ integrationId: INT_A, channelId: 'C1', agentId: null }),
      channel({ integrationId: INT_B, channelId: 'C1', agentId: null })
    ]
    await makeOrch().replaceChannels(BOT, [{ id: 'C1', name: 'deploys' }])
    expect(channels.find((c) => c.integrationId === INT_A && c.channelId === 'C1')?.agentId).toBeNull()
    expect(channels.find((c) => c.integrationId === INT_B && c.channelId === 'C1')?.agentId).toBeNull()
  })

  it('defers placement when no relay is connected', async () => {
    relayReg = new RelayRegistry() // none connected
    botRow = bot()
    const orch = makeOrch()
    await orch.syncBot(BOT)
    expect(orch.hasConnectedRelay()).toBe(false)
    expect(ch.sends).toEqual([]) // nothing broadcast
  })
})
