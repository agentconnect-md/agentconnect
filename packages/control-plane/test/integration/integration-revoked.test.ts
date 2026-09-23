// `integration/revoked` end to end on the CP: a serving daemon's socket report revokes its Slack bot; anyone else's is refused.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AnyFrame, IntegrationUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo, PgBotRepo, PgIntegrationRepo } from '../../src/persistence/index.js'
import { handleIntegrationRevoked } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { BotRecord } from '../../src/persistence/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-fixture-123', appToken: 'xapp-1-fixture-456' }
// The identity `auth.test` stored for the bot at install, which the reporting socket must name.
const IDENTITY = { botUserId: 'U0FIXTURE', workspaceId: 'T0FIXTURE' }

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records the spec pushes a revocation makes to member daemons. */
class SpyControl {
  readonly removals: Array<{ daemonId: string; integrationId: string }> = []
  async integrationUpsert(_daemonId: string, _u: IntegrationUpsert): Promise<void> {}
  async integrationRemove(daemonId: string, r: { integrationId: string }): Promise<void> {
    this.removals.push({ daemonId, integrationId: r.integrationId })
  }
  async collaborationRoutes(): Promise<void> {}
}

/** A socket Slack integration on an agent placed on DAEMON. */
async function install(): Promise<{ app: HttpApp; spy: SpyControl; integrationId: string; botId: string }> {
  await seedDaemon(prisma, DAEMON)
  await seedDaemon(prisma, OTHER_DAEMON)
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID })
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
  })
  expect(res.statusCode).toBe(201)
  const integrationId = (res.json() as { id: string }).id
  const { botId } = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })
  const bot = await prisma.bot.update({ where: { id: botId }, data: IDENTITY })
  expect(bot.transport).toBe('socket')
  return { app, spy, integrationId, botId }
}

/** Dispatch one `integration/revoked` REQ through the real handler, as `daemonId` of `orgId`. */
async function report(
  app: HttpApp,
  opts: {
    daemonId?: string
    orgId?: string
    integrationIds: string[]
    eventAtMs: number
    identity?: { botUserId: string; workspaceId: string }
  }
): Promise<{ replies: unknown[]; errors: unknown[]; refusals: unknown[] }> {
  const replies: unknown[] = []
  const errors: unknown[] = []
  const refusals: unknown[] = []
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'integration/revoked',
    payload: {
      integrationIds: opts.integrationIds,
      reason: 'app_uninstalled',
      eventAtMs: opts.eventAtMs,
      ...(opts.identity ?? IDENTITY)
    }
  } as AnyFrame
  const conn = {
    daemonId: opts.daemonId ?? DAEMON,
    orgId: opts.orgId ?? DEFAULT_ORG_ID,
    replyTo: (_req: AnyFrame, type: string, payload: unknown) => void replies.push({ type, payload }),
    sendError: (_id: string, code: string, _message: string, retryable: boolean) =>
      void errors.push({ code, retryable })
  } as unknown as DaemonConnection
  const deps = {
    log: { error: () => {}, warn: (o: unknown) => void refusals.push(o) },
    integration: new PgIntegrationRepo(prisma),
    agent: new PgAgentRepo(prisma),
    bot: new PgBotRepo(prisma),
    socketBotRevocation: {
      matches: (bot: BotRecord, reported: { botUserId: string; workspaceId: string }) =>
        app.deps.platforms.get(bot.platform)?.socketLifecycleRevocation?.(bot, reported) === true,
      revoke: (botId: string, reason: 'app_uninstalled' | 'tokens_revoked', eventAtMs: number) =>
        app.deps.httpBot.revokeBot(botId, reason, { eventAtMs })
    }
  } as unknown as DaemonWsDeps
  await handleIntegrationRevoked(frame, conn, deps)
  return { replies, errors, refusals }
}

const state = async (integrationId: string, botId: string) => ({
  integration: (await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).status,
  revokedAt: (await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).revokedAt
})

