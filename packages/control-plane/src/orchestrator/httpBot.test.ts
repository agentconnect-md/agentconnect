import { describe, it, expect, beforeEach } from 'vitest'
import { HttpBotOrchestrator } from './httpBot.js'
import { AgentDelivery } from './agentDelivery.js'
import type { PlacementResolver } from './placementResolver.js'
import type { GatedDmSeedResolver } from './linkedDm.js'
import { RelayRegistry, type RelayChannel } from '../ws/relay-registry.js'
import type { RcBotAssign, RelayCpFrameType } from '@agentconnect.md/protocol'
import { AgentId, BotId, DaemonId, IntegrationId, OrgId } from '../domain/ids.js'
import type {
  BotRepo,
  BotRecord,
  BotSecretMaterial,
  BotSecretStore,
  BotCredentialWriter,
  IntegrationRepo,
  IntegrationRecord,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  AgentRepo,
  AgentRecord,
  ThreadAffinityStore,
  SessionRepo
} from '../persistence/ports.js'
import type { CpPlatformProvider } from '../platforms/provider.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import { createTelegramCpProvider } from '../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../platforms/discord/provider.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'

// §9: both `rc/bot-assign` bags and every send-only spec payload come from the
// platform provider. Offline stubs — the projectors reach no provider API.
const PLATFORMS = buildCpPlatformRegistry([
  createSlackCpProvider({}),
  createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
  createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
  createFeishuCpProvider({})
])

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
    teamId: null,
    botUserId: null,
    revokedAt: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
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
  } as BotRecord
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
    kind: 'channel',
    trigger: 'mention',
    dmUserId: null,
    triggerChosen: false,
    agentId: null,
    ...over
  } as IntegrationChannelRecord
}

