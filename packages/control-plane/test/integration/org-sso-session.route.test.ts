/** Organization SSO per session (organization-sso.md §4.5): an address in the verified domains reaches the organization only from a session signed in through its connection. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { LogtoApiError } from '../../src/github/logto-identity.js'
import { PgOrgDomainRepo } from '../../src/persistence/repositories/org-domain.repo.js'
import { PgOrgSsoConnectionRepo } from '../../src/persistence/repositories/org-sso-connection.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgSsoProtocol } from '../../src/persistence/ports.js'
import { OrgSsoConnectionService } from '../../src/org-sso/connections.js'
import { OrgSsoDomainService } from '../../src/org-sso/domains.js'
import type { OrgSsoAccount, OrgSsoIdp } from '../../src/org-sso/idp.js'
import { ORG_SSO_LOOKUP_TTL_MS, OrgSsoSignInLookup } from '../../src/org-sso/lookup.js'
import { ORG_SSO_SESSION_CACHE_TTL_MS, OrgSsoSessionRule } from '../../src/org-sso/session.js'
import { SSO_CONNECTOR_CLAIM } from '../../src/org-sso/token-claims.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const SSO = `${ORG}/sso`
const AUDIENCE = 'org-sso-session-test'
const OWNER_SUBJECT = 'subject-owner'
const MEMBER_SUBJECT = 'subject-member'
const MEMBER_EMAIL = 'member@acme.example'
const INSIDE_OWNER_SUBJECT = 'subject-inside-owner'

/** The identity service in memory: connectors by id and accounts by subject. */
class FakeIdp implements OrgSsoIdp {
  readonly connectors = new Map<string, { name: string; protocol: OrgSsoProtocol; config: Record<string, unknown> }>()
  readonly accounts = new Map<string, Pick<OrgSsoAccount, 'primaryEmail' | 'connectorIds'>>()
  down = false

  private up(): void {
    if (this.down) throw new LogtoApiError('logto unreachable', 0, true)
  }

  async ensureConnector(input: { connectorName: string; protocol: OrgSsoProtocol }) {
    this.up()
    for (const [id, connector] of this.connectors) if (connector.name === input.connectorName) return id
    const id = `connector-${randomUUID().slice(0, 8)}`
    this.connectors.set(id, { name: input.connectorName, protocol: input.protocol, config: {} })
    return id
  }

  async connector(id: string) {
    this.up()
    const connector = this.connectors.get(id)
    return connector ? { config: connector.config } : ('missing' as const)
  }

  async configure(id: string, input: { config: Record<string, unknown> }) {
    this.up()
    const connector = this.connectors.get(id)
    if (!connector) return 'missing' as const
    connector.config = input.config
    return 'ok' as const
  }

  async setDomains(id: string) {
    this.up()
    return this.connectors.has(id) ? ('ok' as const) : ('missing' as const)
  }

  async deleteConnector(id: string) {
    this.up()
    this.connectors.delete(id)
  }

  async account(subject: string): Promise<OrgSsoAccount | null> {
    this.up()
    const account = this.accounts.get(subject)
    return account ? { attributeNames: {}, addressAttributes: {}, ...account } : null
  }

  async deleteAccount(subject: string) {
    this.up()
    this.accounts.delete(subject)
  }
}

