/** The Mattermost provider against real Postgres: self-hosted serverUrl normalization, /api/v4/users/me check, D6 uniqueness, and token rotation. */
import { createHash, randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { systemClock } from '../../src/domain/clock.js'
import { AgentId, OrgId, SessionId } from '../../src/domain/ids.js'
import { PgBotRepo, PgBotSecretStore, PgIntegrationRepo } from '../../src/persistence/repositories/integration.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { MattermostSessionAccessService } from '../../src/platforms/mattermost/session-access.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd4d4d4d4-dddd-4ddd-8ddd-dddddddddddd'
const SERVER_URL = 'https://chat.example.com/team'
const BOT_USER_ID = 'mmuser1234567890abcdefghij'
const BOT_USERNAME = 'agentbot'
const BOT_TOKEN = 'mm-token-placeholder'
const ROTATED = 'mm-token-placeholder-rotated'
const SECOND_USER_ID = 'mmuser9999999999abcdefghij'
const SECOND_TOKEN = 'mm-second-bot-token'

const EXPECTED_APP_ID = `mm-${createHash('sha256').update(SERVER_URL).digest('hex').slice(0, 16)}`

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  readonly removals: IntegrationRemove[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, r: IntegrationRemove): Promise<void> {
    this.removals.push(r)
  }
}

interface MockUser {
  id: string
  username: string
  is_bot?: boolean
}

function fakeMattermost(usersByToken: Record<string, MockUser>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push(url)
    const headers = init.headers as Record<string, string> | undefined
    const auth = headers?.Authorization ?? headers?.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    const user = usersByToken[token]
    if (!user)
      return Response.json({ id: 'api.context.session_expired.app_error', message: 'Invalid session' }, { status: 401 })
    return Response.json(user)
  }) as typeof fetch
}

function harness(
  usersByToken: Record<string, MockUser> = {
    [BOT_TOKEN]: { id: BOT_USER_ID, username: BOT_USERNAME, is_bot: true },
    [ROTATED]: { id: BOT_USER_ID, username: 'agentbot-renamed', is_bot: true },
    [SECOND_TOKEN]: { id: SECOND_USER_ID, username: 'pat-user', is_bot: false }
  }
) {
  const control = new SpyControl()
  const calls: string[] = []
  const app = buildHttpApp(prisma, {}, undefined, control as unknown as ControlSender, {
    mattermostFetch: fakeMattermost(usersByToken, calls)
  })
  running = app
  return { app, control, calls }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['mattermost'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

const install = (
  app: HttpApp,
  agentId: string,
  mattermost: { serverUrl?: string; botToken?: string } = {},
  transport?: 'http'
) =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      platform: 'mattermost',
      agentId,
      ...(transport ? { transport } : {}),
      mattermost: {
        serverUrl: mattermost.serverUrl ?? `${SERVER_URL}/`,
        botToken: mattermost.botToken ?? BOT_TOKEN
      }
    }
  })

