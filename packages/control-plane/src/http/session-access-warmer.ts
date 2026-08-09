/**
 * `SessionAccessWarmer` — §4 of session-access-cold-visit.md (Phase 3).
 *
 * The session-access plugins cache viewer-independent resource facts (Slack
 * conversation audiences, GitHub repository shapes) under the §2 verdict-split
 * leases, but only console reads populate them — so the infrequent visitor
 * always misses. This service turns the product's own activity into the warming
 * signal: the `event/session` ingest handler pokes it fire-and-forget with
 * `(orgId, externalScopeId)` after commit-then-publish, and everything else is
 * re-resolved at execution time.
 *
 * A poke marks the scope active in a bounded working set (per-entry LRU
 * eviction, never a wholesale clear) and — when the scope is not already
 * carried by the loop — schedules one warm. A `CronRunReaper`-style
 * clock-driven loop re-warms every working-set scope on a cadence of half the
 * public-verdict lease and drops scopes with no poke for `idleDropMs` (24 h),
 * so warmth follows activity through a workday instead of ending one lease
 * after the last message (§4.3). An idle org costs zero.
 *
 * Execution discipline (§4.2): the org's external-access policy is read before
 * any provider work (`disabled`/missing row skips the warm entirely); scope →
 * credential → secret re-resolve through the read path's own fences inside the
 * plugins' warm entries; and every observation goes through the classifying
 * wrappers (`warmAudience`/`warmShape`) — never the raw caches — so a failed
 * warm is never cached and a §4.2(4) invalidation always wins. Rate
 * discipline: a global concurrency cap, per-warm jitter, and first warms after
 * a restart spread across the young-process window; replayed
 * `event/session-sync` frames never poke (the handler layer enforces that).
 *
 * Lifecycle: constructed in the container, armed by `startBackground()` only
 * (tests never see a timer), stopped in `shutdown()` — `stop()` cancels timers
 * first, then `settle()` drains in-flight warms until quiescent.
 */
import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord, SessionRepo } from '../persistence/ports.js'
import type { SessionAccessWarmOutcome } from './session-access-plugin.js'

const MAX_WORKING_SET = 10_000
/** §4.3: a scope with no poke for this long leaves the working set. */
const DEFAULT_IDLE_DROP_MS = 24 * 60 * 60 * 1000
/** §4.2(6): warms never start aligned — each start is jittered within this. */
const WARM_JITTER_MS = 30_000
/** §4.2(6): warms in flight at once, across all tokens. */
const WARM_CONCURRENCY = 3
/** Matches the plugins' default `SESSION_ACCESS_PUBLIC_TTL_SEC` when omitted. */
const DEFAULT_PUBLIC_TTL_MS = 3_600_000

interface WorkingEntry {
  orgId: OrgId
  lastPokeAtMs: number
  lastWarmAtMs?: number
}

export interface WarmerLog {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface SessionAccessWarmerDeps {
  /** Scope re-read + the §4.2(1) policy gate, both at execution time. */
  sessions: Pick<SessionRepo, 'getExternalScopes' | 'getExternalAccessPolicy'>
  /** provider → the plugin's §4.1 warm entry (its classifying-wrapper front
   *  door, §4.2(3)); a provider with no entry is skipped, never improvised. */
  targets: ReadonlyMap<string, (scope: ExternalScopeRecord) => Promise<SessionAccessWarmOutcome>>
  clock: Clock
  log?: WarmerLog
  /** `SESSION_ACCESS_PUBLIC_TTL_SEC` in ms; the re-warm cadence is half of it. */
  publicTtlMs?: number
  /** §4.3 working-set retention; default 24 h. Injectable for tests. */
  idleDropMs?: number
  /** Working-set bound; default 10 000. Injectable for tests. */
  maxScopes?: number
  /** Jitter source; injectable so tests are deterministic. */
  random?: () => number
}

export class SessionAccessWarmer {
  /** externalScopeId → activity record. LRU-bounded; pruned by the loop. */
  private readonly entries: LRUCache<string, WorkingEntry>
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly scheduled = new Map<string, TimerHandle>()
  private loopTimer: TimerHandle | undefined
  private armed = false
  private startedAtMs = 0
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly warmIntervalMs: number
  private readonly idleDropMs: number
  private readonly random: () => number
  /** §5 instrumentation: poke volume, warm executions, and their outcomes. */
  readonly stats = { pokes: 0, warms: 0, warmed: 0, skipped: 0, failed: 0 }

