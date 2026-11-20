// `PUT /internal/orgs/:orgId/session-policy` and its store: own credential, revision compare-and-set, 404 for an unknown org (org-session-policy.md).
import { describe, it, expect, vi } from 'vitest'
import { SESSION_POLICY_WRITER_SA_NAME, USAGE_COLLECTOR_SA_NAME, USAGE_READER_SA_NAME } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { DEF_ORG } from '../fixtures/seed.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import type { HttpDeps } from '../../src/http/deps.js'

const TOKEN = 'session-policy-token-0123456789abcdef'
const USAGE_TOKEN = 'usage-ingest-token-0123456789abcdef'
const PROJECTED = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2UtcHJvamVjdGVkLXRva2VuIn0.payload.sig'
const POD_UID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const url = (orgId: string) => `/api/v1/internal/orgs/${orgId}/session-policy`

type App = ReturnType<typeof buildHttpApp>['app']

function policy(revision: number, over: Record<string, unknown> = {}) {
  return { revision, monthlySessionLimit: 100, historyRetentionDays: 30, enforce: false, ...over }
}

/** A stand-in for the in-cluster review: accepts one token as the given ServiceAccount's pod. */
function fakeClusterIdentity(opts: { accepts?: string; as?: string; throws?: boolean } = {}) {
  const asked: string[] = []
  return {
    asked,
    verify: async (token: string, serviceAccount: string) => {
      asked.push(serviceAccount)
      if (opts.throws) throw new Error('api server unreachable')
      const sa = opts.as ?? SESSION_POLICY_WRITER_SA_NAME
      return opts.accepts !== undefined && token === opts.accepts && serviceAccount === sa ? { podUid: POD_UID } : null
    }
  }
}

async function withApp(
  config: Partial<HttpDeps['config']>,
  run: (app: App) => Promise<void>,
  identity?: ReturnType<typeof fakeClusterIdentity>
): Promise<void> {
  const { app, close } = buildHttpApp(
    prisma,
    config,
    undefined,
    undefined,
    identity ? { clusterWorkloadIdentity: identity } : undefined
  )
  try {
    await run(app)
  } finally {
    await close()
  }
}

async function put(app: App, orgId: string, payload: unknown, credential: string | null = TOKEN) {
  return app.inject({
    method: 'PUT',
    url: url(orgId),
    headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
    payload: payload as Record<string, unknown>
  })
}