describe('a Mattermost bot from POST /integrations', () => {
  it('sets and clears numbered replies on an existing installation without replacing its bot', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness()
    const installed = await install(app, agentId)
    expect(installed.statusCode).toBe(201)
    const id = installed.json().id
    const url = `${ORG}/integrations/${id}/mattermost/reply-settings`
    expect((await app.app.inject({ method: 'GET', url })).json()).toEqual({ websocketRepliesOnly: false })
    for (const enabled of [true, false]) {
      const payload = { websocketRepliesOnly: enabled }
      const result = await app.app.inject({ method: 'PUT', url, payload })
      expect(result.statusCode).toBe(200)
      expect(result.json()).toEqual(payload)
      expect((await app.app.inject({ method: 'GET', url })).json()).toEqual(payload)
      expect(control.upserts.at(-1)?.integrationId).toBe(id)
      expect((control.upserts.at(-1)?.config as { websocketRepliesOnly?: boolean }).websocketRepliesOnly ?? false).toBe(
        enabled
      )
    }
  })

  it('verifies /api/v4/users/me, normalizes serverUrl, stores the token write-only, and pushes daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control, calls } = harness()

    const res = await install(app, agentId, { serverUrl: 'HTTPS://Chat.Example.COM:443/team/' })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(BOT_TOKEN)
    expect(calls).toEqual([`${SERVER_URL}/api/v4/users/me`])
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(`Mattermost · ${BOT_USERNAME}`)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      name: BOT_USERNAME,
      platform: 'mattermost',
      transport: 'socket',
      externalAppId: EXPECTED_APP_ID,
      externalTenantId: BOT_USER_ID,
      botUserId: BOT_USER_ID,
      workspaceName: 'chat.example.com',
      platformConfig: {
        serverUrl: SERVER_URL,
        botUserId: BOT_USER_ID,
        botUsername: BOT_USERNAME
      }
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: BOT_TOKEN,
      appToken: null,
      signingSecret: null
    })
    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      platform: 'mattermost',
      config: {
        serverUrl: SERVER_URL,
        botToken: BOT_TOKEN,
        botUserId: BOT_USER_ID,
        botUsername: BOT_USERNAME
      }
    })

    const botDtoRes = await app.app.inject({ method: 'GET', url: `${ORG}/bots/${dto.botId}` })
    expect(botDtoRes.statusCode).toBe(200)
    expect(botDtoRes.body).not.toContain(BOT_TOKEN)
    expect(botDtoRes.json()).toMatchObject({
      externalAppId: EXPECTED_APP_ID,
      externalTenantId: BOT_USER_ID,
      workspaceName: 'chat.example.com',
      platformConfig: {
        serverUrl: SERVER_URL,
        botUserId: BOT_USER_ID,
        botUsername: BOT_USERNAME
      }
    })
  })

  it('accepts a PAT (is_bot: false) on a self-hosted private-IP http:// server', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()
    const res = await install(app, agentId, { serverUrl: 'http://192.168.1.50:8065/', botToken: SECOND_TOKEN })
    expect(res.statusCode).toBe(201)
    expect(calls).toEqual(['http://192.168.1.50:8065/api/v4/users/me'])
  })

  it('refuses rejected credentials with MATTERMOST_CREDENTIALS_INVALID, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const res = await install(app, agentId, { botToken: 'wrong-token' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MATTERMOST_CREDENTIALS_INVALID')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses blocked or malformed serverUrl before calling Mattermost, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()

    for (const serverUrl of [
      'http://169.254.169.254',
      'http://[fe80::1]:8065',
      'http://0.0.0.0:8065',
      'https://user:pass@chat.example.com',
      'ftp://chat.example.com'
    ]) {
      const res = await install(app, agentId, { serverUrl })
      expect(res.statusCode, serverUrl).toBe(400)
      expect(res.json().code, serverUrl).toBe('MATTERMOST_SERVER_URL_INVALID')
    }
    expect(calls).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })

  it('answers unavailable when Mattermost cannot be reached, storing nothing', async () => {
    const agentId = await placedAgent()
    const app = buildHttpApp(prisma, {}, undefined, new SpyControl() as unknown as ControlSender, {
      mattermostFetch: (async () => {
        throw new TypeError('connect ECONNREFUSED')
      }) as typeof fetch
    })
    running = app

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('MATTERMOST_CHECK_UNAVAILABLE')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses a second bot for the same (serverUrl, botUserId) while allowing a different bot on the same server', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    const third = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    await seedAgent(prisma, third, { daemonId: DAEMON })
    const { app } = harness()

    expect((await install(app, agentId)).statusCode).toBe(201)
    const dup = await install(app, other)
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('MATTERMOST_BOT_ALREADY_INSTALLED')
    expect(dup.json().message).toMatch(/already installed/)

    const secondBot = await install(app, third, { botToken: SECOND_TOKEN })
    expect(secondBot.statusCode).toBe(201)
    expect(await prisma.bot.count({ where: { platform: 'mattermost' } })).toBe(2)
  })

  it('reuses an existing bot without calling Mattermost again', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }
    expect(
      (await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })).statusCode
    ).toBeLessThan(300)

    const reused = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'mattermost', agentId, botId: created.botId }
    })
    expect(reused.statusCode).toBe(201)
    expect(calls).toEqual([`${SERVER_URL}/api/v4/users/me`])
  })

  it('refuses the http transport before calling Mattermost', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()

    expect((await install(app, agentId, {}, 'http')).statusCode).toBe(400)
    expect(calls).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses POST /integrations with 409 when the daemon lacks mattermost capability and deletes integrations cleanly', async () => {
    const unsupportedDaemon = 'd5d5d5d5-dddd-4ddd-8ddd-dddddddddddd'
    await seedDaemon(prisma, unsupportedDaemon, {
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
    })
    const unsupportedAgent = randomUUID()
    await seedAgent(prisma, unsupportedAgent, { daemonId: unsupportedDaemon })
    const { app, control, calls } = harness()

    const blocked = await install(app, unsupportedAgent)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().message).toContain('mattermost')
    expect(calls).toEqual([])

    const agentId = await placedAgent()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }
    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })
    expect(del.statusCode).toBe(204)
    expect(control.removals).toEqual([{ integrationId: created.id }])
    expect(await prisma.integration.findUnique({ where: { id: created.id } })).toBeNull()
  })
})

