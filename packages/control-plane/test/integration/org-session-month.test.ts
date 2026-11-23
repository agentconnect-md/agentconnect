// Monthly session counting on first record and `GET /orgs/:orgId/usage/sessions` (org-session-policy.md).
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { DEF_ORG, seedAgent, seedSessionMeta } from '../fixtures/seed.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { AgentId, SessionId } from '../../src/domain/ids.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UNKNOWN_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_ORG = 'org-session-month-other'
const POD_UID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USAGE_URL = `/api/v1/orgs/${DEF_ORG}/usage/sessions`

function ev(
  sessionId: string,
  phase: 'start' | 'plan' | 'problem' | 'end' = 'start',
  extra: Record<string, unknown> = {}
) {
  return {
    sessionId: SessionId(sessionId),
    agentId: AgentId(AGENT),
    phase,
    platform: 'slack' as const,
    channel: 'C1',
    thread: sessionId,
    at: new Date(),
    ...extra
  }
}

/** The database's current UTC month start, the key counting writes under. */
async function dbMonthStart(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ m: Date }>>`
    SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "m"`
  return rows[0]!.m
}

async function used(orgId: string = DEF_ORG): Promise<number> {
  const rows = await prisma.orgSessionMonth.findMany({ where: { orgId } })
  return rows.reduce((sum, row) => sum + row.used, 0)
}

/** Wait until a backend is queued on an `org_session_month` row, the overlap the race test is written for. */
async function awaitMonthLockWaiter(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%org_session_month%'
      `
      expect(rows[0]?.waiting ?? 0).toBeGreaterThanOrEqual(1)
    },
    { timeout: 20_000, interval: 10 }
  )
}

describe('SessionRepo.recordMilestone — monthly session counting', () => {
  it('counts a new session once, whatever milestones follow', async () => {
    await seedAgent(prisma, AGENT)
    const repo = new PgSessionRepo(prisma)
    expect((await repo.recordMilestone(ev('s-1'))).recorded).toBe(true)
    expect(await used()).toBe(1)
    for (const phase of ['plan', 'start', 'problem', 'end'] as const) {
      expect((await repo.recordMilestone(ev('s-1', phase))).recorded).toBe(true)
    }
    expect(await used()).toBe(1)
    await repo.recordMilestone(ev('s-2', 'end'))
    expect(await used()).toBe(2)
  })

  it('counts under the database clock’s UTC month, not the reported time', async () => {
    await seedAgent(prisma, AGENT)
    await new PgSessionRepo(prisma).recordMilestone(ev('s-old', 'start', { at: new Date('2020-01-15T12:00:00.000Z') }))
    const rows = await prisma.orgSessionMonth.findMany({ where: { orgId: DEF_ORG } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.monthStart.toISOString()).toBe((await dbMonthStart()).toISOString())
    expect(rows[0]!.used).toBe(1)
  })

  it('does not count a milestone the agent guard drops, or one for an unknown agent', async () => {
    await prisma.org.create({ data: { id: OTHER_ORG, slug: OTHER_ORG } })
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, OTHER_AGENT, { orgId: OTHER_ORG })
    const repo = new PgSessionRepo(prisma)
    await repo.recordMilestone(ev('s-owned'))
    // Another org's agent claiming the same session id writes nothing, so counts nothing.
    const claimed = await repo.recordMilestone(ev('s-owned', 'end', { agentId: AgentId(OTHER_AGENT) }))
    expect(claimed.recorded).toBe(false)
    const unknown = await repo.recordMilestone(ev('s-unknown', 'start', { agentId: AgentId(UNKNOWN_AGENT) }))
    expect(unknown.recorded).toBe(false)
    expect(await used(DEF_ORG)).toBe(1)
    expect(await used(OTHER_ORG)).toBe(0)
  })

  it('counts the org the session row was written for', async () => {
    await prisma.org.create({ data: { id: OTHER_ORG, slug: OTHER_ORG } })
    await seedAgent(prisma, OTHER_AGENT, { orgId: OTHER_ORG })
    await new PgSessionRepo(prisma).recordMilestone(ev('s-other', 'start', { agentId: AgentId(OTHER_AGENT) }))
    expect(await used(OTHER_ORG)).toBe(1)
    expect(await used(DEF_ORG)).toBe(0)
  })

  it('does not count a session recorded before counting began', async () => {
    await seedAgent(prisma, AGENT)
    await seedSessionMeta(prisma, 's-existing', AGENT, { platform: 'slack', channel: 'C1', thread: 's-existing' })
    expect((await new PgSessionRepo(prisma).recordMilestone(ev('s-existing', 'end'))).recorded).toBe(true)
    expect(await used()).toBe(0)
  })

  it('counts both of two concurrent new sessions of one org', async () => {
    await seedAgent(prisma, AGENT)
    let racing: Promise<unknown> | undefined
    // The first holds its uncommitted month row while the second queues on it, so the two genuinely overlap.
    await prisma.$transaction(async (tx) => {
      await new PgSessionRepo(tx).recordMilestone(ev('s-a'))
      racing = new PgSessionRepo(prisma).recordMilestone(ev('s-b'))
      await awaitMonthLockWaiter()
    })
    await racing
    expect(await used()).toBe(2)
  })

  it('deletes the counts with their organization', async () => {
    await prisma.org.create({ data: { id: OTHER_ORG, slug: OTHER_ORG } })
    await seedAgent(prisma, OTHER_AGENT, { orgId: OTHER_ORG })
    await new PgSessionRepo(prisma).recordMilestone(ev('s-cascade', 'start', { agentId: AgentId(OTHER_AGENT) }))
    expect(await used(OTHER_ORG)).toBe(1)
    await prisma.org.delete({ where: { id: OTHER_ORG } })
    expect(await prisma.orgSessionMonth.count({ where: { orgId: OTHER_ORG } })).toBe(0)
  })
})

/** A projected ServiceAccount token: a JWT carrying the `kubernetes.io` claim the usage scope routes on. */
function workloadToken(): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part({ 'kubernetes.io': { namespace: 'ac' } })}.sig`
}

