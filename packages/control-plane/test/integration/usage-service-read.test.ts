/**
 * The org usage aggregate's SECOND credential — a Kubernetes workload instead of a
 * person (`http/usage-service-auth.ts`).
 *
 * What this pins: the reader ServiceAccount reads the org whole with every row ATTRIBUTED,
 * where a human gets the same total but the rows they may not attribute folded into an
 * id-less residual; the collector's ServiceAccount cannot use it, so writing spend
 * and reading it stay separate capabilities; a review outage is retryable rather than a
 * verdict; a console request never costs a TokenReview round trip; and with no cluster
 * surface configured the workload path simply does not exist.
 */
import { describe, it, expect } from 'vitest'
import { USAGE_COLLECTOR_SA_NAME, USAGE_READER_SA_NAME } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgSessionUsageRepo } from '../../src/persistence/repositories/session-usage.repo.js'
import { AgentId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const OPEN_AGENT = '11111111-1111-4111-8111-111111111111'
const RESTRICTED_AGENT = '22222222-2222-4222-8222-222222222222'
const POD_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DAY_MS = 24 * 60 * 60 * 1000

/** A projected ServiceAccount token is a JWT carrying a `kubernetes.io` claim — the
 *  marker the hook routes on before spending a TokenReview. */
function workloadToken(claims: Record<string, unknown> = { 'kubernetes.io': { namespace: 'ac' } }): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}
/** A human's OIDC bearer: a JWT with no `kubernetes.io` claim. */
const HUMAN_LOOKING_TOKEN = workloadToken({ sub: 'user-1', iss: 'https://issuer.example.test' })

function fakeClusterIdentity(opts: { accepts?: string; throws?: boolean } = {}) {
  const asked: string[] = []
  return {
    asked,
    verify: async (token: string, serviceAccount: string) => {
      asked.push(serviceAccount)
      if (opts.throws) throw new Error('api server unreachable')
      return opts.accepts !== undefined && token === opts.accepts ? { podUid: POD_UID } : null
    }
  }
}

async function withApp(
  identity: ReturnType<typeof fakeClusterIdentity> | undefined,
  run: (app: ReturnType<typeof buildHttpApp>['app']) => Promise<void>
): Promise<void> {
  const { app, close } = buildHttpApp(
    prisma,
    {},
    undefined,
    undefined,
    identity ? { clusterWorkloadIdentity: identity } : {}
  )
  try {
    await run(app)
  } finally {
    await close()
  }
}

/** One org, two agents: one visible to everyone, one restricted to a user the caller is
 *  not. Both spend, so "did visibility apply?" has a different answer per credential. */
async function seedSpend(): Promise<void> {
  await seedAgent(prisma, OPEN_AGENT)
  await seedAgent(prisma, RESTRICTED_AGENT, { visibility: 'restricted', sharedWith: ['someone-else'] })
  const repo = new PgSessionUsageRepo(prisma)
  const at = new Date(Date.now() - 60_000)
  for (const [agentId, sessionId, costAmount] of [
    [OPEN_AGENT, 'open', '10'],
    [RESTRICTED_AGENT, 'restricted', '32']
  ] as const) {
    await seedSessionMeta(prisma, sessionId, agentId, { lastActivityAt: at })
    await repo.record({
      agentId: AgentId(agentId),
      sessionId,
      source: 'gateway',
      lastActivityAt: at,
      usage: { totalTokens: 100, costAmount, costCurrency: 'USD' }
    })
  }
}

function windowQuery(extra: Record<string, string> = {}): string {
  const to = new Date()
  return new URLSearchParams({
    from: new Date(to.getTime() - DAY_MS).toISOString(),
    to: to.toISOString(),
    ...extra
  }).toString()
}

describe('GET /usage — the workload credential', () => {
  it('attributes every row, where a human gets the same total as a residual', async () => {
    await seedSpend()
    const token = workloadToken()
    await withApp(fakeClusterIdentity({ accepts: token }), async (app) => {
      const asService = await app.inject({
        method: 'GET',
        url: `${ORG}/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${token}` }
      })
      expect(asService.statusCode).toBe(200)
      type Read = {
        totals: { costAmount: string }
        agents: { agentId: string }[]
        unattributed?: { costAmount: string }
      }
      const service = asService.json() as Read

      // The same window through the console's own credential (devAuth's seeded owner).
      const asHuman = await app.inject({ method: 'GET', url: `${ORG}/usage?${windowQuery()}` })
      expect(asHuman.statusCode).toBe(200)
      const human = asHuman.json() as Read

      // A settlement total that omitted the sessions no human may read would undercharge —
      // which is why the HUMAN's total is now the same figure. An org's spend is a fact
      // about the org, so the two credentials cannot disagree about it.
      expect(service.totals.costAmount).toBe('42')
      expect(human.totals.costAmount).toBe('42')

      // What the credential buys is ATTRIBUTION. The workload names both agents and has
      // nothing to withhold; the human gets one row plus an id-less residual.
      expect(service.agents.map((a) => a.agentId).sort()).toEqual([OPEN_AGENT, RESTRICTED_AGENT].sort())
      expect(service.unattributed).toBeUndefined()
      expect(human.agents.map((a) => a.agentId)).toEqual([OPEN_AGENT])
      expect(human.unattributed?.costAmount).toBe('32')
      expect(JSON.stringify(human)).not.toContain(RESTRICTED_AGENT)
    })
  })

  it('refuses the COLLECTOR’s ServiceAccount — writing spend is not reading it', async () => {
    await seedSpend()
    const token = workloadToken()
    // The fake accepts no token, standing in for a TokenReview whose subject is some
    // other ServiceAccount than the one this surface pins.
    const identity = fakeClusterIdentity()
    await withApp(identity, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: `${ORG}/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.statusCode).toBe(401)
      // And it asked about the reader, never the collector.
      expect(identity.asked).toEqual([USAGE_READER_SA_NAME])
      expect(identity.asked).not.toContain(USAGE_COLLECTOR_SA_NAME)
    })
  })

  it('answers 503, not 401, when the review itself is unreachable', async () => {
    await withApp(fakeClusterIdentity({ throws: true }), async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: `${ORG}/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${workloadToken()}` }
      })
      expect(res.statusCode).toBe(503)
    })
  })

  it('never spends a TokenReview on a console request', async () => {
    await seedSpend()
    const identity = fakeClusterIdentity({ accepts: workloadToken() })
    await withApp(identity, async (app) => {
      // devAuth (no bearer) and a human-shaped bearer both reach the API server zero times.
      expect((await app.inject({ method: 'GET', url: `${ORG}/usage?${windowQuery()}` })).statusCode).toBe(200)
      await app.inject({
        method: 'GET',
        url: `${ORG}/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${HUMAN_LOOKING_TOKEN}` }
      })
      expect(identity.asked).toEqual([])
    })
  })

  it('404s an org that does not exist rather than reporting it spent nothing', async () => {
    const token = workloadToken()
    await withApp(fakeClusterIdentity({ accepts: token }), async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/99999999-9999-4999-8999-999999999999/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('does not exist as a credential when no cluster surface is configured', async () => {
    await seedSpend()
    const token = workloadToken()
    await withApp(undefined, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: `${ORG}/usage?${windowQuery()}`,
        headers: { authorization: `Bearer ${token}` }
      })
      // Falls through to humanAuth, which is the devAuth stub here — the point is that
      // the workload path never admitted it.
      const body = res.json() as { agents?: { agentId: string }[] }
      expect(body.agents?.map((a) => a.agentId) ?? []).not.toContain(RESTRICTED_AGENT)
    })
  })
})