describe('PUT /bots/:id/mattermost/credentials', () => {
  it('verifies and stores a replacement token, updates username if changed, and re-pushes daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: ROTATED }
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(ROTATED)
    expect(res.json().platformConfig).toEqual({
      serverUrl: SERVER_URL,
      botUserId: BOT_USER_ID,
      botUsername: 'agentbot-renamed'
    })
    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({
      botToken: ROTATED,
      appToken: null
    })
    expect(control.upserts.at(-1)).toMatchObject({
      platform: 'mattermost',
      config: {
        serverUrl: SERVER_URL,
        botToken: ROTATED,
        botUserId: BOT_USER_ID,
        botUsername: 'agentbot-renamed'
      }
    })
  })

  it('refuses an invalid token or a token belonging to a different Mattermost user', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const bad = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: 'wrong-token' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('MATTERMOST_CREDENTIALS_INVALID')

    const mismatch = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: SECOND_TOKEN }
    })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json().code).toBe('MATTERMOST_BOT_MISMATCH')

    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({ botToken: BOT_TOKEN })
  })

  it('answers 404 for an unknown bot, another organization’s bot, and a non-Mattermost bot', async () => {
    const { app } = harness()
    const otherOrg = `org-mm-token-${randomUUID()}`
    await prisma.org.create({ data: { id: otherOrg, slug: otherOrg } })
    const foreignBot = randomUUID()
    await prisma.bot.create({
      data: { id: foreignBot, orgId: otherOrg, platform: 'mattermost', name: 'foreign', transport: 'socket' }
    })
    const telegramBot = randomUUID()
    await prisma.bot.create({
      data: { id: telegramBot, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: 'tg', transport: 'socket' }
    })

    for (const botId of [randomUUID(), foreignBot, telegramBot]) {
      const res = await app.app.inject({
        method: 'PUT',
        url: `${ORG}/bots/${botId}/mattermost/credentials`,
        payload: { botToken: ROTATED }
      })
      expect(res.statusCode, botId).toBe(404)
    }
  })

  it('reconnects a revoked bot in place (restoreRevokedMemberships), preserving channels/crons and re-pushing daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }

    const channelId = 'mmchanrevoked1234567890abc'
    await prisma.integrationChannel.create({
      data: {
        integrationId: created.id,
        channelId,
        name: 'ops',
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
        targetChannel: channelId,
        targetIntegrationId: created.id,
        trigger: 'weekly report'
      }
    })

    const before = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId } })
    await app.deps.repos.botCredential.revoke(
      before.id as never,
      new Date(),
      { revision: before.credentialRevision },
      { reason: 'tokens_revoked', evidence: 'event', code: null }
    )
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: 'revoked'
    })
    control.upserts.length = 0

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${created.botId}/mattermost/credentials`,
      payload: { botToken: ROTATED }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: created.botId, revokedAt: null, agentIds: [agentId] })
    expect(res.body).not.toContain(ROTATED)

    const after = await prisma.bot.findUniqueOrThrow({ where: { id: created.botId }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision + 1)
    expect(after.revokedAt).toBeNull()
    expect(after.secret?.botToken).toBe(ROTATED)
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: 'active',
      revokedCredentialRevision: null
    })
    expect(
      await prisma.integrationChannel.findUniqueOrThrow({
        where: { integrationId_channelId: { integrationId: created.id, channelId } }
      })
    ).toMatchObject({ trigger: 'any', triggerChosen: true, sessionMode: 'append' })
    expect(await prisma.cronDef.findUniqueOrThrow({ where: { id: cronId } })).toMatchObject({
      targetIntegrationId: created.id
    })
    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      integrationId: created.id,
      config: { serverUrl: SERVER_URL, botToken: ROTATED, botUsername: 'agentbot-renamed' }
    })
  })

  it('refuses a viewer (403) and an API key (403 interactiveOnly)', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const minted = await app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    const { apiKey } = minted.json() as { apiKey: string }
    const byKey = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { botToken: ROTATED }
    })
    expect(byKey.statusCode).toBe(403)
    expect(byKey.json().message).toBe('interactive sign-in required')
    await app.close()
    running = undefined

    const users = new PgUserRepo(prisma)
    const email = 'mm-token-viewer@example.test'
    const { userId } = await users.provisionOidcUser({ oidcSubject: 'mm-token-viewer', email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'viewer')

    const viewerApp = buildHttpApp(
      prisma,
      { DEFAULT_OWNER_ID: userId },
      undefined,
      new SpyControl() as unknown as ControlSender,
      {
        mattermostFetch: fakeMattermost({ [ROTATED]: { id: BOT_USER_ID, username: BOT_USERNAME, is_bot: true } }, [])
      }
    )
    running = viewerApp
    const byViewer = await viewerApp.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: ROTATED }
    })
    expect(byViewer.statusCode).toBe(403)
    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({ botToken: BOT_TOKEN })
  })

  it('answers 503 MATTERMOST_CHECK_UNAVAILABLE when Mattermost is unreachable and 400 on invalid token input', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const empty = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: '   ' }
    })
    expect(empty.statusCode).toBe(400)
    await app.close()
    running = undefined

    const offlineApp = buildHttpApp(prisma, {}, undefined, new SpyControl() as unknown as ControlSender, {
      mattermostFetch: (async () => {
        throw new TypeError('connect ECONNREFUSED')
      }) as typeof fetch
    })
    running = offlineApp
    const unavailable = await offlineApp.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/mattermost/credentials`,
      payload: { botToken: ROTATED }
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().code).toBe('MATTERMOST_CHECK_UNAVAILABLE')
    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({ botToken: BOT_TOKEN })
  })
})

