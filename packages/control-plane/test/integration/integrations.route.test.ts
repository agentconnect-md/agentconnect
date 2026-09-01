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
import { seedDaemon, seedAgent, seedDutyGroup, defaultAgentName } from '../fixtures/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationUpsert, IntegrationRemove } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
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
  readonly removes: Array<{ daemonId: string; r: IntegrationRemove; orgId?: string }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  // `orgId` is recorded because a removal payload is a bare id: the send cannot
  // derive an org on an install-wide connection, so dropping it here is the bug.
  async integrationRemove(daemonId: string, r: IntegrationRemove, orgId?: string): Promise<void> {
    this.removes.push({ daemonId, r, orgId })
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
  // A publicly reachable relay origin — the http-transport gate refuses a
  // deployment whose PUBLIC_RELAY_URL is unset or loopback-only, so the tests
  // that exercise http installs need the same config a real one would have.
  const config = { PUBLIC_RELAY_URL: 'https://relay.example.test' }
  const app = buildHttpApp(prisma, config, undefined, spy as unknown as ControlSender)
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
      // §6.4 emission flip: credentials ride the opaque config envelope.
      config: { botToken: SLACK.botToken, appToken: SLACK.appToken }
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
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'http-bot',
      appId: 'AHTTPBOT',
      botUserId: 'UHTTPBOT',
      teamId: 'T1',
      teamName: 'Acme',
      scopes: [...SLACK_BOT_SCOPES]
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
      slackAppId: 'AHTTPBOT',
      botUserId: 'UHTTPBOT',
      workspaceId: 'T1',
      workspaceName: 'Acme'
    })
  })

  it('POST refuses an http install with 409 BEFORE the credential round-trip when no relay is connected', async () => {
    // §9 create tail: relay availability is core's gate and now precedes the
    // provider call on EVERY platform (Feishu already did; Slack checked after).
    // The deployment-level blocker wins over the credential verdict, and no
    // provider API call is spent on a request that cannot succeed.
    const agentId = await placedAgent()
    for (const payload of [
      { platform: 'slack', slack: { botToken: SLACK.botToken, signingSecret: 'signing-secret' } },
      { platform: 'feishu', feishu: { appId: 'cli_x', appSecret: 's', verificationToken: 'vt' } }
    ]) {
      const { app } = withSpy()
      // No relay is registered on the fake app by default.
      let verified = false
      app.platformStubs.verifySlackBot = async () => {
        verified = true
        return { status: 'invalid' }
      }
      app.platformStubs.verifyFeishuBot = async () => {
        verified = true
        return { status: 'invalid' }
      }

      const res = await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { ...payload, agentId, transport: 'http' }
      })

      expect(res.statusCode).toBe(409)
      expect((res.json() as { message: string }).message).toBe(
        'HTTP callback delivery is unavailable on this deployment — no relay is connected.'
      )
      expect(verified).toBe(false)
      expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)
      await app.close()
      running = undefined
    }
  })

  it('POST refuses an http install when the connected relay is loopback-only', async () => {
    // The default self-hosted Compose stack: a healthy, registered relay whose
    // PUBLIC_RELAY_URL no platform can POST to. Availability is not reachability —
    // and because transport is immutable, accepting one mints a bot that silently
    // black-holes every inbound message.
    const agentId = await placedAgent()
    const spy = new SpyControl()
    const app = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: 'http://localhost:8090' },
      undefined,
      spy as unknown as ControlSender
    )
    running = app
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    let verified = false
    app.platformStubs.verifySlackBot = async () => {
      verified = true
      return {
        status: 'ok',
        name: 'http-bot',
        appId: 'AHTTPBOT',
        botUserId: 'U1',
        teamId: 'T1',
        teamName: 'Acme',
        scopes: [...SLACK_BOT_SCOPES]
      }
    }

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

    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('http://localhost:8090')
    expect(verified).toBe(false)
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)
    // Socket transport is the escape hatch the refusal points at, and it still works.
    const socket = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'slack',
        agentId,
        slack: { botToken: SLACK.botToken, appToken: SLACK.appToken }
      }
    })
    expect(socket.statusCode).toBe(201)
  })

  it('POST telegram check reports Group Privacy Mode without storing the token', async () => {
    const { app } = withSpy()
    app.platformStubs.verifyTelegramBot = async (botToken) => ({
      status: 'ok',
      name: 'acme-tg',
      privacyModeDisabled: botToken.endsWith('ready')
    })

    const enabled = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/telegram/check`,
      payload: { botToken: '123456:privacy-on' }
    })
    const ready = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/telegram/check`,
      payload: { botToken: '123456:ready' }
    })

    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toEqual({ status: 'privacy_enabled' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ status: 'ready' })
    expect(await prisma.botSecret.count()).toBe(0)
  })

  it('POST telegram refuses an enabled Group Privacy Mode before storing credentials', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.verifyTelegramBot = async () => ({
      status: 'ok',
      name: 'acme-tg',
      privacyModeDisabled: false
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'telegram', agentId, telegram: { botToken: '123456:AAE-xyz' } }
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'TELEGRAM_PRIVACY_MODE_ENABLED',
      message: expect.stringContaining('/setprivacy')
    })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST telegram registers a bot + secret with a NULL appToken, pushes a telegram-shaped upsert', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    let iconSync: { botToken: string; agentId: string } | undefined
    app.platformStubs.syncTelegramBotIcon = async (botToken, agent) => {
      iconSync = { botToken, agentId: agent.id }
      throw new Error('fixture rate limit')
    }

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
    // D6 (§11): a Telegram install is a bot token and nothing else — no app id,
    // no tenant, no public row metadata — so the row claims no external
    // identity. Completes the four-platform pin the discord / feishu / slack
    // cases in this file carry.
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId as string } })
    expect(bot).toMatchObject({ externalAppId: null, externalTenantId: null, platformConfig: null })

    // The daemon got a telegram-shaped spec (single botToken, no slack block).
    expect(spy.upserts).toHaveLength(1)
    const u = spy.upserts[0]!.u
    if (u.platform !== 'telegram') throw new Error('expected telegram upsert')
    expect(u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'telegram',
      config: { botToken: '123456:AAE-xyz' }
    })
    // Cosmetic profile updates are attempted after the durable install, but a
    // Telegram failure never rolls back or blocks the functional integration.
    expect(iconSync).toEqual({ botToken: '123456:AAE-xyz', agentId })
  })

  it('POST discord registers a bot + secret with a NULL appToken, decodes the app id, pushes a discord-shaped upsert', async () => {
    const agentId = await placedAgent()
    await prisma.agent.update({ where: { id: agentId }, data: { description: 'Answers support questions.' } })
    const { app, spy } = withSpy()
    let profileSync: { botToken: string; agentId: string; hasDescription: boolean } | undefined
    let intentToken: string | undefined
    app.platformStubs.ensureDiscordMessageContentIntent = async (botToken) => {
      intentToken = botToken
      return 'ready'
    }
    app.platformStubs.syncDiscordBotProfile = async (botToken, agent) => {
      profileSync = { botToken, agentId: agent.id, hasDescription: 'description' in agent }
      throw new Error('fixture rate limit')
    }

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
    expect(bot).toMatchObject({ platform: 'discord', slackAppId: null })
    // D6: Discord has no demux identity — the decoded application id is public
    // metadata, so it rides the per-platform bag and fences nothing.
    expect(bot).toMatchObject({
      externalAppId: null,
      externalTenantId: null,
      platformConfig: { discordAppId: '123456789012345678' }
    })

    // The daemon got a discord-shaped spec (single botToken, no slack block).
    expect(spy.upserts).toHaveLength(1)
    const u = spy.upserts[0]!.u
    if (u.platform !== 'discord') throw new Error('expected discord upsert')
    expect(u).toMatchObject({
      integrationId: dto.id,
      agentId,
      platform: 'discord',
      config: { botToken: DISCORD_TOKEN }
    })
    // Cosmetic profile updates are attempted after the durable install, but a
    // Discord failure never rolls back or blocks the functional integration.
    expect(profileSync).toEqual({ botToken: DISCORD_TOKEN, agentId, hasDescription: false })
    expect(intentToken).toBe(DISCORD_TOKEN)
  })

  it('POST rejects a discord bot token Discord refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.verifyDiscordBot = async () => ({ status: 'invalid' })

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

  it('POST stops before storing when Discord cannot enable Message Content Intent', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.verifyDiscordBot = async () => ({ status: 'ok', name: 'matrix' })
    app.platformStubs.ensureDiscordMessageContentIntent = async () => 'rejected'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId, discord: { botToken: 'MTA1-bot.token.abc' } }
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'DISCORD_MESSAGE_CONTENT_INTENT_SETUP_FAILED',
      message: expect.stringContaining('turn on Message Content Intent')
    })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST asks the user to retry when Discord intent setup is unreachable', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.ensureDiscordMessageContentIntent = async () => 'unreachable'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId, discord: { botToken: 'MTA1-bot.token.abc' } }
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      code: 'DISCORD_MESSAGE_CONTENT_INTENT_CHECK_UNAVAILABLE',
      message: expect.stringContaining('Try installing again')
    })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST discord derives the bot name from users/@me, and proceeds when Discord is unreachable', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.platformStubs.verifyDiscordBot = async () => ({ status: 'ok', name: 'matrix#4242' })

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
    app.platformStubs.verifyDiscordBot = async () => ({ status: 'unreachable' })
    const unreachable = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'discord', agentId: agentId2, discord: { botToken: 'MTA1-bot.token.abc' } }
    })
    expect(unreachable.statusCode).toBe(201)
    expect((unreachable.json() as { name: string }).name).toBe(defaultAgentName(agentId2))
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
    expect(bot).toMatchObject({ platform: 'feishu' })
    // The generic demux identity carries the app id with the tenantless '-'
    // sentinel; the app id and gateway also ride the per-platform bag, which is
    // what the console reads and what survives an uninstall.
    expect(bot).toMatchObject({
      externalAppId: FEISHU.appId,
      externalTenantId: '-',
      platformConfig: { feishuAppId: FEISHU.appId, feishuRegion: 'lark' }
    })

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
      config: { appId: FEISHU.appId, appSecret: FEISHU.appSecret, region: 'lark' }
    })
    expect(dto.region).toBe('lark')
  })

  it('POST feishu refuses a SECOND bot for the same Feishu app (D6 identity fence), and slack dual-writes its pair', async () => {
    const agentId = await placedAgent()
    const agentId2 = randomUUID()
    await seedAgent(prisma, agentId2, { daemonId: DAEMON })
    const { app } = withSpy()

    const FEISHU = { appId: 'cli_dupfence01', appSecret: 'first-secret-value' }
    const first = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId, feishu: FEISHU }
    })
    expect(first.statusCode).toBe(201)

    // Same Feishu app pasted again (even by another agent, even with a different
    // secret): one Bot per external app identity — reuse the existing bot instead.
    const dup = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId: agentId2, feishu: { appId: FEISHU.appId, appSecret: 'other-secret' } }
    })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { message: string }).message).toContain('already registered')

    // Slack manual create with a parsable xapp: the generic pair mirrors
    // (slackAppId, teamId) — app id captured, tenant NULL until OAuth captures it
    // (pre-capture rows keep NULLs-distinct semantics, so no fence engages).
    const slackRes = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'slack',
        agentId: agentId2,
        slack: { botToken: SLACK.botToken, appToken: 'xapp-1-A0DUALW01-123-abcdef' }
      }
    })
    expect(slackRes.statusCode).toBe(201)
    const slackBot = await prisma.bot.findUnique({
      where: { id: (slackRes.json() as { botId: string }).botId }
    })
    expect(slackBot).toMatchObject({
      slackAppId: 'A0DUALW01',
      teamId: null,
      externalAppId: 'A0DUALW01',
      externalTenantId: null,
      platformConfig: null
    })
  })

  // ingress-tenant-fence.md §5: the manual-paste create path reaches the same
  // shared create seam as the funnels, so the workspace-claim fence must hold
  // here too — this is the path a second org would use to paste an app's
  // credentials for a workspace another org already runs.
  it('POST /integrations refuses a workspace already claimed by ANOTHER organization', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'http-bot',
      appId: 'ACLAIMED',
      botUserId: 'UCLAIMED',
      teamId: 'TCLAIMED',
      teamName: 'Acme',
      scopes: [...SLACK_BOT_SCOPES]
    })
    // Another org already runs this app in this workspace: same signing secret,
    // same tenant — the relay's delivery fence cannot tell the two rows apart.
    const foreignOrgId = `org-claim-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: foreignOrgId,
        platform: 'slack',
        name: 'foreign-claim',
        slackAppId: 'ACLAIMED',
        externalAppId: 'ACLAIMED',
        workspaceId: 'TCLAIMED'
      }
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

    expect(res.statusCode).toBe(409)
    // The refusal never names the organization holding the workspace.
    expect(res.body).not.toContain(foreignOrgId)
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, slackAppId: 'ACLAIMED' } })).toBe(0)
  })

  it('POST /integrations allows a DIFFERENT app in a workspace another org already uses', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'http-bot',
      appId: 'AMINE',
      botUserId: 'UMINE',
      teamId: 'TSHARED',
      teamName: 'Acme',
      scopes: [...SLACK_BOT_SCOPES]
    })
    // Same workspace, DIFFERENT app ⇒ different signing secret ⇒ nothing is
    // ambiguous at delivery time, so admission must not over-refuse.
    const foreignOrgId = `org-otherapp-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: foreignOrgId,
        platform: 'slack',
        name: 'foreign-other-app',
        slackAppId: 'ATHEIRS',
        externalAppId: 'ATHEIRS',
        workspaceId: 'TSHARED'
      }
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
  })

  it('POST an HTTP Feishu app assigns callback-only secrets and keeps API egress on the daemon', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const relaySends: Array<{ type: string; payload: unknown }> = []
    app.relayReg.add({
      relayId: 'r1',
      send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
      close() {}
    } as RelayChannel)
    app.platformStubs.verifyFeishuBot = async () => ({
      status: 'ok',
      name: 'HTTP Lark Bot',
      openId: 'ou_http_bot'
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'feishu',
        agentId,
        transport: 'http',
        feishu: {
          appId: 'cli_http_app',
          appSecret: 'app-secret',
          region: 'lark',
          verificationToken: 'verify-token',
          encryptKey: 'encrypt-key'
        }
      }
    })

    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string }
    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      platform: 'feishu',
      transport: 'http',
      botUserId: 'ou_http_bot'
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: 'app-secret',
      appToken: 'cli_http_app',
      verificationToken: 'verify-token',
      encryptKey: 'encrypt-key'
    })

    const assign = relaySends.find((send) => send.type === 'rc/bot-assign')?.payload as {
      platform: string
      ingress: Record<string, unknown>
      secrets: Record<string, unknown>
    }
    // §6.7 emission flip: the demux identity rides the opaque ingress bag only.
    expect(assign).toMatchObject({
      platform: 'feishu',
      ingress: { apiAppId: 'cli_http_app', botUserId: 'ou_http_bot' },
      secrets: { verificationToken: 'verify-token', encryptKey: 'encrypt-key' }
    })
    expect(assign.secrets).not.toHaveProperty('botToken')
    expect(assign.secrets).not.toHaveProperty('appSecret')

    expect(spy.upserts).toHaveLength(1)
    const upsert = spy.upserts[0]!.u
    if (upsert.platform !== 'feishu') throw new Error('expected Feishu upsert')
    expect(upsert.core).toMatchObject({ mode: 'shared' })
    expect(upsert.config).toMatchObject({
      appId: 'cli_http_app',
      appSecret: 'app-secret',
      botOpenId: 'ou_http_bot',
      region: 'lark'
    })
  })

  it("POST feishu with region 'feishu' verifies against + pushes the China gateway", async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const verifierCalls: Array<string | undefined> = []
    app.platformStubs.verifyFeishuBot = async (_appId, _appSecret, region) => {
      verifierCalls.push(region)
      return { status: 'ok', name: null, openId: 'ou_feishu_bot' }
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
    expect(u.config).toMatchObject({ appId: FEISHU.appId, region: 'feishu' })

    // Persisted on the integration row so a reconnect reconstructs the same region.
    const row = await prisma.integration.findUnique({ where: { id: dto.id as string } })
    expect(row?.feishuRegion).toBe('feishu')
  })

  it('POST rejects feishu credentials Feishu refuses (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.verifyFeishuBot = async () => ({ status: 'invalid' })

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

  it('POST rejects a Feishu App from a different deployment organization', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    app.platformStubs.feishuAppTenantGuard.checkApp = async () => 'org_mismatch'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId, feishu: { appId: 'cli_other_org', appSecret: 'secret' } }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'FEISHU_ORG_MISMATCH' })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST feishu derives the bot name from bot/v3/info, and proceeds when Feishu is unreachable', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.platformStubs.verifyFeishuBot = async () => ({ status: 'ok', name: 'Matrix Bot', openId: 'ou_matrix_bot' })

    const named = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId, feishu: { appId: 'cli_a', appSecret: 's' } } // NO name
    })
    expect(named.statusCode).toBe(201)
    expect((named.json() as { name: string }).name).toBe('Matrix Bot')

    // Unreachable is best-effort, not a gate: a second agent installs fine, name falls back.
    // (A different app id — registering the SAME Feishu app twice is refused by the
    // D6 external-identity fence, covered in its own test.)
    const agentId2 = randomUUID()
    await seedAgent(prisma, agentId2, { daemonId: DAEMON })
    app.platformStubs.verifyFeishuBot = async () => ({ status: 'unreachable' })
    const unreachable = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId: agentId2, feishu: { appId: 'cli_b', appSecret: 's' } }
    })
    expect(unreachable.statusCode).toBe(201)
    expect((unreachable.json() as { name: string }).name).toBe(defaultAgentName(agentId2))
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
    const agentName = defaultAgentName(agentId)

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
    app.platformStubs.verifySlackBot = async () => ({ status: 'invalid' })

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
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: null,
      appId: null,
      teamId: null,
      teamName: null,
      scopes: [...SLACK_BOT_SCOPES]
    })
    app.platformStubs.verifySlackAppToken = async () => 'invalid'

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
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: null,
      appId: 'AOTHER',
      teamId: null,
      teamName: null,
      scopes: [...SLACK_BOT_SCOPES]
    })
    app.platformStubs.verifySlackAppToken = async () => 'ok'

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

  // The manual Bot-token wizard is the third install path the #768 scope fences
  // cover (after the config-token finalize and the platform OAuth callback): a
  // workspace authorization that positively granted fewer bot scopes than the
  // manifest declares used to install silently and only fail weeks later, as
  // scoped calls answering `missing_scope`.
  it('POST rejects a bot token whose workspace grant is short on scopes (400) and stores nothing', async () => {
    const agentId = await placedAgent()
    const { app, spy } = withSpy()
    const withheld = ['channels:history', 'users:read']
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T_INSTALL',
      teamName: 'Acme',
      botUserId: 'U1',
      scopes: SLACK_BOT_SCOPES.filter((scope) => !withheld.includes(scope))
    })
    app.platformStubs.verifySlackAppToken = async () => 'ok'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK }
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { code?: string; message: string }
    // The list is the point: "reinstall the app" is only actionable when the
    // refusal says WHICH permissions are absent.
    expect(body.code).toBe('SLACK_MISSING_SCOPES')
    expect(body.message).toContain('channels:history')
    expect(body.message).toContain('users:read')
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.botSecret.count()).toBe(0)
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST derives the bot name from auth.test when none is given', async () => {
    const agentId = await placedAgent()
    const { app } = withSpy()
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'matrix_test',
      appId: null,
      teamId: null,
      teamName: null,
      scopes: [...SLACK_BOT_SCOPES]
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
    app.platformStubs.verifySlackBot = async () => ({ status: 'unreachable' })
    app.platformStubs.verifySlackAppToken = async () => 'unreachable'

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId, slack: SLACK } // NO name
    })
    expect(res.statusCode).toBe(201)
    // Name falls back to the owning agent when auth.test couldn't derive one.
    expect((res.json() as { name: string }).name).toBe(defaultAgentName(agentId))
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
    expect(bot?.lastAgentName).toBe(defaultAgentName(agentId))
    expect(await prisma.botSecret.findUnique({ where: { botId: created.botId } })).not.toBeNull()
    // The org rides every removal now: the payload is a bare id, so the send has
    // nothing else to scope on when the connection is install-wide.
    expect(spy.removes).toEqual([{ daemonId: DAEMON, r: { integrationId: created.id }, orgId: DEFAULT_ORG_ID }])
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
    expect(spy.upserts[1]!.u).toMatchObject({ config: { botToken: SLACK.botToken, appToken: SLACK.appToken } })
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
    // Region lives durably on the freed bot — in the per-platform bag, which is
    // what survives the uninstall so a reinstall dials the same gateway.
    expect((await prisma.bot.findUnique({ where: { id: first.botId } }))?.platformConfig).toMatchObject({
      feishuRegion: 'lark'
    })

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
    expect((u.config as { region?: string }).region).toBe('lark')
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
      async () => ({
        appId: 'ALEGACYHTTP',
        botUserId: 'ULEGACYHTTP',
        workspaceId: 'TLEGACY',
        workspaceName: 'Legacy workspace'
      }),
      systemClock,
      { intervalMs: 60_000 }
    )

    await reconciler.tick()

    expect((await prisma.bot.findUnique({ where: { id: botId } }))?.botUserId).toBe('ULEGACYHTTP')
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/bots` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: botId,
        slackAppId: 'ALEGACYHTTP',
        workspaceId: 'TLEGACY',
        workspaceName: 'Legacy workspace'
      })
    ])
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
    app.platformStubs.slackConfigApi = {
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
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'refresh-me',
      appId: 'A0TESTAPP1',
      teamId: 'T0TESTTEAM1',
      teamName: 'Acme',
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
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'manual-app',
      appId: 'A0MANUAL01',
      teamId: 'T0MANUAL01',
      teamName: 'Acme',
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
    app.platformStubs.slackConfigApi = {
      createApp: async () => ({ ok: false, error: 'unused' }),
      exportApp: async () => {
        exportCalls += 1
        return { ok: true, manifest: {} }
      },
      updateApp: async () => ({ ok: true, permissionsUpdated: false }),
      exchangeOAuth: async () => ({ ok: false, error: 'unused' }),
      rotateConfigToken: async () => ({ ok: false, error: 'unused' })
    } satisfies SlackConfigApi
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'mismatched-app',
      appId: 'A0DIFFERENT',
      teamId: 'T0OTHERTEAM',
      teamName: 'Other',
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
    expect(await prisma.bot.findUnique({ where: { id: created.botId } })).toMatchObject({
      workspaceId: null,
      workspaceName: null
    })
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
      app.platformStubs.verifySlackBot = async () => ({
        status: 'ok',
        name: 'old-app',
        appId: 'A0OLDAPP01',
        teamId: 'T0OLDTEAM01',
        teamName: 'Legacy',
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

/**
 * Multi-agent bots are a per-PLATFORM capability — the §5 manifest's
 * `multiAgentShareable` — and the two routes that read it had drifted: the
 * shareable install refused everything but Slack while `PATCH /bots/:id` gated
 * only on the transport. So any HTTP-transport bot on a platform outside the set
 * — Feishu is the one that exists, since it offers a transport choice of its own
 * — could be flipped `shareable`, and the flag would sit on the row as a promise
 * the install path never honors.
 */
describe('bot sharing capability (PATCH /bots/:id)', () => {
  /** A durable bot row with no install — enough for the toggle, which reads
   *  `platform`, `transport`, `shareable` and the membership count. */
  async function seedBot(over: { platform: string; transport?: 'socket' | 'http'; shareable?: boolean }) {
    const id = randomUUID()
    await prisma.bot.create({
      data: {
        id,
        orgId: DEFAULT_ORG_ID,
        platform: over.platform,
        name: `${over.platform}-bot`,
        transport: over.transport ?? 'http',
        shareable: over.shareable ?? false
      }
    })
    return id
  }

  it('refuses enabling sharing on a platform without multi-agent bots', async () => {
    const { app } = withSpy()
    const botId = await seedBot({ platform: 'feishu', transport: 'http' })

    const res = await app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${botId}`, payload: { shareable: true } })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ message: 'multi-agent bots are not supported on feishu' })
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).shareable).toBe(false)
  })

  it('names the platform rather than the transport when neither would help', async () => {
    // Ordering claim: the platform gate runs FIRST. A Feishu socket bot used to
    // be told to "recreate the bot in HTTP mode" — advice that would not have
    // worked, because the install path refuses the platform either way.
    const { app } = withSpy()
    const botId = await seedBot({ platform: 'feishu', transport: 'socket' })

    const res = await app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${botId}`, payload: { shareable: true } })

    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toBe('multi-agent bots are not supported on feishu')
  })

  it('still lets a row flipped before the guard existed be turned back off', async () => {
    // Only the ENABLE direction is refused. While the toggle was transport-gated
    // only, this PATCH accepted the flip — so such rows may exist, and the
    // console's repair has to keep working.
    const { app } = withSpy()
    const botId = await seedBot({ platform: 'feishu', transport: 'http', shareable: true })

    const res = await app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${botId}`, payload: { shareable: false } })

    expect(res.statusCode).toBe(200)
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).shareable).toBe(false)
  })

  it('leaves Slack’s HTTP bots shareable, and its socket bots refused on transport', async () => {
    const { app } = withSpy()
    const http = await seedBot({ platform: 'slack', transport: 'http' })
    const socket = await seedBot({ platform: 'slack', transport: 'socket' })

    const ok = await app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${http}`, payload: { shareable: true } })
    expect(ok.statusCode).toBe(200)
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: http } })).shareable).toBe(true)

    const refused = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${socket}`,
      payload: { shareable: true }
    })
    expect(refused.statusCode).toBe(409)
    expect((refused.json() as { message: string }).message).toMatch(/HTTP-mode/)
  })

  it('refuses a second agent on a non-Slack HTTP bot — the rule this toggle now agrees with', async () => {
    // The create path's half of the same predicate, pinned here so the two stay
    // in one place: a reuse that would make the bot multi-agent is a 400 (there
    // the platform is the client's assertion in the body; on the PATCH it is the
    // stored row's, hence the 409 above).
    const first = await placedAgent()
    const second = randomUUID()
    await seedAgent(prisma, second, { daemonId: DAEMON })
    const { app } = withSpy()
    app.relayReg.add({ relayId: 'r1', send() {}, close() {} } as RelayChannel)
    app.platformStubs.verifyFeishuBot = async () => ({ status: 'ok', name: 'shared-lark', openId: 'ou_shared_bot' })

    const created = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: {
          platform: 'feishu',
          agentId: first,
          transport: 'http',
          feishu: { appId: 'cli_shared', appSecret: 'app-secret', verificationToken: 'vt', encryptKey: 'ek' }
        }
      })
    ).json() as { botId: string }

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'feishu', agentId: second, botId: created.botId }
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ message: 'multi-agent bots are not supported on feishu' })
  })
})

