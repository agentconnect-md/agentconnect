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
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgDaemonRepo, PgIntegrationRepo, PgIntegrationChannelRepo } from '../../src/persistence/index.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { handleIntegrationChannels } from '../../src/ws/handlers/index.js'
import { IntegrationId } from '../../src/domain/ids.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
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

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  readonly collaboration: Array<{ daemonId: string; snapshot: CollabRoutesSnapshot }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
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

/** Dispatch a hand-built `integration/channels` EVT through the real handler. */
async function report(
  daemonId: string,
  integrationId: string,
  channels: IntegrationChannel[],
  agentMutations = new AgentMutationGate(),
  collabRoutes = { broadcast: async () => undefined } as unknown as CollabRoutesService,
  authoritative?: boolean
): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/channels',
    payload: { integrationId, channels, ...(authoritative === undefined ? {} : { authoritative }) }
  } as AnyFrame
  const deps = {
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    agent: new PgAgentRepo(prisma),
    agentMutations,
    collabRoutes
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

  it("a restricted agent's fresh conversations default to OFF, and DM rows survive a membership re-report (§14)", async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({ where: { id: integration.agentId }, data: { visibility: 'restricted' } })

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

  it('stores a DM discovered while the agent is public as OFF, so a later gate stays closed (§14.3)', async () => {
    // Observed-conversation discovery reports DMs whatever the agent's visibility, and
    // visibility can flip later — at which point gatedBindRules enables every non-Off IM
    // row. A DM stored with the ordinary 'mention' default would therefore keep being
    // answered by a now-private agent that no operator ever enabled it for.
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
    expect(byId.get('D1')).toMatchObject({ kind: 'im', trigger: 'off' })
    expect(byId.get('C1')).toMatchObject({ kind: 'channel', trigger: 'mention' })

    spy.upserts.length = 0
    const put = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(put.statusCode).toBe(200)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.slack.gated).toBe(true)
    // No dm rule for D1: the private agent answers that DM only once enabled.
    expect(u0.slack.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])
  })

  it('resets the trigger when a row misclassified as a channel converts to a DM (§14.3)', async () => {
    // Session-history discovery cannot tell a DM from a group, so a DM could already be
    // stored as a channel carrying a channel's trigger. That is not an operator's DM
    // choice, so the conversion must not inherit it into the gated DM rule set.
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })

    await report(DAEMON, id, [{ id: 'D1', name: '@alice' }], undefined, undefined, false)
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'D1', 'any')
    // The daemon now knows it is a DM and re-reports it as one.
    await report(DAEMON, id, [{ id: 'D1', name: '@alice', kind: 'im' }], undefined, undefined, false)

    const res = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    const [dto] = res.json() as { channels: { channelId: string; kind: string; trigger: string }[] }[]
    expect(dto!.channels).toEqual([expect.objectContaining({ channelId: 'D1', kind: 'im', trigger: 'off' })])

    spy.upserts.length = 0
    await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.slack.bindRules).toEqual([])
  })

  it('stores a group DM OFF and keeps a channel→group-DM conversion fail-closed (§14.3)', async () => {
    // Slack classifies a group DM late: an `app_mention` payload carries no
    // channel_type, so the conversation first lands as a channel with a channel's
    // trigger. That is not an operator's choice for this conversation, so resolving it
    // must reset to Off — and an authoritative channel snapshot (which can never list a
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
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'off' })

    // An operator enables it; a later authoritative channel snapshot leaves it alone.
    await new PgIntegrationChannelRepo(prisma).setTrigger(IntegrationId(id), 'G1', 'mention')
    await report(DAEMON, id, [{ id: 'C1', name: 'general' }])
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'mention' })

    // A daemon restart loses the classification cache, so the next app_mention is
    // re-reported as a provisional channel — and the daemon stamps a kind on every
    // observed row, so this arrives as an EXPLICIT 'channel', not the absent-kind case
    // the existing preservation rule covers. Accepting it would flip the row twice and
    // reset the operator's trigger to Off on every restart.
    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1', kind: 'channel' }], undefined, undefined, false)
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'mention' })
    // The daemon's own conversations.info correction lands afterwards and is a no-op.
    await report(DAEMON, id, [{ id: 'G1', name: 'mpim-alice--bob-1', kind: 'mpim' }], undefined, undefined, false)
    expect((await channelsOf()).get('G1')).toMatchObject({ kind: 'mpim', trigger: 'mention' })
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

  it('keeps the DM conversion fail-closed when a kind-less and an IM report OVERLAP (§14.3)', async () => {
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
    expect(row).toMatchObject({ channelId: 'D1', kind: 'im', trigger: 'off' })

    spy.upserts.length = 0
    await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.slack.bindRules).toEqual([])
  })

  it('enabling conversations on a GATED integration pushes conversation-scoped rules ONLY (§14)', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    await prisma.agent.update({ where: { id: integration.agentId }, data: { visibility: 'restricted' } })
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
    expect(u0.slack.gated).toBe(true)
    expect(u0.slack.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])

    await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${id}/channels/D1`,
      payload: { trigger: 'any' }
    })
    const u1 = spy.upserts[1]!.u
    if (u1.platform !== 'slack') throw new Error('expected slack integration')
    expect(u1.slack.bindRules).toHaveLength(2)
    expect(u1.slack.bindRules).toEqual(
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
      payload: { visibility: 'restricted', sharedWith: [] }
    })
    expect(put.statusCode).toBe(200)
    expect(spy.upserts).toHaveLength(1)
    const u0 = spy.upserts[0]!.u
    if (u0.platform !== 'slack') throw new Error('expected slack integration')
    expect(u0.slack.gated).toBe(true)
    // The pre-flip channel row keeps its 'mention' trigger — grandfathered enabled.
    expect(u0.slack.bindRules).toEqual([{ channel: 'C1', match: { kind: 'mention' } }])

    const back = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${integration.agentId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    expect(back.statusCode).toBe(200)
    const u1 = spy.upserts[1]!.u
    if (u1.platform !== 'slack') throw new Error('expected slack integration')
    expect(u1.slack.gated).toBe(false)
    expect(u1.slack.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
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
    const scoped = new PgIntegrationRepo(prisma)
    let firstRead = true
    const frame = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'integration/channels',
      payload: { integrationId: id, channels: [{ id: 'C1', name: 'late-source' }] }
    } as AnyFrame
    const deps = {
      integration: {
        activeForDaemon: async (daemonId: Parameters<typeof scoped.activeForDaemon>[0]) => {
          const rows = await scoped.activeForDaemon(daemonId)
          if (firstRead) {
            firstRead = false
            await prisma.agent.update({ where: { id: stored.agentId }, data: { daemonId: OTHER_DAEMON } })
          }
          return rows
        }
      },
      integrationChannel: new PgIntegrationChannelRepo(prisma),
      agentMutations: new AgentMutationGate()
    } as unknown as DaemonWsDeps

    await handleIntegrationChannels(frame, { daemonId: DAEMON } as DaemonConnection, deps)
    expect(await prisma.integrationChannel.count()).toBe(0)
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
        }
      ]
    })
    running = buildHttpApp(prisma)

    let listed = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    let shared = (
      listed.json() as Array<{ botId: string; channels: Array<{ agentId: string; trigger: string }> }>
    ).filter((integration) => integration.botId === botId)
    expect(shared).toHaveLength(2)
    expect(shared.every((integration) => integration.channels[0]?.agentId === alice)).toBe(true)
    expect(shared.every((integration) => integration.channels[0]?.trigger === 'any')).toBe(true)

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

    listed = await running.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    shared = (listed.json() as Array<{ botId: string; channels: Array<{ agentId: string; trigger: string }> }>).filter(
      (integration) => integration.botId === botId
    )
    expect(shared.every((integration) => integration.channels[0]?.agentId === bob)).toBe(true)
    expect(shared.every((integration) => integration.channels[0]?.trigger === 'any')).toBe(true)

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
    await seedAgent(prisma, bob, { daemonId: DAEMON, visibility: 'restricted' })
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
    expect(u0.slack.bindRules).toEqual([
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
    expect(u1.slack.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
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
