/** Periodically redelivers eligible GitHub hooks missing a run or proven to fail before daemon admission. */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { HookId } from '../domain/ids.js'
import type { GhHookDeliveryPage } from '../github/service.js'
import type { HookRecord, RelayRecord } from '../persistence/ports.js'

/** The families the relay matches (everything else never produces a run). */
const SUBSCRIPTION_EVENTS = new Set(['issues', 'pull_request', 'issue_comment', 'pull_request_review_comment', 'push'])
/** Redeliveries requested per GUID before giving up (loop breaker). */
const MAX_ATTEMPTS = 3
/** Delay before the first sweep of a process — see {@link HookRedeliveryReconciler.start}. */
const FIRST_SWEEP_DELAY_MS = 60_000
/** Durable minimum delay for failures proven to precede daemon admission. */
// One external redelivery is safe; another could cross a placement move after an accepted report is lost.
export const FAILED_DELIVERY_BACKOFF_MS = [30_000] as const
/** Attempt-map bound (flush-at-cap, the daemon dedup-map precedent). */
const MAX_TRACKED = 5_000
/** Hard ceiling on how far back a post-outage catch-up may reach. GitHub's own
 *  redelivery window is 3 days; the delivery listing walks its cursor to the
 *  window floor and, when a firehose exhausts its page budget first, coverage
 *  stops where the listing stopped and the next sweep resumes from there. */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

export interface HookRedeliveryGithub {
  listHookDeliveries(opts?: { perPage?: number; maxPages?: number; deliveredSince?: Date }): Promise<GhHookDeliveryPage>
  redeliverHookDelivery(deliveryId: string): Promise<void>
}

export interface HookRedeliveryHooks {
  listEnabled(): Promise<HookRecord[]>
  existingDeliveryKeys(deliveryKeys: string[]): Promise<Set<string>>
  claimReviewRequestRequiredFanoutRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date
  ): Promise<boolean>
  claimRetryableDeliveryRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date,
    backoffMs: readonly number[]
  ): Promise<boolean>
  settleRetryableDeliveryRedeliveries(requestedAt: Date, expiredBefore: Date, maxAttempts: number): Promise<number>
}

export interface HookRedeliveryRelays {
  listAlive(seenSince: Date): Promise<RelayRecord[]>
}

export interface HookRedeliveryConfig {
  /** Sweep cadence. */
  intervalMs: number
  /** Look-back window — deliveries older than this are out of scope. */
  windowMs: number
  /** Deliveries younger than this are still in flight — leave them alone. */
  graceMs: number
  /** A relay counts as alive when seen within this (mirrors the ingress gate). */
  relayStaleMs: number
}

export interface ReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/** `event:action` vs a hook's patterns, with the `event:*` family wildcard.
 *  Issue/PR edits and close/reopen actions are intentionally
 *  silent, mirroring the relay matcher, so the absence of a HookRun never makes
 *  the reconciler redeliver a no-op.
 *  Diff-line review comments alias onto the `issue_comment` subscription —
 *  mirror of the relay matcher. The delivery summary cannot distinguish issue
 *  vs PR subjects for regular `issue_comment`, nor expose authored text, so
 *  created-cadence summon fallbacks remain conservative candidates;
 *  review-comment summaries are known-PR and can honor scope. */
function hookMatchesEvent(hook: HookRecord, event: string, action: string | null): boolean {
  if ((action === 'closed' || action === 'reopened') && (event === 'issues' || event === 'pull_request')) return false
  if ((event === 'issues' || event === 'pull_request') && action === 'edited') return false
  const matchesPattern = (candidate: string): boolean =>
    hook.events.includes(`${candidate}:${action ?? ''}`) || hook.events.includes(`${candidate}:*`)
  if (matchesPattern(event)) return true
  const createdCadenceIncludes = (family: 'issues' | 'pull_request'): boolean =>
    hook.events.includes(`${family}:opened`)
  if (event === 'issues' || event === 'pull_request') return createdCadenceIncludes(event)
  if (event === 'issue_comment') {
    return action === 'created' && (createdCadenceIncludes('issues') || createdCadenceIncludes('pull_request'))
  }
  if (event !== 'pull_request_review_comment') return false
  const pullRequestInScope = hook.commentFamilies.length === 0 || hook.commentFamilies.includes('pull_request')
  if (!pullRequestInScope) return false
  return matchesPattern('issue_comment') || (action === 'created' && createdCadenceIncludes('pull_request'))
}

