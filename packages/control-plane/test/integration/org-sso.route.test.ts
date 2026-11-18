import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { buildApp } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1 } from '../../src/persistence/deployment-config.js'
import { PgOrgDomainRepo } from '../../src/persistence/repositories/org-domain.repo.js'
import {
  MAX_DOMAINS_PER_ORG,
  ORG_DOMAIN_CHALLENGE_TTL_MS,
  ORG_DOMAIN_RECHECK_MS,
  OrgSsoDomainService
} from '../../src/org-sso/domains.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const SSO = `/api/v1/orgs/${DEFAULT_ORG_ID}/sso`

interface DomainBody {
  id: string
  domain: string
  status: 'pending' | 'verified'
  record: { type: 'TXT'; name: string; value: string }
  challengeExpiresAt: string | null
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastCheckOk: boolean | null
}

let running: HttpApp | undefined
let clock: FakeClock
let service: OrgSsoDomainService
let foreignOrgId: string
/** What DNS answers per record name; an Error makes the lookup itself fail. */
let dns: Map<string, string[] | Error>

beforeEach(async () => {
  clock = new FakeClock(Date.now())
  dns = new Map()
  service = new OrgSsoDomainService(
    new PgOrgDomainRepo(prisma),
    async (name) => {
      const answer = dns.get(name) ?? []
      if (answer instanceof Error) throw answer
      return answer
    },
    clock
  )
  foreignOrgId = `org-foreign-${randomUUID().slice(0, 8)}`
  await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
})

afterEach(async () => {
  await running?.close()
  running = undefined
})

function declared(): HttpApp['app'] {
  running = buildHttpApp(prisma, undefined, undefined, undefined, { orgSsoDomains: service })
  return running.app
}

async function add(app: HttpApp['app'], domain: string) {
  return app.inject({ method: 'POST', url: `${SSO}/domains`, payload: { domain } })
}

const publish = (body: DomainBody) => dns.set(body.record.name, [body.record.value])

