/** `DELETE /agents/:id` cascades the agent's installs with no uninstall running, so it must settle their bots itself (shared-bot-relay.md §10.1). */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgIntegrationChannelRepo } from '../../src/persistence/index.js'
import { AgentId, IntegrationId } from '../../src/domain/ids.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

const quietControl = {
  integrationUpsert: async () => undefined,
  integrationRemove: async () => undefined,
  agentRemove: async () => undefined,
  collaborationRoutes: async () => undefined
} as unknown as ControlSender

const channels = () => new PgIntegrationChannelRepo(prisma)

/** An agent placed on DAEMON with its own Slack bot; returns the agent, its install and the bot. */
async function agentWithBot(): Promise<{ agentId: string; integrationId: string; botId: string }> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await running!.app.inject({
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
  const integrationId = (res.json() as { id: string }).id
  const { botId } = await prisma.integration.findUniqueOrThrow({
    where: { id: integrationId },
    select: { botId: true }
  })
  return { agentId, integrationId, botId }
}

/** A second agent installed on the same bot, which becomes relay-hosted and shared. */
async function sibling(botId: string): Promise<{ agentId: string; integrationId: string }> {
  await prisma.bot.update({ where: { id: botId }, data: { transport: 'http', shareable: true } })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const admission = await running!.deps.repos.integration.addBotMembership({
    id: IntegrationId(randomUUID()),
    orgId: DEFAULT_ORG_ID as never,
    agentId: agentId as never,
    botId: botId as never,
    platform: 'slack',
    name: 'acme-bot'
  } as never)
  if (!('integration' in admission)) throw new Error(`unexpected membership outcome: ${admission.outcome}`)
  return { agentId, integrationId: admission.integration.id }
}

const deleteAgent = (agentId: string) => running!.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })

const rowsOf = (channelId: string) =>
  prisma.integrationChannel.findMany({
    where: { channelId },
    select: { integrationId: true, agentId: true, trigger: true }
  })

describe('DELETE /agents/:id settles the bots its installs sat on', () => {
  it('passes a shared bot’s conversations it owned to the remaining agent, keeping their trigger', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, quietControl)
    const first = await agentWithBot()
    const second = await sibling(first.botId)
    // The second agent owns C0OWNED on All messages; the first has no row for it yet.
    await channels().upsertAgent(IntegrationId(second.integrationId), 'C0OWNED', AgentId(second.agentId), {
      defaultTrigger: 'any',
      kind: 'channel'
    })

    expect((await deleteAgent(second.agentId)).statusCode).toBe(204)

    expect(await rowsOf('C0OWNED')).toEqual([
      { integrationId: first.integrationId, agentId: first.agentId, trigger: 'any' }
    ])
  })

  it('stamps a bot the deleted agent was the last to use as freed, under that agent’s name', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, quietControl)
    const only = await agentWithBot()
    const { name } = await prisma.agent.findUniqueOrThrow({ where: { id: only.agentId }, select: { name: true } })
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: only.botId }, select: { lastAgentName: true } })
    expect(before.lastAgentName).toBeNull()

    expect((await deleteAgent(only.agentId)).statusCode).toBe(204)

    const after = await prisma.bot.findUniqueOrThrow({
      where: { id: only.botId },
      select: { lastAgentName: true, lastUsedAt: true }
    })
    expect(after.lastAgentName).toBe(name)
    expect(after.lastUsedAt).not.toBeNull()
  })

  it('leaves a shared bot another agent still uses unstamped', async () => {
    await seedDaemon(prisma, DAEMON)
    running = buildHttpApp(prisma, undefined, undefined, quietControl)
    const first = await agentWithBot()
    const second = await sibling(first.botId)

    expect((await deleteAgent(second.agentId)).statusCode).toBe(204)

    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: first.botId }, select: { lastAgentName: true } })
    expect(bot.lastAgentName).toBeNull()
  })
})