export class HookRedeliveryReconciler {
  private timer: TimerHandle | undefined
  private stopped = false
  /** GUID → no-HookRun recovery requests (capped at MAX_ATTEMPTS). Failed
   * HookRun attempts are persisted by HookRedeliveryHooks instead. */
  private readonly attempts = new Map<string, number>()
  /** Everything up to this instant has been swept. Skipped sweeps (relay pool
   *  down — the exact outage this job exists for) do NOT advance it, so the
   *  first post-recovery sweep reaches back over the whole outage instead of
   *  losing whatever aged past the fixed window. */
  private coveredUntilMs: number | undefined

  constructor(
    private readonly github: HookRedeliveryGithub,
    private readonly hooks: HookRedeliveryHooks,
    private readonly relays: HookRedeliveryRelays,
    private readonly clock: Clock,
    private readonly cfg: HookRedeliveryConfig,
    private readonly log?: ReconcilerLog
  ) {}

  /** Arm the periodic sweep. Idempotent — a second call re-arms from now. The
   *  FIRST sweep comes early: the window a fresh process most needs to recover
   *  is the one its own restart interrupted, and a deployment that restarts the
   *  CP more often than `intervalMs` would otherwise never sweep at all. */
  start(): void {
    this.stopped = false
    this.arm(Math.min(FIRST_SWEEP_DELAY_MS, this.cfg.intervalMs))
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(delayMs = this.cfg.intervalMs): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), delayMs)
  }

  /** One sweep. Errors are logged and swallowed — a GitHub/DB blip must never
   *  kill the loop. Exposed for tests (call directly, no clock advance). */
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      await this.sweep()
    } catch (err) {
      this.log?.error({ err }, 'hook-redelivery: sweep failed')
    } finally {
      this.arm()
    }
  }

  private async sweep(): Promise<void> {
    const now = this.clock.now()
    // Pin the anchor on the FIRST sweep — even a skipped one: a CP booting
    // mid-outage still reaches back one full window once a relay returns.
    this.coveredUntilMs ??= now - this.cfg.windowMs
    const oldest = Math.max(now - MAX_LOOKBACK_MS, this.coveredUntilMs)
    const newest = now - this.cfg.graceMs

    // Gate retirement is DB-owned and must not depend on the GUID remaining in
    // GitHub's first delivery page. Clearing a gate also makes the terminal row
    // non-reopenable before Check projection becomes eligible.
    await this.hooks.settleRetryableDeliveryRedeliveries(
      new Date(now),
      new Date(now - MAX_LOOKBACK_MS),
      FAILED_DELIVERY_BACKOFF_MS.length
    )

    // The compile sieve: enabled github hooks that could actually fire.
    const byRepo = new Map<string, HookRecord[]>()
    for (const hook of await this.hooks.listEnabled()) {
      if (hook.kind !== 'github' || hook.repoId === null || !hook.agentId) continue
      const key = hook.repoId.toString()
      const bucket = byRepo.get(key)
      if (bucket) bucket.push(hook)
      else byRepo.set(key, [hook])
    }
    if (byRepo.size === 0) {
      // Nothing to recover — but the interval IS covered (don't accumulate an
      // ever-growing catch-up window while no github hook exists).
      this.coveredUntilMs = newest
      return
    }

    // No live relay ⇒ a redelivery would land on the same dead pool. Wait.
    const alive = await this.relays.listAlive(new Date(this.clock.now() - this.cfg.relayStaleMs))
    if (alive.length === 0) {
      this.log?.warn({}, 'hook-redelivery: no live relay — skipping the sweep')
      return
    }

    const { deliveries, truncated } = await this.github.listHookDeliveries({ deliveredSince: new Date(oldest) })
    // A truncated walk saw everything down to its oldest entry and nothing
    // below it. Coverage stops THERE — advancing the cursor to `newest` would
    // declare a slice swept that was never listed, which is exactly how a lost
    // delivery stays lost.
    const oldestListedMs = deliveries.length > 0 ? Date.parse(deliveries[deliveries.length - 1]!.delivered_at) : NaN
    const truncatedFloor =
      truncated && !Number.isNaN(oldestListedMs) && oldestListedMs > oldest ? oldestListedMs : undefined
    // …and never PAST `newest`: everything above that ceiling is inside the
    // grace window and was skipped below, so a budget exhausted entirely inside
    // the grace period must not carry coverage over the deliveries it withheld.
    const sweptUntil = truncatedFloor === undefined ? newest : Math.min(newest, truncatedFloor)
    if (sweptUntil !== newest) {
      this.log?.warn(
        { count: deliveries.length, reachedBack: new Date(sweptUntil).toISOString() },
        'hook-redelivery: delivery list ran out before the look-back window — the rest retries next sweep'
      )
    }

    const matchingHookIds = new Map<string, HookId[]>()
    const matching = deliveries.filter((d) => {
      if (!SUBSCRIPTION_EVENTS.has(d.event)) return false
      const at = Date.parse(d.delivered_at)
      if (Number.isNaN(at) || at < now - MAX_LOOKBACK_MS || at > newest) return false
      const hooks = d.repository_id === null ? undefined : byRepo.get(String(d.repository_id))
      const matched = hooks?.filter((hook) => hookMatchesEvent(hook, d.event, d.action)) ?? []
      if (matched.length === 0) return false
      matchingHookIds.set(
        d.guid,
        matched.map((hook) => hook.id)
      )
      return true
    })
    if (matching.length === 0) {
      this.coveredUntilMs = sweptUntil
      return
    }

    const landed = await this.hooks.existingDeliveryKeys([...new Set(matching.map((c) => c.guid))])
    let redelivered = 0
    let oldestFailedAt: number | undefined // a failed GitHub call keeps its slice of the window open for retry
    const seenThisTick = new Set<string>() // one guid may list several attempts — ask once
    for (const d of matching) {
      if (seenThisTick.has(d.guid)) continue
      const persistedFailure = landed.has(d.guid)
      const deliveredAt = Date.parse(d.delivered_at)
      if (!persistedFailure && deliveredAt < oldest) continue
      if (!persistedFailure && (this.attempts.get(d.guid) ?? 0) >= MAX_ATTEMPTS) continue

      seenThisTick.add(d.guid)
      if (persistedFailure) {
        const expectedHookIds = matchingHookIds.get(d.guid) ?? []
        const claimed =
          (await this.hooks.claimReviewRequestRequiredFanoutRedelivery(d.guid, expectedHookIds, new Date(now))) ||
          (await this.hooks.claimRetryableDeliveryRedelivery(
            d.guid,
            expectedHookIds,
            new Date(now),
            FAILED_DELIVERY_BACKOFF_MS
          ))
        if (!claimed) continue
      } else {
        if (this.attempts.size >= MAX_TRACKED) this.attempts.clear()
        this.attempts.set(d.guid, (this.attempts.get(d.guid) ?? 0) + 1)
      }
      try {
        await this.github.redeliverHookDelivery(d.id)
        redelivered += 1
      } catch (err) {
        // Durable HookRuns are scanned independent of the no-row coverage
        // cursor and retain their next due time. Only a failed no-row request
        // must keep its historical slice open.
        if (!persistedFailure) oldestFailedAt = Math.min(oldestFailedAt ?? Infinity, deliveredAt)
        this.log?.warn({ deliveryId: d.id, guid: d.guid, err }, 'hook-redelivery: redeliver call failed')
      }
    }
    if (redelivered > 0) {
      this.log?.info({ redelivered, scanned: deliveries.length }, 'hook-redelivery: re-posted lost deliveries')
    }
    this.coveredUntilMs = oldestFailedAt !== undefined ? Math.min(sweptUntil, oldestFailedAt - 1) : sweptUntil
  }
}