describe('integration/revoked → socket bot revocation', () => {
  it('revokes the bot, flips its integrations, and pulls the spec off the serving daemon', async () => {
    const { app, spy, integrationId, botId } = await install()

    const { replies, errors } = await report(app, { integrationIds: [integrationId], eventAtMs: Date.now() + 1_000 })

    expect(errors).toEqual([])
    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: true } }])
    const after = await state(integrationId, botId)
    expect(after.integration).toBe('revoked')
    expect(after.revokedAt).toBeInstanceOf(Date)
    expect(spy.removals).toEqual([{ daemonId: DAEMON, integrationId }])
  })

  it('treats a duplicate report as settled without writing anything', async () => {
    const { app, spy, integrationId, botId } = await install()
    await report(app, { integrationIds: [integrationId], eventAtMs: Date.now() + 1_000 })
    const first = await state(integrationId, botId)

    const { replies } = await report(app, { integrationIds: [integrationId], eventAtMs: Date.now() + 2_000 })

    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: true } }])
    expect(await state(integrationId, botId)).toEqual(first)
    expect(spy.removals).toHaveLength(1)
  })

  it('refuses a daemon that does not serve the integration', async () => {
    const { app, spy, integrationId, botId } = await install()

    const { replies, refusals } = await report(app, {
      daemonId: OTHER_DAEMON,
      integrationIds: [integrationId],
      eventAtMs: Date.now() + 1_000
    })

    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    expect(refusals).toMatchObject([{ integrationId, daemonId: OTHER_DAEMON }])
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
    expect(spy.removals).toEqual([])
  })

  it("refuses a report naming another organization's integration", async () => {
    const { app, integrationId, botId } = await install()
    const otherOrg = `org-${randomUUID()}`
    await prisma.org.create({ data: { id: otherOrg, slug: otherOrg } })

    const { replies } = await report(app, {
      orgId: otherOrg,
      integrationIds: [integrationId],
      eventAtMs: Date.now() + 1_000
    })

    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
  })

  it("refuses a relay bot, whose revocation is the relay's to report", async () => {
    const { app, integrationId, botId } = await install()
    await prisma.bot.update({ where: { id: botId }, data: { transport: 'http' } })

    const { replies } = await report(app, { integrationIds: [integrationId], eventAtMs: Date.now() + 1_000 })

    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
  })

  it("refuses a socket whose bot user or workspace is not the integration's current bot", async () => {
    const { app, spy, integrationId, botId } = await install()

    // A socket the integration was re-keyed away from still names the old bot user; one of another workspace names that.
    for (const identity of [
      { ...IDENTITY, botUserId: 'U0PREVIOUS' },
      { ...IDENTITY, workspaceId: 'T0ELSEWHERE' }
    ]) {
      const { replies } = await report(app, {
        integrationIds: [integrationId],
        eventAtMs: Date.now() + 1_000,
        identity
      })
      expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    }
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
    expect(spy.removals).toEqual([])
  })

  it('refuses every report while the stored bot has no bot user or workspace to match', async () => {
    const { app, integrationId, botId } = await install()

    for (const missing of [{ botUserId: null }, { workspaceId: null }]) {
      await prisma.bot.update({ where: { id: botId }, data: { ...IDENTITY, ...missing } })
      const { replies } = await report(app, { integrationIds: [integrationId], eventAtMs: Date.now() + 1_000 })
      expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    }
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
  })

  it('fences an event older than the credential it would revoke', async () => {
    const { app, spy, integrationId, botId } = await install()
    const { credentialInstalledAt } = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })

    const { replies } = await report(app, {
      integrationIds: [integrationId],
      eventAtMs: credentialInstalledAt!.getTime() - 60_000
    })

    expect(replies).toEqual([{ type: 'integration/revoked/ok', payload: { applied: false } }])
    expect(await state(integrationId, botId)).toEqual({ integration: 'active', revokedAt: null })
    expect(spy.removals).toEqual([])
  })
})