/**
 * A dependent follows the DUTY HOLDER too (#973). `AgentDelivery` owns the agent
 * frames; an integration spec is token-bearing and its bindRules are what the
 * daemon admits on, so a holder that never receives the push keeps stale
 * credentials and stale routing until it happens to reconnect — the same
 * frozen-bundle failure one level down. These mutations do not advance
 * `Agent.configRevision` either, so the grant-time freshness stamp gives the
 * holder no reason to refetch: the live push IS the only in-session repair.
 */
describe('integration updates follow the duty holder', () => {
  const HOLDER = 'd7777777-7777-4777-8777-777777777777'
  const GROUP = '00000000-0000-4000-8000-0000000009b1'

  /** A placed agent with a Slack install, plus a live duty held by HOLDER. */
  async function installedWithHolder(): Promise<{ agentId: string; integrationId: string; app: HttpApp }> {
    const agentId = await placedAgent()
    await seedDaemon(prisma, HOLDER, { capabilities: daemonCapabilities(ALL_BOT_PLATFORMS) })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const { app } = withSpy()
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'held-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(created.statusCode).toBe(201)
    return { agentId, integrationId: (created.json() as { id: string }).id, app }
  }

  it('the install push reaches the holder as well as the placement — with the credential', async () => {
    const agentId = await placedAgent()
    await seedDaemon(prisma, HOLDER, { capabilities: daemonCapabilities(ALL_BOT_PLATFORMS) })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'held-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(created.statusCode).toBe(201)

    expect(spy.upserts.map((u) => u.daemonId)).toEqual([DAEMON, HOLDER])
    // A credential that reaches only the placement is the worst of the three:
    // the holder would go on authenticating with whatever it last saw.
    expect(JSON.stringify(spy.upserts.at(-1)!.u)).toContain(SLACK.botToken)
  })

  it('a bindRules change reaches the holder, and the holder is current WITHOUT a reconnect', async () => {
    const { integrationId, app } = await installedWithHolder()
    const spy = app.deps.control as unknown as SpyControl
    await prisma.integrationChannel.create({
      data: { integrationId, channelId: 'C900', kind: 'channel', trigger: 'mention' }
    })
    spy.upserts.length = 0

    const patched = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/integrations/${integrationId}/channels/C900`,
      payload: { trigger: 'any' }
    })
    expect(patched.statusCode).toBe(200)

    // Arrival is not enough — the pinning assertion is that what ARRIVED is the
    // new routing. No register/reconcile ran anywhere in this test.
    const held = spy.upserts.find((u) => u.daemonId === HOLDER)
    expect(held).toBeDefined()
    expect(held!.u.core.bindRules).toContainEqual({ channel: 'C900', match: { kind: 'auto' } })
  })

  it('an integration removal reaches the holder', async () => {
    const { integrationId, app } = await installedWithHolder()
    const spy = app.deps.control as unknown as SpyControl

    const deleted = await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${integrationId}` })
    expect(deleted.statusCode).toBe(204)

    expect(spy.removes.map((r) => r.daemonId)).toEqual([DAEMON, HOLDER])
    expect(spy.removes.every((r) => r.r.integrationId === integrationId)).toBe(true)
    // The org is the assertion, not an incidental: `integration/remove` carries
    // only an id, and this holder never registered the integration (it would have
    // arrived through `duty/fetch`), so a send without the org is SCOPE_DENIED
    // before it leaves the process — the delete 500s and the holder keeps serving.
    expect(spy.removes.every((r) => r.orgId === DEFAULT_ORG_ID)).toBe(true)
  })

  it('the upsert path carries the org on the payload — verified, not assumed', async () => {
    // `IntegrationSpec.orgId` is OPTIONAL on the wire (decode tolerance), so the
    // guarantee is that the projector always stamps the row's org. Pin it: if a
    // future producer omits it, upserts inherit exactly the removal bug.
    const { app } = await installedWithHolder()
    const spy = app.deps.control as unknown as SpyControl

    expect(spy.upserts).not.toHaveLength(0)
    expect(spy.upserts.every((u) => u.u.orgId === DEFAULT_ORG_ID)).toBe(true)
  })

  it('a gating flip re-pushes the derived spec to the holder', async () => {
    const { agentId, app } = await installedWithHolder()
    const spy = app.deps.control as unknown as SpyControl
    spy.upserts.length = 0

    // Visibility drives the derived conversation-gating flag; the converge path
    // (orchestrator/integrationPush.ts) re-pushes every integration of the agent.
    const shared = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect(shared.statusCode).toBe(200)

    const held = spy.upserts.find((u) => u.daemonId === HOLDER)
    expect(held).toBeDefined()
    // A holder still admitting on the ungated defaults would serve conversations
    // the agent's new visibility forbids.
    expect(held!.u.core.gated).toBe(true)
  })

  // #1026: the create probed with the resolver and then finalized on `agent.daemonId`, which is
  // NULL for a pool agent — so the whole install refused after its capability check had passed.
  it('installs on a POOL agent through the member holding its duty (#1026)', async () => {
    const setId = await seedPoolMember(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId])
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'pool-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect({ status: created.statusCode, message: created.json() }).toMatchObject({ status: 201 })
    expect(spy.upserts.map((u) => u.daemonId)).toEqual([HOLDER])
    expect(await prisma.integration.count()).toBe(1)
  })

  it('a POOL agent nothing is serving is still refused with 409, and stores nothing', async () => {
    const setId = await seedPoolMember(prisma, HOLDER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'pool-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(created.statusCode).toBe(409)
    expect({
      integrations: await prisma.integration.count(),
      bots: await prisma.bot.count(),
      pushes: spy.upserts
    }).toEqual({ integrations: 0, bots: 0, pushes: [] })
  })

  it('an EXPIRED lease is not a holding — the dependent goes to the placement alone', async () => {
    const agentId = await placedAgent()
    await seedDaemon(prisma, HOLDER, { capabilities: daemonCapabilities(ALL_BOT_PLATFORMS) })
    await seedDutyGroup(prisma, GROUP, HOLDER, [agentId], { expiresAt: new Date(Date.now() - 1000) })
    const { app, spy } = withSpy()

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { name: 'lapsed-bot', platform: 'slack', agentId, slack: SLACK }
    })
    expect(created.statusCode).toBe(201)
    expect(spy.upserts.map((u) => u.daemonId)).toEqual([DAEMON])
  })
})

