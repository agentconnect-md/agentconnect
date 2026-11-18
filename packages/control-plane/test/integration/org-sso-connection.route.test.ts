import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { LogtoApiError } from '../../src/github/logto-identity.js'
import { PgOrgDomainRepo } from '../../src/persistence/repositories/org-domain.repo.js'
import { PgOrgSsoConnectionRepo } from '../../src/persistence/repositories/org-sso-connection.repo.js'
import type { OrgSsoProtocol } from '../../src/persistence/ports.js'
import { OrgSsoAdmission } from '../../src/org-sso/admission.js'
import { ORG_SSO_TEST_TTL_MS, OrgSsoConnectionService } from '../../src/org-sso/connections.js'
import { OrgSsoDomainService } from '../../src/org-sso/domains.js'
import { OrgSsoIdpRejected, type OrgSsoAccount, type OrgSsoIdp } from '../../src/org-sso/idp.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const SSO = `/api/v1/orgs/${DEFAULT_ORG_ID}/sso`
const OWNER_SUBJECT = 'subject-owner'

interface Connector {
  name: string
  protocol: OrgSsoProtocol
  displayName: string
  config: Record<string, unknown> | null
  domains: string[]
}

/** The identity service in memory: connectors by id, and the accounts a sign-in would have produced. */
class FakeIdp implements OrgSsoIdp {
  readonly connectors = new Map<string, Connector>()
  readonly accounts = new Map<string, OrgSsoAccount>()
  rejectWith: string | null = null
  down = false

  private up(): void {
    if (this.down) throw new LogtoApiError('logto unreachable', 0, true)
  }

  async ensureConnector(input: { connectorName: string; protocol: OrgSsoProtocol; displayName: string }) {
    this.up()
    for (const [id, connector] of this.connectors) {
      if (connector.name !== input.connectorName) continue
      if (connector.protocol === input.protocol) return id
      this.connectors.delete(id)
    }
    const id = `connector-${randomUUID().slice(0, 8)}`
    this.connectors.set(id, {
      name: input.connectorName,
      protocol: input.protocol,
      displayName: input.displayName,
      config: null,
      domains: []
    })
    return id
  }

  async configure(id: string, input: { displayName: string; config: Record<string, unknown> }) {
    this.up()
    if (this.rejectWith) throw new OrgSsoIdpRejected(this.rejectWith)
    const connector = this.connectors.get(id)
    if (!connector) return 'missing' as const
    Object.assign(connector, input)
    return 'ok' as const
  }

  async setDomains(id: string, domains: readonly string[]) {
    this.up()
    const connector = this.connectors.get(id)
    if (!connector) return 'missing' as const
    connector.domains = [...domains]
    return 'ok' as const
  }

  async deleteConnector(id: string) {
    this.up()
    this.connectors.delete(id)
  }

  async account(subject: string) {
    this.up()
    return this.accounts.get(subject) ?? null
  }

  async deleteAccount(subject: string) {
    this.up()
    this.accounts.delete(subject)
  }

  only(): Connector & { id: string } {
    const [entry, ...rest] = [...this.connectors]
    if (!entry || rest.length > 0) throw new Error(`expected one connector, found ${this.connectors.size}`)
    return { id: entry[0], ...entry[1] }
  }
}

interface ConnectionBody {
  id: string
  protocol: OrgSsoProtocol
  name: string
  status: 'draft' | 'tested' | 'active'
  tested: boolean
  serviceProvider: Record<string, string>
}

const OIDC = {
  protocol: 'oidc',
  name: 'Example IdP',
  issuer: 'https://idp.example.test',
  clientId: 'client-1',
  clientSecret: 'secret-1'
}

let running: HttpApp | undefined
let clock: FakeClock
let idp: FakeIdp
let domains: OrgSsoDomainService
let connections: OrgSsoConnectionService
let admission: OrgSsoAdmission
let dns: Map<string, string[]>

beforeEach(async () => {
  clock = new FakeClock(Date.now())
  dns = new Map()
  idp = new FakeIdp()
  domains = new OrgSsoDomainService(new PgOrgDomainRepo(prisma), async (name) => dns.get(name) ?? [], clock)
  const repo = new PgOrgSsoConnectionRepo(prisma)
  connections = new OrgSsoConnectionService({
    connections: repo,
    domains,
    idp,
    clock,
    idpOrigin: 'https://auth.example.test'
  })
  admission = new OrgSsoAdmission({ connections: repo, domains, idp })
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: OWNER_SUBJECT } })
})

afterEach(async () => {
  await running?.close()
  running = undefined
})