describe('HttpBotOrchestrator — attributed route compilation (§10)', () => {
  let relayReg: RelayRegistry
  let ch: FakeChannel
  let botRow: BotRecord
  let integrations: IntegrationRecord[]
  let channels: IntegrationChannelRecord[]
  let upserts: {
    daemonId: string
    spec: { platform: string; core?: { mode?: string }; config?: unknown }
  }[]
  let secretMaterial: BotSecretMaterial
  // Drives the SessionRepo.findThreadOwner fallback in lookupThread (null = no daemon session).
  // The AGENT alone: which member serves it is resolved live, so a pool agent resolves too.
  let threadOwner: { agentId: string } | null
  let threadOwnerLookup: { botId: BotId; channel: string; thread: string } | null
  // §14: agents whose AgentRepo.get returns visibility 'restricted' (⇒ gated).
  let gatedAgents: Set<string>
  // Agents reported with no daemonId — not placed, so they compile no routes.
  let unplacedAgents: Set<string>
  // Drives ThreadAffinityStore.get (null = affinity miss → SessionMeta fallback).
  let threadBinding: { agentId: AgentId; daemonId: DaemonId } | null
  let threadParticipants: Awaited<ReturnType<ThreadAffinityStore['participantsForBot']>>
  // revokeBot recordings: the Bot revocation stamp + integration/remove pushes.
  let botRevokedAt: Date | null
  let removals: { daemonId: string; integrationId: string }[]
  // One-shot barrier for deterministic channel-mutation concurrency tests.
  let blockNextChannelList: (() => Promise<void>) | null
  // When set, `bots.get` reports a BUMPED generation from its second call on —
  // a re-install landing between revokeBot's commit and its external effects.
  let bumpRevisionAfterFirstGet: boolean
  // Operator-facing diagnostics the orchestrator emitted — the completeness
  // gate's message and its bindings ARE the contract for an operator debugging
  // "why is my bot not receiving anything".
  let warns: { bindings: Record<string, unknown>; message: string }[]

  /** `placement` stands in for the duty ledger: absent ⇒ placement alone, which is what every
   *  expectation predating the pool was written against. */
  function makeOrch(
    platforms = PLATFORMS,
    placement?: Pick<PlacementResolver, 'routableDaemon'>,
    gatedDmSeeds?: GatedDmSeedResolver
  ): HttpBotOrchestrator {
    const agents: Record<string, AgentRecord> = {
      [ALICE]: agent(ALICE, 'alice', unplacedAgents.has(ALICE) ? null : D1),
      [BOB]: agent(BOB, 'bob', unplacedAgents.has(BOB) ? null : D2)
    }
    let getCalls = 0
    const bots: Pick<BotRepo, 'getUnscoped' | 'listHttpActive' | 'revokeIfCurrent'> = {
      getUnscoped: async () => {
        getCalls += 1
        if (bumpRevisionAfterFirstGet && getCalls > 1) {
          return { ...botRow, credentialRevision: botRow.credentialRevision + 1 }
        }
        return botRow
      },
      listHttpActive: async () => [botRow],
      // Mirrors the SQL CAS: both arms conjunctive, each skipped when the report
      // didn't carry it, and `credentialInstalledAt: null` passes the time arm.
      revokeIfCurrent: async (_id, at, fence) => {
        if (fence.revision !== undefined && fence.revision !== botRow.credentialRevision) return false
        if (fence.eventAt && botRow.credentialInstalledAt && botRow.credentialInstalledAt >= fence.eventAt) return false
        botRevokedAt = at
        return true
      }
    }
    const botSecret: Pick<BotSecretStore, 'get'> = {
      get: async () => secretMaterial
    }
    const threads: ThreadAffinityStore = {
      upsert: async () => {},
      get: async () => threadBinding,
      listForBot: async () => [],
      upsertParticipant: async (_botId, sessionKey, agentId, daemonId) => {
        const current = threadParticipants.find((p) => p.sessionKey === sessionKey && p.agentId === agentId)
        if (current) current.daemonId = daemonId
        else threadParticipants.push({ sessionKey, agentId, daemonId })
      },
      participants: async (_botId, sessionKey) =>
        threadParticipants
          .filter((participant) => participant.sessionKey === sessionKey)
          .map(({ agentId, daemonId }) => ({ agentId, daemonId })),
      participantsForBot: async () => threadParticipants
    }
    const intRepo: Pick<IntegrationRepo, 'listForBot' | 'markRevokedForBot'> = {
      listForBot: async () => integrations.filter((i) => i.status === 'active'),
      markRevokedForBot: async () => {
        const flipped = integrations.filter((i) => i.status === 'active')
        for (const i of flipped) i.status = 'revoked'
        return flipped.map((i) => i.id)
      }
    }
    const chRepo: Pick<
      IntegrationChannelRepo,
      'listForBot' | 'replaceSnapshot' | 'setAgent' | 'setTrigger' | 'upsertAgent' | 'upsertConversation'
    > = {
      listForBot: async () => {
        const block = blockNextChannelList
        blockNextChannelList = null
        if (block) await block()
        return channels
      },
      replaceSnapshot: async (integrationId, reported, opts) => {
        channels = channels.filter(
          (row) => row.integrationId !== integrationId || reported.some((candidate) => candidate.id === row.channelId)
        )
        for (const candidate of reported) {
          let row = channels.find((item) => item.integrationId === integrationId && item.channelId === candidate.id)
          if (!row) {
            row = channel({ integrationId, channelId: candidate.id, trigger: opts?.defaultTrigger ?? 'mention' })
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
      setTrigger: async (integrationId, channelId, trigger) => {
        const row = channels.find((c) => c.integrationId === integrationId && c.channelId === channelId)
        if (!row) return null
        row.trigger = trigger
        return row
      },
      upsertConversation: async (integrationId, conversation, opts) => {
        let row = channels.find((c) => c.integrationId === integrationId && c.channelId === conversation.id)
        if (!row) {
          row = channel({
            integrationId,
            channelId: conversation.id,
            name: conversation.name ?? null,
            kind: conversation.kind ?? 'channel',
            dmUserId: conversation.dmUserId ?? null,
            trigger: opts?.defaultTrigger ?? 'mention'
          })
          channels.push(row)
        } else {
          if (conversation.name) row.name = conversation.name
          if (conversation.dmUserId) row.dmUserId = conversation.dmUserId
        }
        return row
      },
      upsertAgent: async (integrationId, channelId, agentId, opts) => {
        let row = channels.find((c) => c.integrationId === integrationId && c.channelId === channelId)
        if (!row) {
          row = channel({ integrationId, channelId, agentId, trigger: opts?.defaultTrigger ?? 'mention' })
          channels.push(row)
        } else row.agentId = agentId
        return row
      }
    }
    const agentRepo: Pick<AgentRepo, 'getUnscoped'> = {
      getUnscoped: async (id) => {
        const a = agents[id]
        if (!a) return null
        return { ...a, visibility: gatedAgents.has(id) ? 'restricted' : 'org' } as AgentRecord
      }
    }
    const control = {
      integrationUpsert: async (daemonId: string, spec: unknown) =>
        void upserts.push({ daemonId, spec: spec as never }),
      integrationRemove: async (daemonId: string, r: { integrationId: string }) =>
        void removals.push({ daemonId, integrationId: r.integrationId })
    }
    const sessions: Pick<SessionRepo, 'findThreadOwner'> = {
      findThreadOwner: async (botId, channel, thread) => {
        threadOwnerLookup = { botId, channel, thread }
        return threadOwner
      }
    }
    // The credential writer is the transaction owner in prod; here it stands in
    // for that one atomic step — CAS, then (only if it applied) the integration
    // flip, which is exactly what the real transaction commits together.
    const botCredential: BotCredentialWriter = {
      install: async () => {
        botRow = { ...botRow, credentialRevision: botRow.credentialRevision + 1 }
        return botRow.credentialRevision
      },
      revoke: async (id, at, fence) => {
        const applied = await bots.revokeIfCurrent!(id, at, fence)
        if (!applied) return { applied: false, integrationIds: [] }
        return {
          applied: true,
          integrationIds: await intRepo.markRevokedForBot!(id, botRow.credentialRevision)
        }
      }
    }
    return new HttpBotOrchestrator(
      bots as BotRepo,
      botSecret as BotSecretStore,
      botCredential,
      intRepo as IntegrationRepo,
      chRepo as IntegrationChannelRepo,
      agentRepo as AgentRepo,
      relayReg,
      control as never,
      threads,
      sessions as SessionRepo,
      {
        info() {},
        warn(bindings: Record<string, unknown>, message: string) {
          warns.push({ bindings, message })
        },
        debug() {}
      },
      platforms,
      // No duty ledger wired ⇒ the delivery set is the placement alone, which is
      // exactly what every expectation in this file was written against.
      new AgentDelivery({ control: control as never, specs: undefined as never }),
      placement ?? undefined,
      gatedDmSeeds
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
    secretMaterial = { botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 'shh-x' }
    threadOwner = null
    threadOwnerLookup = null
    gatedAgents = new Set()
    unplacedAgents = new Set()
    threadBinding = null
    threadParticipants = []
    blockNextChannelList = null
    bumpRevisionAfterFirstGet = false
    botRevokedAt = null
    removals = []
    warns = []
  })

  describe('lookupThread — SessionMeta fallback on affinity miss (§7.2 case 2a)', () => {
    const SK = 'C1/1784297789.871789' // sessionKeyOf({channel:'C1', thread:'1784297789.871789'})

    // The fake ThreadAffinityStore.get always returns null, so every lookup here exercises the
    // fallback: a daemon-created thread (an agent's own channel-root post) that never went through
    // the relay's REPORT leg is still resolved from the daemon-reported SessionMeta.
    it('falls back to the daemon-reported SessionMeta owner (channel/thread parsed from sessionKey)', async () => {
      const orch = makeOrch()
      threadOwner = { agentId: ALICE }
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res).toEqual({
        botId: BOT,
        sessionKey: SK,
        target: { agentId: ALICE, daemonId: D1 },
        participants: [{ agentId: ALICE, daemonId: D1 }]
      })
      expect(threadOwnerLookup).toEqual({ botId: BOT, channel: 'C1', thread: '1784297789.871789' })
    })

    it('resolves a POOL owner through the placement resolver, which the agent row cannot name', async () => {
      // The blind spot: the lookup used to require a non-null `agent.daemonId`, so a pool agent —
      // placed on a set, naming no machine — never resolved and its own thread's un-mentioned
      // follow-ups were dropped.
      unplacedAgents = new Set([ALICE])
      const orch = makeOrch(PLATFORMS, {
        routableDaemon: async (a) => (a.id === ALICE ? DaemonId(D1) : null)
      })
      threadOwner = { agentId: ALICE }
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res.target).toEqual({ agentId: ALICE, daemonId: D1 })
    })

    it('still names nobody while no member is routable for the owning agent', async () => {
      // Fail closed, not stale: between a lapsed lease and the next grant the honest answer is
      // "no target", which the relay retries — never a member that has stopped serving it.
      unplacedAgents = new Set([ALICE])
      const orch = makeOrch(PLATFORMS, { routableDaemon: async () => null })
      threadOwner = { agentId: ALICE }
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res.target).toBeNull()
    })

    it('returns null when neither affinity nor a SessionMeta owner exists', async () => {
      const orch = makeOrch()
      threadOwner = null
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res.target).toBeNull()
    })

    it('persists and broadcasts participant joins independently of the compatibility owner', async () => {
      const orch = makeOrch()
      await orch.recordThreadParticipant({ botId: BOT, sessionKey: SK, agentId: BOB, daemonId: D2 })

      expect(ch.sends.at(-1)).toEqual({
        type: 'rc/participant-assign',
        payload: { botId: BOT, sessionKey: SK, agentId: BOB, daemonId: D2 }
      })
      threadOwner = null
      const res = await orch.lookupThread({ botId: BOT, sessionKey: SK })
      expect(res).toEqual({
        botId: BOT,
        sessionKey: SK,
        target: null,
        participants: [{ agentId: BOB, daemonId: D2 }]
      })
    })
  })

  /**
   * §9 `secretShape.httpAssignRequires` — the completeness gate core runs before
   * asking a provider to project the assign bags. It used to be two hand-written
   * arms in this file (`bot.platform === 'slack' && !secret.signingSecret`,
   * `bot.platform === 'feishu' && (!secret.verificationToken || !secret.appToken)`);
   * the slots are now READ OFF the platform that owns them, so a fifth platform's
   * requirement arrives with its provider and no core edit.
   */
  describe('incomplete callback credentials (§9 secretShape.httpAssignRequires)', () => {
    const cases: {
      platform: BotRecord['platform']
      secret: BotSecretMaterial
      missing: string[]
    }[] = [
      // Slack ⇒ signingSecret: an http-mode bot the relay cannot HMAC-verify.
      {
        platform: 'slack',
        secret: { botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: null },
        missing: ['signingSecret']
      },
      // Feishu ⇒ verificationToken + appToken (the app id lives in the appToken
      // slot — the two-slot overloading), reported one at a time…
      {
        platform: 'feishu',
        secret: { botToken: 'secret', appToken: 'cli_x', signingSecret: null, verificationToken: null },
        missing: ['verificationToken']
      },
      {
        platform: 'feishu',
        secret: { botToken: 'secret', appToken: null, signingSecret: null, verificationToken: 'vt' },
        missing: ['appToken']
      },
      // …and both together, which the old Feishu arm could not say.
      {
        platform: 'feishu',
        secret: { botToken: 'secret', appToken: null, signingSecret: null, verificationToken: null },
        missing: ['verificationToken', 'appToken']
      }
    ]

    for (const { platform, secret, missing } of cases) {
      it(`syncBot refuses a ${platform} bot missing ${missing.join(' + ')} and says which slots`, async () => {
        botRow = bot({ platform })
        for (const int of integrations) int.platform = platform
        secretMaterial = secret

        await expect(makeOrch().syncBot(BOT)).resolves.toBeUndefined()

        // Nothing armed: no ingress the relay could not verify, and no send-only
        // spec either (an unassigned bot has no inbound path).
        expect(ch.sends).toEqual([])
        expect(upserts).toEqual([])
        expect(warns).toEqual([
          {
            bindings: { botId: BOT, platform, missing },
            message: 'http-bot: incomplete callback credentials — cannot assign'
          }
        ])
      })

      it(`replayTo skips a ${platform} bot missing ${missing.join(' + ')} without failing the replay`, async () => {
        botRow = bot({ platform })
        for (const int of integrations) int.platform = platform
        secretMaterial = secret
        const fresh = new FakeChannel('66666666-6666-4666-8666-666666666667')

        await expect(makeOrch().replayTo(fresh)).resolves.toBeUndefined()

        // Silent by design (unchanged): the replay walks every http bot, and one
        // incomplete row must not turn the seed into a log storm.
        expect(fresh.sends).toEqual([])
        expect(warns).toEqual([])
      })
    }

    it('a platform declaring no required slots is never gated here', async () => {
      // Telegram/Discord declare `httpAssignRequires: []`. Their bots cannot take
      // the http transport at all (the create route refuses it on the missing
      // `projectBotAssign`), so the absent-projector fence — not this gate — is
      // what stops them, and it must still be what fires.
      botRow = bot({ platform: 'telegram' })
      for (const int of integrations) int.platform = 'telegram'
      secretMaterial = { botToken: 'tg', appToken: null, signingSecret: null }

      await expect(makeOrch().syncBot(BOT)).resolves.toBeUndefined()

      expect(ch.sends).toEqual([])
      expect(warns.map((w) => w.message)).toEqual(['http-bot: platform contributes no relay ingress — skipping'])
    })

    it('a complete Feishu credential assigns', async () => {
      botRow = bot({ platform: 'feishu' })
      for (const int of integrations) int.platform = 'feishu'
      secretMaterial = { botToken: 'secret', appToken: 'cli_x', signingSecret: null, verificationToken: 'vt' }

      await makeOrch().syncBot(BOT)

      expect(ch.sends.filter((send) => send.type === 'rc/bot-assign')).toHaveLength(1)
      expect(warns).toEqual([])
    })
  })

  // §9 erratum: `projectBotAssign` is OPTIONAL — a platform whose inbound
  // transport is a daemon-owned long-lived connection contributes no relay
  // projection, and its ABSENCE is the "no relay path" signal. Core must neither
  // fabricate an empty assign (the relay would arm an ingress it cannot verify)
  // nor throw; it takes the same outcome as the other "cannot assign" guards.
  describe('a platform with no projectBotAssign (§9 erratum)', () => {
    /** The slack provider with its relay projection removed — a platform that
     *  contributes a spec projector but no assign projector, like telegram and
     *  discord (whose bots the create route refuses `transport: 'http'` for, on
     *  exactly this signal, so this arm is unreachable in production). */
    const noRelayPath = (): ReturnType<typeof buildCpPlatformRegistry> => {
      const { projectBotAssign: _omitted, ...rest } = createSlackCpProvider({})
      return buildCpPlatformRegistry([rest as CpPlatformProvider])
    }

    it('broadcasts no rc/bot-assign and does not throw', async () => {
      await expect(makeOrch(noRelayPath()).syncBot(BOT)).resolves.toBeUndefined()
      expect(ch.sends.filter((s) => s.type === 'rc/bot-assign')).toEqual([])
      // Nothing was half-armed: no empty/partial frame of any kind went out.
      expect(ch.sends).toEqual([])
      // …and an unassignable bot gets no send-only spec either — it has no ingress.
      expect(upserts).toEqual([])
    })

    it('skips the bot on the register replay instead of failing the whole replay', async () => {
      const fresh = new FakeChannel('66666666-6666-4666-8666-666666666666')
      await expect(makeOrch(noRelayPath()).replayTo(fresh)).resolves.toBeUndefined()
      expect(fresh.sends).toEqual([])
    })

    it('still assigns once the platform DOES contribute a relay projection', async () => {
      await makeOrch().syncBot(BOT)
      expect(ch.sends.filter((s) => s.type === 'rc/bot-assign')).toHaveLength(1)
    })
  })

  it('assigns the bot to a relay and compiles channel-owner + keyword routes + default', async () => {
    await makeOrch().syncBot(BOT)

    const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign).toBeTruthy() // broadcast to the connected relay pool
    // §6.1: a bot assignment is always a chat platform; the kind teaches an older relay
    // to classify an id a newer CP introduces.
    expect(assign.originKind).toBe('chat')
    // §6.7: a manual-paste bot has no demux identity, so the opaque ingress bag ships empty
    // (keys omitted, never null) and the relay verify-scans instead.
    expect(assign.ingress).toEqual({})

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
    for (const u of upserts) expect(u.spec.core?.mode).toBe('shared')
    // signing secret rides to the relay (to HMAC-verify inbound Events API POSTs), NOT the daemons.
    if (!('signingSecret' in assign.secrets)) throw new Error('expected Slack credentials')
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

  it('carries the public Slack app id to each daemon for permission-update links', async () => {
    botRow = bot({ slackAppId: 'A123' })
    await makeOrch().syncBot(BOT)
    expect(upserts).toHaveLength(2)
    expect(upserts.every((upsert) => (upsert.spec.config as { appId?: string })?.appId === 'A123')).toBe(true)
  })

  it('keeps Feishu API credentials on the daemon and sends only callback credentials to the relay', async () => {
    botRow = bot({
      platform: 'feishu',
      name: 'lark-bot',
      shareable: false,
      botUserId: 'ou_bot',
      agentIds: [ALICE],
      inUseByAgentId: ALICE
    })
    integrations = [
      {
        ...integration(INT_A, ALICE),
        platform: 'feishu',
        name: 'lark-bot',
        feishuRegion: 'lark'
      }
    ]
    channels = []
    secretMaterial = {
      botToken: 'app-secret',
      appToken: 'cli_http_app',
      signingSecret: null,
      verificationToken: 'verify-token',
      encryptKey: 'encrypt-key'
    }

    await makeOrch().syncBot(BOT)

    const assign = ch.sends.find((send) => send.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign).toMatchObject({
      platform: 'feishu',
      ingress: { apiAppId: 'cli_http_app', botUserId: 'ou_bot' },
      secrets: { verificationToken: 'verify-token', encryptKey: 'encrypt-key' },
      defaultAgentId: ALICE,
      defaultDaemonId: D1,
      agents: [{ agentId: ALICE, daemonId: D1, integrationId: INT_A }]
    })
    expect('botToken' in assign.secrets).toBe(false)
    expect(upserts).toEqual([
      {
        daemonId: D1,
        spec: expect.objectContaining({
          platform: 'feishu',
          core: expect.objectContaining({ mode: 'shared' }),
          config: expect.objectContaining({
            appId: 'cli_http_app',
            appSecret: 'app-secret',
            botOpenId: 'ou_bot',
            region: 'lark'
          })
        })
      }
    ])
  })

  describe('conversation gating (resource-visibility §14)', () => {
    it("a GATED owner's 'off' channel compiles no route (fail-closed until an editor enables it)", async () => {
      gatedAgents = new Set([ALICE])
      channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'off' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'C9')).toEqual([])
    })

    it("a NON-gated owner's 'off' channel compiles no route and is muted for the whole bot", async () => {
      channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'off' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'C9')).toEqual([])
      // Dropping the route is not enough on an ungated bot: the keyword slug and
      // `defaultAgentId` rungs are unscoped, so Off must also be stated as a fence.
      expect(assign.mutedChannels).toEqual(['C9'])
    })

    it("mutes an Off channel whose owner isn't placed — the operator's choice outlives the placement", async () => {
      channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'off' })]
      unplacedAgents = new Set([ALICE])
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.mutedChannels).toEqual(['C9'])
    })

    it("mutes an enabled DM whose owner isn't placed before unscoped fallback", async () => {
      gatedAgents = new Set([ALICE])
      channels = [channel({ integrationId: INT_A, channelId: 'D42', kind: 'im', agentId: ALICE, trigger: 'any' })]
      unplacedAgents = new Set([ALICE])
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'D42')).toEqual([])
      expect(assign.mutedChannels).toContain('D42')
      expect(assign.gatedOffChannels).not.toContain('D42')
    })

    // The fence covers every Off channel: dropping the route is not enough, because
    // the keyword and defaultAgentId rungs are unscoped and would hand a bare @bot to
    // a mixed bot's public default in a channel the console shows as Off.
    it("mutes a GATED owner's Off channel too, and marks it as still owing a notice", async () => {
      gatedAgents = new Set([ALICE])
      channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'off' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'C9')).toEqual([])
      expect(assign.mutedChannels).toEqual(['C9'])
      expect(assign.gatedOffChannels).toEqual(['C9'])
    })

    it('separates the two kinds of Off on one mixed bot: both muted, only the gated one speaks', async () => {
      gatedAgents = new Set([ALICE])
      channels = [
        channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'off' }), // gate
        channel({ integrationId: INT_B, channelId: 'C8', agentId: BOB, trigger: 'off' }) // operator mute
      ]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect([...assign.mutedChannels].sort()).toEqual(['C8', 'C9'])
      expect(assign.gatedOffChannels).toEqual(['C9'])
    })

    it('leaves an active channel unmuted', async () => {
      channels = [channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'any' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.mutedChannels).toEqual([])
      expect(assign.routes.filter((r) => r.scope?.channel === 'C9')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    it('a gated member loses its keyword rung, never becomes the default, and rides gatedAgentIds', async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.some((r) => r.match.kind === 'keyword' && r.agentId === ALICE)).toBe(false)
      expect(assign.routes.some((r) => r.match.kind === 'keyword' && r.agentId === BOB)).toBe(true)
      // ALICE's install is the earliest, but a gated agent must not catch bare @bot/DMs.
      expect(assign.defaultAgentId).toBe(BOB)
      expect(assign.gatedAgentIds).toEqual([ALICE])
    })

    it('a group of only gated agents has NO default agent', async () => {
      gatedAgents = new Set([ALICE, BOB])
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.defaultAgentId).toBeUndefined()
      expect(assign.gatedAgentIds).toEqual([ALICE, BOB])
    })

    it("a gated install's send-only spec carries its scoped bindRules + gated for the daemon backstop", async () => {
      gatedAgents = new Set([ALICE])
      channels = [
        channel({ integrationId: INT_A, channelId: 'C9', agentId: ALICE, trigger: 'mention' }),
        channel({ integrationId: INT_A, channelId: 'C0', agentId: ALICE, trigger: 'off' })
      ]
      await makeOrch().syncBot(BOT)
      // §6.4 emission flip: the spec carries the envelope only — knobs ride `core`.
      const alice = upserts.find((u) => u.daemonId === D1)!.spec as never as {
        core: { gated: boolean; bindRules: unknown[] }
      }
      expect(alice.core.gated).toBe(true)
      expect(alice.core.bindRules).toEqual([{ channel: 'C9', match: { kind: 'mention' } }])
      const bob = upserts.find((u) => u.daemonId === D2)!.spec as never as {
        core: { gated: boolean; bindRules: unknown[] }
      }
      expect(bob.core.gated).toBe(false)
      expect(bob.core.bindRules).toEqual([])
    })

    it("replaceChannels makes a gated default owner's fresh channel Off on every membership row", async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      await makeOrch().replaceChannels(BOT, [{ id: 'C7', name: 'deploys' }])
      const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'C7')
      const bobRow = channels.find((c) => c.integrationId === INT_B && c.channelId === 'C7')
      expect(aliceRow?.trigger).toBe('off')
      expect(bobRow?.trigger).toBe('off')
    })

    it('reportConversation converges a DM to one owner and one trigger', async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      const orch = makeOrch()
      await orch.reportConversation(BOT, { id: 'D42', name: '@Alice' })
      const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'D42')
      const bobRow = channels.find((c) => c.integrationId === INT_B && c.channelId === 'D42')
      expect(aliceRow).toMatchObject({ kind: 'im', trigger: 'off', agentId: ALICE, name: '@Alice' })
      expect(bobRow).toMatchObject({ kind: 'im', trigger: 'off', agentId: null, name: '@Alice' })

      // Editor enables it; a re-report must keep the trigger (name refresh only).
      aliceRow!.trigger = 'any'
      await orch.reportConversation(BOT, { id: 'D42', name: '@Alice Smith' })
      expect(aliceRow).toMatchObject({ trigger: 'any', name: '@Alice Smith' })
      expect(bobRow).toMatchObject({ trigger: 'any', name: '@Alice Smith' })

      const assign = ch.sends.filter((s) => s.type === 'rc/routes').at(-1)!.payload as RcBotAssign
      expect(assign.routes.filter((route) => route.scope?.channel === 'D42')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    // §14.8: the shared-bot mirror of the direct path. The seed has to survive the
    // ownership convergence that immediately follows the report — that pass re-derives
    // a gated owner's trigger, and forcing Off there would undo the seed on the very
    // syncRoutes the report itself triggers.
    it('reportConversation opens a gated DM with a member of the agent’s own audience (§14.8)', async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      // Stands in for the real resolver, whose own policy is pinned in linkedDm.test.ts.
      const orch = makeOrch(PLATFORMS, undefined, async (reported) =>
        reported.some((c) => c.dmUserId === 'U_ALICE') ? new Map([['D42', 'any' as const]]) : new Map()
      )
      await orch.reportConversation(BOT, { id: 'D42', name: '@Alice', dmUserId: 'U_ALICE' })
      const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'D42')
      expect(aliceRow).toMatchObject({ kind: 'im', trigger: 'any', agentId: ALICE })

      // And it routes: an open DM compiles the same channel-scoped auto rung an
      // editor-enabled conversation gets.
      const assign = ch.sends.filter((s) => s.type === 'rc/routes').at(-1)!.payload as RcBotAssign
      expect(assign.routes.filter((route) => route.scope?.channel === 'D42')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    it('reportConversation keeps a gated DM Off when its counterpart is outside the audience (§14.8)', async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      const orch = makeOrch(PLATFORMS, undefined, async () => new Map())
      await orch.reportConversation(BOT, { id: 'D42', name: '@Dave', dmUserId: 'U_DAVE' })
      expect(channels.find((c) => c.integrationId === INT_A && c.channelId === 'D42')).toMatchObject({ trigger: 'off' })
    })

    it('reportConversation preserves a group DM and converges it like a channel', async () => {
      gatedAgents = new Set([ALICE])
      channels = []
      const orch = makeOrch()
      await orch.reportConversation(BOT, { id: 'G42', name: 'mpim-alice--bob-1', kind: 'mpim' })
      const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'G42')
      const bobRow = channels.find((c) => c.integrationId === INT_B && c.channelId === 'G42')
      expect(aliceRow).toMatchObject({ kind: 'mpim', trigger: 'off', agentId: ALICE })
      expect(bobRow).toMatchObject({ kind: 'mpim', trigger: 'off', agentId: null })

      ch.sends.length = 0
      aliceRow!.trigger = 'mention'
      bobRow!.trigger = 'off'
      await orch.syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      const compiled = assign.routes.filter((r) => r.scope?.channel === 'G42')
      // The owner and trigger match the channel-style path.
      expect(compiled).toEqual([expect.objectContaining({ agentId: ALICE, match: { kind: 'mention' } })])
    })

    // One Slack identity cannot say WHICH agent a group-DM mention meant, and the slug
    // that disambiguates a multi-agent DM does not apply (the mention rung outranks keyword).
    // Two identical scoped mention routes would let relay order decide silently, so the
    // conversation converges on the earliest install instead.
    it('converges a group DM enabled by TWO gated agents onto the earliest install', async () => {
      gatedAgents = new Set([ALICE, BOB])
      channels = [
        channel({ integrationId: INT_B, channelId: 'G42', kind: 'mpim', agentId: BOB, trigger: 'mention' }),
        channel({ integrationId: INT_A, channelId: 'G42', kind: 'mpim', agentId: ALICE, trigger: 'mention' })
      ]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      const g42 = assign.routes.filter((r) => r.scope?.channel === 'G42')
      // ALICE is the earliest install (INT_A) — one route, hers, regardless of row order.
      expect(g42).toEqual([expect.objectContaining({ agentId: ALICE, match: { kind: 'mention' } })])
    })

    it('lets an enabled org-visible agent own a group DM', async () => {
      gatedAgents = new Set([BOB])
      channels = [
        channel({ integrationId: INT_A, channelId: 'G42', kind: 'mpim', agentId: ALICE, trigger: 'any' }),
        channel({ integrationId: INT_B, channelId: 'G42', kind: 'mpim', agentId: BOB, trigger: 'mention' })
      ]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'G42')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    it('compiles an org-visible group-DM trigger', async () => {
      gatedAgents = new Set()
      channels = [channel({ integrationId: INT_A, channelId: 'G42', kind: 'mpim', agentId: ALICE, trigger: 'any' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'G42')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    it('recordNoticePosted re-stamps the pool with the DELIVERED conversation', async () => {
      gatedAgents = new Set([ALICE])
      const orch = makeOrch()
      await orch.recordNoticePosted({ botId: BOT, channel: 'D42' })
      const routes = ch.sends.filter((s) => s.type === 'rc/routes')
      expect(routes.length).toBeGreaterThan(0)
      const stamped = routes.at(-1)!.payload as { noticedDmConversations: string[] }
      expect(stamped.noticedDmConversations).toEqual(['D42'])
      // Idempotent: a repeat report neither grows the set nor re-pushes.
      const before = ch.sends.length
      await orch.recordNoticePosted({ botId: BOT, channel: 'D42' })
      expect(ch.sends.length).toBe(before)
    })

    it('an enabled gated DM row compiles one scoped auto route', async () => {
      gatedAgents = new Set([ALICE])
      channels = [channel({ integrationId: INT_A, channelId: 'D42', kind: 'im', agentId: ALICE, trigger: 'any' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      const d42 = assign.routes.filter((r) => r.scope?.channel === 'D42')
      expect(d42).toEqual([expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })])
    })

    it('an enabled public DM compiles one scoped auto route for its owner', async () => {
      channels = [channel({ integrationId: INT_A, channelId: 'D42', kind: 'im', agentId: ALICE, trigger: 'any' })]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'D42')).toEqual([
        expect.objectContaining({ agentId: ALICE, match: { kind: 'auto' } })
      ])
    })

    it('mutes a public DM when every placed install switched it Off', async () => {
      channels = [
        channel({ integrationId: INT_A, channelId: 'D42', kind: 'im', agentId: ALICE, trigger: 'off' }),
        channel({ integrationId: INT_B, channelId: 'D42', kind: 'im', agentId: BOB, trigger: 'off' })
      ]
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.routes.filter((r) => r.scope?.channel === 'D42')).toEqual([])
      expect(assign.mutedChannels).toContain('D42')
      expect(assign.gatedOffChannels).not.toContain('D42')
    })

    it('stamps a deterministic notice authority from the connected relay roster', async () => {
      await makeOrch().syncBot(BOT)
      const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')!.payload as RcBotAssign
      expect(assign.noticeAuthority).toBe(RELAY) // sole connected relay
    })

    it('lookupThread refuses a binding to a gated agent whose conversation is off', async () => {
      gatedAgents = new Set([ALICE])
      threadBinding = { agentId: ALICE, daemonId: DaemonId(D1) }
      channels = [] // no enabled row for ALICE in C1 ⇒ off
      const res = await makeOrch().lookupThread({ botId: BOT, sessionKey: 'C1/123.456' })
      expect(res.target).toBeNull()
    })

    it('lookupThread honours a binding to a gated agent whose conversation is enabled', async () => {
      gatedAgents = new Set([ALICE])
      threadBinding = { agentId: ALICE, daemonId: DaemonId(D1) }
      channels = [channel({ integrationId: INT_A, channelId: 'C1', agentId: ALICE, trigger: 'mention' })]
      const res = await makeOrch().lookupThread({ botId: BOT, sessionKey: 'C1/123.456' })
      expect(res.target).toEqual({ agentId: ALICE, daemonId: D1 })
    })
  })

  it('releases the bot (rc/bot-unassign) when transport is socket (no relay ingress)', async () => {
    botRow = bot({ transport: 'socket' })
    await makeOrch().syncBot(BOT)
    expect(ch.sends.some((s) => s.type === 'rc/bot-unassign')).toBe(true)
  })

  it('setChannelAgent makes the pick the sole owner of the channel + pushes rc/routes', async () => {
    botRow = bot()
    // Start with C7 owned by alice (on alice's install); no row on bob's install.
    channels = [channel({ integrationId: INT_A, channelId: 'C7', agentId: ALICE, trigger: 'any' })]
    const orch = makeOrch()
    // Operator picks BOB as C7's default in the modal.
    await orch.setChannelAgent(BOT, 'C7', BOB)

    // alice's row for C7 is cleared; bob's install now owns C7.
    const aliceRow = channels.find((c) => c.integrationId === INT_A && c.channelId === 'C7')
    const bobRow = channels.find((c) => c.integrationId === INT_B && c.channelId === 'C7')
    expect(aliceRow?.agentId).toBeNull()
    expect(bobRow).toMatchObject({ agentId: BOB, trigger: 'any' })

    // and the relay got a hot rc/routes with C7 scoped to bob.
    const routes = ch.sends.filter((s) => s.type === 'rc/routes')
    expect(routes.length).toBeGreaterThan(0)
    const last = routes[routes.length - 1]!.payload as { routes: { agentId: string; scope?: { channel?: string } }[] }
    expect(last.routes.some((r) => r.scope?.channel === 'C7' && r.agentId === BOB)).toBe(true)
  })

  it('keeps an in-Slack owner move to a gated agent Off', async () => {
    gatedAgents = new Set([BOB])
    channels = [
      channel({ integrationId: INT_A, channelId: 'C7', agentId: ALICE, trigger: 'any' }),
      channel({ integrationId: INT_B, channelId: 'C7', agentId: null, trigger: 'off' })
    ]

    await makeOrch().setChannelAgent(BOT, 'C7', BOB)

    expect(channels.find((row) => row.integrationId === INT_A)).toMatchObject({ agentId: null, trigger: 'off' })
    expect(channels.find((row) => row.integrationId === INT_B)).toMatchObject({ agentId: BOB, trigger: 'off' })
    const routes = ch.sends.filter((send) => send.type === 'rc/routes').at(-1)?.payload as RcBotAssign
    expect(routes.routes.some((route) => route.scope?.channel === 'C7')).toBe(false)
  })

  it('rejects a queued Console update when Slack changes the authorized owner first', async () => {
    gatedAgents = new Set([BOB])
    channels = [
      channel({ integrationId: INT_A, channelId: 'C7', agentId: ALICE, trigger: 'mention' }),
      channel({ integrationId: INT_B, channelId: 'C7', agentId: null, trigger: 'mention' })
    ]
    let releaseChannelList!: () => void
    let channelListReached!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseChannelList = resolve
    })
    const reached = new Promise<void>((resolve) => {
      channelListReached = resolve
    })
    blockNextChannelList = async () => {
      channelListReached()
      await blocked
    }
    const orch = makeOrch()

    const slackMove = orch.setChannelAgent(BOT, 'C7', BOB)
    await reached
    const consoleUpdate = orch.updateConversation(
      BOT,
      'C7',
      { trigger: 'any' },
      { expectedOwnerAgentId: ALICE, source: 'console' }
    )
    releaseChannelList()

    await slackMove
    expect(await consoleUpdate).toBeNull()
    expect(channels.find((row) => row.integrationId === INT_A)).toMatchObject({ agentId: null, trigger: 'off' })
    expect(channels.find((row) => row.integrationId === INT_B)).toMatchObject({ agentId: BOB, trigger: 'off' })
  })

  it('backfills a missing sibling before the current owner can be removed', async () => {
    channels = [channel({ integrationId: INT_A, channelId: 'C7', name: 'deploys', agentId: ALICE, trigger: 'any' })]

    await makeOrch().prepareIntegrationRemoval(BOT)

    expect(channels.find((row) => row.integrationId === INT_B)).toMatchObject({
      channelId: 'C7',
      name: 'deploys',
      agentId: null,
      trigger: 'any'
    })
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

  /**
   * F9 — the gate on this path is the §5 manifest's
   * `membershipEnumeration: 'authoritative'`, not `platform === 'slack'`.
   *
   * It is load-bearing in the destructive direction: `replaceChannels` REPLACES
   * the stored set, so applying it to a platform whose rows are discovered from
   * traffic would delete conversations no snapshot can restore. Slack is the one
   * platform that declares an authoritative snapshot today, so these cases also
   * pin that the rewrite did not widen the arm.
   */
  it('applies the snapshot only for a platform declaring authoritative membership', async () => {
    for (const platform of ['telegram', 'discord', 'feishu', 'mastodon']) {
      channels = [channel({ integrationId: INT_A, channelId: 'C-known', name: 'known', agentId: ALICE })]
      botRow = bot({ platform })
      await makeOrch().replaceChannels(BOT, [{ id: 'C1', name: 'deploys' }])
      // Untouched: no row added, none dropped, no route push.
      expect(
        channels.map((c) => c.channelId),
        platform
      ).toEqual(['C-known'])
      expect(
        ch.sends.some((send) => send.type === 'rc/routes'),
        platform
      ).toBe(false)
    }

    channels = [channel({ integrationId: INT_A, channelId: 'C-known', name: 'known', agentId: ALICE })]
    botRow = bot({ platform: 'slack' })
    await makeOrch().replaceChannels(BOT, [{ id: 'C1', name: 'deploys' }])
    // Slack alone declares the authoritative snapshot: the stale row is dropped
    // and the reported one is fanned across both installs.
    expect([...new Set(channels.map((c) => c.channelId))]).toEqual(['C1'])
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

  it('repairs a known ownerless channel to the earliest active agent', async () => {
    channels = [
      channel({ integrationId: INT_A, channelId: 'C1', agentId: null }),
      channel({ integrationId: INT_B, channelId: 'C1', agentId: null })
    ]
    await makeOrch().replaceChannels(BOT, [{ id: 'C1', name: 'deploys' }])
    expect(channels.find((c) => c.integrationId === INT_A && c.channelId === 'C1')?.agentId).toBe(ALICE)
    expect(channels.find((c) => c.integrationId === INT_B && c.channelId === 'C1')?.agentId).toBeNull()
  })

  it('transfers an ownerless channel to the earliest remaining integration', async () => {
    integrations = [integration(INT_B, BOB)]
    botRow = bot({ agentIds: [BOB] })
    channels = [channel({ integrationId: INT_B, channelId: 'C1', agentId: null })]

    await makeOrch().syncBot(BOT)

    expect(channels).toEqual([expect.objectContaining({ integrationId: INT_B, channelId: 'C1', agentId: BOB })])
    const assign = ch.sends.find((send) => send.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign.routes).toEqual([
      expect.objectContaining({ agentId: BOB, scope: { channel: 'C1' }, match: { kind: 'mention' } }),
      expect.objectContaining({ agentId: BOB, match: { kind: 'keyword', value: 'bob' } })
    ])
  })

  it('keeps an automatic ownerless fallback to a gated agent Off', async () => {
    integrations = [integration(INT_B, BOB)]
    botRow = bot({ agentIds: [BOB] })
    gatedAgents = new Set([BOB])
    channels = [channel({ integrationId: INT_B, channelId: 'C1', agentId: null, trigger: 'any' })]

    await makeOrch().syncBot(BOT)

    expect(channels).toEqual([
      expect.objectContaining({ integrationId: INT_B, channelId: 'C1', agentId: BOB, trigger: 'off' })
    ])
    const assign = ch.sends.find((send) => send.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign.routes).toEqual([])
  })

  it('defers placement when no relay is connected', async () => {
    relayReg = new RelayRegistry() // none connected
    botRow = bot()
    const orch = makeOrch()
    await orch.syncBot(BOT)
    expect(orch.hasConnectedRelay()).toBe(false)
    expect(ch.sends).toEqual([]) // nothing broadcast
  })

  it('stamps teamId + botUserId into the rc/bot-assign ingress bag for a platform-app install', async () => {
    // A distributed app's install: every workspace shares the app id + signing
    // secret, so the relay may only demux this bot on (api_app_id, team_id).
    // §6.7: the opaque ingress bag is the ONE carrier of that demux identity.
    botRow = bot({ slackAppId: 'APLATFORM', teamId: 'T1WORKSPACE', botUserId: 'U0BOT' })

    await makeOrch().syncBot(BOT)

    const assign = ch.sends.find((send) => send.type === 'rc/bot-assign')?.payload as RcBotAssign
    expect(assign.ingress).toEqual({ apiAppId: 'APLATFORM', teamId: 'T1WORKSPACE', botUserId: 'U0BOT' })
  })

  it('revokeBot marks the bot + installs revoked, unassigns, and pulls the daemon specs', async () => {
    await makeOrch().revokeBot(BOT, 'app_uninstalled')

    expect(botRevokedAt).toBeInstanceOf(Date)
    expect(integrations.map((i) => i.status)).toEqual(['revoked', 'revoked'])
    // The release carries the generation it revoked, so a relay that already holds
    // a newer assignment (a re-install that overtook this broadcast) drops it.
    expect(ch.sends).toEqual([{ type: 'rc/bot-unassign', payload: { botId: BOT, credentialRevision: 1 } }])
    // Both member agents are placed (ALICE→D1, BOB→D2): each daemon loses its spec.
    expect(removals).toEqual([
      { daemonId: D1, integrationId: INT_A },
      { daemonId: D2, integrationId: INT_B }
    ])
  })

  // Slack does not guarantee lifecycle-event ordering: an `app_uninstalled` from a
  // PRIOR install can be delivered after the workspace re-installed. Applying it
  // would revoke a live, freshly-authorized bot and kill its integrations.
  it('revokeBot ignores a report whose credential generation was superseded', async () => {
    botRow = bot({ credentialRevision: 2 }) // re-install bumped it since the event

    await makeOrch().revokeBot(BOT, 'app_uninstalled', { revision: 1 })

    expect(botRevokedAt).toBeNull() // fresh install untouched…
    expect(integrations.map((i) => i.status)).toEqual(['active', 'active'])
    expect(ch.sends).toEqual([]) // …not unassigned from the pool…
    expect(removals).toEqual([]) // …and its daemon specs stay
  })

  // The load-bearing arm: a relay that already received the re-install's assignment
  // echoes the NEW revision, so only the event's own occurrence time reveals that it
  // predates the credential it would kill.
  it('revokeBot ignores a report that predates the current credential', async () => {
    const installedAt = new Date('2026-07-29T12:00:00Z')
    botRow = bot({ credentialRevision: 2, credentialInstalledAt: installedAt })

    await makeOrch().revokeBot(BOT, 'app_uninstalled', {
      revision: 2, // current — only the timestamp can catch this one
      eventAtMs: installedAt.getTime() - 60_000
    })

    expect(botRevokedAt).toBeNull()
    expect(integrations.map((i) => i.status)).toEqual(['active', 'active'])
    expect(removals).toEqual([])
  })

  it('revokeBot applies a report from the CURRENT generation', async () => {
    const installedAt = new Date('2026-07-29T12:00:00Z')
    botRow = bot({ credentialRevision: 2, credentialInstalledAt: installedAt })

    await makeOrch().revokeBot(BOT, 'app_uninstalled', {
      revision: 2,
      eventAtMs: installedAt.getTime() + 60_000 // uninstalled AFTER this credential
    })

    expect(botRevokedAt).toBeInstanceOf(Date)
    expect(integrations.map((i) => i.status)).toEqual(['revoked', 'revoked'])
    expect(removals).toHaveLength(2)
  })

  // The revoke commits, but a re-install wins the bot row the instant it is
  // released and broadcasts its own assign. Emitting the teardown then would tear
  // down a credential this report no longer describes.
  it('revokeBot skips its teardown effects when the credential moved after the commit', async () => {
    // `bumpRevisionAfterFirstGet` makes the post-commit re-read observe a newer
    // generation — exactly what a re-install that won the row lock leaves behind.
    bumpRevisionAfterFirstGet = true

    await makeOrch().revokeBot(BOT, 'app_uninstalled')

    expect(ch.sends).toEqual([]) // no bot-unassign racing the fresh assign
    expect(removals).toEqual([]) // no spec pulled off the re-installed bot
  })

  it('revokeBot is idempotent — a duplicate report finds no active installs', async () => {
    const orch = makeOrch()
    await orch.revokeBot(BOT, 'tokens_revoked')
    removals = []
    ch.sends.length = 0

    await orch.revokeBot(BOT, 'tokens_revoked')

    expect(removals).toEqual([]) // nothing left to pull
    expect(ch.sends).toEqual([{ type: 'rc/bot-unassign', payload: { botId: BOT, credentialRevision: 1 } }]) // re-stamp only
  })
})