/**
 * The bot-level preferred default agent: a persisted pointer the HTTP-bot compile
 * prefers over its earliest-non-gated-member derivation, so moving the default agent
 * actually moves a bare mention, a DM, or a delegation. Platform-free — this is the
 * generic knob every shared bot has, not a per-platform one.
 */
describe('preferred default agent (PATCH /bots/:id)', () => {
  const SECOND_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

  /** A shared HTTP Slack bot with two placed members, `first` being the earliest install. */
  async function sharedBot(): Promise<{ botId: string; first: string; second: string }> {
    await seedDaemon(prisma, DAEMON, { capabilities: daemonCapabilities(['slack']) })
    await seedDaemon(prisma, SECOND_DAEMON, { capabilities: daemonCapabilities(['slack']) })
    const first = randomUUID()
    const second = randomUUID()
    await seedAgent(prisma, first, { daemonId: DAEMON, name: 'alpha' })
    await seedAgent(prisma, second, { daemonId: SECOND_DAEMON, name: 'beta' })
    const botId = randomUUID()
    await prisma.bot.create({
      data: {
        id: botId,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'shared-bot',
        transport: 'http',
        shareable: true
      }
    })
    await prisma.botSecret.create({
      data: { botId, botToken: SLACK.botToken, signingSecret: 'signing-secret' }
    })
    // Distinct createdAt: the compile orders installs by it, so "earliest" is pinned.
    for (const [index, agentId] of [first, second].entries()) {
      await prisma.integration.create({
        data: {
          id: randomUUID(),
          orgId: DEFAULT_ORG_ID,
          agentId,
          botId,
          platform: 'slack',
          name: 'shared-bot',
          status: 'active',
          createdAt: new Date(1_700_000_000_000 + index * 1000)
        }
      })
    }
    return { botId, first, second }
  }

  /** The app plus the frames its one connected relay received. */
  function withRelay(): { app: HttpApp; sends: Array<{ type: string; payload: unknown }> } {
    const { app } = withSpy()
    const sends: Array<{ type: string; payload: unknown }> = []
    app.relayReg.add({
      relayId: 'r1',
      send: (type: string, payload: unknown) => sends.push({ type, payload }),
      close() {}
    } as RelayChannel)
    return { app, sends }
  }

  /** The `defaultAgentId`/`defaultDaemonId` of the last routing frame the relay saw. */
  function compiledDefault(sends: Array<{ type: string; payload: unknown }>) {
    const routing = sends.filter((send) => send.type === 'rc/routes' || send.type === 'rc/bot-assign')
    return routing.at(-1)?.payload as { defaultAgentId?: string; defaultDaemonId?: string } | undefined
  }

  it('sets the preference and recompiles the relay fallback rung onto it', async () => {
    const { botId, first, second } = await sharedBot()
    const { app, sends } = withRelay()

    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${botId}`,
      payload: { preferredAgentId: second }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: botId, preferredAgentId: second })
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).preferredAgentId).toBe(second)
    // The whole point: the compiled default moved off the earliest install.
    expect(compiledDefault(sends)).toMatchObject({ defaultAgentId: second, defaultDaemonId: SECOND_DAEMON })
    expect(compiledDefault(sends)?.defaultAgentId).not.toBe(first)
  })

  it('clears the preference back to the earliest member', async () => {
    const { botId, first, second } = await sharedBot()
    await prisma.bot.update({ where: { id: botId }, data: { preferredAgentId: second } })
    const { app, sends } = withRelay()

    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${botId}`,
      payload: { preferredAgentId: null }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: botId, preferredAgentId: null })
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).preferredAgentId).toBeNull()
    expect(compiledDefault(sends)).toMatchObject({ defaultAgentId: first, defaultDaemonId: DAEMON })
  })

  it('refuses an agent that does not use this bot, writing nothing', async () => {
    const { botId, second } = await sharedBot()
    const stranger = randomUUID()
    await seedAgent(prisma, stranger, { daemonId: DAEMON, name: 'stranger' })
    await prisma.bot.update({ where: { id: botId }, data: { preferredAgentId: second } })
    const { app } = withRelay()

    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${botId}`,
      payload: { preferredAgentId: stranger }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ message: 'default agent must be an agent that uses this bot' })
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).preferredAgentId).toBe(second)
  })

  it('carries the preference on GET /bots and takes both fields in one body', async () => {
    const { botId, second } = await sharedBot()
    const { app } = withRelay()

    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/bots/${botId}`,
      payload: { shareable: false, preferredAgentId: second }
    })
    expect(res.statusCode).toBe(409) // two members still installed — the sharing half is refused
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).preferredAgentId).toBe(second)

    const listed = (await app.app.inject({ method: 'GET', url: `${ORG}/bots` })).json() as {
      id: string
      preferredAgentId: string | null
    }[]
    expect(listed.find((bot) => bot.id === botId)?.preferredAgentId).toBe(second)
  })

  it('rejects a body that names neither field', async () => {
    const { botId } = await sharedBot()
    const { app } = withRelay()

    const res = await app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${botId}`, payload: {} })

    expect(res.statusCode).toBe(400)
  })

  it('leaves the bot on its derivation when the preferred agent is deleted', async () => {
    // The FK is SET NULL, not CASCADE: the bot row outlives the agent, so nothing else
    // would clear the pointer and the compile would keep chasing a vanished member.
    const { botId, first, second } = await sharedBot()
    await prisma.bot.update({ where: { id: botId }, data: { preferredAgentId: second } })

    await prisma.integration.deleteMany({ where: { agentId: second } })
    await prisma.agent.delete({ where: { id: second } })

    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).preferredAgentId).toBeNull()
    const { app, sends } = withRelay()
    await app.deps.httpBot.syncRoutes(botId)
    expect(compiledDefault(sends)).toMatchObject({ defaultAgentId: first, defaultDaemonId: DAEMON })
  })
})
