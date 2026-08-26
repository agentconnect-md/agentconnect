/**
 * `HookRedeliveryReconciler` — the candidate sieve (families / repo / event
 * patterns / window), the landed-GUID probe, the alive-relay gate, the
 * per-GUID attempt cap, and error isolation. Pure logic over faked deps +
 * FakeClock — no DB, no network.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  FAILED_DELIVERY_BACKOFF_MS,
  HookRedeliveryReconciler,
  type HookRedeliveryConfig
} from './hookRedeliveryReconciler.js'
import type { GhHookDelivery } from '../github/service.js'
import type { HookRecord, RelayRecord } from '../persistence/ports.js'
import { AgentId, HookId, OrgId } from '../domain/ids.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const NOW = 1_700_000_000_000
const REPO_ID = 987654321n

const CFG: HookRedeliveryConfig = {
  intervalMs: 10 * 60 * 1000,
  windowMs: 30 * 60 * 1000,
  graceMs: 2 * 60 * 1000,
  relayStaleMs: 45_000
}

function ghHook(over: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HookId('11111111-1111-4111-8111-111111111111'),
    orgId: OrgId('org'),
    agentId: AgentId('22222222-2222-4222-8222-222222222222'),
    kind: 'github',
    name: 'gh',
    enabled: true,
    sessionMode: 'perThread',
    urlToken: null,
    hmacConfigured: false,
    repoId: REPO_ID,
    repoFullName: 'acme/infra',
    events: ['issues:opened'],
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    targetPlatform: 'slack',
    targetChannel: null,
    targetIntegrationId: null,
    lastFiredAt: null,
    createdBy: null,
    createdByUserId: null,
    createdAt: new Date(0),
    lastModifiedAt: new Date(0),
    lastModifiedBy: null,
    configRevision: 0n,
    ...over
  } as HookRecord
}

/** A delivery 10 min old — inside the window, past the grace. */
function delivery(over: Partial<GhHookDelivery> = {}): GhHookDelivery {
  return {
    id: '1234567890123456789', // 19 digits — past Number.MAX_SAFE_INTEGER
    guid: 'guid-1',
    delivered_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    event: 'issues',
    action: 'opened',
    repository_id: Number(REPO_ID),
    installation_id: 1234567,
    ...over
  }
}

function make(opts: {
  hooks?: HookRecord[]
  deliveries?: GhHookDelivery[] | (() => GhHookDelivery[])
  /** The listing walked its page budget without reaching `deliveredSince`. */
  truncated?: boolean
  landed?: string[]
  relaysAlive?: boolean | (() => boolean)
  redeliverError?: boolean
  reviewFanoutClaim?: boolean
  claim?:
    | boolean
    | ((
        deliveryKey: string,
        expectedHookIds: readonly HookId[],
        at: Date,
        backoffMs: readonly number[]
      ) => boolean | Promise<boolean>)
}) {
  const clock = new FakeClock(NOW)
  const redelivered: string[] = []
  const redeliverMock = vi.fn(async (id: string) => {
    if (opts.redeliverError) throw new Error('github 502')
    redelivered.push(id)
  })
  const alive = () => (typeof opts.relaysAlive === 'function' ? opts.relaysAlive() : (opts.relaysAlive ?? true))
  const claimMock = vi.fn(
    async (deliveryKey: string, expectedHookIds: readonly HookId[], at: Date, backoffMs: readonly number[]) =>
      typeof opts.claim === 'function' ? opts.claim(deliveryKey, expectedHookIds, at, backoffMs) : (opts.claim ?? false)
  )
  const settleMock = vi.fn(async () => 0)
  const reviewFanoutClaimMock = vi.fn(async () => opts.reviewFanoutClaim ?? false)
  const listMock = vi.fn(async (_opts?: { deliveredSince?: Date }) => ({
    deliveries: typeof opts.deliveries === 'function' ? opts.deliveries() : (opts.deliveries ?? [delivery()]),
    truncated: opts.truncated ?? false
  }))
  const reconciler = new HookRedeliveryReconciler(
    {
      listHookDeliveries: listMock,
      redeliverHookDelivery: redeliverMock
    },
    {
      listEnabled: vi.fn(async () => opts.hooks ?? [ghHook()]),
      existingDeliveryKeys: vi.fn(async () => new Set(opts.landed ?? [])),
      claimReviewRequestRequiredFanoutRedelivery: reviewFanoutClaimMock,
      claimRetryableDeliveryRedelivery: claimMock,
      settleRetryableDeliveryRedeliveries: settleMock
    },
    { listAlive: vi.fn(async () => (alive() ? [{ id: 'r1' } as RelayRecord] : [])) },
    clock,
    CFG
  )
  // Ticks stay MANUAL: tick()'s finally re-arms a timer, and clock.advance()
  // would fire those into async sweeps racing the test's own tick() calls.
  reconciler.stop()
  return { reconciler, redelivered, redeliverMock, reviewFanoutClaimMock, claimMock, settleMock, listMock, clock }
}