  constructor(private readonly deps: SessionAccessWarmerDeps) {
    this.entries = new LRUCache({
      ...cacheOptions(deps.clock, deps.maxScopes ?? MAX_WORKING_SET),
      // The working-set bound must bound the timers too: an entry leaving the
      // set — LRU pressure or the idle drop — takes its scheduled warm with it,
      // or a distinct-scope burst during the young window would grow
      // `scheduled` past the advertised bound.
      dispose: (_entry, scopeId) => this.cancelScheduled(scopeId)
    })
    this.warmIntervalMs = Math.floor((deps.publicTtlMs ?? DEFAULT_PUBLIC_TTL_MS) / 2)
    this.idleDropMs = deps.idleDropMs ?? DEFAULT_IDLE_DROP_MS
    this.random = deps.random ?? Math.random
  }

  /**
   * §4.4 hot-path discipline: the ingest handler's only new work — a map write
   * and maybe one armed timer, never a provider call. Records activity always;
   * schedules a warm only when armed and the loop is not already carrying the
   * scope (its last warm at least one full cadence old, or never warmed).
   */
  poke(orgId: OrgId, externalScopeId: string): void {
    this.stats.pokes += 1
    const now = this.deps.clock.now()
    let entry = this.entries.get(externalScopeId)
    if (entry && entry.orgId === orgId) {
      entry.lastPokeAtMs = now
    } else {
      entry = { orgId, lastPokeAtMs: now }
      this.entries.set(externalScopeId, entry)
    }
    if (entry.lastWarmAtMs === undefined || now - entry.lastWarmAtMs >= this.warmIntervalMs) {
      this.scheduleWarm(externalScopeId, entry)
    }
  }

  /** Arm the re-warm loop. Idempotent — a second call re-arms from now. */
  start(): void {
    this.armed = true
    if (this.startedAtMs === 0) this.startedAtMs = this.deps.clock.now()
    this.armLoop()
  }

  /** Cancel the loop and every scheduled warm — call before `settle()`. */
  stop(): void {
    this.armed = false
    if (this.loopTimer !== undefined) {
      this.deps.clock.clearTimeout(this.loopTimer)
      this.loopTimer = undefined
    }
    for (const timer of this.scheduled.values()) this.deps.clock.clearTimeout(timer)
    this.scheduled.clear()
  }

  /** Await quiescence: a draining warm can release a queued one, so loop until
   *  nothing is in flight rather than awaiting one snapshot of the map. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()])
  }

  private armLoop(): void {
    if (!this.armed) return
    if (this.loopTimer !== undefined) this.deps.clock.clearTimeout(this.loopTimer)
    this.loopTimer = this.deps.clock.setTimeout(() => this.tick(), this.warmIntervalMs)
  }

  /** One cadence sweep: drop idle scopes, queue one warm for every survivor.
   *  Errors are logged and swallowed — nothing may kill the loop. */
  private tick(): void {
    this.loopTimer = undefined
    try {
      const now = this.deps.clock.now()
      const dropped: string[] = []
      for (const [scopeId, entry] of this.entries.entries()) {
        if (now - entry.lastPokeAtMs > this.idleDropMs) dropped.push(scopeId)
        else this.scheduleWarm(scopeId, entry)
      }
      for (const scopeId of dropped) this.entries.delete(scopeId)
    } catch (err) {
      this.deps.log?.warn({ err }, 'session-access warmer: sweep failed')
    } finally {
      this.armLoop()
    }
  }

  /** Cancel a scope's pending warm timer, if any (eviction/idle-drop dispose). */
  private cancelScheduled(scopeId: string): void {
    const timer = this.scheduled.get(scopeId)
    if (timer === undefined) return
    this.deps.clock.clearTimeout(timer)
    this.scheduled.delete(scopeId)
  }

