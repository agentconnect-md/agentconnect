import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { importPKCS8, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { provisionPresetAgents } from '../../src/persistence/index.js'
import { seedSessionMeta } from '../fixtures/seed.js'
import { GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER } from '../../src/platforms/googlechat/deployment-app.js'

const USER = '100000000000000000009'
const CUSTOMER = 'C0000000000'
const DOMAIN = '0000000000'
const PROJECT = '123456789012'
const OAUTH = {
  clientId: 'example-client.apps.googleusercontent.com',
  clientSecret: 'synthetic-secret',
  webAppUrl: 'https://console.example.test'
}
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})
const jwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'example', alg: 'RS256' }
const APP = {
  projectId: 'example-project',
  projectNumber: PROJECT,
  serviceAccountKey: JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key: privateKey,
    client_email: 'agentconnect-chat@example-project.iam.gserviceaccount.com'
  })
}
const claimState = (kind: 'space' | 'dm' = 'space') =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      app: PROJECT,
      space: `spaces/${kind === 'space' ? 'AAAAexample' : 'DDDDexample'}`,
      kind,
      user: `users/${USER}`,
      iat: 1
    })
  ).toString('base64url')

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness() {
  await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { googleAccountId: USER } })
  const destination = await prisma.org.create({ data: { slug: 'recovery-example' } })
  await prisma.membership.create({ data: { orgId: destination.id, userId: DEFAULT_OWNER_ID, role: 'collaborator' } })
  await provisionPresetAgents(prisma, { orgId: destination.id })
  const google = {
    admin: true,
    customer: CUSTOMER,
    subject: USER,
    nonce: '',
    challenge: '',
    wrongNonce: false,
    calls: [] as string[],
    used: new Set<string>()
  }
  const fetchGoogle: typeof fetch = async (input, init) => {
    const url = String(input)
    google.calls.push(url)
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') !== 'authorization_code') return Response.json({ access_token: 'synthetic-bot-token' })
      const code = body.get('code')!
      if (google.used.has(code)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      google.used.add(code)
      expect(body.get('redirect_uri')).toBe('https://console.example.test/googlechat/recover')
      expect(body.get('code_verifier')).not.toBe(google.nonce)
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(google.challenge)
      const idToken = await new SignJWT({ nonce: google.wrongNonce ? 'other-nonce' : google.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'example' })
        .setSubject(google.subject)
        .setIssuer('https://accounts.google.com')
        .setAudience(OAUTH.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(await importPKCS8(privateKey, 'RS256'))
      return Response.json({ access_token: 'synthetic-admin-token', id_token: idToken })
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] })
    if (url.startsWith('https://admin.googleapis.com/admin/directory/v1/users/')) {
      expect(url).toContain(`/users/${USER}?`)
      return Response.json({
        id: USER,
        isAdmin: google.admin,
        isDelegatedAdmin: true,
        suspended: false,
        customerId: google.customer
      })
    }
    const member = { name: `users/${USER}`, type: 'HUMAN', domainId: DOMAIN }
    if (url === `https://chat.googleapis.com/v1/spaces/AAAAexample/members/${USER}`)
      return Response.json({ affiliation: 'INTERNAL', member })
    if (url === 'https://chat.googleapis.com/v1/spaces/AAAAexample')
      return Response.json({ customer: `customers/${CUSTOMER}` })
    if (url === 'https://chat.googleapis.com/v1/spaces/DDDDexample/members?pageSize=100')
      return Response.json({ memberships: [{ member }] })
    throw new Error(`unexpected Google request: ${url}`)
  }
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' }, undefined, undefined, {
    googleChatFetch: fetchGoogle,
    googleChatPlatformApp: APP,
    googleChatRecoveryApplication: OAUTH
  })
  const app = running
  const errors: string[] = []
  app.app.addHook('onError', (_req, _reply, error, done) => {
    errors.push(error.message)
    done()
  })
  app.relayReg.add({ relayId: 'example-relay', send() {}, close() {} } as unknown as RelayChannel)
  const post = (step: string, payload: Record<string, string>, orgId = destination.id) =>
    app.app.inject({ method: 'POST', url: `/api/v1/orgs/${orgId}/integrations/googlechat/${step}`, payload })
  async function start(kind: 'space' | 'dm' = 'space') {
    const response = await post('recovery/start', { state: claimState(kind) })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json<{ state: string; authorizeUrl: string }>()
    const query = new URL(result.authorizeUrl).searchParams
    google.nonce = query.get('nonce')!
    google.challenge = query.get('code_challenge')!
    expect(query.get('scope')).toBe('openid https://www.googleapis.com/auth/admin.directory.user.readonly')
    expect(query.get('access_type')).toBe('online')
    return result.state
  }
  async function verified(kind: 'space' | 'dm' = 'space') {
    const state = await start(kind)
    const response = await post('recovery/verify', { state, code: randomUUID() })
    expect(response.statusCode, response.body).toBe(200)
    return response.json<{ ticket: string }>().ticket
  }
  const initial = await post('claim', { state: claimState() }, DEFAULT_ORG_ID)
  expect(initial.statusCode, initial.body).toBe(201)
  const old = await prisma.bot.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID, platform: 'googlechat' } })
  const oldInstall = await prisma.integration.findFirstOrThrow({ where: { botId: old.id } })
  return { app, google, post, start, verified, old, oldInstall, destination, errors }
}