describe('organization SSO domains', () => {
  it('does not exist on a deployment that has not declared organization SSO', async () => {
    running = buildHttpApp(prisma)
    expect((await running.app.inject({ method: 'GET', url: SSO })).statusCode).toBe(404)
    expect((await add(running.app, 'example.test')).statusCode).toBe(404)
  })

  it('is mounted by the composition root from the deployment’s declaration', async () => {
    const app = buildApp({
      prisma,
      config: AppConfigSchema.parse({
        DATABASE_URL: 'postgresql://unused/ignored',
        API_KEY_PEPPER: 'org-sso-api-key-pepper-0123456789abcdef',
        SECRETS_PROVIDER: 'memory'
      }),
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider(),
      deploymentConfig: {
        schemaVersion: 1,
        revision: 1,
        values: {
          ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
          features: { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1.features, organizationSso: true }
        },
        secrets: {},
        updatedAt: new Date()
      },
      orgSsoTxtLookup: async () => []
    })
    try {
      const res = await app.http.inject({ method: 'GET', url: SSO })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ domains: [], connection: null })
    } finally {
      await app.shutdown()
    }
  })

  it('starts a claim with the TXT record to publish and returns the same claim when asked again', async () => {
    const app = declared()
    const created = await add(app, ' Example.TEST ')
    expect(created.statusCode).toBe(201)
    const body = created.json() as DomainBody
    expect(body).toMatchObject({
      domain: 'example.test',
      status: 'pending',
      record: { type: 'TXT', name: '_agentconnect-challenge.example.test' },
      verifiedAt: null,
      lastCheckedAt: null,
      lastCheckOk: null
    })
    expect(body.record.value).toMatch(/^agentconnect-verification=[A-Za-z0-9_-]{32}$/)
    expect(new Date(body.challengeExpiresAt!).getTime()).toBe(clock.now() + ORG_DOMAIN_CHALLENGE_TTL_MS)

    const again = await add(app, 'example.test')
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(body)
    expect((await add(app, 'not a domain')).statusCode).toBe(400)

    const state = (await app.inject({ method: 'GET', url: SSO })).json() as { domains: DomainBody[] }
    expect(state.domains).toEqual([body])
  })

  it('verifies only when the record carries the challenge and reports what the lookup found', async () => {
    const app = declared()
    const body = (await add(app, 'example.test')).json() as DomainBody
    const verify = async () => {
      const res = await app.inject({ method: 'POST', url: `${SSO}/domains/${body.id}/verify` })
      expect(res.statusCode).toBe(200)
      return res.json() as { domain: DomainBody; check: string }
    }

    expect(await verify()).toMatchObject({ check: 'not_found', domain: { status: 'pending', lastCheckOk: false } })
    dns.set(body.record.name, ['v=spf1 -all'])
    expect(await verify()).toMatchObject({ check: 'mismatch', domain: { status: 'pending', lastCheckOk: false } })
    dns.set(body.record.name, new Error('SERVFAIL'))
    expect(await verify()).toMatchObject({ check: 'lookup_failed', domain: { status: 'pending', lastCheckOk: false } })

    dns.set(body.record.name, ['v=spf1 -all', body.record.value])
    const verified = await verify()
    expect(verified).toMatchObject({
      check: 'ok',
      domain: { status: 'verified', challengeExpiresAt: null, lastCheckOk: true }
    })
    expect(verified.domain.verifiedAt).toBe(new Date(clock.now()).toISOString())

    const audit = await prisma.auditEvent.findMany({
      where: { orgId: DEFAULT_ORG_ID, kind: 'org_sso_change' },
      orderBy: { id: 'asc' }
    })
    expect(audit.map((event) => [event.actorUserId, (event.details as { action: string }).action])).toEqual([
      [DEFAULT_OWNER_ID, 'domain_added'],
      [DEFAULT_OWNER_ID, 'domain_verified']
    ])
  })

  it('lets one organization hold a domain and drops the claims of the others when it is verified', async () => {
    const app = declared()
    const body = (await add(app, 'example.test')).json() as DomainBody
    const foreign = await service.add(foreignOrgId, 'example.test', DEFAULT_OWNER_ID)
    if (typeof foreign === 'string') throw new Error(`unexpected ${foreign}`)
    // The same record name carries both challenges, so neither organization can block the other.
    dns.set(body.record.name, [foreign.domain.record.value, body.record.value])

    const res = await app.inject({ method: 'POST', url: `${SSO}/domains/${body.id}/verify` })
    expect(res.json()).toMatchObject({ check: 'ok', domain: { status: 'verified' } })
    expect(await service.list(foreignOrgId)).toEqual([])
    expect(await service.add(foreignOrgId, 'example.test', DEFAULT_OWNER_ID)).toBe('taken')
    expect(await service.verify(foreignOrgId, foreign.domain.id, DEFAULT_OWNER_ID)).toBeNull()

    expect((await app.inject({ method: 'DELETE', url: `${SSO}/domains/${body.id}` })).statusCode).toBe(204)
    expect(await service.add(foreignOrgId, 'example.test', DEFAULT_OWNER_ID)).toMatchObject({ created: true })
  })

  it('refuses a domain another organization verified, at the claim and at the check', async () => {
    const app = declared()
    const foreign = await service.add(foreignOrgId, 'held.example.test', DEFAULT_OWNER_ID)
    if (typeof foreign === 'string') throw new Error(`unexpected ${foreign}`)
    dns.set(foreign.domain.record.name, [foreign.domain.record.value])
    await service.verify(foreignOrgId, foreign.domain.id, DEFAULT_OWNER_ID)

    const refused = await add(app, 'held.example.test')
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'SSO_DOMAIN_TAKEN' })

    // The other organization verifies between this one's lookup and its write.
    const body = (await add(app, 'raced.example.test')).json() as DomainBody
    publish(body)
    await prisma.orgDomain.create({
      data: {
        orgId: foreignOrgId,
        domain: 'raced.example.test',
        challenge: 'other',
        challengeExpiresAt: new Date(clock.now()),
        verifiedAt: new Date(clock.now())
      }
    })
    const raced = await app.inject({ method: 'POST', url: `${SSO}/domains/${body.id}/verify` })
    expect(raced.statusCode).toBe(409)
    expect(raced.json()).toMatchObject({ code: 'SSO_DOMAIN_TAKEN' })
  })

  it('treats another organization’s domain id as absent and leaves the row untouched', async () => {
    const app = declared()
    const foreign = await service.add(foreignOrgId, 'example.test', DEFAULT_OWNER_ID)
    if (typeof foreign === 'string') throw new Error(`unexpected ${foreign}`)
    dns.set(foreign.domain.record.name, [foreign.domain.record.value])
    const id = foreign.domain.id

    expect((await app.inject({ method: 'POST', url: `${SSO}/domains/${id}/verify` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `${SSO}/domains/${id}` })).statusCode).toBe(404)
    expect(((await app.inject({ method: 'GET', url: SSO })).json() as { domains: DomainBody[] }).domains).toEqual([])
    expect(await prisma.orgDomain.findUnique({ where: { id } })).toMatchObject({
      orgId: foreignOrgId,
      verifiedAt: null,
      lastCheckedAt: null
    })
  })

  it('lets a pending claim lapse and issues a new challenge afterwards', async () => {
    const app = declared()
    const body = (await add(app, 'example.test')).json() as DomainBody
    publish(body)
    clock.advance(ORG_DOMAIN_CHALLENGE_TTL_MS)

    expect(((await app.inject({ method: 'GET', url: SSO })).json() as { domains: DomainBody[] }).domains).toEqual([])
    expect((await app.inject({ method: 'POST', url: `${SSO}/domains/${body.id}/verify` })).statusCode).toBe(404)

    const renewed = await add(app, 'example.test')
    expect(renewed.statusCode).toBe(201)
    expect((renewed.json() as DomainBody).record.value).not.toBe(body.record.value)
  })

  it('caps the domains one organization may hold', async () => {
    const app = declared()
    for (let i = 0; i < MAX_DOMAINS_PER_ORG; i += 1) {
      expect((await add(app, `d${i}.example.test`)).statusCode).toBe(201)
    }
    const over = await add(app, 'one-more.example.test')
    expect(over.statusCode).toBe(409)
    expect(over.json()).toMatchObject({ code: 'SSO_DOMAIN_LIMIT' })
  })

  it('re-checks verified domains daily, marks a failing one without releasing it, and drops lapsed claims', async () => {
    const app = declared()
    const kept = (await add(app, 'kept.example.test')).json() as DomainBody
    publish(kept)
    await app.inject({ method: 'POST', url: `${SSO}/domains/${kept.id}/verify` })
    const lapsed = (await add(app, 'lapsed.example.test')).json() as DomainBody

    // Not due yet: the sweep leaves a fresh check alone.
    dns.delete(kept.record.name)
    await service.sweep()
    expect(await prisma.orgDomain.findUnique({ where: { id: kept.id } })).toMatchObject({ lastCheckOk: true })

    clock.advance(ORG_DOMAIN_RECHECK_MS + 1)
    dns.set(kept.record.name, new Error('SERVFAIL'))
    await service.sweep()
    // A lookup that got no answer keeps the last definite result.
    expect(await prisma.orgDomain.findUnique({ where: { id: kept.id } })).toMatchObject({
      lastCheckOk: true,
      lastCheckedAt: new Date(clock.now())
    })

    clock.advance(ORG_DOMAIN_RECHECK_MS + 1)
    dns.delete(kept.record.name)
    await service.sweep()
    const failing = await prisma.orgDomain.findUnique({ where: { id: kept.id } })
    expect(failing).toMatchObject({ lastCheckOk: false })
    expect(failing?.verifiedAt).not.toBeNull()

    clock.advance(ORG_DOMAIN_CHALLENGE_TTL_MS)
    await service.sweep()
    expect(await prisma.orgDomain.findUnique({ where: { id: lapsed.id } })).toBeNull()
    expect(await prisma.orgDomain.findUnique({ where: { id: kept.id } })).not.toBeNull()
  })
})
