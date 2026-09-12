// The owed-frame outbox shared by every formal review adapter (gitlab §15.1, gitea §10.3): owed durably before sending, replayed until taken.
import type {
  CodeHostReviewAuthorize,
  CodeHostReviewAuthorized,
  CodeHostReviewLeaseRenew,
  CodeHostReviewLeaseRenewed,
  CodeHostReviewOpAccepted,
  CodeHostReviewOpRequest,
  CodeHostReviewResultOk,
  CodeHostReviewResultReport
} from '@agentconnect.md/protocol'
import type { PosterScheduler } from '../github/poster.js'

/** One control-plane frame a finished attempt still owes, replayed verbatim until acked (§15.1). */
export interface ReviewIntentRow {
  intentId: string
  daemonId: string
  attemptId: string
  orgId?: string
  kind: 'operation' | 'result'
  /** The exact JSON payload; both frames are idempotent REQs by contract. */
  frame: string
  attempts: number
}

export interface ReviewIntentStore {
  recordReviewIntent(row: ReviewIntentRow, now: number): Promise<void>
  clearReviewIntent(intentId: string): Promise<void>
  listReviewIntents(daemonId: string): Promise<ReviewIntentRow[]>
}

/** The narrow Control-Plane surface the review adapters need (§15.1 lease + operation ledger). */
export interface CodeHostReviewControlPlane {
  /** The CP advertises `codehost-review-v1`; without it an adapter refuses before any effect. */
  supportsReview(): boolean
  authorize(payload: CodeHostReviewAuthorize, orgId?: string): Promise<CodeHostReviewAuthorized>
  operate(payload: CodeHostReviewOpRequest, orgId?: string): Promise<CodeHostReviewOpAccepted>
  renew(payload: CodeHostReviewLeaseRenew, orgId?: string): Promise<CodeHostReviewLeaseRenewed>
  report(payload: CodeHostReviewResultReport, orgId?: string): Promise<CodeHostReviewResultOk>
}

export interface CodeHostReviewOutboxDeps {
  cp: () => CodeHostReviewControlPlane | undefined
  /** The STABLE daemon identity owed frames are recovered under — never a process incarnation. */
  daemonId: () => string | undefined
  store: ReviewIntentStore
  log: { warn: (message: string) => void }
  /** Timer seam for the owed-frame resweep; tests drive it, production uses real timers. */
  scheduler?: PosterScheduler
  resweepBaseMs?: number
  resweepCapMs?: number
  now?: () => number
}

const DEFAULT_RESWEEP_BASE_MS = 30_000
const DEFAULT_RESWEEP_CAP_MS = 300_000
/** Pages of owed frames one sweep drains; the store answers a bounded page at a time. */
const MAX_SWEEP_PAGES = 50

export class CodeHostReviewOutbox {
  private readonly now: () => number
  private readonly sched: PosterScheduler
  /** Owed frames whose durable write has not landed yet; replayed and re-written from here. */
  private readonly unwritten = new Map<string, ReviewIntentRow>()
  private resweepHandle?: unknown
  private resweepAttempt = 0
  /** Monotonic count of arm REQUESTS, so a zero-work disarm can tell whether it raced new work. */
  private armGeneration = 0
  private sweeping = false
  private stopped = false

  constructor(private readonly deps: CodeHostReviewOutboxDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
  }

  /** Drop the pending resweep so a shutting-down daemon leaves no timer behind. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  /** Owe one frame; true once it is durably recorded or answered, else the caller keeps its upstream record as the only replay source (§15.1). */
  async owe(row: ReviewIntentRow): Promise<boolean> {
    const durable = await this.persistIntent(row)
    if (!durable) this.unwritten.set(row.intentId, row)
    const cp = this.deps.cp()
    const answer = cp ? await this.deliver(cp, row) : 'retry'
    if (answer === 'retry') {
      this.arm()
      return durable
    }
    await this.forget(row.intentId)
    return true
  }