/** Let a clock-fired sweep run to completion. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('HookRedeliveryReconciler', () => {
  it('redelivers a matching, unlanded GUID', async () => {
    const h = make({})
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['1234567890123456789']) // 19-digit id survives verbatim
  })

  it('leaves landed GUIDs alone', async () => {
    const h = make({ landed: ['guid-1'] })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual([])
    expect(h.claimMock).toHaveBeenCalledOnce()
  })

  it('redelivers a landed GUID only after its durable failed-row claim succeeds', async () => {
    const h = make({ landed: ['guid-1'], claim: true })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['1234567890123456789'])
    expect(h.claimMock).toHaveBeenCalledWith('guid-1', [ghHook().id], new Date(NOW), FAILED_DELIVERY_BACKOFF_MS)
  })

  it('repairs a partially persisted review-request fan-out with one durable redelivery claim', async () => {
    const hook2 = ghHook({ id: HookId('33333333-3333-4333-8333-333333333333') })
    const h = make({
      hooks: [ghHook(), hook2],
      landed: ['guid-1'],
      reviewFanoutClaim: true
    })
    await h.reconciler.tick()
    expect(h.reviewFanoutClaimMock).toHaveBeenCalledWith('guid-1', [ghHook().id, hook2.id], new Date(NOW))
    expect(h.claimMock).not.toHaveBeenCalled()
    expect(h.redelivered).toEqual(['1234567890123456789'])
  })

  it('coalesces several listed attempts and failed hook rows to one durable claim and POST', async () => {
    const h = make({
      landed: ['guid-1'],
      claim: true,
      deliveries: [delivery({ id: 'newest' }), delivery({ id: 'older' })]
    })
    await h.reconciler.tick()
    expect(h.claimMock).toHaveBeenCalledOnce()
    expect(h.redelivered).toEqual(['newest'])
  })

  it('keeps scanning persisted failures after the no-row coverage cursor advances', async () => {
    let due = false
    const h = make({ landed: ['guid-1'], claim: () => due, deliveries: () => [delivery()] })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual([])

    h.clock.advance(CFG.intervalMs)
    due = true
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['1234567890123456789'])
  })

  it('sieves by family, repo, event pattern, and window', async () => {
    const h = make({
      deliveries: [
        delivery({ id: '1', guid: 'g-ping', event: 'ping', action: null }), // wrong family
        delivery({ id: '2', guid: 'g-inst', event: 'installation', action: 'created' }), // doorbell class
        delivery({ id: '3', guid: 'g-repo', repository_id: 1 }), // unwatched repo
        delivery({ id: '4', guid: 'g-action', event: 'issue_comment', action: 'edited' }), // unsupported comment action
        delivery({ id: '5', guid: 'g-old', delivered_at: new Date(NOW - 31 * 60 * 1000).toISOString() }), // too old
        delivery({ id: '6', guid: 'g-new', delivered_at: new Date(NOW - 60 * 1000).toISOString() }), // inside grace
        delivery({ id: '7', guid: 'g-null-repo', repository_id: null }),
        delivery({ id: '8', guid: 'g-hit' }) // the one real candidate
      ]
    })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['8'])
  })

  it('the event:* wildcard widens the sieve', async () => {
    const h = make({
      hooks: [ghHook({ events: ['pull_request:*'] })],
      deliveries: [delivery({ event: 'pull_request', action: 'synchronize' })]
    })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['1234567890123456789'])
  })

  it('conservatively redelivers possible created-cadence summons', async () => {
    const issue = make({
      hooks: [ghHook({ events: ['issues:opened'], commentFamilies: ['issues'] })],
      deliveries: [
        delivery({ id: '1', guid: 'issue-update', action: 'labeled' }),
        delivery({ id: '2', guid: 'issue-comment', event: 'issue_comment', action: 'created' }),
        delivery({ id: '3', guid: 'edited-comment', event: 'issue_comment', action: 'edited' }),
        delivery({ id: '4', guid: 'pr-update', event: 'pull_request', action: 'synchronize' }),
        delivery({ id: '5', guid: 'pr-review', event: 'pull_request_review_comment', action: 'created' }),
        delivery({ id: '6', guid: 'issue-closed', action: 'closed' })
      ]
    })
    await issue.reconciler.tick()
    expect(issue.redelivered).toEqual(['1', '2'])

    const pullRequest = make({
      hooks: [ghHook({ events: ['pull_request:opened'], commentFamilies: ['pull_request'] })],
      deliveries: [
        delivery({ id: '7', guid: 'pr-update', event: 'pull_request', action: 'synchronize' }),
        delivery({ id: '8', guid: 'pr-review', event: 'pull_request_review_comment', action: 'created' })
      ]
    })
    await pullRequest.reconciler.tick()
    expect(pullRequest.redelivered).toEqual(['7', '8'])
  })

  // The summary carries no issue-vs-PR subject, so BOTH family rows are handed
  // to the claim; deciding which of them actually landed a run is its job.
  it('offers both comment-family sibling rows as candidates for one issue_comment GUID', async () => {
    const pullRow = HookId('33333333-3333-4333-8333-333333333333')
    const issuesRow = HookId('44444444-4444-4444-8444-444444444444')
    const h = make({
      hooks: [
        ghHook({ id: pullRow, events: ['pull_request:*', 'issue_comment:created'], commentFamilies: ['pull_request'] }),
        ghHook({ id: issuesRow, events: ['issues:*', 'issue_comment:created'], commentFamilies: ['issues'] })
      ],
      deliveries: [delivery({ id: '9', guid: 'shared-comment', event: 'issue_comment', action: 'created' })],
      landed: ['shared-comment'],
      claim: true
    })
    await h.reconciler.tick()
    expect(h.claimMock).toHaveBeenCalledWith('shared-comment', [pullRow, issuesRow], new Date(NOW), [
      ...FAILED_DELIVERY_BACKOFF_MS
    ])
    expect(h.redelivered).toEqual(['9'])
  })

  it('silences issue/PR edits and close/reopen events', async () => {
    const h = make({
      hooks: [ghHook({ events: ['issues:*', 'pull_request:*'] })],
      deliveries: [
        delivery({ id: '1', guid: 'issue-closed', event: 'issues', action: 'closed' }),
        delivery({ id: '2', guid: 'issue-reopened', event: 'issues', action: 'reopened' }),
        delivery({ id: '3', guid: 'pr-closed', event: 'pull_request', action: 'closed' }),
        delivery({ id: '4', guid: 'pr-reopened', event: 'pull_request', action: 'reopened' }),
        delivery({ id: '5', guid: 'issue-edited', event: 'issues', action: 'edited' }),
        delivery({ id: '6', guid: 'pr-edited', event: 'pull_request', action: 'edited' })
      ]
    })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual([])
  })

  it('scopes the review-comment alias to PRs while preserving explicit review subscriptions', async () => {
    const review = delivery({ event: 'pull_request_review_comment', action: 'created' })

    const issueOnly = make({
      hooks: [ghHook({ events: ['issue_comment:created'], commentFamilies: ['issues'] })],
      deliveries: [review]
    })
    await issueOnly.reconciler.tick()
    expect(issueOnly.redelivered).toEqual([])

    const pullRequest = make({
      hooks: [ghHook({ events: ['issue_comment:created'], commentFamilies: ['pull_request'] })],
      deliveries: [review]
    })
    await pullRequest.reconciler.tick()
    expect(pullRequest.redelivered).toEqual(['1234567890123456789'])

    const explicit = make({
      hooks: [ghHook({ events: ['pull_request_review_comment:created'], commentFamilies: ['issues'] })],
      deliveries: [review]
    })
    await explicit.reconciler.tick()
    expect(explicit.redelivered).toEqual(['1234567890123456789'])
  })

  it('skips the sweep entirely when no relay is alive (redelivery would be lost too)', async () => {
    const h = make({ relaysAlive: false })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual([])
  })

  it('does nothing when no github hook is enabled (never calls GitHub)', async () => {
    const h = make({ hooks: [ghHook({ kind: 'webhook', repoId: null })] })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual([])
  })

  it('a swept interval is not re-scanned: the same stale delivery is asked once, not per tick', async () => {
    const h = make({ deliveries: () => [delivery({ id: '9001' })] })
    await h.reconciler.tick()
    await h.reconciler.tick() // same list, clock unmoved — already covered
    expect(h.redelivered).toEqual(['9001'])
  })

  it('caps redelivery attempts per GUID (the re-list loop breaker)', async () => {
    // A never-landing delivery keeps re-appearing under the same GUID with a
    // FRESH timestamp (GitHub lists every redelivery attempt) — the cap must
    // end the loop that the sliding coverage window alone cannot.
    const h = make({
      deliveries: () => [delivery({ id: '9001', delivered_at: new Date(h.clock.now() - 3 * 60 * 1000).toISOString() })]
    })
    for (let i = 0; i < 5; i++) {
      await h.reconciler.tick()
      h.clock.advance(CFG.intervalMs)
    }
    expect(h.redelivered).toEqual(['9001', '9001', '9001']) // MAX_ATTEMPTS
  })

  it('an outage longer than the window is still caught up (skipped sweeps do not advance coverage)', async () => {
    // Delivery lands 10min before the outage-spanning sweeps; the pool is down
    // for 40min (> windowMs). The first post-recovery sweep must reach back
    // over the whole outage instead of losing everything older than 30min.
    let up = false
    const h = make({
      relaysAlive: () => up,
      deliveries: () => [delivery()] // delivered_at = NOW − 10min
    })
    await h.reconciler.tick() // pool down — skipped, but the anchor is pinned
    expect(h.redelivered).toEqual([])
    h.clock.advance(40 * 60 * 1000)
    up = true
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['1234567890123456789'])
  })

  it('asks once per GUID per tick even when several attempts are listed', async () => {
    const h = make({
      deliveries: [delivery({ id: '9001' }), delivery({ id: '9002' })] // same guid, two attempts
    })
    await h.reconciler.tick()
    expect(h.redelivered).toEqual(['9001'])
  })

  it('a failing redeliver call keeps its window slice open for retry, bounded by the attempt cap', async () => {
    const h = make({ redeliverError: true, deliveries: () => [delivery()] })
    for (let i = 0; i < 5; i++) await expect(h.reconciler.tick()).resolves.toBeUndefined()
    expect(h.redelivered).toEqual([]) // never succeeded…
    expect(h.redeliverMock).toHaveBeenCalledTimes(3) // …retried next ticks, then the cap ended the calls
  })

  it('asks the delivery listing to reach the whole look-back window', async () => {
    const h = make({})
    await h.reconciler.tick()
    expect(h.listMock.mock.calls[0]?.[0]?.deliveredSince).toEqual(new Date(NOW - CFG.windowMs))
  })

  it('a truncated listing covers only what it listed, and the next sweep resumes there', async () => {
    // The busy-App case: the page budget runs out long before the window does.
    // Anything older than the oldest listed delivery was never looked at.
    const listedFloor = NOW - 4 * 60 * 1000
    const h = make({
      truncated: true,
      deliveries: () => [delivery({ delivered_at: new Date(listedFloor).toISOString() })]
    })
    await h.reconciler.tick()
    h.clock.advance(CFG.intervalMs)
    await h.reconciler.tick()

    // Not `now − windowMs` (which would slide past the unlisted slice) and not
    // `newest` — the second sweep starts exactly where the first one stopped.
    expect(h.listMock.mock.calls[1]?.[0]?.deliveredSince).toEqual(new Date(listedFloor))
  })

  it('a listing truncated entirely inside the grace window covers no more than the ceiling it evaluated', async () => {
    // Every listed delivery is younger than `graceMs`, so none of them were
    // evaluated. Coverage must stop at that ceiling — carrying it up to the
    // oldest listed delivery would skip everything in between once those
    // deliveries age into eligibility.
    const h = make({
      truncated: true,
      deliveries: () => [delivery({ delivered_at: new Date(NOW - 30_000).toISOString() })]
    })
    await h.reconciler.tick()
    h.clock.advance(CFG.intervalMs)
    await h.reconciler.tick()
    expect(h.listMock.mock.calls[1]?.[0]?.deliveredSince).toEqual(new Date(NOW - CFG.graceMs))
  })

  it('a complete listing that is simply short still advances coverage', async () => {
    const h = make({ deliveries: () => [delivery()] }) // truncated: false — quiet App
    await h.reconciler.tick()
    h.clock.advance(CFG.intervalMs)
    await h.reconciler.tick()
    // The first sweep covered its whole window, so the second resumes at that
    // sweep's ceiling instead of re-listing an interval it already saw.
    expect(h.listMock.mock.calls[1]?.[0]?.deliveredSince).toEqual(new Date(NOW - CFG.graceMs))
  })

  it('runs its first sweep early — a CP that restarts every few minutes still sweeps', async () => {
    const h = make({})
    h.reconciler.start()

    h.clock.advance(30_000)
    await flush()
    expect(h.listMock).not.toHaveBeenCalled()
    h.clock.advance(30_000) // 60s after boot, not a full interval
    await flush()
    expect(h.listMock).toHaveBeenCalledOnce()
    h.reconciler.stop()
  })
})
