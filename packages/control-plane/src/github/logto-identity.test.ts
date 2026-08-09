/**
 * Unit tests for LogtoIdentityService's access-triggered refresh-ahead (fake
 * fetch — no Docker, no network). A cache hit past half of the lease it ran
 * under answers from cache and renews the entry through a background lookup on
 * the shared in-flight dedupe and epoch fence; the leases themselves stay hard
 * for first-ever and idle-return reads. The identity projections are covered
 * by `slack-identity.test.ts`, the GitHub login half and the unlink writes by
 * `user-authz.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { SocialIdentityMutationGate } from '../persistence/ports.js'
import { LogtoIdentityService } from './logto-identity.js'

const MGMT = { endpoint: 'https://t.logto.app', appId: 'app', appSecret: 'sec', resource: 'https://t.logto.app/api' }
const MUTATIONS: SocialIdentityMutationGate = {
  runExclusive: async (_oidcSubject, mutation) => mutation()
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/** A Logto user with a Slack identity in the given workspace. Synthetic ids. */
function slackUser(teamId = 'T0EXAMPLE1') {
  const rawData = { 'https://slack.com/team_id': teamId, 'https://slack.com/user_id': 'U0EXAMPLE1' }
  return { identities: { slack: { userId: 'U0EXAMPLE1', details: { rawData } } } }
}

/** A Logto user with a GitHub login (plus Google, so an unlink is not blocked
 *  by the last-sign-in-method guard). */
function githubUser(login: string) {
  return { identities: { github: { details: { rawData: { userInfo: { login } } } }, google: { userId: 'g' } } }
}

/** A Logto user with both a Slack and a GitHub identity — one directory read feeds both caches. */
function linkedUser() {
  return { identities: { ...slackUser().identities, ...githubUser('octocat').identities } }
}

/**
 * Fake Logto: one token endpoint + a mutable user directory. Counts user
 * reads, and can PARK the `parkRead`-th of them (1-based) until `release()` —
 * how these tests hold a background refresh in flight. A parked response
 * carries the directory snapshot from when the request ARRIVED, which is what
 * a slow provider response delivers.
 */
function fakeLogto(users: Record<string, unknown>, opts: { parkRead?: number; onDelete?: () => void } = {}) {
  const calls = { user: 0 }
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let arrived!: () => void
  const parkedReadArrived = new Promise<void>((resolve) => (arrived = resolve))
  const fetchImpl: FetchImpl = async (url, init) => {
    if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
    if (init?.method === 'DELETE') {
      opts.onDelete?.()
      return new Response(null, { status: 204 })
    }
    calls.user++
    const snapshot = users[decodeURIComponent(url.split('/').pop()!)]
    if (calls.user === opts.parkRead) {
      arrived()
      await gate
    }
    return snapshot ? Response.json(snapshot) : new Response('{}', { status: 404 })
  }
  return { fetchImpl, calls, release: () => release(), parkedReadArrived }
}

const logSpy = () => ({
  debug: vi.fn<(obj: object, msg: string) => void>(),
  info: vi.fn<(obj: object, msg: string) => void>()
})
type SvcLog = ReturnType<typeof logSpy>
const svcOf = (fetchImpl: FetchImpl, clock: FakeClock, log?: SvcLog) =>
  new LogtoIdentityService(MGMT, clock, MUTATIONS, fetchImpl, log)