/** Wait until a backend is queued on an `org_session_policy` row, the overlap the race test is written for. */
async function awaitPolicyLockWaiter(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%org_session_policy%'
      `
      expect(rows[0]?.waiting ?? 0).toBeGreaterThanOrEqual(1)
    },
    { timeout: 20_000, interval: 10 }
  )
}

async function stored(orgId: string = DEF_ORG) {
  return prisma.orgSessionPolicy.findUnique({ where: { orgId } })
}

describe('PUT /internal/orgs/:orgId/session-policy — credentials', () => {
  it('is not registered at all when no credential mode is configured', async () => {
    await withApp({}, async (app) => {
      expect((await put(app, DEF_ORG, policy(1))).statusCode).toBe(404)
    })
    expect(await stored()).toBeNull()
  })

  it('accepts its shared secret and refuses a missing, wrong, or usage-ingest one with 401', async () => {
    await withApp({ SESSION_POLICY_TOKEN: TOKEN, USAGE_INGEST_TOKEN: USAGE_TOKEN }, async (app) => {
      for (const credential of [null, `${TOKEN}x`, USAGE_TOKEN]) {
        expect((await put(app, DEF_ORG, policy(1), credential)).statusCode).toBe(401)
      }
      expect(await stored()).toBeNull()
      const res = await put(app, DEF_ORG, policy(1))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ appliedRevision: 1 })
    })
  })

  it('does not exist when only the usage ingest secret is configured', async () => {
    await withApp({ USAGE_INGEST_TOKEN: USAGE_TOKEN }, async (app) => {
      expect((await put(app, DEF_ORG, policy(1), USAGE_TOKEN)).statusCode).toBe(404)
    })
  })

  it('accepts a projected token for the writer ServiceAccount only', async () => {
    const identity = fakeClusterIdentity({ accepts: PROJECTED })
    await withApp(
      {},
      async (app) => {
        expect((await put(app, DEF_ORG, policy(1), PROJECTED)).statusCode).toBe(200)
      },
      identity
    )
    expect(identity.asked).toEqual([SESSION_POLICY_WRITER_SA_NAME])
  })

  it('refuses a projected token of the usage ServiceAccounts', async () => {
    for (const sa of [USAGE_COLLECTOR_SA_NAME, USAGE_READER_SA_NAME]) {
      await withApp(
        {},
        async (app) => {
          expect((await put(app, DEF_ORG, policy(1), PROJECTED)).statusCode).toBe(401)
        },
        fakeClusterIdentity({ accepts: PROJECTED, as: sa })
      )
    }
    expect(await stored()).toBeNull()
  })

  it('asks for the ServiceAccount the deployment configured', async () => {
    const identity = fakeClusterIdentity({ accepts: PROJECTED, as: 'example-policy-writer' })
    await withApp(
      { SESSION_POLICY_WRITER_SERVICE_ACCOUNT: 'example-policy-writer' },
      async (app) => {
        expect((await put(app, DEF_ORG, policy(1), PROJECTED)).statusCode).toBe(200)
      },
      identity
    )
    expect(identity.asked).toEqual(['example-policy-writer'])
  })

  it('answers 503, not 401, when the review itself is unreachable', async () => {
    await withApp(
      {},
      async (app) => {
        expect((await put(app, DEF_ORG, policy(1), PROJECTED)).statusCode).toBe(503)
      },
      fakeClusterIdentity({ throws: true })
    )
  })
})

describe('PUT /internal/orgs/:orgId/session-policy — delivery', () => {
  const config = { SESSION_POLICY_TOKEN: TOKEN }

  it('answers 404 for an organization that does not exist, and stores nothing', async () => {
    await withApp(config, async (app) => {
      expect((await put(app, 'org-that-does-not-exist', policy(1))).statusCode).toBe(404)
    })
    expect(await prisma.orgSessionPolicy.count()).toBe(0)
  })

  it('refuses a bad body with 400', async () => {
    await withApp(config, async (app) => {
      for (const payload of [
        policy(0),
        policy(1.5),
        policy(1, { monthlySessionLimit: -1 }),
        policy(1, { historyRetentionDays: 0 }),
        policy(1, { enforce: 'yes' }),
        policy(1, { revision: 2_147_483_648 }),
        policy(1, { unknown: true }),
        { revision: 1, monthlySessionLimit: 1, historyRetentionDays: 1 }
      ]) {
        expect((await put(app, DEF_ORG, payload)).statusCode).toBe(400)
      }
    })
    expect(await stored()).toBeNull()
  })

  it('stores a first delivery, replaces every field on a higher revision, and ignores an equal or lower one', async () => {
    await withApp(config, async (app) => {
      expect((await put(app, DEF_ORG, policy(3))).json()).toEqual({ appliedRevision: 3 })
      expect(await stored()).toMatchObject(policy(3))

      const next = policy(5, { monthlySessionLimit: 0, historyRetentionDays: 7, enforce: true })
      expect((await put(app, DEF_ORG, next)).json()).toEqual({ appliedRevision: 5 })
      expect(await stored()).toMatchObject(next)

      for (const stale of [policy(5, { monthlySessionLimit: 9 }), policy(4, { enforce: false })]) {
        const res = await put(app, DEF_ORG, stale)
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ appliedRevision: 5 })
        expect(await stored()).toMatchObject(next)
      }
    })
  })

  it('round-trips a null limit and a null retention', async () => {
    await withApp(config, async (app) => {
      const open = policy(1, { monthlySessionLimit: null, historyRetentionDays: null })
      expect((await put(app, DEF_ORG, open)).statusCode).toBe(200)
      expect(await stored()).toMatchObject(open)
    })
  })

  it('deletes the policy with its organization', async () => {
    const orgId = 'org-session-policy-cascade'
    await prisma.org.create({ data: { id: orgId, slug: orgId } })
    await withApp(config, async (app) => {
      expect((await put(app, orgId, policy(1))).statusCode).toBe(200)
    })
    expect(await stored(orgId)).not.toBeNull()
    await prisma.org.delete({ where: { id: orgId } })
    expect(await stored(orgId)).toBeNull()
  })
})

describe('PgOrgSessionPolicyRepo.apply', () => {
  it('keeps the higher revision whichever of two concurrent deliveries commits first', async () => {
    const repo = new PgOrgSessionPolicyRepo(prisma)
    const low = { revision: 2, monthlySessionLimit: 10, historyRetentionDays: 10, enforce: false }
    const high = { revision: 3, monthlySessionLimit: 20, historyRetentionDays: 20, enforce: true }
    for (const [first, second] of [
      [low, high],
      [high, low]
    ] as const) {
      await prisma.orgSessionPolicy.deleteMany()
      let racing: Promise<number | null> | undefined
      // The first delivery holds its uncommitted row while the second queues on it, so the two genuinely overlap.
      const firstApplied = await prisma.$transaction(async (tx) => {
        const applied = await new PgOrgSessionPolicyRepo(tx).apply(DEF_ORG, first)
        racing = repo.apply(DEF_ORG, second)
        await awaitPolicyLockWaiter()
        return applied
      })
      expect(firstApplied).toBe(first.revision)
      expect(await racing).toBe(3)
      expect(await stored()).toMatchObject(high)
    }
  })

  it('returns null for an organization that does not exist', async () => {
    expect(
      await new PgOrgSessionPolicyRepo(prisma).apply('org-that-does-not-exist', {
        revision: 1,
        monthlySessionLimit: null,
        historyRetentionDays: null,
        enforce: false
      })
    ).toBeNull()
  })
})
