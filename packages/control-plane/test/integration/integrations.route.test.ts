/**
 * Integration install flow over the C2 REST surface (design
 * docs/designs/slack-integration-install.md).
 *
 * POST /integrations resolves the bot identity two ways — register a new bot
 * from pasted tokens (`slack`, stored via the BotSecretStore seam) or reuse an
 * existing FREE bot (`botId`) — then pushes `integration/upsert` (carrying the
 * tokens) to the owning agent's daemon so it opens the Socket Mode socket. The
 * owning agent must already be placed (409 otherwise); the DTOs never return
 * tokens; DELETE removes the install but KEEPS the bot (freed for reuse) and
 * pushes `integration/remove`. An offline daemon (NoConnection) never fails the
 * request. GET /bots surfaces the durable identities for the console picker.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationUpsert, IntegrationRemove } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { BotId, OrgId } from '../../src/domain/ids.js'
import type { SlackConfigApi } from '../../src/http/slack-config-api.js'
import { SLACK_BOT_EVENTS, SLACK_BOT_SCOPES } from '../../src/http/slack-manifest.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { SlackBotIdentityReconciler } from '../../src/orchestrator/slackBotIdentityReconciler.js'
import { systemClock } from '../../src/domain/clock.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A ControlSender spy recording the integration pushes the route makes. */
class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  readonly removes: Array<{ daemonId: string; r: IntegrationRemove }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationRemove(daemonId: string, r: IntegrationRemove): Promise<void> {
    this.removes.push({ daemonId, r })
  }
}

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const SLACK = { botToken: 'xoxb-abc-123', appToken: 'xapp-1-def-456' }
const ALL_BOT_PLATFORMS = ['slack', 'telegram', 'discord', 'feishu']

function daemonCapabilities(platforms: string[]) {
  return { platforms, runtimes: ['claude'], acp: true, features: [] }
}

function withSpy(): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender)
  running = app
  return { app, spy }
}

