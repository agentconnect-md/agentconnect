import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { importPKCS8, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { BotId, OrgId } from '../../src/domain/ids.js'
import { msTeamsConnectKeys, sealMsTeamsTicket } from '../../src/platforms/msteams/connect.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { provisionPresetAgents } from '../../src/persistence/index.js'
import { seedSessionMeta } from '../fixtures/seed.js'
import { MSTEAMS_DEPLOYMENT_SECRET_MARKER } from '../../src/platforms/msteams/deployment-app.js'

const TENANT = '55555555-5555-4555-8555-555555555555'
const OBJECT = '66666666-6666-4666-8666-666666666666'
const TEAM_ADMIN = '69091246-20e8-4a56-aa4d-066075b2a7a8'
const APP = {
  appId: '33333333-3333-4333-8333-333333333333',
  tenantId: '44444444-4444-4444-8444-444444444444',
  clientSecret: 'synthetic-secret'
}
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})
const jwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'example', alg: 'RS256' }
let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness() {
  await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
  const destination = await prisma.org.create({ data: { slug: 'recovery-example' } })
  await prisma.membership.create({ data: { orgId: destination.id, userId: DEFAULT_OWNER_ID, role: 'collaborator' } })
  await provisionPresetAgents(prisma, { orgId: destination.id })
  const agent = await prisma.agent.findFirstOrThrow({ where: { orgId: destination.id } })
  const previousAgent = await prisma.agent.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
  const microsoft = {
    roles: [TEAM_ADMIN],
    tenant: TENANT,
    object: OBJECT,
    me: OBJECT,
    nonce: '',
    challenge: '',
    wrongNonce: false,
    status: 200,
    calls: [] as string[],
    used: new Set<string>()
  }
  const fetchMicrosoft: typeof fetch = async (input, init) => {
    const url = String(input)
    microsoft.calls.push(url)
    if (url.endsWith('/oauth2/v2.0/token')) {
      const body = new URLSearchParams(String(init?.body))
      const code = body.get('code')!
      if (microsoft.used.has(code)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      microsoft.used.add(code)
      if (body.get('scope') === 'https://graph.microsoft.com/User.Read openid')
        return Response.json({
          access_token: 'synthetic-connect-token',
          id_token: ['e30', Buffer.from(JSON.stringify({ tid: TENANT })).toString('base64url'), 'sig'].join('.')
        })
      expect(url).toContain(`/${TENANT}/`)
      expect(body.get('redirect_uri')).toBe('https://console.example.test/msteams/connect')
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(microsoft.challenge)
      const token = await new SignJWT({
        tid: microsoft.tenant,
        oid: microsoft.object,
        nonce: microsoft.wrongNonce ? 'wrong' : microsoft.nonce
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'example' })
        .setSubject('example-subject')
        .setIssuer(`https://login.microsoftonline.com/${microsoft.tenant}/v2.0`)
        .setAudience(APP.appId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(await importPKCS8(privateKey, 'RS256'))
      return Response.json({ access_token: 'synthetic-admin-token', id_token: token })
    }
    if (url.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] })
    if (url === 'https://graph.microsoft.com/v1.0/me?$select=id') return Response.json({ id: microsoft.me })
    if (url === 'https://graph.microsoft.com/v1.0/me/checkMemberObjects') {
      expect(JSON.parse(String(init?.body))).toEqual({ ids: ['62e90394-69f5-4237-9190-012177145e10', TEAM_ADMIN] })
      return Response.json({ value: microsoft.roles }, { status: microsoft.status })
    }
    throw new Error(`unexpected Microsoft request: ${url}`)
  }
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' }, undefined, undefined, {
    msTeamsFetch: fetchMicrosoft,
    msTeamsPlatformApp: APP
  })
  const app = running
  app.relayReg.add({ relayId: 'example-relay', send() {}, close() {} } as unknown as RelayChannel)
  const errors: string[] = []
  app.app.addHook('onError', (_req, _reply, error, done) => {
    errors.push(error.message)
    done()
  })
  const post = (step: string, payload: Record<string, string>, orgId = destination.id) =>
    app.app.inject({ method: 'POST', url: `/api/v1/orgs/${orgId}/integrations/msteams/${step}`, payload })
  const old = await prisma.bot.create({
    data: {
      id: randomUUID(),
      orgId: DEFAULT_ORG_ID,
      name: 'Original private label',
      platform: 'msteams',
      transport: 'http',
      prebuilt: true,
      externalAppId: APP.appId,
      externalTenantId: TENANT,
      platformConfig: { appOwner: 'deployment', tokenTenantId: APP.tenantId, source: 'store' }
    }
  })
  const oldInstall = await prisma.integration.create({
    data: {
      id: randomUUID(),
      orgId: DEFAULT_ORG_ID,
      agentId: previousAgent.id,
      botId: old.id,
      platform: 'msteams',
      name: 'Teams'
    }
  })
  async function start() {
    const response = await post('recovery/start', { tenantId: TENANT, agentId: agent.id })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<{ state: string; authorizeUrl: string }>()
    const query = new URL(result.authorizeUrl).searchParams
    microsoft.nonce = query.get('nonce')!
    microsoft.challenge = query.get('code_challenge')!
    expect(query.get('scope')).toBe('openid profile https://graph.microsoft.com/User.Read')
    return result.state
  }
  async function verified() {
    const state = await start()
    const response = await post('recovery/verify', { state, code: randomUUID() })
    expect(response.statusCode, errors.join('\n') || response.body).toBe(200)
    return response.json<{ ticket: string }>().ticket
  }
  return { app, microsoft, post, start, verified, old, oldInstall, agent, destination, errors }
}

