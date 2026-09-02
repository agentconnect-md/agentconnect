/**
 * Per-channel trigger config, end to end on the CP side:
 *
 *  - `integration/channels` (D→C EVT) converges `integration_channel` to either
 *    an authoritative membership snapshot or a partial observed-conversation
 *    report. New channels default to '@-mention', authoritative omissions drop
 *    channels, and the operator's trigger choice SURVIVES every re-report.
 *  - The handler is daemon-scoped: a report from a daemon that does not own the
 *    integration's agent is dropped.
 *  - `PATCH /integrations/:id/channels/:channelId {trigger}` persists the choice,
 *    surfaces it on `GET /integrations`, and pushes `integration/upsert` whose
 *    recomputed bindRules carry one channel-scoped `auto` rule per 'any' channel.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedDutyGroup } from '../fixtures/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { installNewBot } from '../../src/http/install-bot.js'
import {
  PgAgentRepo,
  PgBotRepo,
  PgDaemonRepo,
  PgIntegrationRepo,
  PgIntegrationChannelRepo
} from '../../src/persistence/index.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { gatedDmSeeds, type GatedDmSeedResolver } from '../../src/orchestrator/linkedDm.js'
import { linearTeamSeedTrigger, seedLinearTeamRows } from '../../src/platforms/linear/teams.js'
import { reconcileAgentLinkedDms, reconcileLinkedDms } from '../../src/orchestrator/linkedDmReconcile.js'
import type { SlackIdentity } from '../../src/github/logto-identity.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { handleIntegrationChannels } from '../../src/ws/handlers/index.js'
import { IntegrationId } from '../../src/domain/ids.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import type { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import type { AnyFrame, CollabRoutesSnapshot, IntegrationUpsert, IntegrationChannel } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

// §14.8 OIDC subjects — the key a linked Slack identity is resolved by.
const ALICE_SUB = 'oidc-alice'
const BOB_SUB = 'oidc-bob'
const CAROL_SUB = 'oidc-carol'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }
/** The connected Linear organization — the channel itself, since the workspace IS the channel. */
const LINEAR_WORKSPACE = '5f3a0c9e-1c2b-4a7d-9e10-6b5c4d3e2f10'
/** A connected workspace's teams — the conversations a Linear bot routes on (§4.5). */
const LINEAR_TEAMS = [
  { id: 'team_eng', key: 'ENG', name: 'Engineering' },
  { id: 'team_design', key: 'DES', name: 'Design' }
]

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  readonly collaboration: Array<{ daemonId: string; snapshot: CollabRoutesSnapshot }> = []
  readonly leaves: Array<{ daemonId: string; l: unknown }> = []
  readonly forgets: Array<{ daemonId: string; f: { integrationId: string; channels: string[] } }> = []
  /** What the fake daemon answers the next leave with — a platform refusal by default
   *  would be surprising, so it succeeds unless a test says otherwise. */
  leaveVerdict: { ok: boolean; error?: string } = { ok: true }
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationLeave(daemonId: string, l: unknown): Promise<{ ok: boolean; error?: string }> {
    this.leaves.push({ daemonId, l })
    return this.leaveVerdict
  }
  /** Set to simulate an unreachable daemon — the suppression then cannot be made durable. */
  forgetThrows: Error | null = null
  async integrationForget(
    daemonId: string,
    f: { integrationId: string; channels: string[] }
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.forgetThrows) throw this.forgetThrows
    this.forgets.push({ daemonId, f })
    return { ok: true }
  }
  async integrationRemove(): Promise<void> {}
  async collaborationRoutes(daemonId: string, snapshot: CollabRoutesSnapshot): Promise<void> {
    this.collaboration.push({ daemonId, snapshot })
  }
}

/** Install an integration on a placed agent; returns its id. */
async function install(app: HttpApp): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

/** Connect a LINEAR workspace through the REAL create tail the OAuth callback uses
 *  (`installNewBot` with the provider's team seeder) — the seat that writes the team rows. */
async function installLinear(
  app: HttpApp,
  opts: { restricted?: boolean } = {}
): Promise<{ integrationId: string; botId: string; agentId: string }> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  if (opts.restricted) {
    await prisma.agent.update({
      where: { id: agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
  }
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
  const { integration } = await installNewBot(app.deps, { debug: () => {} }, {
    orgId: DEFAULT_ORG_ID as never,
    agent: agent as never,
    platform: 'linear',
    name: 'Acme',
    transport: 'http',
    secrets: { botToken: 'client-secret', appToken: null, signingSecret: 'lin_wh_secret' },
    bot: {
      shareable: true,
      workspaceId: LINEAR_WORKSPACE,
      workspaceName: 'Acme',
      botUserId: 'lin-app-user'
    },
    seedConversations: (integration: { id: string }) =>
      seedLinearTeamRows(app.deps.repos.integrationChannel, integration.id as never, LINEAR_TEAMS, {
        trigger: linearTeamSeedTrigger([agent as never]),
        owner: agentId as never,
        workspaceName: 'Acme'
      })
  } as never)
  return { integrationId: integration.id, botId: integration.botId, agentId }
}

/** Add a SECOND agent to a connected Linear workspace, exactly as the add-member route does: the
 *  membership row, then the `syncBot` whose compile replicates each team's ownerless sibling row. */
async function addLinearMember(app: HttpApp, botId: string): Promise<{ integrationId: string; agentId: string }> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const admission = await app.deps.repos.integration.addBotMembership({
    id: IntegrationId(randomUUID()),
    orgId: DEFAULT_ORG_ID as never,
    agentId: agentId as never,
    botId: botId as never,
    platform: 'linear',
    name: 'Acme'
  } as never)
  if (!('integration' in admission)) throw new Error(`unexpected membership outcome: ${admission.outcome}`)
  await app.deps.httpBot.syncBot(botId)
  return { integrationId: admission.integration.id, agentId }
}

/** Install a TELEGRAM integration — the platform whose rows are session-derived, so
 *  the only one where a durable suppression is what makes a removal stick. */
async function installTelegram(app: HttpApp): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { name: 'acme-tg', platform: 'telegram', agentId, telegram: { botToken: '123456:AAE-xyz' } }
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

/** Install a DISCORD integration — the one platform whose bot joins a SPACE
 *  rather than individual conversations (§5 `leaveGranularity: 'space'`), so the
 *  only one whose leave requests take the mirror-image arms of the two refusals
 *  below. */
async function installDiscord(app: HttpApp): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      name: 'acme-dc',
      platform: 'discord',
      agentId,
      discord: { botToken: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.fixture.not-a-secret' }
    }
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

/** Dispatch a hand-built `integration/channels` EVT through the real handler. */
async function report(
  daemonId: string,
  integrationId: string,
  channels: IntegrationChannel[],
  agentMutations = new AgentMutationGate(),
  collabRoutes = { broadcast: async () => undefined } as unknown as CollabRoutesService,
  authoritative?: boolean,
  removed?: string[],
  /** §14.8: OIDC subject → the Slack identity that console account carries. Given, the
   *  report runs the REAL seed resolver over these links instead of none. */
  links?: Record<string, SlackIdentity>,
  /** §14.8: records the re-converge a report that opened a DM has to trigger. */
  integrationConverge?: (agent: unknown) => Promise<void>
): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/channels',
    payload: {
      integrationId,
      channels,
      ...(authoritative === undefined ? {} : { authoritative }),
      ...(removed === undefined ? {} : { removed })
    }
  } as AnyFrame
  const users = new PgUserRepo(prisma)
  const deps = {
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    agent: new PgAgentRepo(prisma),
    bot: new PgBotRepo(prisma),
    // Admission is the served set now — placement ∪ the duties this member holds.
    dutyLease: new PgDutyGroupRepo(prisma),
    clock: systemClock,
    agentMutations,
    collabRoutes,
    ...(links
      ? {
          gatedDmSeeds: ((reported, agent, bot) =>
            gatedDmSeeds(reported, agent, bot, {
              users,
              identity: { slackIdentityFor: async (sub: string) => links[sub] ?? null }
            })) satisfies GatedDmSeedResolver
        }
      : {}),
    ...(integrationConverge ? { integrationConverge } : {})
  } as unknown as DaemonWsDeps
  await handleIntegrationChannels(frame, { daemonId } as DaemonConnection, deps)
}