function start(): HttpApp['app'] {
  running = buildHttpApp(prisma, undefined, undefined, undefined, {
    orgSsoDomains: domains,
    orgSsoConnections: connections
  })
  return running.app
}

const post = (app: HttpApp['app'], url: string, payload?: object) =>
  app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) })
const save = (app: HttpApp['app'], payload: object = OIDC) =>
  app.inject({ method: 'PUT', url: `${SSO}/connection`, payload })
const connectionOf = async (app: HttpApp['app']) =>
  ((await app.inject({ method: 'GET', url: SSO })).json() as { connection: ConnectionBody | null }).connection

/** Claim a domain, publish its record and verify it; returns the domain's id. */
async function verifiedDomain(app: HttpApp['app'], domain: string): Promise<string> {
  const body = (await post(app, `${SSO}/domains`, { domain })).json() as {
    id: string
    record: { name: string; value: string }
  }
  dns.set(body.record.name, [body.record.value])
  expect((await post(app, `${SSO}/domains/${body.id}/verify`)).json()).toMatchObject({ check: 'ok' })
  return body.id
}

/** Run a test sign-in that lands on `subject`, an account holding an identity on the organization's connector. */
async function passTest(app: HttpApp['app'], subject = OWNER_SUBJECT, email = 'owner@example.test') {
  clock.advance(1000)
  const test = (await post(app, `${SSO}/connection/test`)).json() as { nonce: string; connectorId: string }
  idp.accounts.set(subject, { primaryEmail: email, connectorIds: [test.connectorId] })
  const res = await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })
  expect(res.json()).toEqual({ tested: true })
}