/** Drain a (released) background refresh — the fakes settle in micro/macrotasks,
 *  never on real timers, so a few event-loop turns are enough. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('LogtoIdentityService refresh-ahead', () => {
  it('a qualifying hit past the half-lease answers from cache and renews behind the caller', async () => {
    const clock = new FakeClock(0)
    const { fetchImpl, calls, release, parkedReadArrived } = fakeLogto({ 'sub-1': slackUser() }, { parkRead: 2 })
    const svc = svcOf(fetchImpl, clock)

    await svc.slackIdentityFor('sub-1') // the first-ever read blocks — that is the lease speaking
    expect(calls.user).toBe(1)

    // Age 61 s: satisfies the 120 s provider-identity cap, past its 60 s half.
    // The renewal is PARKED upstream, so these resolving proves callers never
    // wait on it — and two triggers coalesce onto ONE in-flight lookup.
    clock.advance(61_000)
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0EXAMPLE1' })
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0EXAMPLE1' })
    await parkedReadArrived
    expect(calls.user).toBe(2)

    release()
    await settled()
    expect(calls.user).toBe(2)

    // The refresh renewed fetchedAt: this read sits 120 s past the ORIGINAL
    // fetch (a blocking miss before this change) but 59 s past the renewal —
    // a quiet cache hit, no third lookup.
    clock.advance(59_000)
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0EXAMPLE1' })
    expect(calls.user).toBe(2)
  })

  it('a read past the full lease still blocks and fetches — the lease stays hard', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = { 'sub-1': slackUser('T0BEFORE00') }
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl, clock)

    await svc.slackIdentityFor('sub-1')
    clock.advance(120_001) // idle return: the entry can no longer satisfy the 120 s cap
    users['sub-1'] = slackUser('T0AFTER000')

    // Served-then-refreshed would hand back the stale workspace; blocking does not.
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0AFTER000' })
    expect(calls.user).toBe(2)
  })

  it('a display read (no caller cap) refreshes against its own 10 min lease, not the 120 s one', async () => {
    const clock = new FakeClock(0)
    const { fetchImpl, calls } = fakeLogto({ 'sub-1': slackUser() })
    const svc = svcOf(fetchImpl, clock)

    await svc.socialAccountFor('sub-1')
    clock.advance(61_000) // far past the identity half-lease, nowhere near half of 10 min
    await svc.socialAccountFor('sub-1')
    await settled()
    expect(calls.user).toBe(1)

    clock.advance(240_000) // age 301 s — past half of the 10 min positive TTL
    await svc.socialAccountFor('sub-1')
    await settled()
    expect(calls.user).toBe(2)
  })

  it('forgetUser racing an in-flight background refresh keeps the refreshed result out of the cache', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = { 'sub-1': slackUser('T0BEFORE00') }
    const { fetchImpl, calls, release, parkedReadArrived } = fakeLogto(users, { parkRead: 2 })
    const svc = svcOf(fetchImpl, clock)

    await svc.slackIdentityFor('sub-1')
    clock.advance(61_000)
    await svc.slackIdentityFor('sub-1') // serves the cache, parks the background refresh
    await parkedReadArrived

    // While the refresh is parked holding a PRE-change snapshot, the identity
    // changes at the provider and the console announces it (forgetUser).
    users['sub-1'] = slackUser('T0AFTER000')
    svc.forgetUser('sub-1')
    release()
    await settled()

    // The refresh settled after the invalidation, so the epoch fence dropped
    // its result; the next read fetches and sees the post-change world.
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0AFTER000' })
    expect(calls.user).toBe(3)
  })

  it('an unlink invalidation racing a background login refresh wins — the stale login never returns', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = { 'sub-1': githubUser('octocat') }
    const { fetchImpl, calls, release, parkedReadArrived } = fakeLogto(users, {
      parkRead: 2,
      onDelete: () => (users['sub-1'] = { identities: { google: { userId: 'g' } } })
    })
    const svc = svcOf(fetchImpl, clock)

    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBe('octocat')
    clock.advance(61_000)
    // Qualifying hit under the caller's 120 s cap — parks the background refresh.
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBe('octocat')
    await parkedReadArrived

    // The unlink's own read/check/delete passes the gate (only read #2 parks)
    // and lands its invalidation while the refresh is still in flight.
    await svc.unlinkSocialIdentity('sub-1', 'github')
    release()
    await settled()

    // The parked refresh carried the pre-unlink login; the fence kept it out,
    // so the next read fetches the post-unlink account.
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBeNull()
    expect(calls.user).toBe(4)
  })

  it('a negative entry refreshes ahead too, flipping to the just-linked login without a blocking read', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = {}
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = svcOf(fetchImpl, clock)

    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBeNull() // 404 → negative entry
    expect(calls.user).toBe(1)

    // 31 s: inside the 60 s negative window, past ITS half — the negative TTL,
    // tighter than the caller's 120 s cap, is the lease that counts here. The
    // hit itself still answers null: refresh-ahead does not shorten (or
    // extend) what the negative lease promises.
    clock.advance(31_000)
    users['sub-1'] = githubUser('late')
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBeNull()
    await settled()
    expect(calls.user).toBe(2)

    // The background refresh replaced the miss with the just-linked login.
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBe('late')
    expect(calls.user).toBe(2)
  })
})

describe('LogtoIdentityService.ensureIdentityFresh (cold-visit warm trigger)', () => {
  it('cold caches: one background lookup per cache, then capped reads serve without blocking', async () => {
    const clock = new FakeClock(0)
    const log = logSpy()
    const { fetchImpl, calls } = fakeLogto({ 'sub-1': linkedUser() })
    const svc = svcOf(fetchImpl, clock, log)

    svc.ensureIdentityFresh('sub-1')
    await settled()
    // One lookup per cache — users and logins read the same Logto resource.
    expect(calls.user).toBe(2)
    expect(log.debug).toHaveBeenCalledWith(
      { sub: 'sub-1', users: true, logins: true },
      'logto identity warm-ahead fired'
    )

    // The session path finds both caches fresh: no further fetch, no cold-block line.
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0EXAMPLE1' })
    await expect(svc.feishuIdentitiesFor('sub-1')).resolves.toEqual([])
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBe('octocat')
    expect(calls.user).toBe(2)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('fires only when an entry is missing or past half of the 120 s cap', async () => {
    const clock = new FakeClock(0)
    const log = logSpy()
    const { fetchImpl, calls } = fakeLogto({ 'sub-1': linkedUser() })
    const svc = svcOf(fetchImpl, clock, log)

    svc.ensureIdentityFresh('sub-1')
    await settled()
    expect(calls.user).toBe(2)

    log.debug.mockClear()
    clock.advance(59_000) // age 59 s — under half of the cap, both entries quiet
    svc.ensureIdentityFresh('sub-1')
    await settled()
    expect(calls.user).toBe(2)
    expect(log.debug).not.toHaveBeenCalled()

    clock.advance(2_000) // age 61 s — fresh by the 10 min TTL, due against the 120 s cap's half
    svc.ensureIdentityFresh('sub-1')
    await settled()
    expect(calls.user).toBe(4)
    expect(log.debug).toHaveBeenCalledWith(
      { sub: 'sub-1', users: true, logins: true },
      'logto identity warm-ahead fired'
    )
  })

  it('concurrent triggers and a blocking read coalesce onto one in-flight lookup', async () => {
    const clock = new FakeClock(0)
    const log = logSpy()
    const { fetchImpl, calls, release, parkedReadArrived } = fakeLogto({ 'sub-1': linkedUser() }, { parkRead: 2 })
    const svc = svcOf(fetchImpl, clock, log)

    // Read 1 — a genuine cold block on the logins cache, counted.
    await expect(svc.githubLoginFor('sub-1', 120_000)).resolves.toBe('octocat')
    expect(log.info).toHaveBeenCalledWith({ sub: 'sub-1', cache: 'logins' }, 'logto identity blocking fetch')

    clock.advance(10_000) // logins young → the trigger has only the users cache to warm
    svc.ensureIdentityFresh('sub-1') // parks upstream as read 2
    await parkedReadArrived
    svc.ensureIdentityFresh('sub-1') // users in flight, logins young — nothing new fires

    const read = svc.slackIdentityFor('sub-1') // joins the parked lookup
    release()
    await expect(read).resolves.toMatchObject({ teamId: 'T0EXAMPLE1' })
    await settled()
    expect(calls.user).toBe(2)
    // The joiner found the warm's lookup in flight — never counted as a cold block.
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('forgetUser racing a warm-fired lookup keeps its result out of the cache', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = { 'sub-1': linkedUser() }
    const { fetchImpl, calls, release, parkedReadArrived } = fakeLogto(users, { parkRead: 2 })
    const svc = svcOf(fetchImpl, clock)

    await svc.githubLoginFor('sub-1', 120_000) // read 1 — leaves only the users cache cold
    clock.advance(10_000)
    svc.ensureIdentityFresh('sub-1') // fires the users lookup; parks as read 2
    await parkedReadArrived

    // The identity changes at the provider and the console announces it while the
    // warm's lookup is still in flight holding the pre-change snapshot.
    users['sub-1'] = slackUser('T0AFTER000')
    svc.forgetUser('sub-1')
    release()
    await settled()

    // The epoch fence dropped the parked result — the next read sees the new world.
    await expect(svc.slackIdentityFor('sub-1')).resolves.toMatchObject({ teamId: 'T0AFTER000' })
    expect(calls.user).toBe(3)
  })

  it('a failing warm is swallowed: debug-logged, nothing thrown', async () => {
    const clock = new FakeClock(0)
    const log = logSpy()
    const failing: FetchImpl = async () => {
      throw new Error('logto unreachable')
    }
    const svc = svcOf(failing, clock, log)

    expect(() => svc.ensureIdentityFresh('sub-1')).not.toThrow()
    await settled()
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1' }),
      'logto refresh-ahead lookup failed'
    )
  })

  it('counts a capped read blocking on a cold cache; display reads and warmed reads are quiet', async () => {
    const clock = new FakeClock(0)
    const log = logSpy()
    const { fetchImpl } = fakeLogto({ 'sub-1': linkedUser() })
    const svc = svcOf(fetchImpl, clock, log)

    await svc.socialAccountFor('sub-1') // display read (no cap): cold, but not the authorization path
    expect(log.info).not.toHaveBeenCalled()

    await svc.githubLoginFor('sub-1', 120_000) // capped read on a cold logins cache
    expect(log.info).toHaveBeenCalledWith({ sub: 'sub-1', cache: 'logins' }, 'logto identity blocking fetch')

    await svc.slackIdentityFor('sub-1') // users cache already warm from the display read
    expect(log.info).toHaveBeenCalledTimes(1)
  })
})

describe('LogtoIdentityService subject-cache bounds', () => {
  it('evicts the least-recently-written subject past the cap instead of growing forever', async () => {
    const clock = new FakeClock(0)
    const { fetchImpl, calls } = fakeLogto({}) // every subject 404s — tiny negative entries
    const svc = svcOf(fetchImpl, clock)

    for (let i = 0; i <= 10_000; i++) await svc.githubLoginFor(`sub-${i}`, 120_000)
    expect(calls.user).toBe(10_001)

    await svc.githubLoginFor('sub-10000', 120_000) // most recent write — still resident
    expect(calls.user).toBe(10_001)
    await svc.githubLoginFor('sub-0', 120_000) // the one evicted entry refetches
    expect(calls.user).toBe(10_002)
  })
})
