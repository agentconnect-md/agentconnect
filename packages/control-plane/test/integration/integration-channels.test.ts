/**
 * Per-channel trigger config, end to end on the CP side:
 *
 *  - `integration/channels` (D→C EVT) converges `integration_channel` to the
 *    daemon's membership snapshot — new channels default to '@-mention', names
 *    refresh, channels the bot left are dropped, and the operator's trigger
 *    choice SURVIVES re-reports (latest-wins on membership, never on trigger).
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
import { PgDaemonRepo, PgIntegrationRepo, PgIntegrationChannelRepo } from '../../src/persistence/index.js'
import { handleIntegrationChannels } from '../../src/ws/handlers/index.js'
import { IntegrationId } from '../../src/domain/ids.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import type { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import type { AnyFrame, CollabRoutesSnapshot, IntegrationUpsert, IntegrationChannel } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

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
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
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
  collabRoutes = { broadcast: async () => undefined } as unknown as CollabRoutesService
): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/channels',
    payload: { integrationId, channels }
  } as AnyFrame
  const deps = {
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: new PgIntegrationChannelRepo(prisma),
    agentMutations,
    collabRoutes
  } as unknown as DaemonWsDeps
  await handleIntegrationChannels(frame, { daemonId } as DaemonConnection, deps)
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
      { channelId: 'C1', name: 'deploys', isPrivate: false, trigger: 'mention', agentId: null },
      { channelId: 'C2', name: 'releases', isPrivate: true, trigger: 'mention', agentId: null }
    ])
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

  it('hot-pushes collaboration routes after both channel joins and removals', async () => {
    await seedDaemon(prisma, DAEMON)
    const spy = new SpyControl()
    running = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
    const id = await install(running)
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id } })
    const collabRoutes = new CollabRoutesService(
      new PgDaemonRepo(prisma),
      new PgIntegrationRepo(prisma),
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
    expect(res.json()).toEqual({ channelId: 'C2', name: 'releases', isPrivate: false, trigger: 'any', agentId: null })

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
