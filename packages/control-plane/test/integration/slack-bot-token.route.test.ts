// `POST /bots/:id/slack/token`: a custom Slack app's new bot token lands in place, so a revoked bot's integrations come back intact.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationUpsert, IntegrationRemove } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { SLACK_BOT_SCOPES } from '../../src/http/slack-manifest.js'
import type { SlackBotVerification } from '../../src/http/slack-identity.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const APP_ID = 'A0CUSTOM01'
const TEAM_ID = 'T0CUSTOM01'
const RELAY = { PUBLIC_RELAY_URL: 'https://relay.example.test' }

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

let running: HttpApp[] = []

afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function withSpy(config: Record<string, string> = RELAY): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, config, undefined, spy as unknown as ControlSender)
  running.push(app)
  return { app, spy }
}

function identity(over: Partial<Extract<SlackBotVerification, { status: 'ok' }>> = {}): SlackBotVerification {
  return {
    status: 'ok',
    name: 'custom-app',
    appId: APP_ID,
    botUserId: 'U0CUSTOM01',
    teamId: TEAM_ID,
    teamName: 'Acme',
    scopes: [...SLACK_BOT_SCOPES],
    ...over
  }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

/** A custom http app installed through the manual token path. */
async function installHttpBot(app: HttpApp, agentId: string): Promise<{ id: string; botId: string }> {
  app.platformStubs.verifySlackBot = async () => identity()
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      name: 'custom-app',
      platform: 'slack',
      agentId,
      transport: 'http',
      slack: { botToken: 'xoxb-original', signingSecret: 'signing-secret-kept' }
    }
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; botId: string }
}

/** A custom socket app installed through the manual token path. */
async function installSocketBot(app: HttpApp, agentId: string): Promise<{ id: string; botId: string }> {
  app.platformStubs.verifySlackBot = async () => identity()
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      name: 'socket-app',
      platform: 'slack',
      agentId,
      slack: { botToken: 'xoxb-original', appToken: `xapp-1-${APP_ID}-123-abcdef` }
    }
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; botId: string }
}