/**
 * Wrap a Prisma client so the FIRST channel-row read is held until `release()` — letting
 * a test pin down the interleaving a pair of fire-and-forget reports can produce: reader
 * takes a stale snapshot, a second writer commits, and only then does the reader write.
 * `taken` resolves when that read is intercepted; a caller that classifies inside its
 * write never takes one, so `taken` simply never resolves (callers race it with a
 * timeout) and `release()` is a no-op.
 */
function holdFirstRead(db: typeof prisma): { db: typeof prisma; taken: Promise<void>; release: () => void } {
  let held = false
  let markTaken = () => {}
  let release = () => {}
  const taken = new Promise<void>((resolve) => {
    markTaken = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const channelProxy = new Proxy(db.integrationChannel, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'findMany' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (...args: unknown[]) => {
        const rows = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        if (!held) {
          held = true
          markTaken()
          await gate
        }
        return rows
      }
    }
  })
  const proxied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'integrationChannel') return channelProxy
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { db: proxied, taken, release }
}

describe('integration/channels EVT → integration_channel convergence', () => {
  it('inserts reported channels with the default @-mention trigger', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'releases', isPrivate: true }
    ])

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: unknown[] }[]
    expect(dto!.channels).toEqual([
      {
        channelId: 'C1',
        name: 'deploys',
        spaceId: null,
        space: null,
        icon: null,
        color: null,
        isPrivate: false,
        kind: 'channel',
        trigger: 'mention',
        agentId: null
      },
      {
        channelId: 'C2',
        name: 'releases',
        spaceId: null,
        space: null,
        icon: null,
        color: null,
        isPrivate: true,
        kind: 'channel',
        trigger: 'mention',
        agentId: null
      }
    ])
  })

  it('keeps the reported space (the Discord server) and never blanks it on a report without one', async () => {
    // A Discord bot spans several servers, each with its own "#general" — the space is
    // what makes the row identifiable. It resolves lazily at the edge, so a later report
    // that carries no space must leave the known server name standing.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    await report(
      DAEMON,
      id,
      [{ id: 'C1', name: 'general', spaceId: 'G1', space: 'Acme HQ' }],
      undefined,
      undefined,
      false
    )
    await report(DAEMON, id, [{ id: 'C1', name: 'general' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; space: string | null }[] }[]
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'C1', spaceId: 'G1', space: 'Acme HQ' })])
  })

  it('keeps a reported glyph, exposes it on the DTO, and never blanks it on a report without one', async () => {
    // A Linear team carries its own icon and colour, which the console draws it by. Like the
    // space, it is learned once: a reporter that could not resolve it must leave the row drawn.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    await report(
      DAEMON,
      id,
      [
        { id: 'team-1', name: 'Acme / Engineering', icon: 'Feather', color: '#5E6AD2' },
        { id: 'team-2', name: 'Acme / Design' }
      ],
      undefined,
      undefined,
      false
    )
    await report(DAEMON, id, [{ id: 'team-1', name: 'Acme / Engineering' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; icon: string | null; color: string | null }[] }[]
    const byId = new Map(dto!.channels.map((c) => [c.channelId, c]))
    expect(byId.get('team-1')).toMatchObject({ icon: 'Feather', color: '#5E6AD2' })
    // A row the platform gives no glyph reads as two nulls rather than an absent pair.
    expect(byId.get('team-2')).toMatchObject({ icon: null, color: null })
  })

  it('lets an enumerating writer CLEAR a glyph, while an omission still leaves the row drawn', async () => {
    // The tri-state at the repository: absent is "unknown" (a daemon lookup that resolved
    // nothing), `null` is "the platform says it has none" — only the second may blank the row.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)
    const glyphOf = async () => {
      const row = (await channels.listForIntegration(IntegrationId(id))).find((c) => c.channelId === 'team-1')
      return { icon: row?.icon ?? undefined, color: row?.color ?? undefined }
    }

    await channels.upsertConversation(IntegrationId(id), {
      id: 'team-1',
      name: 'Acme / Engineering',
      icon: 'Feather',
      color: '#5E6AD2',
      kind: 'channel'
    })
    expect(await glyphOf()).toEqual({ icon: 'Feather', color: '#5E6AD2' })

    // An omitting write is a name-only refresh and must not blank what is already drawn.
    await channels.upsertConversation(IntegrationId(id), { id: 'team-1', name: 'Acme / Eng', kind: 'channel' })
    expect(await glyphOf()).toEqual({ icon: 'Feather', color: '#5E6AD2' })

    // An explicit null is the enumerating writer saying the team dropped its icon.
    await channels.upsertConversation(IntegrationId(id), {
      id: 'team-1',
      name: 'Acme / Eng',
      icon: null,
      color: null,
      kind: 'channel'
    })
    expect(await glyphOf()).toEqual({ icon: undefined, color: undefined })
  })

  it("a restricted agent's fresh conversations default to OFF, and DM rows survive a membership re-report (§14)", async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({
      where: { id: integration.agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })

    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'D1', name: '@alice', kind: 'im' }
    ])
    let res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    let [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    const byId = new Map(dto!.channels.map((c) => [c.channelId, c]))
    expect(byId.get('C1')).toMatchObject({ kind: 'channel', trigger: 'off' })
    expect(byId.get('D1')).toMatchObject({ kind: 'im', trigger: 'off', name: '@alice' })

    // A later membership-only snapshot (bot left C1; D1 not re-reported) must drop
    // C1 but KEEP the DM row — the snapshot governs kind='channel' rows only.
    await report(DAEMON, id, [{ id: 'C2', name: 'ops' }])
    res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    ;[dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    expect(dto!.channels.map((c) => c.channelId).sort()).toEqual(['C2', 'D1'])

    // A KIND-LESS re-report of the same id (telegram/discord observed-channel
    // snapshots carry no kind) must not downgrade the established im row.
    await report(DAEMON, id, [{ id: 'C2', name: 'ops' }, { id: 'D1' }])
    res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    ;[dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    expect(dto!.channels.find((c) => c.channelId === 'D1')).toMatchObject({ kind: 'im' })
  })

  it('seeds the Linear TEAM rows AT INSTALL, through the ordinary §14 gating arm', async () => {
    // A team is a channel, so its rows take the same seed every other conversation does: born
    // `mention` under an unrestricted linking agent and `off` under a gated one, for an operator
    // to enable. They are written by the install path itself, so the install's own syncBot
    // already publishes the routes that follow from them.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const restricted = (await installLinear(running, { restricted: true })).integrationId
    const open = (await installLinear(running)).integrationId

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const byId = new Map(
      (res.json() as { id: string; channels: { channelId: string; name: string; trigger: string }[] }[]).map((d) => [
        d.id,
        d.channels
      ])
    )
    const sorted = (id: string) => [...byId.get(id)!].sort((a, b) => a.channelId.localeCompare(b.channelId))
    expect(sorted(open)).toEqual([
      expect.objectContaining({ channelId: 'team_design', name: 'Acme / Design', trigger: 'mention' }),
      expect.objectContaining({ channelId: 'team_eng', name: 'Acme / Engineering', trigger: 'mention' })
    ])
    expect(sorted(restricted).map((c) => [c.channelId, c.trigger])).toEqual([
      ['team_design', 'off'],
      ['team_eng', 'off']
    ])
  })

  it("a daemon's observed report refreshes a team name without touching the seeded trigger", async () => {
    // The wire report carries no trigger and `replaceSnapshot` preserves the stored one, so the
    // backstop cannot fight the seed — a gated agent's Off row stays Off through a rename.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = (await installLinear(running, { restricted: true })).integrationId

    await report(DAEMON, id, [{ id: 'team_eng', name: 'Acme / Platform' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const dto = (res.json() as { id: string; channels: { channelId: string; name: string; trigger: string }[] }[]).find(
      (d) => d.id === id
    )
    expect(dto!.channels).toContainEqual(
      expect.objectContaining({ channelId: 'team_eng', name: 'Acme / Platform', trigger: 'off' })
    )
  })

  it('still starts a restricted agent OFF on a platform whose install grants nothing', async () => {
    // The Linear arm above must not have widened the §14 default for everyone else.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({
      where: { id: integration.agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })

    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }])

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const dto = (res.json() as { id: string; channels: { channelId: string; trigger: string }[] }[]).find(
      (d) => d.id === id
    )
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'C1', trigger: 'off' })])
  })

  /** §14.8 fixture: a private agent shared with `audience`, on a bot in workspace T_ACME.
   *  The seeded owner gets an OIDC subject so their own link can be resolved. */
  async function privateAgentInWorkspace(app: HttpApp, audience: string[]): Promise<string> {
    const id = await install(app)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({
      where: { id: integration.agentId },
      data: { visibility: 'restricted', sharedWith: audience }
    })
    await prisma.bot.update({ where: { id: integration.botId }, data: { teamId: 'T_ACME' } })
    await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: ALICE_SUB } })
    return id
  }

  /** A second console account in the default org, for the multi-member audience. */
  async function seedMember(sub: string): Promise<string> {
    const users = new PgUserRepo(prisma)
    const email = `${sub}@example.test`
    const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
    return userId
  }

  /** Real repos + a stubbed identity service keyed by OIDC subject. */
  const reconcileDeps = (links: Record<string, SlackIdentity>) => ({
    users: new PgUserRepo(prisma),
    orgs: new PgOrgRepo(prisma),
    agents: new PgAgentRepo(prisma),
    integrations: new PgIntegrationRepo(prisma),
    bots: new PgBotRepo(prisma),
    channels: new PgIntegrationChannelRepo(prisma),
    identity: { slackIdentityFor: async (sub: string) => links[sub] ?? null },
    push: async () => {}
  })

  const triggersOf = async (id: string): Promise<Map<string, string>> =>
    new Map(
      (await new PgIntegrationChannelRepo(prisma).listForIntegration(IntegrationId(id))).map((row) => [
        row.channelId,
        row.trigger
      ])
    )

  it("opens a private agent's DM with every audience member who linked their Slack identity (§14.8)", async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const bob = await seedMember(BOB_SUB)
    const carol = await seedMember(CAROL_SUB)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID, bob, carol])

    // Alice (the owner), Bob and Carol are the audience and all three linked; Dave is a
    // workspace member who is not, and Erin is in the audience but never linked.
    await report(
      DAEMON,
      id,
      [
        { id: 'C1', name: 'deploys' },
        { id: 'D_ALICE', name: '@alice', kind: 'im', dmUserId: 'U_ALICE' },
        { id: 'D_BOB', name: '@bob', kind: 'im', dmUserId: 'U_BOB' },
        { id: 'D_CAROL', name: '@carol', kind: 'im', dmUserId: 'U_CAROL' },
        { id: 'D_DAVE', name: '@dave', kind: 'im', dmUserId: 'U_DAVE' }
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      {
        [ALICE_SUB]: { teamId: 'T_ACME', userId: 'U_ALICE' },
        [BOB_SUB]: { teamId: 'T_ACME', userId: 'U_BOB' },
        [CAROL_SUB]: { teamId: 'T_ACME', userId: 'U_CAROL' }
      }
    )

    const triggers = await triggersOf(id)
    expect(triggers.get('D_ALICE')).toBe('any')
    expect(triggers.get('D_BOB')).toBe('any')
    expect(triggers.get('D_CAROL')).toBe('any')
    // The two arms that must NOT open: a channel (its membership is a room, not a
    // person) and a DM from someone outside the audience.
    expect(triggers.get('C1')).toBe('off')
    expect(triggers.get('D_DAVE')).toBe('off')
  })

  // The other regression the review caught. On a direct/socket integration this handler
  // is the ONLY path where a REPORT creates an enabled row: the reporting daemon still
  // holds bindRules with no scoped rule for that DM, and it has already cached the
  // conversation, so nothing re-reports and the DM stays refused until an unrelated
  // reconnect. Opening a row therefore has to push.
  it('re-converges the reporting daemon when a report opens a gated DM (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    const links = { [ALICE_SUB]: { teamId: 'T_ACME', userId: 'U_ALICE' } }
    const converged: unknown[] = []
    const converge = async (agent: unknown) => void converged.push(agent)

    // A channel-only report changes no gating, so it must NOT push.
    await report(
      DAEMON,
      id,
      [{ id: 'C1', name: 'deploys' }],
      undefined,
      undefined,
      undefined,
      undefined,
      links,
      converge
    )
    expect(converged).toHaveLength(0)

    // The DM that opens does.
    await report(
      DAEMON,
      id,
      [{ id: 'D_ALICE', name: '@alice', kind: 'im', dmUserId: 'U_ALICE' }],
      undefined,
      undefined,
      false,
      undefined,
      links,
      converge
    )
    expect((await triggersOf(id)).get('D_ALICE')).toBe('any')
    expect(converged).toHaveLength(1)
  })

  it('keeps the Off default for an audience member who linked a DIFFERENT workspace (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    await report(
      DAEMON,
      id,
      [{ id: 'D_ALICE', name: '@alice', kind: 'im', dmUserId: 'U_ALICE' }],
      undefined,
      undefined,
      undefined,
      undefined,
      { [ALICE_SUB]: { teamId: 'T_OTHER', userId: 'U_ALICE' } }
    )
    expect((await triggersOf(id)).get('D_ALICE')).toBe('off')
  })

  it('opens an already-Off DM when its counterpart links afterwards, and pushes (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    // The real order of events: the DM is discovered and refused BEFORE the link.
    await report(DAEMON, id, [{ id: 'D_ALICE', name: '@alice', kind: 'im', dmUserId: 'U_ALICE' }])
    expect((await triggersOf(id)).get('D_ALICE')).toBe('off')

    const pushed: string[] = []
    const opened = await reconcileLinkedDms(DEFAULT_OWNER_ID, ALICE_SUB, {
      users: new PgUserRepo(prisma),
      orgs: new PgOrgRepo(prisma),
      agents: new PgAgentRepo(prisma),
      integrations: new PgIntegrationRepo(prisma),
      bots: new PgBotRepo(prisma),
      channels: new PgIntegrationChannelRepo(prisma),
      identity: { slackIdentityFor: async () => ({ teamId: 'T_ACME', userId: 'U_ALICE' }) },
      push: async (agent) => {
        pushed.push(agent.id)
      }
    })
    expect(opened).toBe(1)
    expect(pushed).toHaveLength(1)
    expect((await triggersOf(id)).get('D_ALICE')).toBe('any')
  })

  it('opens an already-Off DM when its counterpart JOINS the audience afterwards (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const bob = await seedMember(BOB_SUB)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    await report(DAEMON, id, [{ id: 'D_BOB', name: '@bob', kind: 'im', dmUserId: 'U_BOB' }])
    expect((await triggersOf(id)).get('D_BOB')).toBe('off')

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const agent = await prisma.agent.update({
      where: { id: integration.agentId },
      data: { sharedWith: [DEFAULT_OWNER_ID, bob] }
    })
    const opened = await reconcileAgentLinkedDms(
      agent as unknown as Parameters<typeof reconcileAgentLinkedDms>[0],
      [bob],
      reconcileDeps({ [BOB_SUB]: { teamId: 'T_ACME', userId: 'U_BOB' } })
    )
    expect(opened).toBe(1)
    expect((await triggersOf(id)).get('D_BOB')).toBe('any')
  })

  // The regression the review caught: the catch-up is a DEFAULT for a pair that just
  // became eligible, not a standing rule. Re-deriving it from the whole current
  // audience on every later sharing edit would silently revert an editor's own Off.
  it('a later sharing edit never reopens a DM the editor closed (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const bob = await seedMember(BOB_SUB)
    const carol = await seedMember(CAROL_SUB)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID, bob])
    const links = {
      [BOB_SUB]: { teamId: 'T_ACME', userId: 'U_BOB' },
      [CAROL_SUB]: { teamId: 'T_ACME', userId: 'U_CAROL' }
    }
    await report(
      DAEMON,
      id,
      [
        { id: 'D_BOB', name: '@bob', kind: 'im', dmUserId: 'U_BOB' },
        { id: 'D_CAROL', name: '@carol', kind: 'im', dmUserId: 'U_CAROL' }
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      links
    )
    expect((await triggersOf(id)).get('D_BOB')).toBe('any')

    // The editor reconsiders and closes Bob's DM.
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'D_BOB', 'off')

    // Carol is added later. Only Carol's DM opens; Bob's stays where the editor put it.
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const agent = await prisma.agent.update({
      where: { id: integration.agentId },
      data: { sharedWith: [DEFAULT_OWNER_ID, bob, carol] }
    })
    await reconcileAgentLinkedDms(
      agent as unknown as Parameters<typeof reconcileAgentLinkedDms>[0],
      [carol],
      reconcileDeps(links)
    )
    const triggers = await triggersOf(id)
    expect(triggers.get('D_CAROL')).toBe('any')
    expect(triggers.get('D_BOB')).toBe('off')
  })

  // The link path cannot prove a link just landed — the browser writes it at the
  // provider BEFORE calling refresh — so it runs on every call. `triggerChosen` is what
  // makes that safe: an editor's Off is a decision, not a pending authorization.
  it('a repeated identity refresh never reopens a DM the editor closed (§14.8)', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    const links = { [ALICE_SUB]: { teamId: 'T_ACME', userId: 'U_ALICE' } }
    await report(
      DAEMON,
      id,
      [{ id: 'D_ALICE', name: '@alice', kind: 'im', dmUserId: 'U_ALICE' }],
      undefined,
      undefined,
      undefined,
      undefined,
      links
    )
    expect((await triggersOf(id)).get('D_ALICE')).toBe('any')

    // The editor closes it through the console route, which records the choice.
    const closed = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/D_ALICE`,
      payload: { trigger: 'off' }
    })
    expect(closed.statusCode).toBe(200)

    // Any number of later refreshes leave it closed.
    for (let i = 0; i < 3; i += 1) {
      expect(await reconcileLinkedDms(DEFAULT_OWNER_ID, ALICE_SUB, reconcileDeps(links))).toBe(0)
    }
    expect((await triggersOf(id)).get('D_ALICE')).toBe('off')
  })

  it('never re-closes a DM an operator turned Off after §14.8 opened it', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await privateAgentInWorkspace(running, [DEFAULT_OWNER_ID])
    const links = { [ALICE_SUB]: { teamId: 'T_ACME', userId: 'U_ALICE' } }
    const dm = { id: 'D_ALICE', name: '@alice', kind: 'im' as const, dmUserId: 'U_ALICE' }
    await report(DAEMON, id, [dm], undefined, undefined, undefined, undefined, links)
    expect((await triggersOf(id)).get('D_ALICE')).toBe('any')

    // The seed is a DEFAULT, not a standing rule: once a row exists, its trigger is
    // the operator's, and a re-report must not reassert the open state.
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'D_ALICE', 'off')
    await report(DAEMON, id, [dm], undefined, undefined, undefined, undefined, links)
    expect((await triggersOf(id)).get('D_ALICE')).toBe('off')
  })

  it('stores a public DM as On, then atomically closes it when the agent becomes restricted (§14.3)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })

    // Public agent: the DM is discovered (and a channel alongside it, for contrast).
    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'D1', name: '@alice', kind: 'im' }
    ])
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    const byId = new Map(dto!.channels.map((c) => [c.channelId, c]))
    expect(byId.get('D1')).toMatchObject({ kind: 'im', trigger: 'any' })
    expect(byId.get('C1')).toMatchObject({ kind: 'channel', trigger: 'mention' })

    spy.upserts.length = 0
    const put = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect(put.statusCode).toBe(200)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.gated).toBe(true)
    // No dm rule for D1: the private agent answers that DM only once enabled.
    expect(u0.core!.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])
    expect(
      (await new PgIntegrationChannelRepo(prisma).listForIntegration(IntegrationId(id))).find(
        (c) => c.channelId === 'D1'
      )
    ).toMatchObject({ trigger: 'off' })
  })

  it('applies the public On default when a row misclassified as a channel converts to a DM (§14.3)', async () => {
    // Session-history discovery cannot tell a DM from a group, so a DM could already be
    // stored as a channel carrying a channel's trigger. That is not an operator's DM
    // choice, so the conversion receives the public DM default instead.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })

    await report(DAEMON, id, [{ id: 'D1', name: '@alice' }], undefined, undefined, false)
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'D1', 'off')
    // The daemon now knows it is a DM and re-reports it as one.
    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'im' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'D1', kind: 'im', trigger: 'any' })])

    spy.upserts.length = 0
    await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.bindRules).toEqual([])
  })

  it('defaults a public group DM to Mention and preserves later choices (§14.3)', async () => {
    // Slack classifies a group DM late: an `app_mention` payload carries no
    // channel_type, so the conversation first lands as a channel with a channel's
    // trigger. That is not an operator's choice for this conversation, so resolving it
    // must receive the group-DM default — and an authoritative channel snapshot (which can never list a
    // group DM) must not delete the row.
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma)
    const id = await install(running)

    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1' }], undefined, undefined, false)
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'G1', 'any')
    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1', kind: 'mpim' }], undefined, undefined, false)

    const channelsOf = async () => {
      const res = await running!.app.inject({ method: 'GET', url: `${ORG}/integrations` })
      const [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
      return new Map(dto!.channels.map((c) => [c.channelId, c]))
    }
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'mention' })

    // An operator enables it; a later authoritative channel snapshot leaves it alone.
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'G1', 'any')
    await report(DAEMON, id, [{ id: 'C1', name: 'general' }])
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'any' })

    // A daemon restart loses the classification cache, so the next app_mention is
    // re-reported as a provisional channel — and the daemon stamps a kind on every
    // observed row, so this arrives as an EXPLICIT 'channel', not the absent-kind case
    // the existing preservation rule covers. Accepting it would flip the row twice and
    // reset the operator's trigger to Off on every restart.
    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1', kind: 'channel' }], undefined, undefined, false)
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'any' })
    // The daemon's own conversations.info correction lands afterwards and is a no-op.
    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1', kind: 'mpim' }], undefined, undefined, false)
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'any' })
  })

  it('an enabled DM row survives a provisional channel re-report too (§14.3)', async () => {
    // Same durability rule, on the kind that already existed: session-history discovery
    // can re-observe a DM without knowing it is one.
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma)
    const id = await install(running)

    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'im' }], undefined, undefined, false)
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'D1', 'any')
    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'channel' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'D1', kind: 'im', trigger: 'any' })])
  })

  it('keeps the public DM default deterministic when a kind-less and an IM report OVERLAP (§14.3)', async () => {
    // Channel reports are fire-and-forget and their handlers run concurrently: a daemon
    // start emits a kind-less observed snapshot, and the resolver's later verdict emits
    // the same conversation as a DM. Deciding the conversion from a read taken BEFORE the
    // write loses that race — the reader sees no row, the kind-less report then creates
    // channel/mention, and the DM write flips only the kind, inheriting a trigger no
    // operator ever chose for a DM. A later gate would honour it.
    //
    // The sequence is pinned rather than left to the scheduler: the DM report's pre-write
    // read is held, the kind-less report commits underneath it, then the DM write lands.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })

    const gate = holdFirstRead(prisma)
    const dmReport = new PgIntegrationChannelRepo(gate.db).replaceSnapshot(
      IntegrationId(id),
      [{ id: 'D1', name: '@alice', kind: 'im' }],
      { authoritative: false }
    )
    // Resolves as soon as a pre-write read is taken; an implementation that takes none
    // is let through by the timeout (its write may land in either order — both are safe).
    await Promise.race([gate.taken, new Promise((r) => setTimeout(r, 300))])
    await new PgIntegrationChannelRepo(prisma).replaceSnapshot(IntegrationId(id), [{ id: 'D1', name: '@alice' }], {
      authoritative: false
    })
    gate.release()
    await dmReport

    const [row] = await new PgIntegrationChannelRepo(prisma).listForIntegration(IntegrationId(id))
    expect(row).toMatchObject({ channelId: 'D1', kind: 'im', trigger: 'any' })

    spy.upserts.length = 0
    await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.bindRules).toEqual([])
  })

  it('enabling conversations on a GATED integration pushes conversation-scoped rules ONLY (§14)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({
      where: { id: integration.agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'D1', name: '@alice', kind: 'im' }
    ])
    spy.upserts.length = 0

    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/C1`,
      payload: { trigger: 'mention' }
    })
    expect(res.statusCode).toBe(200)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.gated).toBe(true)
    expect(u0.core!.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])

    await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/D1`,
      payload: { trigger: 'any' }
    })
    const u1 = spy.upserts[1]!.u
    if (u1.platform !== 'slack') throw new Error('expected slack integration')
    expect(u1.core!.bindRules).toHaveLength(2)
    expect(u1.core!.bindRules).toEqual(
      expect.arrayContaining([
        { channel: 'C1', match: { kind: 'mention' } },
        { channel: 'D1', match: { kind: 'dm' } }
      ])
    )
  })

  it('flipping agent visibility re-pushes the integration spec with the derived gate (§14.4)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }]) // org agent ⇒ default mention
    spy.upserts.length = 0

    const put = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect(put.statusCode).toBe(200)
    expect(spy.upserts).toHaveLength(1)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.gated).toBe(true)
    // The pre-flip channel row keeps its 'mention' trigger — grandfathered enabled.
    expect(u0.core!.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])

    const back = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    expect(back.statusCode).toBe(200)
    const u1 = spy.upserts[1]!.u
    if (u1.platform !== 'slack') throw new Error('expected slack integration')
    expect(u1.core!.gated).toBe(false)
    expect(u1.core!.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
  })

  it('a re-report preserves the trigger, refreshes names, and drops left channels', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)

    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'releases' }
    ])
    await channels.setTrigger(IntegrationId(id), 'C2', 'any')

    // Bot renamed #deploys → #ship, left #releases… but C2's trigger must survive
    // while it is still a member; here it left, so the row (and its trigger) go.
    await report(DAEMON, id, [
      { id: 'C1', name: 'ship' },
      { id: 'C2', name: 'releases' }
    ])
    let rows = await channels.listForIntegration(IntegrationId(id))
    expect(rows.find((c) => c.channelId === 'C2')!.trigger).toBe('any') // preserved
    expect(rows.find((c) => c.channelId === 'C1')!.name).toBe('ship') // refreshed

    await report(DAEMON, id, [{ id: 'C1', name: 'ship' }])
    rows = await channels.listForIntegration(IntegrationId(id))
    expect(rows.map((c) => c.channelId)).toEqual(['C1']) // C2 dropped
  })

  it('a non-authoritative observed-conversation report upserts without deleting missing channels', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)

    await report(DAEMON, id, [{ id: '-1001', name: 'First group' }], undefined, undefined, false)
    await report(DAEMON, id, [{ id: '-1002', name: 'Second group' }], undefined, undefined, false)
    await report(DAEMON, id, [{ id: '-1001' }], undefined, undefined, false)

    const rows = await channels.listForIntegration(IntegrationId(id))
    expect(rows.map((c) => c.channelId).sort()).toEqual(['-1001', '-1002'])
    expect(rows.find((c) => c.channelId === '-1001')?.name).toBe('First group')
  })

  // A non-authoritative reporter's omissions carry no meaning — which is why these
  // rows accumulated — so leaving a chat has to be stated by naming it.
  it('a non-authoritative report DELETES the conversations it names as removed', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)

    await report(
      DAEMON,
      id,
      [
        { id: '-1001', name: 'First group' },
        { id: '-1002', name: 'Second group' }
      ],
      undefined,
      undefined,
      false
    )
    // The bot left the first group; the report both retracts it and refreshes the rest.
    await report(DAEMON, id, [{ id: '-1002', name: 'Second group' }], undefined, undefined, false, ['-1001'])

    const rows = await channels.listForIntegration(IntegrationId(id))
    expect(rows.map((c) => c.channelId)).toEqual(['-1002'])
  })

  it('a retraction wins over the same conversation still listed in the report', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)

    await report(DAEMON, id, [{ id: '-1001', name: 'First group' }], undefined, undefined, false)
    // A stale snapshot may still carry the chat it is simultaneously retracting; the
    // more specific statement has to win, or the row would be resurrected each time.
    await report(DAEMON, id, [{ id: '-1001', name: 'First group' }], undefined, undefined, false, ['-1001'])

    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])
  })

  // §14.3 DM rows are exempt from authoritative deletion (no snapshot can list them),
  // so an explicit retraction is the ONLY way one ever goes.
  it('retracts a DM row, which no authoritative snapshot could delete', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)

    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'im' }], undefined, undefined, false)
    expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['D1'])

    await report(DAEMON, id, [], undefined, undefined, false, ['D1'])
    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])
  })

  it('hot-pushes collaboration routes after both channel joins and removals', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const collabRoutes = new CollabRoutesService(
      new PgDaemonRepo(prisma),
      new PgIntegrationRepo(prisma),
      new PgAgentRepo(prisma),
      { collabRoutes: () => undefined } as unknown as RelayControlSender,
      spy as unknown as ControlSender
    )

    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }], new AgentMutationGate(), collabRoutes)
    expect(spy.collaboration.at(-1)).toMatchObject({
      daemonId: DAEMON,
      snapshot: {
        channels: [
          {
            orgId: DEFAULT_ORG_ID,
            platform: 'slack',
            channelId: 'C1',
            agents: [{ agentId: integration.agentId, integrationId: id, daemonId: DAEMON }]
          }
        ]
      }
    })

    await report(DAEMON, id, [], new AgentMutationGate(), collabRoutes)
    expect(spy.collaboration.at(-1)).toMatchObject({
      daemonId: DAEMON,
      snapshot: { channels: [] }
    })
  })

  it('keeps an accepted membership snapshot when its best-effort route push fails', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    await expect(
      report(DAEMON, id, [{ id: 'C1', name: 'deploys' }], new AgentMutationGate(), {
        broadcast: async () => Promise.reject(new Error('offline'))
      } as unknown as CollabRoutesService)
    ).resolves.toBeUndefined()
    expect(await prisma.integrationChannel.count({ where: { integrationId: id, channelId: 'C1' } })).toBe(1)
  })

  it('drops a report from a daemon that does not own the integration', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    await report(OTHER_DAEMON, id, [{ id: 'C1', name: 'deploys' }])
    expect(await prisma.integrationChannel.count()).toBe(0)
  })

  it('drops a source report while the integration agent is moving', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const mutations = new AgentMutationGate()
    const releaseMove = mutations.tryBeginMove(integration.agentId)!
    try {
      await report(DAEMON, id, [{ id: 'C1', name: 'stale-source' }], mutations)
      expect(await prisma.integrationChannel.count()).toBe(0)
    } finally {
      releaseMove()
    }
  })

  it('rechecks daemon ownership after taking the mutation lease', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const stored = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const agents = new PgAgentRepo(prisma)
    let firstRead = true
    const frame = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'integration/channels',
      payload: { integrationId: id, channels: [{ id: 'C1', name: 'late-source' }] }
    } as AnyFrame
    // The served set is what admission reads, so the move lands between its two evaluations.
    const deps = {
      integration: new PgIntegrationRepo(prisma),
      agent: {
        listForDaemon: async (daemonId: Parameters<typeof agents.listForDaemon>[0]) => {
          const rows = await agents.listForDaemon(daemonId)
          if (firstRead) {
            firstRead = false
            await prisma.agent.update({ where: { id: stored.agentId }, data: { daemonId: OTHER_DAEMON } })
          }
          return rows
        },
        listByIds: (ids: Parameters<typeof agents.listByIds>[0]) => agents.listByIds(ids),
        getUnscoped: (agentId: Parameters<typeof agents.getUnscoped>[0]) => agents.getUnscoped(agentId)
      },
      clock: systemClock,
      integrationChannel: new PgIntegrationChannelRepo(prisma),
      agentMutations: new AgentMutationGate()
    } as unknown as DaemonWsDeps

    await handleIntegrationChannels(frame, { daemonId: DAEMON } as DaemonConnection, deps)
    expect(await prisma.integrationChannel.count()).toBe(0)
  })
})

describe('PATCH /integrations/:id/channels/:channelId — a Linear team row', () => {
  const patch = async (integrationId: string, body: Record<string, unknown>, channelId = 'team_eng') =>
    await running!.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${integrationId}/channels/${channelId}`,
      payload: body
    })

  it('takes a TRIGGER write like any other conversation, and mutes only that team', async () => {
    // "review-bot handles ENG but stays out of DESIGN" is one row's setting (§15), so Off is open
    // here — and it is per team for the whole bot, never a per-member value.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const { integrationId } = await installLinear(running)

    expect((await patch(integrationId, { trigger: 'off' })).statusCode).toBe(200)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const dto = (res.json() as { id: string; channels: { channelId: string; trigger: string }[] }[]).find(
      (d) => d.id === integrationId
    )
    expect(dto!.channels).toContainEqual(expect.objectContaining({ channelId: 'team_eng', trigger: 'off' }))
    expect(dto!.channels).toContainEqual(expect.objectContaining({ channelId: 'team_design', trigger: 'mention' }))
  })

  it('moves one team’s owner and leaves every other team’s where it was', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const first = await installLinear(running)
    const second = await addLinearMember(running, first.botId)

    const res = await patch(first.integrationId, { agentId: second.agentId })
    expect(res.statusCode).toBe(200)

    const list = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const rows = (list.json() as { id: string; channels: { channelId: string; agentId: string }[] }[]).filter((d) =>
      [first.integrationId, second.integrationId].includes(d.id)
    )
    for (const dto of rows) {
      expect(dto.channels).toContainEqual(expect.objectContaining({ channelId: 'team_eng', agentId: second.agentId }))
      expect(dto.channels).toContainEqual(expect.objectContaining({ channelId: 'team_design', agentId: first.agentId }))
    }
  })

  it('leaves both writes working on an ordinary platform', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }])

    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/C1`,
      payload: { trigger: 'off' }
    })
    expect(res.statusCode).toBe(200)
    const list = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const dto = (list.json() as { id: string; channels: { channelId: string; trigger: string }[] }[]).find(
      (d) => d.id === id
    )
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'C1', trigger: 'off' })])
  })
})

describe('PATCH /integrations/:id/channels/:channelId', () => {
  it('projects and updates one shared-channel owner consistently across member integrations', async () => {
    await seedDaemon(prisma, DAEMON)
    const alice = randomUUID()
    const bob = randomUUID()
    const botId = randomUUID()
    const aliceIntegration = randomUUID()
    const bobIntegration = randomUUID()
    await seedAgent(prisma, alice, { daemonId: DAEMON })
    await seedAgent(prisma, bob, { daemonId: DAEMON })
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'shared-bot',
        shareable: true,
        transport: 'http'
      }
    })
    await prisma.integration.createMany({
      data: [
        {
          id: aliceIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId: alice,
          botId,
          platform: 'slack',
          name: 'shared-bot'
        },
        {
          id: bobIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId: bob,
          botId,
          platform: 'slack',
          name: 'shared-bot'
        }
      ]
    })
    await prisma.integrationChannel.createMany({
      data: [
        {
          integrationId: aliceIntegration,
          channelId: 'C1',
          name: 'deploys',
          trigger: 'any',
          agentId: alice
        },
        {
          integrationId: bobIntegration,
          channelId: 'C1',
          name: 'deploys',
          trigger: 'mention',
          agentId: null
        },
        {
          integrationId: aliceIntegration,
          channelId: 'D1',
          name: '@Alice',
          kind: 'im',
          trigger: 'off',
          agentId: alice
        },
        {
          integrationId: bobIntegration,
          channelId: 'D1',
          name: '@Alice',
          kind: 'im',
          trigger: 'any',
          agentId: bob
        }
      ]
    })
    running = buildHttpApp(prisma)

    let listed = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    let shared = (
      listed.json() as Array<{
        botId: string
        channels: Array<{ channelId: string; agentId: string; trigger: string }>
      }>
    ).filter((integration) => integration.botId === botId)
    expect(shared).toHaveLength(2)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'C1')?.agentId === alice
      )
    ).toBe(true)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'C1')?.trigger === 'any'
      )
    ).toBe(true)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'D1')?.agentId === alice
      )
    ).toBe(true)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'D1')?.trigger === 'off'
      )
    ).toBe(true)

    const changed = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${aliceIntegration}/channels/C1`,
      payload: { agentId: bob }
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ agentId: bob, trigger: 'any' })

    const stored = await prisma.integrationChannel.findMany({
      where: { integration: { botId }, channelId: 'C1' }
    })
    expect(stored.find((channel) => channel.integrationId === aliceIntegration)?.agentId).toBeNull()
    expect(stored.find((channel) => channel.integrationId === bobIntegration)).toMatchObject({
      agentId: bob,
      trigger: 'any'
    })

    await prisma.integrationChannel.delete({
      where: { integrationId_channelId: { integrationId: bobIntegration, channelId: 'D1' } }
    })
    const directChanged = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${aliceIntegration}/channels/D1`,
      payload: { agentId: bob }
    })
    expect(directChanged.statusCode).toBe(200)
    expect(directChanged.json()).toMatchObject({ kind: 'im', agentId: bob, trigger: 'off' })

    const directStored = await prisma.integrationChannel.findMany({
      where: { integration: { botId }, channelId: 'D1' }
    })
    expect(directStored.find((channel) => channel.integrationId === aliceIntegration)?.agentId).toBeNull()
    expect(directStored.find((channel) => channel.integrationId === bobIntegration)).toMatchObject({
      kind: 'im',
      agentId: bob,
      trigger: 'off'
    })

    listed = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    shared = (
      listed.json() as Array<{
        botId: string
        channels: Array<{ channelId: string; agentId: string; trigger: string }>
      }>
    ).filter((integration) => integration.botId === botId)
    expect(
      shared.every((integration) => integration.channels.find((channel) => channel.channelId === 'C1')?.agentId === bob)
    ).toBe(true)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'C1')?.trigger === 'any'
      )
    ).toBe(true)
    expect(
      shared.every((integration) => integration.channels.find((channel) => channel.channelId === 'D1')?.agentId === bob)
    ).toBe(true)
    expect(
      shared.every(
        (integration) => integration.channels.find((channel) => channel.channelId === 'D1')?.trigger === 'off'
      )
    ).toBe(true)

    const cleared = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${aliceIntegration}/channels/C1`,
      payload: { agentId: null }
    })
    expect(cleared.statusCode).toBe(400)

    // Simulate a new install whose membership snapshot has not arrived, then
    // remove the sole-row owner. Pre-delete convergence must backfill the
    // survivor with both channel metadata and the effective trigger.
    await prisma.integrationChannel.delete({
      where: { integrationId_channelId: { integrationId: aliceIntegration, channelId: 'C1' } }
    })
    const removed = await running.app.inject({
      method: 'DELETE',
      url: `${ORG}/integrations/${bobIntegration}`
    })
    expect(removed.statusCode).toBe(204)
    expect(
      await prisma.integrationChannel.findUnique({
        where: { integrationId_channelId: { integrationId: aliceIntegration, channelId: 'C1' } }
      })
    ).toMatchObject({ agentId: alice, trigger: 'any' })
  })

  it('projects a hidden canonical owner but refuses to mutate it through a visible sibling', async () => {
    const users = new PgUserRepo(prisma)
    const subject = `channel-auth-${randomUUID()}`
    const email = `${subject}@acme.dev`
    const { userId } = await users.provisionOidcUser({ oidcSubject: subject, email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')

    await seedDaemon(prisma, DAEMON)
    const alice = randomUUID()
    const bob = randomUUID()
    const botId = randomUUID()
    const aliceIntegration = randomUUID()
    const bobIntegration = randomUUID()
    await seedAgent(prisma, alice, { daemonId: DAEMON })
    await seedAgent(prisma, bob, {
      daemonId: DAEMON,
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'restricted-owner-bot',
        shareable: true,
        transport: 'http'
      }
    })
    await prisma.integration.createMany({
      data: [
        {
          id: aliceIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId: alice,
          botId,
          platform: 'slack',
          name: 'restricted-owner-bot'
        },
        {
          id: bobIntegration,
          orgId: DEFAULT_ORG_ID,
          agentId: bob,
          botId,
          platform: 'slack',
          name: 'restricted-owner-bot'
        }
      ]
    })
    await prisma.integrationChannel.createMany({
      data: [
        {
          integrationId: aliceIntegration,
          channelId: 'C1',
          name: 'deploys',
          trigger: 'mention',
          agentId: null
        },
        {
          integrationId: bobIntegration,
          channelId: 'C1',
          name: 'deploys',
          trigger: 'any',
          agentId: bob
        }
      ]
    })
    running = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })

    const listed = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const visible = (
      listed.json() as Array<{
        agentId: string
        botId: string
        channels: Array<{ agentId: string; trigger: string }>
      }>
    ).filter((integration) => integration.botId === botId)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      agentId: alice,
      channels: [expect.objectContaining({ agentId: bob, trigger: 'any' })]
    })

    const denied = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${aliceIntegration}/channels/C1`,
      payload: { trigger: 'mention' }
    })
    expect(denied.statusCode).toBe(403)
    expect(
      await prisma.integrationChannel.findUnique({
        where: { integrationId_channelId: { integrationId: bobIntegration, channelId: 'C1' } }
      })
    ).toMatchObject({ agentId: bob, trigger: 'any' })

    await prisma.integrationChannel.update({
      where: { integrationId_channelId: { integrationId: bobIntegration, channelId: 'C1' } },
      data: { agentId: null }
    })
    await prisma.integrationChannel.update({
      where: { integrationId_channelId: { integrationId: aliceIntegration, channelId: 'C1' } },
      data: { agentId: alice, trigger: 'any' }
    })
    const deniedTarget = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${aliceIntegration}/channels/C1`,
      payload: { agentId: bob }
    })
    expect(deniedTarget.statusCode).toBe(403)
  })

  it("persists the trigger and pushes integration/upsert with the channel-scoped 'auto' rule", async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'releases' }
    ])
    spy.upserts.length = 0

    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/C2`,
      payload: { trigger: 'any' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      channelId: 'C2',
      name: 'releases',
      spaceId: null,
      space: null,
      icon: null,
      color: null,
      isPrivate: false,
      kind: 'channel',
      trigger: 'any',
      agentId: null
    })

    // The daemon got the recomputed rule set: defaults + ONE auto rule for C2.
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.daemonId).toBe(DAEMON)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.core!.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C2', match: { kind: 'auto' } }
    ])

    // Flipping back to mention removes the auto rule again.
    await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/C2`,
      payload: { trigger: 'mention' }
    })
    const u1 = spy.upserts[1]!.u
    if (u1.platform !== 'slack') throw new Error('expected slack integration')
    expect(u1.core!.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
  })

  it('404s on an unknown channel or integration', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)

    const missChannel = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/CUNKNOWN`,
      payload: { trigger: 'any' }
    })
    expect(missChannel.statusCode).toBe(404)

    const missIntegration = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${randomUUID()}/channels/C1`,
      payload: { trigger: 'any' }
    })
    expect(missIntegration.statusCode).toBe(404)
  })
})