  /** Bounded local-write retry; false means the row is only in memory for now. */
  private async persistIntent(row: ReviewIntentRow): Promise<boolean> {
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        await this.deps.store.recordReviewIntent(row, this.now())
        this.unwritten.delete(row.intentId)
        return true
      } catch (err) {
        if (tries === 2) {
          this.warn(`codehost review: owed frame write deferred (${err instanceof Error ? err.message : err})`)
        }
      }
    }
    return false
  }

  /** Send one owed frame verbatim. `retry` keeps it; anything else is finished with. */
  private async deliver(cp: CodeHostReviewControlPlane, row: ReviewIntentRow): Promise<'sent' | 'retry' | 'refused'> {
    try {
      if (row.kind === 'operation') await cp.operate(JSON.parse(row.frame) as CodeHostReviewOpRequest, row.orgId)
      else await cp.report(JSON.parse(row.frame) as CodeHostReviewResultReport, row.orgId)
      return 'sent'
    } catch (err) {
      // A control plane that answered `retryable: false` has decided; replaying cannot change it.
      const permanent = (err as { retryable?: unknown }).retryable === false
      this.warn(
        `codehost review: owed ${row.kind} frame ${permanent ? 'refused' : 'deferred'} (${err instanceof Error ? err.message : err})`
      )
      return permanent ? 'refused' : 'retry'
    }
  }

  private async forget(intentId: string): Promise<void> {
    this.unwritten.delete(intentId)
    try {
      await this.deps.store.clearReviewIntent(intentId)
    } catch (err) {
      // The frame is delivered; a stale row only costs one idempotent replay later.
      this.warn(`codehost review: owed frame could not be cleared (${err instanceof Error ? err.message : err})`)
    }
  }

  /** Replay everything this daemon identity still owes (§15.1): at startup, on reconnect, and re-armed on backoff while anything remains. */
  async reconcilePending(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    // Read BEFORE the scan: work that arms after this point owns the timer, not this sweep.
    const armedThrough = this.armGeneration
    try {
      const remaining = await this.sweepOnce()
      if (remaining === undefined || remaining > 0) this.arm()
      else this.disarm(armedThrough)
    } finally {
      this.sweeping = false
    }
  }

  /** One pass over the owed frames, draining pages until none is new; returns the count still outstanding, or undefined. */
  private async sweepOnce(): Promise<number | undefined> {
    const daemonId = this.deps.daemonId()
    // Before the control plane adopts an id there is no identity to recover rows under.
    if (!daemonId) return 0
    const cp = this.deps.cp()
    if (!cp) return undefined
    const seen = new Set<string>()
    let outstanding = 0
    let unreadable = false
    // Hitting the cap proves nothing about what is left, so the sweep stays armed.
    let capped = true
    for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
      let rows: ReviewIntentRow[]
      try {
        rows = await this.deps.store.listReviewIntents(daemonId)
      } catch (err) {
        this.warn(`codehost review: owed frame scan failed (${err instanceof Error ? err.message : err})`)
        unreadable = true
        break
      }
      const fresh = rows.filter((row) => !seen.has(row.intentId))
      if (fresh.length === 0) {
        capped = false
        break
      }
      for (const row of fresh) {
        seen.add(row.intentId)
        outstanding += await this.replay(cp, row)
      }
    }
    // Frames whose durable write never landed live only here; they are owed all the same.
    for (const row of [...this.unwritten.values()]) {
      if (seen.has(row.intentId)) continue
      seen.add(row.intentId)
      await this.persistIntent(row)
      outstanding += await this.replay(cp, row)
    }
    return unreadable || capped ? undefined : outstanding
  }

  /** Deliver one owed frame; 1 when it is still owed afterwards, 0 when it is finished with. */
  private async replay(cp: CodeHostReviewControlPlane, row: ReviewIntentRow): Promise<number> {
    const answer = await this.deliver(cp, row)
    if (answer !== 'retry') {
      await this.forget(row.intentId)
      return 0
    }
    const next = { ...row, attempts: row.attempts + 1 }
    if (this.unwritten.has(row.intentId)) this.unwritten.set(row.intentId, next)
    await this.deps.store.recordReviewIntent(next, this.now()).catch(() => undefined)
    return 1
  }

  /** Arm the next resweep on exponential backoff, capped. An armed timer is never restarted early. */
  arm(): void {
    if (this.stopped) return
    this.armGeneration += 1
    if (this.resweepHandle !== undefined) return
    const base = this.deps.resweepBaseMs ?? DEFAULT_RESWEEP_BASE_MS
    const cap = this.deps.resweepCapMs ?? DEFAULT_RESWEEP_CAP_MS
    const delay = Math.min(base * 2 ** Math.min(this.resweepAttempt, 16), cap)
    this.resweepAttempt += 1
    try {
      this.resweepHandle = this.sched.setTimeout(() => {
        this.resweepHandle = undefined
        void this.reconcilePending()
      }, delay)
    } catch (err) {
      this.warn(`codehost review: resweep scheduling failed (${err instanceof Error ? err.message : err})`)
    }
  }

  /** Go quiet — but only if nothing armed after the sweep that decided there was no work left. */
  private disarm(armedThrough: number): void {
    if (this.armGeneration !== armedThrough) return
    this.resweepAttempt = 0
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.resweepHandle === undefined) return
    try {
      this.sched.clearTimeout(this.resweepHandle)
    } catch {
      // A failed clear only leaves a sweep that finds nothing to do.
    }
    this.resweepHandle = undefined
  }

  private warn(message: string): void {
    try {
      this.deps.log.warn(message)
    } catch {
      // A broken logger must not break a settlement path.
    }
  }
}
