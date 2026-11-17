/** `integration/room-grant` (resource-visibility.md §14.10): a conversation-gated agent's own new room opens to it, and to nothing wider. */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgBotRepo, PgIntegrationRepo, PgIntegrationChannelRepo } from '../../src/persistence/index.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { IntegrationId } from '../../src/domain/ids.js'
import { handleIntegrationChannels, handleIntegrationRoomGrant } from '../../src/ws/handlers/index.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import type { CollabRoutesService } from '../../src/orchestrator/collabRoutes.service.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame, IntegrationChannel, IntegrationRoomGrant } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const ORIGIN = 'C0ORIGIN'
const ROOM = 'C0ROOM'

let running: HttpApp | undefined
let converged: unknown[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  converged = []
  relayRooms = undefined
})

const quietControl = {
  integrationUpsert: async () => undefined,
  integrationRemove: async () => undefined,
  collaborationRoutes: async () => undefined
} as unknown as ControlSender

const channels = () => new PgIntegrationChannelRepo(prisma)

function wsDeps(): DaemonWsDeps {
  return {
    integration: new PgIntegrationRepo(prisma),
    integrationChannel: channels(),
    agent: new PgAgentRepo(prisma),
    bot: new PgBotRepo(prisma),
    dutyLease: new PgDutyGroupRepo(prisma),
    clock: systemClock,
    agentMutations: new AgentMutationGate(),
    collabRoutes: { broadcast: async () => undefined } as unknown as CollabRoutesService,
    connReg: { get: () => undefined },
    integrationConverge: async (agent: unknown) => void converged.push(agent),
    ...(relayRooms ? { httpBotRooms: relayRooms } : {}),
    log: { warn: () => undefined }
  } as unknown as DaemonWsDeps
}

/** What a relay-hosted bot's orchestrator was asked, when a test stands one in. */
let relayRooms: DaemonWsDeps['httpBotRooms'] | undefined

const frameOf = (type: string, payload: unknown): AnyFrame =>
  ({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload }) as AnyFrame