/**
 * The two console actions that end a conversation's listing. They are deliberately
 * different things: forgetting touches only AgentConnect, leaving touches the
 * platform — so they are tested for what each does NOT do as much as what it does.
 */
describe('DELETE …/channels/:channelId (forget) and POST …/leave (platform)', () => {
  it('forgets a row without asking the daemon to touch the platform', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)
    await report(DAEMON, id, [
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'releases' }
    ])

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/C1` })

    expect(res.statusCode).toBe(204)
    expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['C2'])
    expect(spy.leaves).toEqual([]) // the bot was never touched on Slack
    // Slack re-lists its membership authoritatively, so that listing governs the row
    // and a tombstone would add nothing — demanding one would only make Forget fail
    // whenever a Slack daemon is offline.
    expect(spy.forgets).toEqual([])
    // It still gets the recomputed spec, or its routing would keep the row.
    expect(spy.upserts.at(-1)!.daemonId).toBe(DAEMON)
  })

  it('404s a row that is not there, so a double-click cannot read as success', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, new SpyControl() as unknown as ControlSender)
    const id = await install(running)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/nope` })
    expect(res.statusCode).toBe(404)
  })

  it('asks the owning daemon to leave, then forgets the row', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await installTelegram(running)
    const channels = new PgIntegrationChannelRepo(prisma)
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }], undefined, undefined, false)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'conversation', channel: 'C1' } }
    })

    expect(res.statusCode).toBe(204)
    expect(spy.leaves).toEqual([
      { daemonId: DAEMON, l: { integrationId: id, target: { kind: 'conversation', channel: 'C1' } } }
    ])
    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])
  })

  // The useful half of a failure: a missing scope or a last-member channel is
  // something the operator can act on, so it must survive to the response.
  it("relays the platform's own refusal as 502 and keeps the row", async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    spy.leaveVerdict = { ok: false, error: 'missing_scope' }
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }])

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'conversation', channel: 'C1' } }
    })

    expect(res.statusCode).toBe(502)
    expect((res.json() as { message: string }).message).toBe('missing_scope')
    // Still a member as far as anyone knows, so the row stays.
    expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['C1'])
  })

  // A cold move re-places the agent and rebuilds its channel state on the new daemon.
  // Dispatching the platform call to the pre-move daemon and then deleting rows the
  // move has already rewritten would leave the new daemon believing it is still in a
  // channel the bot has actually left.
  it('refuses to leave while an agent move holds the lease, and never reaches the platform', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    const mutations = new AgentMutationGate()
    running = buildHttpApp(
      prisma,
      undefined,
      undefined,
      spy as unknown as ControlSender,
      {
        agentMutations: mutations
      } as never
    )
    const id = await install(running)
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }])
    const stored = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const channels = new PgIntegrationChannelRepo(prisma)

    const releaseMove = mutations.tryBeginMove(stored.agentId)!
    try {
      const res = await running.app.inject({
        method: 'POST',
        url: `${ORG}/integrations/${id}/leave`,
        payload: { target: { kind: 'conversation', channel: 'C1' } }
      })
      expect(res.statusCode).toBe(409)
      expect(spy.leaves).toEqual([]) // the platform was never told anything
      // …and the row is untouched, so the two sides cannot disagree.
      expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['C1'])
    } finally {
      releaseMove()
    }
  })

  // §14.3 gives each install its OWN DM row, so fanning a forget across the bot
  // would let an editor of one agent silently drop another agent's direct message.
  it('forgets a DM row on this install only, never across the bot', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const channels = new PgIntegrationChannelRepo(prisma)
    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'im' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/D1` })

    expect(res.statusCode).toBe(204)
    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])
  })

  // The suppression is what makes the removal stick, so a daemon that never got it
  // WILL list the conversation again — reporting 204 would be a lie found out later.
  it('refuses to forget when the suppression cannot reach the daemon', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    spy.forgetThrows = new NoConnection(DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await installTelegram(running)
    await report(DAEMON, id, [{ id: 'C1', name: 'deploys' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/C1` })

    expect(res.statusCode).toBe(502)
    expect((res.json() as { message: string }).message).toContain('offline')
    // The row must SURVIVE. Deleting it and then reporting failure would leave the
    // console empty while telling the operator it failed — and the advised retry would
    // 404 on the already-deleted row instead of re-attempting the suppression.
    const channels = new PgIntegrationChannelRepo(prisma)
    expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['C1'])

    // …so the retry the message advises actually works once the daemon is back.
    spy.forgetThrows = null
    const retried = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/C1` })
    expect(retried.statusCode).toBe(204)
    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])
  })

  // The rule the two cases above encode, stated once: suppression exists only for the
  // platforms whose rows are rebuilt from session history.
  it('pushes the suppression for a session-derived platform', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await installTelegram(running)
    await report(DAEMON, id, [{ id: '-100123', name: 'Team' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/-100123` })

    expect(res.statusCode).toBe(204)
    expect(spy.forgets).toEqual([{ daemonId: DAEMON, f: { integrationId: id, channels: ['-100123'] } }])
  })

  // The two arms below are one rule read off the §5 manifest's
  // `leaveGranularity` (audit F12): a request whose target shape the platform
  // cannot serve is refused HERE — before an owner resolves, before the mutation
  // lease, before any daemon is reached — so neither ever dispatches.
  it('refuses a space-scoped leave on a platform whose bot leaves conversations', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running) // Slack

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'space', spaceId: 'G1' } }
    })

    expect(res.statusCode).toBe(400)
    expect(spy.leaves).toEqual([]) // never reached the daemon
  })

  it('refuses a conversation-scoped leave on a platform whose bot joins a space', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await installDiscord(running)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'conversation', channel: 'C1' } }
    })

    expect(res.statusCode).toBe(400)
    expect(spy.leaves).toEqual([])
  })

  it('dispatches a space-scoped leave on the platform that has one', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await installDiscord(running)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'space', spaceId: 'G1' } }
    })

    expect(res.statusCode).toBe(204)
    expect(spy.leaves).toEqual([
      { daemonId: DAEMON, l: { integrationId: id, target: { kind: 'space', spaceId: 'G1' } } }
    ])
  })
})