describe('Mattermost channelPlacements', () => {
  it('emits botAppId (mm-...) and botUserId for active Mattermost integrations', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }

    const channelId = 'mmchan1234567890abcdefghij'
    await prisma.integrationChannel.create({
      data: { integrationId: created.id, channelId, name: 'town-square' }
    })

    const placements = await new PgIntegrationRepo(prisma).channelPlacements(OrgId(DEFAULT_ORG_ID))
    expect(placements).toEqual([
      expect.objectContaining({
        platform: 'mattermost',
        channelId,
        agentId,
        daemonId: DAEMON,
        integrationId: created.id,
        botAppId: EXPECTED_APP_ID,
        botUserId: BOT_USER_ID
      })
    ])
    expect(placements[0]!.botAppId).toMatch(/^mm-[0-9a-f]{16}$/)
  })
})

describe('Mattermost session access sync (Postgres + HTTP)', () => {
  it('gates PUT/GET /session-access/mattermost by owner role and availability, and resolves Mode B sessions', async () => {
    const usersRepo = new PgUserRepo(prisma)
    const { userId: ownerId } = await usersRepo.provisionOidcUser({
      oidcSubject: 'sub-mm-owner',
      email: 'owner@acme.dev',
      emailVerified: true
    })
    await usersRepo.addMemberByEmail(DEFAULT_ORG_ID, 'owner@acme.dev', 'owner')
    const { userId: memberId } = await usersRepo.provisionOidcUser({
      oidcSubject: 'sub-mm-member',
      email: 'member@acme.dev',
      emailVerified: true
    })
    await usersRepo.addMemberByEmail(DEFAULT_ORG_ID, 'member@acme.dev', 'collaborator')
    const { userId: outsiderId } = await usersRepo.provisionOidcUser({
      oidcSubject: 'sub-mm-outsider',
      email: 'outsider@acme.dev',
      emailVerified: true
    })
    await usersRepo.addMemberByEmail(DEFAULT_ORG_ID, 'outsider@acme.dev', 'collaborator')

    const agentId = await placedAgent()
    const { app } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }

    // Default test harness marks mattermost session access unavailable until wired with identity.
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/session-access/mattermost` })).json()).toMatchObject({
      provider: 'mattermost',
      available: false,
      enabled: false
    })
    expect(
      (
        await app.app.inject({
          method: 'PUT',
          url: `${ORG}/session-access/mattermost`,
          payload: { enabled: true }
        })
      ).statusCode
    ).toBe(409)
    await app.close()
    running = undefined

    const memberApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: memberId })
    running = memberApp
    expect(
      (
        await memberApp.app.inject({
          method: 'PUT',
          url: `${ORG}/session-access/mattermost`,
          payload: { enabled: true }
        })
      ).statusCode
    ).toBe(403)
    await memberApp.close()
    running = undefined

    const channelId = 'mmchan1234567890abcdefghij'
    const publicChannelId = 'mmpubchan1234567890abcdefg'
    const teamId = 'mmteam1234567890abcdefghij'
    const memberMmId = 'mmuseralice1234567890abcde'
    const ownerMmId = 'mmuserowner1234567890abcde'

    const makeSessionAccess = () =>
      new MattermostSessionAccessService({
        bots: new PgBotRepo(prisma),
        botSecrets: new PgBotSecretStore(prisma, new PlaintextSecretCipher()),
        users: usersRepo,
        clock: systemClock,
        mattermostOauthRealmKey: EXPECTED_APP_ID,
        identity: {
          chatIdentitiesFor: async (sub) => {
            if (sub === 'sub-mm-owner')
              return [{ platform: 'mattermost', tenant: EXPECTED_APP_ID, memberId: ownerMmId }]
            if (sub === 'sub-mm-member')
              return [{ platform: 'mattermost', tenant: EXPECTED_APP_ID, memberId: memberMmId }]
            return []
          }
        },
        fetchImpl: (async (url) => {
          const path = new URL(String(url)).pathname
          if (
            path === `/team/api/v4/channels/${channelId}/members/${ownerMmId}` ||
            path === `/team/api/v4/channels/${channelId}/members/${memberMmId}`
          ) {
            return Response.json({ channel_id: channelId, user_id: path.split('/').pop()! })
          }
          if (path === `/team/api/v4/users/${ownerMmId}` || path === `/team/api/v4/users/${memberMmId}`) {
            return Response.json({ id: path.split('/').pop()!, delete_at: 0, roles: 'system_user' })
          }
          if (path === `/team/api/v4/channels/${publicChannelId}`) {
            return Response.json({ id: publicChannelId, type: 'O', delete_at: 0, team_id: teamId })
          }
          if (path === `/team/api/v4/teams/${teamId}/members/${ownerMmId}`) {
            return Response.json({ team_id: teamId, user_id: ownerMmId, delete_at: 0 })
          }
          return new Response('{}', { status: 404 })
        }) as typeof fetch
      })

    const ownerApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: ownerId }, undefined, undefined, {
      sessionAccessPlugins: [makeSessionAccess()]
    })
    running = ownerApp
    const enabledRes = await ownerApp.app.inject({
      method: 'PUT',
      url: `${ORG}/session-access/mattermost`,
      payload: { enabled: true }
    })
    expect(enabledRes.statusCode).toBe(200)
    expect(enabledRes.json()).toMatchObject({
      provider: 'mattermost',
      available: true,
      enabled: true,
      state: 'enabled'
    })

    const sessions = new PgSessionRepo(prisma)
    const extChannelSess = SessionId(`s-mm-chan-${randomUUID()}`)
    const pubChannelSess = SessionId(`s-mm-pub-${randomUUID()}`)
    const dmSess = SessionId(`s-mm-dm-${randomUUID()}`)
    for (const [id, key] of [
      [extChannelSess, channelId],
      [pubChannelSess, publicChannelId]
    ] as const) {
      await sessions.recordMilestone({
        sessionId: id,
        agentId: AgentId(agentId),
        phase: 'start',
        platform: 'mattermost',
        channel: key,
        at: new Date(),
        classification: { visibility: 'org', ownerIdentity: null, source: 'default' },
        externalCandidate: {
          provider: 'mattermost',
          resolution: 'settled',
          scope: {
            realmKey: EXPECTED_APP_ID,
            resourceKind: 'conversation',
            resourceKey: key,
            credentialKind: 'bot',
            credentialId: created.botId
          }
        }
      })
    }
    await sessions.recordMilestone({
      sessionId: dmSess,
      agentId: AgentId(agentId),
      phase: 'start',
      platform: 'mattermost',
      channel: 'mmdmchan1234567890abcdefgh',
      at: new Date(),
      classification: {
        visibility: 'private',
        ownerIdentity: `mattermost:${EXPECTED_APP_ID}:${memberMmId}`,
        source: 'default'
      }
    })

    // Owner sees direct channel session + public team channel session, not the member's private DM.
    const ownerList = (await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json() as {
      sessions: Array<{ sessionId: string }>
    }
    expect(ownerList.sessions.map((s) => s.sessionId).sort()).toEqual([extChannelSess, pubChannelSess].sort())
    expect((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${pubChannelSess}` })).statusCode).toBe(
      200
    )
    expect((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${dmSess}` })).statusCode).toBe(404)
    await ownerApp.close()
    running = undefined

    // Member sees direct channel session + their private DM (not the team-only public channel they are not in).
    const modeBApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: memberId }, undefined, undefined, {
      sessionAccessPlugins: [makeSessionAccess()]
    })
    running = modeBApp
    const memberList = (await modeBApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json() as {
      sessions: Array<{ sessionId: string }>
    }
    expect(memberList.sessions.map((s) => s.sessionId).sort()).toEqual([dmSess, extChannelSess].sort())
    expect((await modeBApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${dmSess}` })).statusCode).toBe(200)
    expect((await modeBApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${pubChannelSess}` })).statusCode).toBe(
      404
    )
    await modeBApp.close()
    running = undefined

    // Unlinked / non-member collaborator sees none of the protected sessions.
    const outsiderApp = buildHttpApp(prisma, { DEFAULT_OWNER_ID: outsiderId }, undefined, undefined, {
      sessionAccessPlugins: [makeSessionAccess()]
    })
    running = outsiderApp
    const outsiderList = (await outsiderApp.app.inject({ method: 'GET', url: `${ORG}/sessions?view=flat` })).json() as {
      sessions: Array<{ sessionId: string }>
    }
    expect(outsiderList.sessions).toEqual([])
    expect((await outsiderApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${extChannelSess}` })).statusCode).toBe(
      404
    )
  })
})