async function withApp(
  run: (app: ReturnType<typeof buildHttpApp>['app']) => Promise<void>,
  opts: { humanUserId?: string; acceptsToken?: string } = {}
): Promise<void> {
  const identity = opts.acceptsToken
    ? { verify: async (token: string) => (token === opts.acceptsToken ? { podUid: POD_UID } : null) }
    : undefined
  const { app, close } = buildHttpApp(
    prisma,
    opts.humanUserId ? { DEFAULT_OWNER_ID: opts.humanUserId } : {},
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

type MonthUsage = {
  used: number
  limit: number | null
  policyRevision: number | null
  enforcing: boolean
  monthStart: string
  resetsAt: string
  asOf: string
}

describe('GET /orgs/:orgId/usage/sessions', () => {
  it('serves the month’s count to a member and the reader workload, with the policy once one is stored', async () => {
    await seedAgent(prisma, AGENT)
    const repo = new PgSessionRepo(prisma)
    for (const id of ['r-1', 'r-2', 'r-3']) await repo.recordMilestone(ev(id))
    await repo.recordMilestone(ev('r-1', 'end'))
    const token = workloadToken()
    const monthStart = await dbMonthStart()
    const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
    await withApp(
      async (app) => {
        const asMember = await app.inject({ method: 'GET', url: USAGE_URL })
        expect(asMember.statusCode).toBe(200)
        const member = asMember.json() as MonthUsage
        expect(member).toMatchObject({
          used: 3,
          limit: null,
          policyRevision: null,
          monthStart: monthStart.toISOString(),
          resetsAt: nextMonth.toISOString()
        })
        expect(Date.parse(member.asOf)).toBeGreaterThanOrEqual(monthStart.getTime())
        expect(Date.parse(member.asOf)).toBeLessThan(nextMonth.getTime())

        await new PgOrgSessionPolicyRepo(prisma).apply(DEF_ORG, {
          revision: 4,
          monthlySessionLimit: 50,
          historyRetentionDays: null,
          enforce: false
        })
        const asService = await app.inject({
          method: 'GET',
          url: USAGE_URL,
          headers: { authorization: `Bearer ${token}` }
        })
        expect(asService.statusCode).toBe(200)
        expect(asService.json()).toMatchObject({ used: 3, limit: 50, policyRevision: 4 })
      },
      { acceptsToken: token }
    )
  })

  it('reports a null limit from a policy without one', async () => {
    await new PgOrgSessionPolicyRepo(prisma).apply(DEF_ORG, {
      revision: 1,
      monthlySessionLimit: null,
      historyRetentionDays: 30,
      enforce: false
    })
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: USAGE_URL })
      expect(res.json()).toMatchObject({ used: 0, limit: null, policyRevision: 1, enforcing: false })
    })
  })

  it('says whether the organization enforces its limit now', async () => {
    const apply = (revision: number, enforce: boolean) =>
      new PgOrgSessionPolicyRepo(prisma).apply(DEF_ORG, {
        revision,
        monthlySessionLimit: 5,
        historyRetentionDays: null,
        enforce
      })
    await withApp(async (app) => {
      const read = async () => (await app.inject({ method: 'GET', url: USAGE_URL })).json() as MonthUsage
      expect((await read()).enforcing).toBe(false)
      await apply(1, false)
      expect(await read()).toMatchObject({ limit: 5, enforcing: false })
      await apply(2, true)
      expect(await read()).toMatchObject({ limit: 5, enforcing: true })
    })
  })

  it('answers 404 to a signed-in user who is not a member', async () => {
    const { userId } = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'session-month-outsider',
      email: 'outsider@example.test',
      emailVerified: true
    })
    await withApp(
      async (app) => {
        expect((await app.inject({ method: 'GET', url: USAGE_URL })).statusCode).toBe(404)
      },
      { humanUserId: userId }
    )
  })

  it('answers 404 to the reader workload for an organization that does not exist', async () => {
    const token = workloadToken()
    await withApp(
      async (app) => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/orgs/org-that-does-not-exist/usage/sessions',
          headers: { authorization: `Bearer ${token}` }
        })
        expect(res.statusCode).toBe(404)
      },
      { acceptsToken: token }
    )
  })
})

describe('PgOrgSessionPolicyRepo.monthUsage', () => {
  it('returns null for an organization that does not exist', async () => {
    expect(await new PgOrgSessionPolicyRepo(prisma).monthUsage('org-that-does-not-exist')).toBeNull()
  })
})