/**
 * The pool half of every conversation path (#1026, #1027): a POOL agent is placed and names no
 * machine, so a snapshot admitted by `agent.daemonId` was dropped in silence, and Forget / Leave
 * refused on a column that could never be filled.
 */
describe('conversation paths for a POOL agent', () => {
  const MEMBER = 'd9999999-9999-4999-8999-999999999999'
  const GROUP = '00000000-0000-4000-8000-0000000009d1'

  /** A pool agent whose duty MEMBER holds, with a Telegram install (the session-derived
   *  platform, so Forget must reach a daemon) — plus the id of that install. */
  async function heldInstall(app: HttpApp, platform: 'slack' | 'telegram'): Promise<string> {
    const setId = await seedPoolMember(prisma, MEMBER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId, createdByUserId: DEFAULT_OWNER_ID })
    await seedDutyGroup(prisma, GROUP, MEMBER, [agentId])
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload:
        platform === 'slack'
          ? { name: 'pool-bot', platform, agentId, slack: SLACK }
          : { name: 'pool-tg', platform, agentId, telegram: { botToken: '123456:AAE-xyz' } }
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { id: string }).id
  }

  it('accepts a channel snapshot from the member holding the duty, and no one else (#1027)', async () => {
    await seedDaemon(prisma, OTHER_DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await heldInstall(running, 'slack')
    const channels = new PgIntegrationChannelRepo(prisma)

    // A daemon that holds no duty for the agent writes nothing — silently, as before.
    await report(OTHER_DAEMON, id, [{ id: 'C1', name: 'deploys' }])
    expect(await channels.listForIntegration(IntegrationId(id))).toEqual([])

    await report(MEMBER, id, [{ id: 'C1', name: 'deploys' }])
    expect((await channels.listForIntegration(IntegrationId(id))).map((c) => c.channelId)).toEqual(['C1'])
  })

  it('pushes Forget to the duty holder instead of refusing as undeliverable (#1026)', async () => {
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await heldInstall(running, 'telegram')
    await report(MEMBER, id, [{ id: '-100123', name: 'Team' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${id}/channels/-100123` })

    expect(res.statusCode).toBe(204)
    expect(spy.forgets).toEqual([{ daemonId: MEMBER, f: { integrationId: id, channels: ['-100123'] } }])
    expect(await new PgIntegrationChannelRepo(prisma).listForIntegration(IntegrationId(id))).toEqual([])
  })

  it('dispatches Leave to the duty holder (#1026)', async () => {
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await heldInstall(running, 'telegram')
    await report(MEMBER, id, [{ id: 'C1', name: 'deploys' }], undefined, undefined, false)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/${id}/leave`,
      payload: { target: { kind: 'conversation', channel: 'C1' } }
    })

    expect(res.statusCode).toBe(204)
    expect(spy.leaves).toEqual([
      { daemonId: MEMBER, l: { integrationId: id, target: { kind: 'conversation', channel: 'C1' } } }
    ])
  })
})
