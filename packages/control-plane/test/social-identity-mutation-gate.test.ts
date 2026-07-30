import { describe, expect, it } from 'vitest'
import { FakeClock } from './fakes/fake-clock.js'
import { Prisma } from '../src/generated/prisma/client.js'
import { LogtoApiError, LogtoIdentityService } from '../src/github/logto-identity.js'
import { PgSocialIdentityMutationGate } from '../src/persistence/index.js'
import { prisma } from './setup.db.js'

const MGMT = {
  endpoint: 'https://tenant.logto.test',
  appId: 'app',
  appSecret: 'secret',
  resource: 'https://tenant.logto.test/api'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForBlockedAdvisoryLock(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `)
    if ((row?.count ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the second Control Plane instance never waited on the subject advisory lock')
}

describe('social identity mutation gate', () => {
  it('serializes concurrent removals across gate instances so one identity remains', async () => {
    const identities = new Set(['google', 'github'])
    const firstDeleteStarted = deferred()
    const releaseFirstDelete = deferred()
    const secondTokenRequested = deferred()
    let reads = 0
    let deletes = 0

    const fetchFor =
      (instance: 'first' | 'second') =>
      async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.endsWith('/oidc/token')) {
          if (instance === 'second') secondTokenRequested.resolve()
          return Response.json({ access_token: `${instance}-token`, expires_in: 3600 })
        }
        if (init?.method === 'DELETE') {
          const target = decodeURIComponent(new URL(url).pathname.split('/').pop()!)
          deletes++
          if (target === 'google') {
            firstDeleteStarted.resolve()
            await releaseFirstDelete.promise
          }
          identities.delete(target)
          return new Response(null, { status: 204 })
        }
        if (url.endsWith('/api/users/logto-user')) {
          reads++
          return Response.json({
            identities: Object.fromEntries([...identities].map((target) => [target, {}]))
          })
        }
        throw new Error(`unexpected Logto request: ${url}`)
      }

    const firstService = new LogtoIdentityService(
      MGMT,
      new FakeClock(0),
      new PgSocialIdentityMutationGate(prisma),
      fetchFor('first')
    )
    const secondService = new LogtoIdentityService(
      MGMT,
      new FakeClock(0),
      new PgSocialIdentityMutationGate(prisma),
      fetchFor('second')
    )

    const first = firstService.unlinkSocialIdentity('logto-user', 'google')
    await firstDeleteStarted.promise
    const second = secondService.unlinkSocialIdentity('logto-user', 'github')
    let results: PromiseSettledResult<void>[] = []
    try {
      await secondTokenRequested.promise
      await waitForBlockedAdvisoryLock()
      expect(reads).toBe(1)
    } finally {
      releaseFirstDelete.resolve()
      results = await Promise.allSettled([first, second])
    }

    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('rejected')
    if (results[1]?.status !== 'rejected') throw new Error('the second removal unexpectedly succeeded')
    expect(results[1].reason).toBeInstanceOf(LogtoApiError)
    expect(results[1].reason).toMatchObject({ status: 409, code: 'LAST_SOCIAL_IDENTITY' })
    expect([...identities]).toEqual(['github'])
    expect({ reads, deletes }).toEqual({ reads: 2, deletes: 1 })
  })
})