describe('Teams administrator recovery', () => {
  it('requires confirmation, removes every deployment bot, retains own apps and history, and refuses replay', async () => {
    const h = await harness()
    const extra = await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        name: 'Additional bot',
        platform: 'msteams',
        transport: 'http',
        prebuilt: true,
        externalAppId: randomUUID(),
        externalTenantId: TENANT,
        platformConfig: { appOwner: 'deployment', agentBot: { blueprintId: randomUUID(), resourceName: 'example-bot' } }
      }
    })
    const own = await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        name: 'Organization app',
        platform: 'msteams',
        transport: 'http',
        externalAppId: randomUUID(),
        externalTenantId: TENANT
      }
    })
    const session = randomUUID()
    await seedSessionMeta(prisma, session, h.oldInstall.agentId, { platform: 'msteams', tenantScope: TENANT })
    // A member's request of the previous organization, still waiting for approval.
    const waiting = await prisma.msTeamsAgentBotRequest.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId: h.oldInstall.agentId,
        tenantId: TENANT,
        createdByUserId: DEFAULT_OWNER_ID,
        sponsorId: randomUUID(),
        identity: randomUUID(),
        catalogAppId: 'catalog-example',
        teamIds: [],
        appPackage: 'fingerprint-example',
        botName: 'Microsoft Teams',
        status: 'pending',
        nextCheckAt: new Date()
      }
    })
    const unassign = vi.spyOn(h.app.deps.httpBot, 'unassign')
    const provider = h.app.deps.platforms.get('msteams')!
    const teardown = vi.fn()
    provider.sideEffects = { ...provider.sideEffects, onBotDelete: teardown }
    const connect = await h.post('connect', { tenantId: TENANT, agentId: h.agent.id })
    const state = new URL(connect.json<{ authorizeUrl: string }>().authorizeUrl).searchParams.get('state')!
    const conflict = await h.post('connect/callback', { state, code: randomUUID() })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({
      code: 'MSTEAMS_TENANT_TAKEN',
      recovery: { tenantId: TENANT, agentId: h.agent.id }
    })
    expect(conflict.body).not.toContain(h.old.name)
    const ticket = await h.verified()
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
    expect(ticket).not.toContain('synthetic-admin-token')
    const response = await h.post('recovery/confirm', { ticket })
    expect(response.statusCode, h.errors.join('\n') || response.body).toBe(200)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).toBeNull()
    expect(await prisma.bot.findUnique({ where: { id: extra.id } })).toBeNull()
    expect(await prisma.bot.findUnique({ where: { id: own.id } })).not.toBeNull()
    expect(await prisma.msTeamsAgentBotRequest.findUnique({ where: { id: waiting.id } })).toBeNull()
    expect(await prisma.sessionMeta.findUnique({ where: { id: session } })).toMatchObject({
      agentId: h.oldInstall.agentId
    })
    const replacement = await prisma.bot.findFirstOrThrow({ where: { orgId: h.destination.id, platform: 'msteams' } })
    expect(replacement.id).not.toBe(h.old.id)
    expect(replacement.name).toBe('Microsoft Teams')
    expect(replacement.platformConfig).toMatchObject({ source: 'store' })
    const secret = await h.app.deps.repos.botSecret.get(OrgId(h.destination.id), BotId(replacement.id))
    expect(secret?.botToken).toBe(MSTEAMS_DEPLOYMENT_SECRET_MARKER)
    expect(unassign.mock.calls.map(([bot]) => bot.id)).toEqual(expect.arrayContaining([h.old.id, extra.id]))
    expect(teardown.mock.calls.map(([bot]) => bot.id)).toEqual(expect.arrayContaining([h.old.id, extra.id]))
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(409)
    const oldTicket = sealMsTeamsTicket(
      msTeamsConnectKeys(TEST_API_KEY_PEPPER),
      {
        accessToken: 'synthetic-old-install-token',
        orgId: DEFAULT_ORG_ID,
        integrationId: h.oldInstall.id,
        catalogAppId: 'example-catalog-app'
      },
      h.app.deps.clock
    )
    h.microsoft.calls.length = 0
    const oldRequest = await h.app.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/integrations/msteams/connect/install`,
      payload: { ticket: oldTicket, teamIds: ['example-team'] }
    })
    expect(oldRequest.statusCode).toBe(409)
    expect(h.microsoft.calls).toEqual([])
  })

  it.each(['member', 'wrongTenant', 'wrongNonce', 'wrongAccount', 'graphFailure'] as const)(
    'refuses %s without releasing the tenant',
    async (kind) => {
      const h = await harness()
      const state = await h.start()
      if (kind === 'member') h.microsoft.roles = []
      if (kind === 'wrongTenant') h.microsoft.tenant = APP.tenantId
      if (kind === 'wrongNonce') h.microsoft.wrongNonce = true
      if (kind === 'wrongAccount') h.microsoft.me = APP.appId
      if (kind === 'graphFailure') h.microsoft.status = 503
      const response = await h.post('recovery/verify', { state, code: randomUUID() })
      expect(response.statusCode, response.body).toBe(kind === 'graphFailure' ? 503 : 403)
      expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
    }
  )

  it.each(['role', 'member', 'agent', 'binding', 'extraBot'] as const)(
    'rechecks changed %s before confirmation',
    async (kind) => {
      const h = await harness()
      const ticket = await h.verified()
      if (kind === 'role') h.microsoft.roles = []
      if (kind === 'member')
        await prisma.membership.updateMany({ where: { orgId: h.destination.id }, data: { role: 'viewer' } })
      if (kind === 'agent')
        await prisma.agent.update({
          where: { id: h.agent.id },
          data: { visibility: 'restricted', sharedWith: ['another-user'] }
        })
      if (kind === 'binding')
        await prisma.bot.update({ where: { id: h.old.id }, data: { credentialRevision: { increment: 1 } } })
      if (kind === 'extraBot')
        await prisma.bot.create({
          data: {
            id: randomUUID(),
            orgId: DEFAULT_ORG_ID,
            name: 'Pending bot',
            platform: 'msteams',
            transport: 'http',
            prebuilt: true,
            externalAppId: randomUUID(),
            externalTenantId: TENANT
          }
        })
      const response = await h.post('recovery/confirm', { ticket })
      expect([403, 409], response.body).toContain(response.statusCode)
      expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
    }
  )

  it('runs provider teardown even when publishing the replacement is interrupted', async () => {
    const h = await harness()
    const ticket = await h.verified()
    const provider = h.app.deps.platforms.get('msteams')!
    const teardown = vi.fn()
    provider.sideEffects = { ...provider.sideEffects, onBotDelete: teardown }
    vi.spyOn(h.app.deps.httpBot, 'syncBot').mockRejectedValueOnce(new Error('synthetic publication interruption'))
    const response = await h.post('recovery/confirm', { ticket })
    expect(response.statusCode).toBe(500)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).toBeNull()
    expect(teardown.mock.calls.map(([bot]) => bot.id)).toContain(h.old.id)
    expect(await prisma.bot.count({ where: { orgId: h.destination.id, externalTenantId: TENANT } })).toBe(1)
  })

  it('serializes competing confirmations so only one succeeds', async () => {
    const h = await harness()
    const first = await h.verified()
    const second = await h.verified()
    const replies = await Promise.all([
      h.post('recovery/confirm', { ticket: first }),
      h.post('recovery/confirm', { ticket: second })
    ])
    expect(replies.map((r) => r.statusCode).sort(), replies.map((r) => r.body).join('\n')).toEqual([200, 409])
    expect(await prisma.bot.count({ where: { externalAppId: APP.appId, externalTenantId: TENANT } })).toBe(1)
  })

  it('cannot start without a conflict or use a different destination to verify', async () => {
    const h = await harness()
    expect((await h.post('recovery/start', { tenantId: APP.tenantId, agentId: h.agent.id })).statusCode).toBe(409)
    const state = await h.start()
    expect((await h.post('recovery/verify', { state, code: randomUUID() }, DEFAULT_ORG_ID)).statusCode).toBe(409)
    expect(h.microsoft.calls).toEqual([])
  })
})