  /** Queue one warm — deduped against a scheduled or in-flight one. */
  private scheduleWarm(scopeId: string, entry: WorkingEntry): void {
    if (!this.armed || this.scheduled.has(scopeId) || this.inflight.has(scopeId)) return
    const timer = this.deps.clock.setTimeout(() => {
      this.scheduled.delete(scopeId)
      void this.runWarm(scopeId)
    }, this.warmDelayMs(entry))
    this.scheduled.set(scopeId, timer)
  }

  /**
   * §4.2(6): while the process is younger than one cadence, a scope's FIRST
   * warm draws its delay from what remains of that window, so the reconnect
   * wave after a deploy trickles out instead of bursting against token budgets
   * shared with the fail-closed foreground sweep. Everything else jitters
   * within `WARM_JITTER_MS` so no batch lands on a provider aligned.
   */
  private warmDelayMs(entry: WorkingEntry): number {
    const young = this.warmIntervalMs - (this.deps.clock.now() - this.startedAtMs)
    const window = entry.lastWarmAtMs === undefined && young > WARM_JITTER_MS ? young : WARM_JITTER_MS
    return Math.floor(this.random() * window)
  }

  private async runWarm(scopeId: string): Promise<void> {
    if (!this.armed || this.inflight.has(scopeId)) return
    const entry = this.entries.peek(scopeId)
    if (!entry) return
    const run = this.executeWarm(scopeId, entry.orgId).finally(() => {
      // `peek`: completing a warm is not activity and must not refresh LRU retention.
      const current = this.entries.peek(scopeId)
      if (current) current.lastWarmAtMs = this.deps.clock.now()
      this.inflight.delete(scopeId)
    })
    this.inflight.set(scopeId, run)
    await run
  }

  private async executeWarm(scopeId: string, orgId: OrgId): Promise<void> {
    await this.acquire()
    try {
      if (!this.armed) return
      this.stats.warms += 1
      const { provider, ...result } = await this.observe(scopeId, orgId)
      this.stats[result.outcome] += 1
      // Doorbell precedent: one structured line per warm, outcome attached — the
      // §5 signal for warming volume and failure rate. Ids only, never a resource key.
      const line = { scopeId, orgId, provider, ...result }
      if (result.outcome === 'warmed') this.deps.log?.info(line, 'session-access warm applied')
      else if (result.outcome === 'failed') this.deps.log?.warn(line, 'session-access warm failed')
      else this.deps.log?.debug(line, 'session-access warm skipped')
    } catch {
      // `observe` already reported; nothing here may become an unhandled rejection.
    } finally {
      this.release()
    }
  }

  private async observe(scopeId: string, orgId: OrgId): Promise<SessionAccessWarmOutcome & { provider?: string }> {
    try {
      const [scope] = await this.deps.sessions.getExternalScopes([scopeId])
      // §4.2(2): the poke-time snapshot proves nothing at run time — a missing,
      // moved, or revoked scope skips; the plugin re-fences the credential.
      if (!scope || scope.orgId !== orgId || scope.revokedAt !== null) {
        return { outcome: 'skipped', reason: 'scope_unresolved' }
      }
      const target = this.deps.targets.get(scope.provider)
      if (!target) return { outcome: 'skipped', reason: 'provider_unwarmed', provider: scope.provider }
      // §4.2(1) policy gate: an org that turned sync off has withdrawn consent
      // for the CP to question its workspace — zero provider calls.
      const policy = await this.deps.sessions.getExternalAccessPolicy(orgId, scope.provider)
      if (!policy || policy.state === 'disabled') {
        return { outcome: 'skipped', reason: 'policy_disabled', provider: scope.provider }
      }
      return { ...(await target(scope)), provider: scope.provider }
    } catch (err) {
      this.deps.log?.warn({ err, scopeId, orgId }, 'session-access warm errored — skipped')
      return { outcome: 'failed', reason: 'warm_error' }
    }
  }

  private acquire(): Promise<void> {
    if (this.active < WARM_CONCURRENCY) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active -= 1
  }
}