async function placedAgent(platforms = ALL_BOT_PLATFORMS): Promise<string> {
  await seedDaemon(prisma, DAEMON, { capabilities: daemonCapabilities(platforms) })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

describe('integration install flow (REST → integration/upsert·remove)', () => {
  it('POST refuses a platform the owning daemon has not reported, before storing credentials', async () => {
    const agentId = await placedAgent(['slack'])
    const { app, spy } = withSpy()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'telegram', agentId, telegram: { botToken: '123456:AAE-xyz' } }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      error: 'Conflict',
      statusCode: 409,
      message: expect.stringContaining('telegram')
    })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST with tokens on a PLACED agent registers a bot + secret, returns no tokens, pushes integration/upsert', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'acme-bot', platform: 'slack', agentId, status: 'active' })
    // The DTO must NOT leak tokens.
    expect(JSON.stringify(dto)).not.toContain('xoxb-')
    expect(JSON.stringify(dto)).not.toContain('xapp-')

    // The durable bot row exists; the secret row holds the plaintext (only place it lives).
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId as string } })
    expect(bot).toMatchObject({ name: 'acme-bot', platform: 'slack' })
    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId as string } })
    expect(secret).toMatchObject({ botToken: SLACK.botToken, appToken: SLACK.appToken })

    // The daemon got the full spec WITH tokens (so it can open the socket).
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.daemonId).toBe(DAEMON)
    expect(spy.upserts[0]!.u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'slack',
      slack: { botToken: SLACK.botToken, appToken: SLACK.appToken }
    })
  })

  it('POST a socket bot with shareable:true degrades — the flag is coerced off (never a shareable Socket Mode bot)', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      // socket transport (default) + shareable:true — used to 400, now silently ignored.
      payload: { name: 'acme-bot', platform: 'slack', agentId, shareable: true, slack: SLACK }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string }
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId } })
    expect(bot?.transport).toBe('socket')
    expect(bot?.shareable).toBe(false) // coerced: a socket bot is never shareable
  })

  it('POST an HTTP Slack bot persists the app id resolved from its bot token', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    app.deps.verifySlackBot = async () => ({
      status: 'ok',
      name: 'http-bot',
      appId: 'AHTTPBOT',
      teamId: 'T1',
      scopes: []
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'slack',
        agentId,
        transport: 'http',
        slack: { botToken: SLACK.botToken, signingSecret: 'signing-secret' }
      }
    })

    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string }
    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      transport: 'http',
      slackAppId: 'AHTTPBOT'
    })
  })

  it('POST telegram registers a bot + secret with a NULL appToken, pushes a telegram-shaped upsert', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-tg', platform: 'telegram', agentId, telegram: { botToken: '123456:AAE-xyz' } }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'acme-tg', platform: 'telegram', agentId, status: 'active' })
    expect(JSON.stringify(dto)).not.toContain('123456:') // no token leak

    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId as string } })
    expect(secret).toMatchObject({ botToken: '123456:AAE-xyz', appToken: null })

    // The daemon got a telegram-shaped spec (single botToken, no slack block).
    expect(spy.upserts).toHaveLength(1)
    const u = spy.upserts[0]!.u
    if (u.platform !== 'telegram') throw new Error('expected telegram upsert')
    expect(u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'telegram',
      telegram: { botToken: '123456:AAE-xyz' }
    })
  })

  it('POST discord registers a bot + secret with a NULL appToken, decodes the app id, pushes a discord-shaped upsert', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()

    // A deliberately invalid credential whose first segment still base64url-decodes
    // to the application (client) id we persist for the "Add to Discord" invite.
    const DISCORD_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.fixture.not-a-secret'
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-dc', platform: 'discord', agentId, discord: { botToken: DISCORD_TOKEN } }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'acme-dc', platform: 'discord', agentId, status: 'active' })
    expect(JSON.stringify(dto)).not.toContain('.Gxxxxx.') // no token leak

    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId as string } })
    expect(secret).toMatchObject({ botToken: DISCORD_TOKEN, appToken: null })
    // The application (client) id is decoded from the token and persisted (public metadata).
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId as string } })
    expect(bot).toMatchObject({ platform: 'discord', discordAppId: '123456789012345678', slackAppId: null })

    // The daemon got a discord-shaped spec (single botToken, no slack block).
    expect(spy.upserts).toHaveLength(1)
    const u = spy.upserts[0]!.u
    if (u.platform !== 'discord') throw new Error('expected discord upsert')
    expect(u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'discord',
      discord: { botToken: DISCORD_TOKEN }
    })
  })

  it('POST rejects a discord bot token Discord refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.deps.verifyDiscordBot = async () => ({ status: 'invalid' })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId, discord: { botToken: 'MTA1-bot.token.abc' } }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST discord derives the bot name from users/@me, and proceeds when Discord is unreachable', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifyDiscordBot = async () => ({ status: 'ok', name: 'matrix#4242' })

    const named = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId, discord: { botToken: 'MTA1-bot.token.abc' } } // NO name
    })
    expect(named.statusCode).toBe(201)
    expect((named.json() as { name: string }).name).toBe('matrix#4242')

    // Unreachable is best-effort, not a gate: a second agent installs fine, name falls back.
    const agentId2 = randomUUID()
    await seedAgent(prisma, agentId2, { daemonId: DAEMON })
    app.deps.verifyDiscordBot = async () => ({ status: 'unreachable' })
    const unreachable = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId: agentId2, discord: { botToken: 'MTA1-bot.token.abc' } }
    })
    expect(unreachable.statusCode).toBe(201)
    expect((unreachable.json() as { name: string }).name).toBe(`agent-${agentId2.slice(0, 4)}`)
  })

  it('POST feishu defaults omitted region to Lark, stores the credential pair, and pushes a feishu-shaped upsert', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()

    const FEISHU = { appId: 'cli_a1b2c3d4', appSecret: 's3cr3t-value-xyz' }
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-fs', platform: 'feishu', agentId, feishu: FEISHU }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'acme-fs', platform: 'feishu', agentId, status: 'active' })
    expect(JSON.stringify(dto)).not.toContain(FEISHU.appSecret) // no secret leak

    // Two-slot reuse: botToken carries the SECRET, appToken carries the (semi-public) app id.
    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId as string } })
    expect(secret).toMatchObject({ botToken: FEISHU.appSecret, appToken: FEISHU.appId })
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId as string } })
    expect(bot).toMatchObject({ platform: 'feishu', feishuAppId: FEISHU.appId, feishuRegion: 'lark' })

    // The bot roster exposes only the public app id + region needed for the
    // developer-console link; the secret never leaves bot_secret.
    const botsRes = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })
    expect(botsRes.statusCode).toBe(200)
    expect(botsRes.json()).toEqual([
      expect.objectContaining({
        id: dto.botId,
        feishuAppId: FEISHU.appId,
        feishuRegion: 'lark'
      })
    ])
    expect(botsRes.body).not.toContain(FEISHU.appSecret)

    // The daemon got a feishu-shaped spec: appId + appSecret, no slack/discord block.
    expect(spy.upserts).toHaveLength(1)
    const u = spy.upserts[0]!.u
    if (u.platform !== 'feishu') throw new Error('expected feishu upsert')
    expect(u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'feishu',
      // New installs default to the international Lark gateway when region is omitted.
      feishu: { appId: FEISHU.appId, appSecret: FEISHU.appSecret, region: 'lark' }
    })
    expect(dto.region).toBe('lark')
  })

  it("POST feishu with region 'feishu' verifies against + pushes the China gateway", async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const verifierCalls: Array<string | undefined> = []
    app.deps.verifyFeishuBot = async (_appId, _appSecret, region) => {
      verifierCalls.push(region)
      return { status: 'ok', name: null }
    }

    const FEISHU = { appId: 'cli_feishu123', appSecret: 's3cr3t-feishu-xyz', region: 'feishu' as const }
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-feishu', platform: 'feishu', agentId, feishu: FEISHU }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    expect(dto.region).toBe('feishu')

    // Explicit Feishu selection overrides the new Lark default.
    expect(verifierCalls).toEqual(['feishu'])

    // The daemon's spec carries region 'feishu' so its SDK dials open.feishu.cn.
    const u = spy.upserts[0]!.u
    if (u.platform !== 'feishu') throw new Error('expected feishu upsert')
    expect(u.feishu).toMatchObject({ appId: FEISHU.appId, region: 'feishu' })

    // Persisted on the integration row so a reconnect reconstructs the same region.
    const row = await prisma.integration.findUnique({ where: { id: dto.id as string } })
    expect(row?.feishuRegion).toBe('feishu')
  })

  it('POST rejects feishu credentials Feishu refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.deps.verifyFeishuBot = async () => ({ status: 'invalid' })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId, feishu: { appId: 'cli_bad', appSecret: 'wrong' } }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST feishu derives the bot name from bot/v3/info, and proceeds when Feishu is unreachable', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifyFeishuBot = async () => ({ status: 'ok', name: 'Matrix Bot' })

    const named = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId, feishu: { appId: 'cli_a', appSecret: 's' } } // NO name
    })
    expect(named.statusCode).toBe(201)
    expect((named.json() as { name: string }).name).toBe('Matrix Bot')

    // Unreachable is best-effort, not a gate: a second agent installs fine, name falls back.
    const agentId2 = randomUUID()
    await seedAgent(prisma, agentId2, { daemonId: DAEMON })
    app.deps.verifyFeishuBot = async () => ({ status: 'unreachable' })
    const unreachable = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId: agentId2, feishu: { appId: 'cli_a', appSecret: 's' } }
    })
    expect(unreachable.statusCode).toBe(201)
    expect((unreachable.json() as { name: string }).name).toBe(`agent-${agentId2.slice(0, 4)}`)
  })

  it('POST rejects a mismatched credential block (platform telegram + slack tokens) with 400', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'telegram', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST without a name falls back to the owning agent name (no resolver wired)', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy() // buildHttpApp wires no resolveSlackBotName ⇒ offline fallback
    const agentName = `agent-${agentId.slice(0, 4)}` // seedAgent's naming

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK } // NO name
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { name: string }).name).toBe(agentName)
  })

  it('POST rejects a bot token Slack refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.deps.verifySlackBot = async () => ({ status: 'invalid' })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST rejects an app-level token Slack refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifySlackBot = async () => ({ status: 'ok', name: null, appId: null, teamId: null, scopes: [] })
    app.deps.verifySlackAppToken = async () => 'invalid'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
  })

  it('POST rejects valid Slack tokens that belong to different apps', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifySlackBot = async () => ({ status: 'ok', name: null, appId: 'AOTHER', teamId: null, scopes: [] })
    app.deps.verifySlackAppToken = async () => 'ok'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'slack',
        agentId,
        slack: { botToken: SLACK.botToken, appToken: 'xapp-1-AEXPECTED-456-abcdef' }
      }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ message: expect.stringContaining('different apps') })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
  })

  it('POST derives the bot name from auth.test when none is given', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifySlackBot = async () => ({
      status: 'ok',
      name: 'matrix_test',
      appId: null,
      teamId: null,
      scopes: []
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK } // NO name
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { name: string }).name).toBe('matrix_test')
  })

  it('POST proceeds when Slack is unreachable (verification is best-effort, not a gate)', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.deps.verifySlackBot = async () => ({ status: 'unreachable' })
    app.deps.verifySlackAppToken = async () => 'unreachable'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK } // NO name
    })
    expect(res.statusCode).toBe(201)
    // Name falls back to the owning agent when auth.test couldn't derive one.
    expect((res.json() as { name: string }).name).toBe(`agent-${agentId.slice(0, 4)}`)
  })

  it('POST on an UNPLACED agent is refused with 409 and stores nothing', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId) // no daemonId
    const { app, spy } = withSpy()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'x', platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(409)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST for an unknown agent is 404', async () => {
    const { app } = withSpy()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'x', platform: 'slack', agentId: randomUUID(), slack: SLACK }
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST with BOTH botId and slack (or neither) is a 400', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const both = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, botId: randomUUID(), slack: SLACK }
    })
    expect(both.statusCode).toBe(400)
    const neither = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId }
    })
    expect(neither.statusCode).toBe(400)
  })

  it('GET lists integrations as metadata only (no tokens)', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
    })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/integrations` })
    expect(res.statusCode).toBe(200)
    const list = res.json() as unknown[]
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain('xoxb-')
  })

  it('DELETE removes the integration but KEEPS the bot (freed, stamped), and pushes integration/remove', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
      })
    ).json() as { id: string; botId: string }

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })
    expect(del.statusCode).toBe(204)
    expect(await prisma.integration.findUnique({ where: { id: created.id } })).toBeNull()
    // The bot SURVIVES with its tokens, stamped with the freed-from hints.
    const bot = await prisma.bot.findUnique({ where: { id: created.botId } })
    expect(bot?.lastUsedAt).not.toBeNull()
    expect(bot?.lastAgentName).toBe(`agent-${agentId.slice(0, 4)}`)
    expect(await prisma.botSecret.findUnique({ where: { botId: created.botId } })).not.toBeNull()
    expect(spy.removes).toEqual([{ daemonId: DAEMON, r: { integrationId: created.id } }])
  })

  it('a freed bot can be reinstalled by botId — tokens reused, no new bot row', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const first = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
      })
    ).json() as { id: string; botId: string }
    await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${first.id}` })

    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: otherAgent, botId: first.botId }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string; name: string }
    expect(dto.botId).toBe(first.botId)
    expect(dto.name).toBe('acme-bot') // the bot keeps its name
    expect(await prisma.bot.count()).toBe(1) // reused, not re-created
    // The daemon still gets the tokens (from the bot's stored secret).
    expect(spy.upserts).toHaveLength(2)
    expect(spy.upserts[1]!.u).toMatchObject({ slack: { botToken: SLACK.botToken, appToken: SLACK.appToken } })
  })

  it("reinstalling a freed Lark bot by botId preserves region 'lark' (retained creds keep their gateway)", async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    // Install a Lark-region bot, then uninstall — the integration row (holding its region
    // mirror) is deleted, but the durable bot row + credentials survive.
    const first = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          platform: 'feishu',
          agentId,
          feishu: { appId: 'cli_lark123', appSecret: 's3cr3t-lark', region: 'lark' }
        }
      })
    ).json() as { id: string; botId: string }
    await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${first.id}` })
    // Region lives durably on the freed bot.
    expect((await prisma.bot.findUnique({ where: { id: first.botId } }))?.feishuRegion).toBe('lark')

    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId: otherAgent, botId: first.botId }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as Record<string, unknown>
    // The reinstall carries the region forward — NOT silently defaulted to Feishu.
    expect(dto.region).toBe('lark')
    expect((await prisma.integration.findUnique({ where: { id: dto.id as string } }))?.feishuRegion).toBe('lark')
    // The daemon's spec dials the Lark gateway for the reinstalled bot.
    const u = spy.upserts[1]!.u
    if (u.platform !== 'feishu') throw new Error('expected feishu upsert')
    expect(u.feishu.region).toBe('lark')
  })

  it('reusing a bot that is STILL installed is refused with 409', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const first = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
      })
    ).json() as { botId: string }

    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: otherAgent, botId: first.botId }
    })
    expect(res.statusCode).toBe(409)
    expect(await prisma.integration.count()).toBe(1)
  })

  it('reusing an unknown botId is 404', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, botId: randomUUID() }
    })
    expect(res.statusCode).toBe(404)
  })

  it('an offline daemon (NoConnection) does not fail the install', async () => {
    const agentId = await placedAgent()
    // A real ControlSender over an empty registry throws NoConnection on push.
    const offline = new ControlSender(
      { get: () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[0],
      { currentLaunch: async () => undefined } as unknown as ConstructorParameters<typeof ControlSender>[1]
    )
    running = buildHttpApp(prisma, undefined, undefined, offline)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(201) // stored despite the offline daemon
    expect(await prisma.integration.count()).toBe(1)
  })
})

describe('bot roster (GET/DELETE /bots)', () => {
  it('backfills a legacy HTTP Slack app id and surfaces its console deep-link metadata', async () => {
    const { app } = withSpy()
    const botId = randomUUID()
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'legacy-http',
        transport: 'http'
      }
    })
    await prisma.botSecret.create({
      data: { botId, botToken: 'xoxb-legacy', appToken: null, signingSecret: 'signing-secret' }
    })
    const reconciler = new SlackBotIdentityReconciler(
      app.deps.repos.bot,
      app.deps.repos.botSecret,
      async () => 'ALEGACYHTTP',
      systemClock,
      { intervalMs: 60_000 }
    )

    await reconciler.tick()

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([expect.objectContaining({ id: botId, slackAppId: 'ALEGACYHTTP' })])
  })

  it('GET /bots surfaces free vs in-use, freed-from hints, and never tokens', async () => {
    const agentId = await placedAgent()
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    const { app } = withSpy()
    const a = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { name: 'busy-bot', platform: 'slack', agentId, slack: SLACK }
      })
    ).json() as { id: string; botId: string }
    const b = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          name: 'freed-bot',
          platform: 'slack',
          agentId: otherAgent,
          slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0TESTAPP1-123-abcdef' }
        }
      })
    ).json() as { id: string; botId: string }
    await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${b.id}` })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })
    expect(res.statusCode).toBe(200)
    const bots = res.json() as Array<Record<string, unknown>>
    expect(bots).toHaveLength(2)
    expect(JSON.stringify(bots)).not.toContain('xoxb-')
    const busy = bots.find((x) => x.id === a.botId)!
    const freed = bots.find((x) => x.id === b.botId)!
    expect(busy.inUseByAgentId).toBe(agentId)
    expect(freed.inUseByAgentId).toBeNull()
    expect(freed.lastUsedAt).not.toBeNull()
    expect(typeof freed.freedFromAgent).toBe('string')
    // Slack app id is parsed from the pasted xapp token (console deep-link to
    // Slack's app settings); an unexpected token shape leaves it null.
    expect(freed.slackAppId).toBe('A0TESTAPP1')
    expect(busy.slackAppId).toBeNull()
  })

  it('GET /bots recovers and backfills a legacy Feishu app id through the secret store', async () => {
    const { app } = withSpy()
    const botId = BotId(randomUUID())
    const appId = 'cli_legacylark123'
    const appSecret = 'legacy-lark-secret'
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'feishu',
        name: 'legacy-lark',
        feishuRegion: 'lark'
      }
    })
    await app.deps.repos.botSecret.put(botId, {
      botToken: appSecret,
      appToken: appId,
      signingSecret: null
    })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([expect.objectContaining({ id: botId, feishuAppId: appId, feishuRegion: 'lark' })])
    expect(res.body).not.toContain(appSecret)
    expect(await prisma.bot.findUnique({ where: { id: botId } })).toMatchObject({ feishuAppId: appId })
  })

  it('DELETE /bots refuses while installed (409), succeeds once freed, and drops the secret', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { name: 'acme-bot', platform: 'slack', agentId, slack: SLACK }
      })
    ).json() as { id: string; botId: string }

    const whileInstalled = await app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${created.botId}` })
    expect(whileInstalled.statusCode).toBe(409)

    await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })
    const freed = await app.app.inject({ method: 'DELETE', url: `${ORG}/bots/${created.botId}` })
    expect(freed.statusCode).toBe(204)
    expect(await prisma.bot.findUnique({ where: { id: created.botId } })).toBeNull()
    expect(await prisma.botSecret.findUnique({ where: { botId: created.botId } })).toBeNull()
  })

  it('POST Slack refresh preserves exported fields, syncs required config, and reports current scopes', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          name: 'refresh-me',
          platform: 'slack',
          agentId,
          slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0TESTAPP1-123-abcdef' }
        }
      })
    ).json() as { botId: string }

    await app.deps.repos.slackUserConfig.put(OrgId(DEFAULT_ORG_ID), DEFAULT_OWNER_ID, {
      accessToken: 'xoxe.xoxp-current',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000)
    })
    let submitted: unknown
    app.deps.slackConfigApi = {
      createApp: async () => ({ ok: false, error: 'unused' }),
      exportApp: async () => ({
        ok: true,
        manifest: {
          display_information: { name: 'Custom', description: 'keep me' },
          features: { slash_commands: [{ command: '/keep' }] },
          oauth_config: { scopes: { bot: ['bookmarks:read'] } },
          settings: { event_subscriptions: { bot_events: ['app_home_opened'] } }
        }
      }),
      updateApp: async (_token, _appId, manifest) => {
        submitted = manifest
        return { ok: true, permissionsUpdated: true }
      },
      exchangeOAuth: async () => ({ ok: false, error: 'unused' }),
      rotateConfigToken: async () => ({ ok: false, error: 'unused' })
    } satisfies SlackConfigApi
    app.deps.verifySlackBot = async () => ({
      status: 'ok',
      name: 'refresh-me',
      appId: 'A0TESTAPP1',
      teamId: 'T0TESTTEAM1',
      scopes: [...SLACK_BOT_SCOPES]
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${created.botId}/slack/refresh` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      manifest: 'synced',
      authorization: 'current',
      missingScopes: [],
      settingsUrl: 'https://api.slack.com/apps/A0TESTAPP1',
      manifestUrl: 'https://app.slack.com/app-settings/T0TESTTEAM1/A0TESTAPP1/app-manifest',
      permissionsUrl: 'https://app.slack.com/app-settings/T0TESTTEAM1/A0TESTAPP1/oauth',
      reinstallUrl: 'https://api.slack.com/apps/A0TESTAPP1/install-on-team?'
    })
    expect(JSON.stringify(res.json())).not.toContain('xox')
    expect(submitted).toMatchObject({
      display_information: { name: 'Custom', description: 'keep me' },
      features: { slash_commands: [{ command: '/keep' }] },
      oauth_config: { scopes: { bot: expect.arrayContaining(['bookmarks:read', ...SLACK_BOT_SCOPES]) } },
      settings: {
        event_subscriptions: { bot_events: expect.arrayContaining(['app_home_opened', ...SLACK_BOT_EVENTS]) }
      }
    })
  })

  it('POST Slack refresh keeps an unverified manifest distinct from current workspace scopes', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          name: 'manual-app',
          platform: 'slack',
          agentId,
          slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0MANUAL01-123-abcdef' }
        }
      })
    ).json() as { botId: string }
    app.deps.verifySlackBot = async () => ({
      status: 'ok',
      name: 'manual-app',
      appId: 'A0MANUAL01',
      teamId: 'T0MANUAL01',
      scopes: [...SLACK_BOT_SCOPES]
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${created.botId}/slack/refresh` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      manifest: 'manual_update_required',
      authorization: 'current',
      missingScopes: [],
      settingsUrl: 'https://api.slack.com/apps/A0MANUAL01',
      manifestUrl: 'https://app.slack.com/app-settings/T0MANUAL01/A0MANUAL01/app-manifest',
      permissionsUrl: 'https://app.slack.com/app-settings/T0MANUAL01/A0MANUAL01/oauth',
      reinstallUrl: 'https://api.slack.com/apps/A0MANUAL01/install-on-team?'
    })
  })

  it('POST Slack refresh never updates an app when the stored bot token belongs to another app', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          name: 'mismatched-app',
          platform: 'slack',
          agentId,
          slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0EXPECTED1-123-abcdef' }
        }
      })
    ).json() as { botId: string }

    await app.deps.repos.slackUserConfig.put(OrgId(DEFAULT_ORG_ID), DEFAULT_OWNER_ID, {
      accessToken: 'xoxe.xoxp-current',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000)
    })
    let exportCalls = 0
    app.deps.slackConfigApi = {
      createApp: async () => ({ ok: false, error: 'unused' }),
      exportApp: async () => {
        exportCalls += 1
        return { ok: true, manifest: {} }
      },
      updateApp: async () => ({ ok: true, permissionsUpdated: false }),
      exchangeOAuth: async () => ({ ok: false, error: 'unused' }),
      rotateConfigToken: async () => ({ ok: false, error: 'unused' })
    } satisfies SlackConfigApi
    app.deps.verifySlackBot = async () => ({
      status: 'ok',
      name: 'mismatched-app',
      appId: 'A0DIFFERENT',
      teamId: 'T0OTHERTEAM',
      scopes: [...SLACK_BOT_SCOPES]
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${created.botId}/slack/refresh` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      manifest: 'manual_update_required',
      authorization: 'app_mismatch',
      missingScopes: [],
      manifestUrl: 'https://api.slack.com/apps/A0EXPECTED1'
    })
    expect(exportCalls).toBe(0)
  })

  it.each(['assistant:write', 'chat:write.customize'] as const)(
    'POST Slack refresh returns manual-update and reinstall links when granted %s scope lags',
    async (missingScope) => {
      const agentId = await placedAgent()
      const { app } = withSpy()
      const created = (
        await app.app.inject({
          method: 'POST',
          url: `${ORG}/integrations`,
          payload: {
            name: 'old-app',
            platform: 'slack',
            agentId,
            slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0OLDAPP01-123-abcdef' }
          }
        })
      ).json() as { botId: string }
      app.deps.verifySlackBot = async () => ({
        status: 'ok',
        name: 'old-app',
        appId: 'A0OLDAPP01',
        teamId: 'T0OLDTEAM01',
        scopes: SLACK_BOT_SCOPES.filter((scope) => scope !== missingScope)
      })

      const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${created.botId}/slack/refresh` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        manifest: 'manual_update_required',
        authorization: 'reinstall_required',
        missingScopes: [missingScope],
        manifestUrl: 'https://app.slack.com/app-settings/T0OLDTEAM01/A0OLDAPP01/app-manifest',
        permissionsUrl: 'https://app.slack.com/app-settings/T0OLDTEAM01/A0OLDAPP01/oauth',
        reinstallUrl: 'https://api.slack.com/apps/A0OLDAPP01/install-on-team?'
      })
    }
  )
})