let oidcServer: Server
let issuer = ''
let sign: (subject: string, claims?: Record<string, unknown>) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: AUDIENCE, use: 'sig' }
  oidcServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
      return
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    oidcServer.once('error', reject)
    oidcServer.listen(0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`
  sign = (subject, claims = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: AUDIENCE })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

let running: HttpApp | undefined
let clock: FakeClock
let idp: FakeIdp
let connections: OrgSsoConnectionService
let dns: Map<string, string[]>
let app: HttpApp['app']

beforeEach(async () => {
  clock = new FakeClock(Date.now())
  dns = new Map()
  idp = new FakeIdp()
  const domains = new OrgSsoDomainService(new PgOrgDomainRepo(prisma), async (name) => dns.get(name) ?? [], clock)
  const repo = new PgOrgSsoConnectionRepo(prisma)
  connections = new OrgSsoConnectionService({
    connections: repo,
    domains,
    idp,
    clock,
    idpOrigin: 'https://auth.example.test'
  })
  const lookup = new OrgSsoSignInLookup({ connections: repo, clock })
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: OWNER_SUBJECT } })
  idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [] })
  running = buildHttpApp(prisma, { OIDC_ISSUER: issuer, OIDC_AUDIENCE: AUDIENCE }, undefined, undefined, {
    orgSsoDomains: domains,
    orgSsoConnections: connections,
    orgSsoLookup: lookup,
    orgSsoSession: new OrgSsoSessionRule({ lookup, idp, clock })
  })
  app = running.app
})

afterEach(async () => {
  await running?.close()
  running = undefined
})

const as = async (subject: string, claims: Record<string, unknown> = {}) => ({
  authorization: `Bearer ${await sign(subject, claims)}`
})
const viaConnector = (connectorId: string) => ({ [SSO_CONNECTOR_CLAIM]: connectorId })
const owner = () => as(OWNER_SUBJECT)
const ownerPost = async (url: string, payload?: object) =>
  app.inject({ method: 'POST', url, headers: await owner(), ...(payload ? { payload } : {}) })
const agents = async (headers: Record<string, string>) => app.inject({ method: 'GET', url: `${ORG}/agents`, headers })
const orgList = async (headers: Record<string, string>) =>
  (await app.inject({ method: 'GET', url: '/api/v1/orgs', headers })).json() as {
    id: string
    ssoSignIn?: { connectorId: string } | null
  }[]

/** Verify acme.example, configure and test the connection; returns its connector id. */
async function testedConnection(): Promise<string> {
  const added = (await ownerPost(`${SSO}/domains`, { domain: 'acme.example' })).json() as {
    id: string
    record: { name: string; value: string }
  }
  dns.set(added.record.name, [added.record.value])
  expect((await ownerPost(`${SSO}/domains/${added.id}/verify`)).json()).toMatchObject({ check: 'ok' })
  const saved = await app.inject({
    method: 'PUT',
    url: `${SSO}/connection`,
    headers: await owner(),
    payload: {
      protocol: 'oidc',
      issuer: 'https://idp.example.test',
      clientId: 'c',
      clientSecret: 's'
    }
  })
  expect(saved.statusCode).toBe(200)
  clock.advance(1000)
  const test = (await ownerPost(`${SSO}/connection/test`)).json() as { nonce: string; connectorId: string }
  idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [test.connectorId] })
  expect((await ownerPost('/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: true })
  return test.connectorId
}

/** A second owner whose own address is inside the verified domain; only such an owner may enforce. */
async function insideOwner(): Promise<void> {
  const users = new PgUserRepo(prisma)
  await users.provisionOidcUser({ oidcSubject: INSIDE_OWNER_SUBJECT, email: 'boss@acme.example', emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, 'boss@acme.example', 'owner')
  idp.accounts.set(INSIDE_OWNER_SUBJECT, { primaryEmail: 'boss@acme.example', connectorIds: [] })
}

const enforce = async (connectorId: string) =>
  app.inject({
    method: 'POST',
    url: `${SSO}/connection/enforce`,
    headers: await as(INSIDE_OWNER_SUBJECT, viaConnector(connectorId))
  })

/** Activate the connection and have an owner inside the domain enforce it; returns its connector id. */
async function activeConnection(): Promise<string> {
  const connectorId = await testedConnection()
  expect((await ownerPost(`${SSO}/connection/activate`)).statusCode).toBe(200)
  await insideOwner()
  expect((await enforce(connectorId)).statusCode).toBe(200)
  clock.advance(ORG_SSO_LOOKUP_TTL_MS)
  return connectorId
}

/** A collaborator whose account address is inside the verified domain; signed in once so the subject maps to the user. */
async function memberInDomain(): Promise<void> {
  const users = new PgUserRepo(prisma)
  await users.provisionOidcUser({ oidcSubject: MEMBER_SUBJECT, email: MEMBER_EMAIL, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, MEMBER_EMAIL, 'collaborator')
  idp.accounts.set(MEMBER_SUBJECT, { primaryEmail: MEMBER_EMAIL, connectorIds: [] })
}

describe('organization SSO per session', () => {
  it('refuses an in-domain member signed in another way, and admits the session that signed in through the connection', async () => {
    await memberInDomain()
    const connectorId = await activeConnection()

    const refused = await agents(await as(MEMBER_SUBJECT))
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ code: 'ORG_SSO_SIGN_IN_REQUIRED' })
    expect((await orgList(await as(MEMBER_SUBJECT))).find((o) => o.id === DEFAULT_ORG_ID)?.ssoSignIn).toEqual({
      connectorId
    })

    // Another organization's connector does not count.
    expect((await agents(await as(MEMBER_SUBJECT, viaConnector('connector-elsewhere')))).statusCode).toBe(403)

    const admitted = await as(MEMBER_SUBJECT, viaConnector(connectorId))
    expect((await agents(admitted)).statusCode).toBe(200)
    expect((await orgList(admitted)).find((o) => o.id === DEFAULT_ORG_ID)?.ssoSignIn).toBeNull()
  })

  it('leaves an owner outside the domains and the member’s other organizations alone', async () => {
    await memberInDomain()
    await activeConnection()
    expect((await agents(await owner())).statusCode).toBe(200)

    const other = await new PgOrgRepo(prisma).create({ name: null, slug: 'elsewhere', ownerUserId: DEFAULT_OWNER_ID })
    await new PgUserRepo(prisma).addMemberByEmail(other.id, MEMBER_EMAIL, 'collaborator')
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${other.id}/agents`,
      headers: await as(MEMBER_SUBJECT)
    })
    expect(elsewhere.statusCode).toBe(200)
    expect((await orgList(await as(MEMBER_SUBJECT))).find((o) => o.id === other.id)?.ssoSignIn).toBeNull()
  })

  it('enforces only once an owner signed in through the connection enforces it', async () => {
    await memberInDomain()
    const connectorId = await testedConnection()
    // A tested connection, a test window and an active connection that is not enforced do not refuse anyone.
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)
    expect((await ownerPost(`${SSO}/connection/test`)).statusCode).toBe(200)
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)
    const early = await ownerPost(`${SSO}/connection/enforce`)
    expect(early.json()).toMatchObject({ code: 'SSO_NOT_ACTIVE' })
    expect((await ownerPost(`${SSO}/connection/activate`)).statusCode).toBe(200)
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)

    // Only an owner whose own address is inside the domains may enforce, since the rule then binds them too.
    const refused = await ownerPost(`${SSO}/connection/enforce`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'SSO_ENFORCER_OUTSIDE_DOMAINS' })
    await insideOwner()
    // An owner inside the domains still has to be signed in through the connection now.
    const notThrough = await app.inject({
      method: 'POST',
      url: `${SSO}/connection/enforce`,
      headers: await as(INSIDE_OWNER_SUBJECT)
    })
    expect(notThrough.json()).toMatchObject({ code: 'SSO_SIGN_IN_REQUIRED' })
    const throughAnother = await app.inject({
      method: 'POST',
      url: `${SSO}/connection/enforce`,
      headers: await as(INSIDE_OWNER_SUBJECT, viaConnector('connector-elsewhere'))
    })
    expect(throughAnother.json()).toMatchObject({ code: 'SSO_SIGN_IN_REQUIRED' })
    const enforced = await enforce(connectorId)
    expect(enforced.json()).toMatchObject({ status: 'active', enforcedAt: expect.any(String) })
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(403)

    // A connector gone from the identity service cannot be signed in through, so it locks nobody out.
    idp.connectors.delete(connectorId)
    clock.advance(ORG_SSO_SESSION_CACHE_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)
  })

  it('tells an owner whether they could enforce now', async () => {
    const connectorId = await testedConnection()
    const readiness = async (headers: Record<string, string>) =>
      ((await app.inject({ method: 'GET', url: SSO, headers })).json() as { enforce?: string }).enforce
    expect(await readiness(await owner())).toBeUndefined()
    expect((await ownerPost(`${SSO}/connection/activate`)).statusCode).toBe(200)
    expect(await readiness(await owner())).toBe('outside_domains')
    await insideOwner()
    expect(await readiness(await as(INSIDE_OWNER_SUBJECT))).toBe('sign_in_required')
    expect(await readiness(await as(INSIDE_OWNER_SUBJECT, viaConnector(connectorId)))).toBe('ready')
    await memberInDomain()
    expect(await readiness(await as(MEMBER_SUBJECT, viaConnector(connectorId)))).toBeUndefined()
  })

  it('stops enforcing when the settings change, so untested settings are never enforced', async () => {
    await memberInDomain()
    await activeConnection()
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(403)
    const changed = await app.inject({
      method: 'PUT',
      url: `${SSO}/connection`,
      headers: await owner(),
      payload: {
        protocol: 'oidc',
        issuer: 'https://idp.example.test',
        clientId: 'c2',
        clientSecret: 's'
      }
    })
    expect(changed.json()).toMatchObject({ status: 'active', enforcedAt: null })
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)
  })

  it('applies to an owner inside the domains like any member', async () => {
    await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { email: 'owner@acme.example' } })
    const connectorId = await activeConnection()
    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@acme.example', connectorIds: [connectorId] })
    clock.advance(ORG_SSO_SESSION_CACHE_TTL_MS)
    expect((await agents(await owner())).statusCode).toBe(403)
    expect((await agents(await as(OWNER_SUBJECT, viaConnector(connectorId)))).statusCode).toBe(200)
  })

  it('lifts the rule when an owner or a deployment administrator stops enforcing, and on deactivation', async () => {
    await memberInDomain()
    await activeConnection()
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(403)
    const stopped = await ownerPost(`${SSO}/connection/stop-enforcing`)
    expect(stopped.json()).toMatchObject({ status: 'active', enforcedAt: null })
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)

    // The administrator's recovery path needs no membership; a member cannot use it.
    const connectorId = idp.connectors.keys().next().value!
    await enforce(connectorId)
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(403)
    const adminPath = `/api/v1/admin/orgs/${DEFAULT_ORG_ID}/sso/connection/stop-enforcing`
    expect((await app.inject({ method: 'POST', url: adminPath, headers: await as(MEMBER_SUBJECT) })).statusCode).toBe(
      403
    )
    const admin = await app.inject({
      method: 'POST',
      url: adminPath,
      headers: await as('subject-admin', { roles: ['ADMIN'], email: 'admin@example.test' })
    })
    expect(admin.json()).toMatchObject({ enforcedAt: null })
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)

    // Deactivating ends the enforcement too, so activating again does not bring it back.
    await enforce(connectorId)
    expect((await ownerPost(`${SSO}/connection/deactivate`)).json()).toMatchObject({ enforcedAt: null })
    expect((await ownerPost(`${SSO}/connection/activate`)).json()).toMatchObject({ enforcedAt: null })
    clock.advance(ORG_SSO_LOOKUP_TTL_MS)
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(200)
  })

  it('answers 503 when the account address cannot be read and nothing is cached', async () => {
    await memberInDomain()
    await activeConnection()
    idp.down = true
    expect((await agents(await as(MEMBER_SUBJECT))).statusCode).toBe(503)
  })

  it('keeps keys minted earlier working, and refuses minting or reissuing one from a session the organization does not accept', async () => {
    await memberInDomain()
    const minted = await app.inject({
      method: 'POST',
      url: '/api/v1/me/keys',
      headers: await as(MEMBER_SUBJECT),
      payload: { orgId: DEFAULT_ORG_ID }
    })
    expect(minted.statusCode).toBe(201)
    const key = minted.json() as { apiKeyId: string; apiKey: string }
    const connectorId = await activeConnection()

    expect((await agents({ authorization: `Bearer ${key.apiKey}` })).statusCode).toBe(200)

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/me/keys',
      headers: await as(MEMBER_SUBJECT),
      payload: { orgId: DEFAULT_ORG_ID }
    })
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ code: 'ORG_SSO_SIGN_IN_REQUIRED' })
    const regenerate = await app.inject({
      method: 'POST',
      url: `/api/v1/me/keys/${key.apiKeyId}/regenerate`,
      headers: await as(MEMBER_SUBJECT)
    })
    expect(regenerate.statusCode).toBe(403)
    // Revoking stays open: it only takes access away.
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/keys/${key.apiKeyId}`,
      headers: await as(MEMBER_SUBJECT)
    })
    expect(revoked.statusCode).toBe(200)

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/me/keys',
      headers: await as(MEMBER_SUBJECT, viaConnector(connectorId)),
      payload: { orgId: DEFAULT_ORG_ID }
    })
    expect(allowed.statusCode).toBe(201)
  })

  it('refuses an OAuth grant to the organization from a session it does not accept', async () => {
    await memberInDomain()
    const connectorId = await activeConnection()
    const registered = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'Tool', redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }
    })
    const consent = (claims: Record<string, unknown>) =>
      as(MEMBER_SUBJECT, claims).then((headers) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/oauth/consent',
          headers,
          payload: {
            clientId: (registered.json() as { client_id: string }).client_id,
            redirectUri: 'http://127.0.0.1:9/cb',
            codeChallenge: 'x'.repeat(43),
            codeChallengeMethod: 'S256',
            scope: 'mcp:read',
            orgId: DEFAULT_ORG_ID,
            decision: 'allow'
          }
        })
      )
    const refused = await consent({})
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ code: 'ORG_SSO_SIGN_IN_REQUIRED' })
    expect((await consent(viaConnector(connectorId))).statusCode).toBe(200)
  })
})