describe('Google Chat administrator recovery', () => {
  it('requires confirmation, creates a fresh binding, keeps old history, and refuses replay', async () => {
    const h = await harness()
    const session = randomUUID()
    await seedSessionMeta(prisma, session, h.oldInstall.agentId, {
      platform: 'googlechat',
      tenantScope: `customers/${CUSTOMER}`
    })
    await prisma.bot.update({
      where: { id: h.old.id },
      data: {
        name: 'Original private label',
        platformConfig: { ...(h.old.platformConfig as Record<string, string>), domainIds: `${DOMAIN},0000000002` }
      }
    })
    const conflict = await h.post('claim', { state: claimState() })
    expect(conflict.statusCode).toBe(409)
    const ticket = await h.verified()
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
    expect(ticket).not.toContain('synthetic-admin-token')
    const recovered = await h.post('recovery/confirm', { ticket })
    expect(recovered.statusCode, h.errors.join('\n') || recovered.body).toBe(200)
    const rows = await prisma.bot.findMany({ where: { platform: 'googlechat' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orgId: h.destination.id, name: 'Google Chat' })
    expect(rows[0]!.platformConfig).toMatchObject({ customerId: CUSTOMER, domainIds: `${DOMAIN},0000000002` })
    expect(rows[0]!.id).not.toBe(h.old.id)
    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId: rows[0]!.id } })
    expect(secret.botToken).toBe(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER)
    expect(await prisma.sessionMeta.findUnique({ where: { id: session } })).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agentId: h.oldInstall.agentId
    })
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(409)
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(1)
  })

  it.each(['member', 'other-customer', 'other-user', 'wrong-nonce'] as const)(
    'rejects %s verification without releasing the binding',
    async (kind) => {
      const h = await harness()
      const state = await h.start()
      if (kind === 'member') h.google.admin = false
      if (kind === 'other-customer') h.google.customer = 'C1111111111'
      if (kind === 'other-user') h.google.subject = '100000000000000000008'
      if (kind === 'wrong-nonce') h.google.wrongNonce = true
      expect([403, 409]).toContain((await h.post('recovery/verify', { state, code: randomUUID() })).statusCode)
      expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
    }
  )

  it('rechecks current admin role and destination membership at confirmation', async () => {
    const h = await harness()
    const ticket = await h.verified()
    h.google.admin = false
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(403)
    h.google.admin = true
    await prisma.membership.update({
      where: { orgId_userId: { orgId: h.destination.id, userId: DEFAULT_OWNER_ID } },
      data: { role: 'viewer' }
    })
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(403)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
  })

  it('binds the ticket to its destination and current linked Google account', async () => {
    const h = await harness()
    const ticket = await h.verified()
    expect((await h.post('recovery/confirm', { ticket }, DEFAULT_ORG_ID)).statusCode).toBe(409)
    await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { googleAccountId: null } })
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(403)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
  })

  it('rejects changed bindings and tampered tickets', async () => {
    const h = await harness()
    const ticket = await h.verified()
    expect((await h.post('recovery/confirm', { ticket: ticket + 'x' })).statusCode).toBe(409)
    await prisma.bot.update({ where: { id: h.old.id }, data: { credentialRevision: { increment: 1 } } })
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(409)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
  })

  it('rejects inconsistent customer identities and a target agent the operator can no longer edit', async () => {
    const h = await harness()
    await prisma.bot.update({ where: { id: h.old.id }, data: { externalTenantId: 'customers/C1111111111' } })
    const state = await h.start()
    expect((await h.post('recovery/verify', { state, code: randomUUID() })).statusCode).toBe(409)
    await prisma.bot.update({ where: { id: h.old.id }, data: { externalTenantId: `customers/${CUSTOMER}` } })
    const ticket = await h.verified()
    const other = await prisma.user.create({ data: { email: 'other@example.test' } })
    await prisma.membership.create({ data: { orgId: h.destination.id, userId: other.id, role: 'collaborator' } })
    await prisma.agent.updateMany({
      where: { orgId: h.destination.id },
      data: { visibility: 'restricted', sharedWith: [other.id] }
    })
    expect((await h.post('recovery/confirm', { ticket })).statusCode).toBe(409)
    expect(await prisma.bot.findUnique({ where: { id: h.old.id } })).not.toBeNull()
  })

  it('allows only one concurrent confirmation, including a domain-only DM proof', async () => {
    const h = await harness()
    const ticket = await h.verified('dm')
    const results = await Promise.all([h.post('recovery/confirm', { ticket }), h.post('recovery/confirm', { ticket })])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(1)
  })
})