/** An integration on a restricted agent placed on DAEMON, with `ORIGIN` reported and, unless told otherwise, enabled by a person. */
async function gatedIntegration(opts: { restricted?: boolean; originEnabled?: boolean } = {}): Promise<string> {
  await seedDaemon(prisma, DAEMON)
  running = buildHttpApp(prisma, undefined, undefined, quietControl)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await running.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      name: 'acme-bot',
      platform: 'slack',
      agentId,
      slack: { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }
    }
  })
  expect(res.statusCode).toBe(201)
  const id = (res.json() as { id: string }).id
  if (opts.restricted !== false)
    await prisma.agent.update({
      where: { id: agentId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
  await reportChannels(id, [{ id: ORIGIN, name: 'deploys' }])
  if (opts.originEnabled !== false)
    await channels().setTrigger(IntegrationId(id), ORIGIN, { trigger: 'mention' }, { chosen: true })
  return id
}

async function reportChannels(integrationId: string, reported: IntegrationChannel[]): Promise<void> {
  const frame = frameOf('integration/channels', { integrationId, channels: reported })
  await handleIntegrationChannels(frame, { daemonId: DAEMON } as DaemonConnection, wsDeps())
}

/** Send one room-grant request through the real handler; resolves to the `open` it was answered with. */
async function grant(payload: IntegrationRoomGrant, daemonId = DAEMON): Promise<boolean> {
  let open: boolean | undefined
  const conn = {
    daemonId,
    replyTo: (_frame: AnyFrame, type: string, body: { open: boolean }) => {
      expect(type).toBe('integration/room-grant/ok')
      open = body.open
    },
    sendError: (_id: string, code: string, message: string) => {
      throw new Error(`${code}: ${message}`)
    }
  } as unknown as DaemonConnection
  await handleIntegrationRoomGrant(frameOf('integration/room-grant', payload), conn, wsDeps())
  if (open === undefined) throw new Error('the handler did not reply')
  return open
}

const triggerOf = async (integrationId: string, channelId: string) =>
  (
    await prisma.integrationChannel.findUnique({
      where: { integrationId_channelId: { integrationId, channelId } },
      select: { trigger: true, triggerChosen: true }
    })
  )?.trigger

describe('integration/room-grant: a gated agent’s own new room', () => {
  it('opens the room on Mention as a default, and republishes the agent’s rules', async () => {
    const id = await gatedIntegration()

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opening' })).toBe(true)
    expect(await triggerOf(id, ROOM)).toBeUndefined()
    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(true)

    const row = await prisma.integrationChannel.findUniqueOrThrow({
      where: { integrationId_channelId: { integrationId: id, channelId: ROOM } }
    })
    expect(row).toMatchObject({ trigger: 'mention', triggerChosen: false, kind: 'channel' })
    expect(converged).toHaveLength(1)
  })

  it('opens a room a membership report already created at the Off default', async () => {
    const id = await gatedIntegration()
    await reportChannels(id, [
      { id: ORIGIN, name: 'deploys' },
      { id: ROOM, name: 'task', isCodeSession: true }
    ])
    expect(await triggerOf(id, ROOM)).toBe('off')

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(true)
    expect(await triggerOf(id, ROOM)).toBe('mention')
  })

  it('leaves a room a person turned Off closed, on a retry too', async () => {
    const id = await gatedIntegration()
    await reportChannels(id, [
      { id: ORIGIN, name: 'deploys' },
      { id: ROOM, name: 'task', isCodeSession: true }
    ])
    await channels().setTrigger(IntegrationId(id), ROOM, { trigger: 'off' }, { chosen: true })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(false)
      expect(await triggerOf(id, ROOM)).toBe('off')
    }
    expect(converged).toHaveLength(0)
  })

  it('opens nothing from a conversation that is itself Off, or unknown', async () => {
    const id = await gatedIntegration({ originEnabled: false })

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opening' })).toBe(false)
    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(false)
    expect(await grant({ integrationId: id, origin: 'C0NOWHERE', phase: 'opened', channel: ROOM })).toBe(false)
    expect(await triggerOf(id, ROOM)).toBeUndefined()
  })

  it('opens only the room named: the agent’s other conversations stay Off', async () => {
    const id = await gatedIntegration()
    await reportChannels(id, [
      { id: ORIGIN, name: 'deploys' },
      { id: 'C0OTHER', name: 'elsewhere' }
    ])

    await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })

    expect(await triggerOf(id, 'C0OTHER')).toBe('off')
  })

  it('opens nothing over an existing conversation that is not a code session', async () => {
    const id = await gatedIntegration()
    await reportChannels(id, [
      { id: ORIGIN, name: 'deploys' },
      { id: 'C0OTHER', name: 'elsewhere' }
    ])

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: 'C0OTHER' })).toBe(false)
    expect(await triggerOf(id, 'C0OTHER')).toBe('off')
  })

  it('refuses a daemon that does not serve the agent, and an abandoned creation', async () => {
    const id = await gatedIntegration()
    await seedDaemon(prisma, OTHER_DAEMON)

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM }, OTHER_DAEMON)).toBe(false)
    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'abandoned' })).toBe(false)
    expect(await triggerOf(id, ROOM)).toBeUndefined()
  })

  it('does nothing for an agent whose conversations start open', async () => {
    const id = await gatedIntegration({ restricted: false })

    expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(false)
    expect(await triggerOf(id, ROOM)).toBeUndefined()
  })

  describe('on a relay-hosted bot', () => {
    /** Flip the fixture's bot to relay ingress and stand in for its orchestrator. */
    async function relayHosted(id: string): Promise<{ botId: string; asked: string[] }> {
      const { botId } = await prisma.integration.findUniqueOrThrow({ where: { id }, select: { botId: true } })
      await prisma.bot.update({ where: { id: botId }, data: { transport: 'http', shareable: true } })
      const asked: string[] = []
      relayRooms = {
        granted: async (bot, integrationId, channelId) => {
          asked.push(`granted ${bot} ${integrationId} ${channelId}`)
          return false
        },
        opening: async (bot, integrationId) => {
          asked.push(`opening ${bot} ${integrationId}`)
          return true
        },
        abandoned: async (bot) => void asked.push(`abandoned ${bot}`),
        open: async (bot, integrationId, channelId) => {
          asked.push(`open ${bot} ${integrationId} ${channelId}`)
          return true
        }
      }
      return { botId, asked }
    }

    it('hands an ungated agent’s room to the orchestrator, which settles its owner, whatever the origin', async () => {
      const id = await gatedIntegration({ restricted: false, originEnabled: false })
      const { botId, asked } = await relayHosted(id)

      expect(await grant({ integrationId: id, origin: 'C0NOWHERE', phase: 'opening' })).toBe(true)
      expect(await grant({ integrationId: id, origin: 'C0NOWHERE', phase: 'opened', channel: ROOM })).toBe(true)
      expect(await grant({ integrationId: id, origin: 'C0NOWHERE', phase: 'abandoned' })).toBe(false)

      expect(asked).toEqual([`opening ${botId} ${id}`, `open ${botId} ${id} ${ROOM}`, `abandoned ${botId}`])
    })

    it('asks the orchestrator whether a gated agent holds a grant in the origin, and opens nothing without one', async () => {
      const id = await gatedIntegration()
      const { botId, asked } = await relayHosted(id)

      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opening' })).toBe(false)
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(false)
      expect(asked).toEqual([`granted ${botId} ${id} ${ORIGIN}`, `granted ${botId} ${id} ${ORIGIN}`])
    })

    // The reviewed case: on a shared bot a sibling's row repeats the owner's trigger, so only the compiled grant can say who is enabled.
    it('opens nothing from a conversation a sibling owns, and opens the room once the gated agent owns the origin', async () => {
      const id = await gatedIntegration()
      const gated = await prisma.integration.findUniqueOrThrow({
        where: { id },
        select: { botId: true, agentId: true }
      })
      await prisma.bot.update({ where: { id: gated.botId }, data: { transport: 'http', shareable: true } })
      const siblingAgent = randomUUID()
      await seedAgent(prisma, siblingAgent, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
      const admission = await running!.deps.repos.integration.addBotMembership({
        id: IntegrationId(randomUUID()),
        orgId: DEFAULT_ORG_ID as never,
        agentId: siblingAgent as never,
        botId: gated.botId as never,
        platform: 'slack',
        name: 'acme-bot'
      } as never)
      if (!('integration' in admission)) throw new Error(`unexpected membership outcome: ${admission.outcome}`)
      const sibling = IntegrationId(admission.integration.id)
      const httpBot = running!.deps.httpBot
      relayRooms = {
        granted: (bot, integrationId, channelId) => httpBot.memberGranted(bot, integrationId, channelId),
        opening: (bot, integrationId) => httpBot.roomOpening(bot, integrationId),
        abandoned: (bot) => httpBot.roomAbandoned(bot),
        open: (bot, integrationId, channelId) => httpBot.openRoom(bot, integrationId, channelId)
      }

      // The ungated sibling owns the origin; the gated agent's row still reads Mention.
      await channels().upsertAgent(sibling, ORIGIN, siblingAgent as never)
      expect(await triggerOf(id, ORIGIN)).toBe('mention')
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opening' })).toBe(false)
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(false)
      expect(await triggerOf(id, ROOM)).toBeUndefined()

      // Enabled there itself, as the origin's owner, the same request opens the room to it.
      await channels().setAgent(sibling, ORIGIN, null)
      await channels().upsertAgent(IntegrationId(id), ORIGIN, gated.agentId as never)
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opening' })).toBe(true)
      expect(await grant({ integrationId: id, origin: ORIGIN, phase: 'opened', channel: ROOM })).toBe(true)
      const room = await prisma.integrationChannel.findUniqueOrThrow({
        where: { integrationId_channelId: { integrationId: id, channelId: ROOM } }
      })
      expect(room).toMatchObject({ trigger: 'mention', triggerChosen: false, agentId: gated.agentId })
    })
  })
})