describe('organization SSO connection', () => {
  it('exists only where the deployment can manage connections', async () => {
    running = buildHttpApp(prisma, undefined, undefined, undefined, { orgSsoDomains: domains })
    expect((await save(running.app)).statusCode).toBe(404)
    expect((await post(running.app, '/api/v1/sso/test-result', { nonce: 'n' })).statusCode).toBe(404)
    expect(await connectionOf(running.app)).toBeNull()
  })

  it('saves the settings as a draft and returns the values for the identity provider', async () => {
    const app = start()
    const res = await save(app)
    expect(res.statusCode).toBe(200)
    const connector = idp.only()
    expect(connector).toMatchObject({
      name: `org-${DEFAULT_ORG_ID}`,
      protocol: 'oidc',
      displayName: 'Example IdP',
      domains: [],
      config: {
        issuer: 'https://idp.example.test',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        trustUnverifiedEmail: false
      }
    })
    expect(res.json()).toMatchObject({
      protocol: 'oidc',
      name: 'Example IdP',
      status: 'draft',
      tested: false,
      serviceProvider: { redirectUri: `https://auth.example.test/callback/${connector.id}` }
    })
    expect(await connectionOf(app)).toEqual(res.json())
    // The secret is forwarded, never kept.
    expect(JSON.stringify(await prisma.orgSsoConnection.findMany())).not.toContain('secret-1')
  })

  it('reports the identity service’s refusal and its absence apart', async () => {
    const app = start()
    idp.rejectWith = 'issuer discovery failed'
    const rejected = await save(app)
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: 'SSO_CONNECTION_REJECTED' })
    expect((rejected.json() as { message: string }).message).toContain('issuer discovery failed')

    idp.rejectWith = null
    idp.down = true
    expect((await save(app)).statusCode).toBe(503)

    const saml = { protocol: 'saml', name: 'Example IdP' }
    expect((await save(app, saml)).statusCode).toBe(400)
    expect((await save(app, { ...saml, metadataUrl: 'https://idp.example.test/m', metadata: '<x/>' })).statusCode).toBe(
      400
    )
  })

  it('starts a new connector when the protocol changes', async () => {
    const app = start()
    await save(app)
    const first = idp.only().id
    const res = await save(app, { protocol: 'saml', name: 'Example IdP', metadataUrl: 'https://idp.example.test/m' })
    const second = idp.only()
    expect(second.id).not.toBe(first)
    expect(res.json()).toMatchObject({
      protocol: 'saml',
      status: 'draft',
      serviceProvider: {
        assertionConsumerServiceUrl: `https://auth.example.test/api/authn/single-sign-on/saml/${second.id}`,
        entityId: `https://auth.example.test/enterprise-sso/${second.id}`
      }
    })
  })

  it('tests a sign-in inside a window that binds the verified domains and unbinds them after', async () => {
    const app = start()
    await save(app)
    const refused = await post(app, `${SSO}/connection/test`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'SSO_DOMAIN_REQUIRED' })

    await verifiedDomain(app, 'example.test')
    expect(idp.only().domains).toEqual([])
    const test = (await post(app, `${SSO}/connection/test`)).json() as { nonce: string; connectorId: string }
    expect(test.connectorId).toBe(idp.only().id)
    expect(idp.only().domains).toEqual(['example.test'])

    // The account that landed holds no identity on this connector: not a proof, and the window stays open.
    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [] })
    expect((await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: false })
    expect((await post(app, '/api/v1/sso/test-result', { nonce: 'not-the-nonce' })).json()).toEqual({ tested: false })
    expect(idp.only().domains).toEqual(['example.test'])

    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [test.connectorId] })
    clock.advance(1000)
    expect((await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: true })
    expect(idp.only().domains).toEqual([])
    expect(await connectionOf(app)).toMatchObject({ status: 'tested', tested: true })
    // One nonce proves one test.
    expect((await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: false })
  })

  it('closes a test window that ran out and stops accepting its nonce', async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')
    const test = (await post(app, `${SSO}/connection/test`)).json() as { nonce: string; connectorId: string }
    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [test.connectorId] })

    await connections.sweep()
    expect(idp.only().domains).toEqual(['example.test'])

    clock.advance(ORG_SSO_TEST_TTL_MS)
    expect((await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: false })
    await connections.sweep()
    expect(idp.only().domains).toEqual([])
    expect(await connectionOf(app)).toMatchObject({ status: 'draft', tested: false })
  })

  it('does not let a test vouch for settings saved after it began', async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')
    const test = (await post(app, `${SSO}/connection/test`)).json() as { nonce: string; connectorId: string }
    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@example.test', connectorIds: [test.connectorId] })

    await save(app, { ...OIDC, clientSecret: 'secret-2' })
    expect(idp.only().domains).toEqual([])
    expect((await post(app, '/api/v1/sso/test-result', { nonce: test.nonce })).json()).toEqual({ tested: false })
    expect(await connectionOf(app)).toMatchObject({ status: 'draft' })
  })

  it('activates only a tested connection whose domains still resolve, and binds them', async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')

    const untested = await post(app, `${SSO}/connection/activate`)
    expect(untested.statusCode).toBe(409)
    expect(untested.json()).toMatchObject({ code: 'SSO_CONNECTION_UNTESTED' })

    await passTest(app)
    const record = [...dns.keys()][0]!
    const value = dns.get(record)!
    dns.delete(record)
    const stale = await post(app, `${SSO}/connection/activate`)
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'SSO_DOMAIN_CHECK_FAILED' })
    expect(idp.only().domains).toEqual([])

    dns.set(record, value)
    const active = await post(app, `${SSO}/connection/activate`)
    expect(active.statusCode).toBe(200)
    expect(active.json()).toMatchObject({ status: 'active', tested: true })
    expect(idp.only().domains).toEqual(['example.test'])

    // A domain verified while the connection is active is bound when it is verified.
    await verifiedDomain(app, 'second.example.test')
    expect(idp.only().domains).toEqual(['example.test', 'second.example.test'])
  })

  it('keeps an active connection active when its settings change, and shows it untested', async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')
    await passTest(app)
    await post(app, `${SSO}/connection/activate`)

    clock.advance(1000)
    const changed = await save(app, { ...OIDC, clientSecret: 'secret-2' })
    expect(changed.json()).toMatchObject({ status: 'active', tested: false })
    expect(idp.only()).toMatchObject({ domains: ['example.test'], config: { clientSecret: 'secret-2' } })

    // A test on an active connection leaves the domains bound.
    clock.advance(1000)
    await passTest(app)
    expect(idp.only().domains).toEqual(['example.test'])
    expect(await connectionOf(app)).toMatchObject({ status: 'active', tested: true })

    const off = await post(app, `${SSO}/connection/deactivate`)
    expect(off.json()).toMatchObject({ status: 'tested' })
    expect(idp.only().domains).toEqual([])
  })

  it('keeps a verified domain while a connection exists, and frees it once the connection is removed', async () => {
    const app = start()
    const domainId = await verifiedDomain(app, 'example.test')
    const pending = (await post(app, `${SSO}/domains`, { domain: 'pending.example.test' })).json() as { id: string }
    await save(app)

    const kept = await app.inject({ method: 'DELETE', url: `${SSO}/domains/${domainId}` })
    expect(kept.statusCode).toBe(409)
    expect(kept.json()).toMatchObject({ code: 'SSO_DOMAIN_IN_USE' })
    expect((await app.inject({ method: 'DELETE', url: `${SSO}/domains/${pending.id}` })).statusCode).toBe(204)

    expect((await app.inject({ method: 'DELETE', url: `${SSO}/connection` })).statusCode).toBe(204)
    expect(idp.connectors.size).toBe(0)
    expect(await connectionOf(app)).toBeNull()
    expect((await app.inject({ method: 'DELETE', url: `${SSO}/connection` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `${SSO}/domains/${domainId}` })).statusCode).toBe(204)
  })

  it('gives a deployment administrator the two recovery paths', async () => {
    const app = start()
    await save(app)
    const domainId = await verifiedDomain(app, 'example.test')
    await passTest(app)
    await post(app, `${SSO}/connection/activate`)

    const off = await post(app, `/api/v1/admin/orgs/${DEFAULT_ORG_ID}/sso/connection/deactivate`)
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ status: 'tested' })
    expect(idp.only().domains).toEqual([])
    expect((await post(app, '/api/v1/admin/orgs/no-such-org/sso/connection/deactivate')).statusCode).toBe(404)

    // Releasing a verified domain ends the identities established on its word: the connector goes with it.
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/sso/domains/${domainId}` })).statusCode).toBe(204)
    expect(idp.connectors.size).toBe(0)
    expect((await app.inject({ method: 'GET', url: SSO })).json()).toEqual({ domains: [], connection: null })
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/sso/domains/${domainId}` })).statusCode).toBe(404)
  })

  it('audits each change with its actor', async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')
    await passTest(app)
    await post(app, `${SSO}/connection/activate`)
    await post(app, `${SSO}/connection/deactivate`)
    await app.inject({ method: 'DELETE', url: `${SSO}/connection` })

    const audit = await prisma.auditEvent.findMany({
      where: { orgId: DEFAULT_ORG_ID, kind: 'org_sso_change' },
      orderBy: { id: 'asc' }
    })
    expect(audit.map((event) => [event.actorUserId, (event.details as { action: string }).action])).toEqual([
      [DEFAULT_OWNER_ID, 'connection_created'],
      [DEFAULT_OWNER_ID, 'domain_added'],
      [DEFAULT_OWNER_ID, 'domain_verified'],
      [DEFAULT_OWNER_ID, 'connection_tested'],
      [DEFAULT_OWNER_ID, 'connection_activated'],
      [DEFAULT_OWNER_ID, 'connection_deactivated'],
      [DEFAULT_OWNER_ID, 'connection_removed']
    ])
  })
})