function replaceToken(app: HttpApp, botId: string, botToken: string) {
  return app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/token`, payload: { botToken } })
}

describe('POST /bots/:id/slack/token', () => {
  it('reconnects a revoked custom bot in place: same integration, settings and schedule target', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const relaySends: Array<{ type: string; payload: unknown }> = []
    app.relayReg.add({
      relayId: 'r1',
      send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
      close() {}
    } as RelayChannel)
    const created = await installHttpBot(app, agentId)
    await prisma.integrationChannel.create({
      data: {
        integrationId: created.id,
        channelId: 'C0DEPLOYS',
        name: 'deploys',
        trigger: 'any',
        triggerChosen: true,
        sessionMode: 'append'
      }
    })
    const cronId = randomUUID()
    await prisma.cronDef.create({
      data: {
        id: cronId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        schedule: '0 9 * * 1',
        timezone: 'UTC',
        targetChannel: 'C0DEPLOYS',
        targetIntegrationId: created.id,
        trigger: 'weekly report'
      }
    })
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId } })
    await app.deps.httpBot.revokeBot(created.botId, 'app_uninstalled')
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: 'revoked'
    })
    spy.upserts.length = 0
    relaySends.length = 0

    const res = await replaceToken(app, created.botId, 'xoxb-reinstalled')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: created.botId, revokedAt: null, agentIds: [agentId] })
    expect(JSON.stringify(res.json())).not.toContain('xoxb-')
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision + 1)
    expect(after.revokedAt).toBeNull()
    expect(after.secret).toMatchObject({ botToken: 'xoxb-reinstalled', signingSecret: 'signing-secret-kept' })
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      agentId,
      status: 'active',
      revokedCredentialRevision: null
    })
    expect(await prisma.integration.count({ where: { botId: created.botId } })).toBe(1)
    expect(
      await prisma.integrationChannel.findUniqueOrThrow({
        where: { integrationId_channelId: { integrationId: created.id, channelId: 'C0DEPLOYS' } }
      })
    ).toMatchObject({ trigger: 'any', triggerChosen: true, sessionMode: 'append' })
    expect(await prisma.cronDef.findUniqueOrThrow({ where: { id: cronId } })).toMatchObject({
      targetIntegrationId: created.id
    })
    // The relay re-arms ingress and the daemon gets the send-only bundle, both carrying the new token.
    const assign = relaySends.find((send) => send.type === 'rc/bot-assign')?.payload as {
      secrets: Record<string, unknown>
    }
    expect(assign.secrets).toMatchObject({ botToken: 'xoxb-reinstalled', signingSecret: 'signing-secret-kept' })
    expect(spy.upserts.map(({ daemonId, u }) => ({ daemonId, integrationId: u.integrationId }))).toEqual([
      { daemonId: DAEMON, integrationId: created.id }
    ])
    expect(spy.upserts[0]!.u.config).toMatchObject({ botToken: 'xoxb-reinstalled' })
  })

  it('rotates a live socket bot: the revision advances and the daemon receives the new token beside the kept app token', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const created = await installSocketBot(app, agentId)
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId } })
    spy.upserts.length = 0
    app.platformStubs.verifySlackBot = async () => identity({ scopes: ['chat:write', 'app_mentions:read'] })

    const res = await replaceToken(app, created.botId, 'xoxb-rotated')

    expect(res.statusCode).toBe(200)
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision + 1)
    expect(after.grantedScopes).toEqual(['chat:write', 'app_mentions:read'])
    expect(after.secret).toMatchObject({ botToken: 'xoxb-rotated', appToken: `xapp-1-${APP_ID}-123-abcdef` })
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]).toMatchObject({
      daemonId: DAEMON,
      u: {
        integrationId: created.id,
        config: { botToken: 'xoxb-rotated', appToken: `xapp-1-${APP_ID}-123-abcdef` }
      }
    })
  })

  it.each([
    ['app', identity({ appId: 'A0SOMEONEELSE' })],
    ['workspace', identity({ teamId: 'T0SOMEWHERE' })]
  ])('refuses a token from a different %s without touching the credential', async (_label, checked) => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const created = await installSocketBot(app, agentId)
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId } })
    spy.upserts.length = 0
    app.platformStubs.verifySlackBot = async () => checked

    const res = await replaceToken(app, created.botId, 'xoxb-foreign')

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      message: 'this token belongs to a different Slack app or workspace than this bot'
    })
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision)
    expect(after.secret?.botToken).toBe('xoxb-original')
    expect(spy.upserts).toHaveLength(0)
  })

  it('carries Slack’s own code when Slack rejects the token, and refuses when Slack cannot be reached', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = await installSocketBot(app, agentId)

    app.platformStubs.verifySlackBot = async () => ({ status: 'invalid', error: 'token_revoked' })
    const rejected = await replaceToken(app, created.botId, 'xoxb-dead')
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: 'token_revoked' })

    app.platformStubs.verifySlackBot = async () => ({ status: 'unreachable' })
    const unreachable = await replaceToken(app, created.botId, 'xoxb-unchecked')
    expect(unreachable.statusCode).toBe(502)

    expect((await prisma.botSecret.findUniqueOrThrow({ where: { botId: created.botId } })).botToken).toBe(
      'xoxb-original'
    )
  })

  it('refuses a malformed token before calling Slack', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = await installSocketBot(app, agentId)
    let calls = 0
    app.platformStubs.verifySlackBot = async () => {
      calls += 1
      return identity()
    }

    const res = await replaceToken(app, created.botId, 'xapp-1-not-a-bot-token')

    expect(res.statusCode).toBe(400)
    expect(calls).toBe(0)
  })

  it('refuses the built-in app, whose remedy is a reinstall', async () => {
    const { app } = withSpy()
    const botId = randomUUID()
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'AgentConnect',
        transport: 'http',
        prebuilt: true,
        slackAppId: APP_ID,
        teamId: TEAM_ID
      }
    })
    app.platformStubs.verifySlackBot = async () => identity()

    const res = await replaceToken(app, botId, 'xoxb-builtin')

    expect(res.statusCode).toBe(409)
  })

  it('answers 404 for an unknown bot, another organization’s bot, and a non-Slack bot', async () => {
    const { app } = withSpy()
    app.platformStubs.verifySlackBot = async () => identity()
    const otherOrg = `org-slack-token-${randomUUID()}`
    await prisma.org.create({ data: { id: otherOrg, slug: otherOrg } })
    const foreignBot = randomUUID()
    await prisma.bot.create({
      data: { id: foreignBot, orgId: otherOrg, platform: 'slack', name: 'foreign', transport: 'socket' }
    })
    const telegramBot = randomUUID()
    await prisma.bot.create({
      data: { id: telegramBot, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: 'tg', transport: 'socket' }
    })

    for (const botId of [randomUUID(), foreignBot, telegramBot]) {
      expect((await replaceToken(app, botId, 'xoxb-anything')).statusCode).toBe(404)
    }
  })

  it('refuses a viewer', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = await installSocketBot(app, agentId)
    const users = new PgUserRepo(prisma)
    const email = 'slack-token-viewer@example.test'
    const { userId } = await users.provisionOidcUser({ oidcSubject: 'slack-token-viewer', email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'viewer')
    const { app: viewerApp } = withSpy({ ...RELAY, DEFAULT_OWNER_ID: userId })
    viewerApp.platformStubs.verifySlackBot = async () => identity()

    const res = await replaceToken(viewerApp, created.botId, 'xoxb-viewer')

    expect(res.statusCode).toBe(403)
    expect((await prisma.botSecret.findUniqueOrThrow({ where: { botId: created.botId } })).botToken).toBe(
      'xoxb-original'
    )
  })
})