describe('organization SSO sign-in admission', () => {
  let connectorId: string

  beforeEach(async () => {
    const app = start()
    await save(app)
    await verifiedDomain(app, 'example.test')
    connectorId = idp.only().id
  })

  it('admits accounts the organization’s connection may speak for', async () => {
    idp.accounts.set('social-only', { primaryEmail: 'someone@elsewhere.example.test', connectorIds: [] })
    idp.accounts.set('in-domain', { primaryEmail: 'Person@Example.TEST', connectorIds: [connectorId] })
    idp.accounts.set('no-address', { primaryEmail: null, connectorIds: [connectorId] })
    idp.accounts.set('other-connector', { primaryEmail: 'x@elsewhere.example.test', connectorIds: ['deployment'] })

    for (const subject of ['social-only', 'in-domain', 'no-address', 'other-connector', 'unknown']) {
      expect(await admission.admit(subject)).toBe(true)
    }
    expect(idp.accounts.size).toBe(4)
  })

  it('refuses an account outside the verified domains and removes it when it has nothing here', async () => {
    idp.accounts.set('outside', { primaryEmail: 'victim@elsewhere.example.test', connectorIds: [connectorId] })
    expect(await admission.admit('outside')).toBe(false)
    expect(idp.accounts.has('outside')).toBe(false)

    const refusal = await prisma.auditEvent.findFirst({
      where: { orgId: DEFAULT_ORG_ID, kind: 'org_sso_change', details: { path: ['action'], equals: 'account_refused' } }
    })
    expect(refusal?.details).toMatchObject({ subject: 'outside', removed: true })
    // The address itself is not recorded.
    expect(JSON.stringify(refusal?.details)).not.toContain('victim@')
  })

  it('refuses but keeps an account that already has a local user', async () => {
    idp.accounts.set(OWNER_SUBJECT, { primaryEmail: 'owner@elsewhere.example.test', connectorIds: [connectorId] })
    expect(await admission.admit(OWNER_SUBJECT)).toBe(false)
    expect(idp.accounts.has(OWNER_SUBJECT)).toBe(true)
  })
})
