/**
 * The orphan-token sweeper (docs/designs/linear-integration.md §7.1) — the provider's one
 * `backgroundLoops` entry.
 *
 * A `linear_token` row is written BEFORE the Bot exists, so a create tail that refuses after step 1
 * (D6 identity taken, workspace claimed elsewhere) leaves a row holding an encrypted refresh token
 * with no Bot FK for the §7.4 disconnect path to find. Nothing else would ever collect it. This
 * loop is that collector, and the backstop for a best-effort `onBotDelete` that failed.
 *
 * The two questions it asks are deliberately at DIFFERENT scopes, because the identity fences are
 * global while token rows are org-scoped:
 *
 *  - SELECT org-scoped — a row is an orphan when its OWN organization has no Bot for the identity.
 *    The cross-org loser must be sweepable even though the winner's Bot is very much alive.
 *  - DELETE unconditionally — the row is dead weight in its organization either way.
 *  - REVOKE only when NO organization relies on this app's authorization of this workspace. The
 *    same app + workspace backs the winner's live install, so a loser-initiated revoke would tear
 *    it down. This one is decided UNDER AN ADVISORY LOCK at the moment of acting, never carried
 *    down from the selection: it is the only question here whose answer another organization can
 *    falsify without touching a single row this sweep looked at.
 *
 * The grace window keeps the sweep off a callback in flight: a row younger than it may be seconds
 * away from its create tail, so it is never a candidate. The window is a heuristic, though, not a
 * lock — a retry can re-grant a long-stale identity at any moment — so every row is additionally
 * CLAIMED against the snapshot it was selected under before anything irreversible happens to it.
 */
import type { LinearTokenStore } from '../../persistence/ports.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { Clock, TimerHandle } from '../../domain/clock.js'
import type { CpBackgroundLoop } from '../provider.js'
import type { LinearTokenService } from './token-service.js'

/** Long enough that a callback can never be swept between §7.1's steps 1 and 2. */
export const LINEAR_ORPHAN_GRACE_MS = 60 * 60 * 1000
export const LINEAR_ORPHAN_SWEEP_INTERVAL_MS = 15 * 60 * 1000
/** Rows per pass — a bound on one tick's upstream calls, not on eventual convergence. */
const SWEEP_BATCH = 100

export interface LinearOrphanTokenSweeperDeps {
  /** Read per tick: the platform self-disables with no deployment app, and so does this loop. */
  readonly app?: LinearPlatformAppConfig
  tokens: LinearTokenStore
  service: LinearTokenService
  clock: Clock
  graceMs?: number
  intervalMs?: number
  log?: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
}

export class LinearOrphanTokenSweeper implements CpBackgroundLoop {
  readonly label = 'linear-orphan-token'
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false

  constructor(private readonly deps: LinearOrphanTokenSweeperDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** One best-effort pass. Exposed so tests drive it without arming a timer. */
  async tick(): Promise<void> {
    if (this.running) return
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.running = true
    try {
      const app = this.deps.app
      if (app) await this.sweep(app)
    } catch (err) {
      this.deps.log?.warn({ err }, 'linear-orphan-token: sweep failed')
    } finally {
      this.running = false
      this.arm()
    }
  }

  private async sweep(app: LinearPlatformAppConfig): Promise<void> {
    const staleBefore = new Date(this.deps.clock.now() - (this.deps.graceMs ?? LINEAR_ORPHAN_GRACE_MS))
    const orphans = await this.deps.tokens.listOrphans(app.clientId, staleBefore, SWEEP_BATCH)
    for (const { identity, updatedAt } of orphans) {
      try {
        // CLAIM BEFORE ACTING. A retried connect can re-grant this identity between the snapshot
        // above and this line — §7.1's step-1 upsert is exactly that write — and the sweep must not
        // then revoke the FRESH token upstream or delete the row that now backs a live install. The
        // guarded delete serializes against that `put` on the row, so either it removes precisely
        // the grant it selected (and returns it), or it removes nothing and this candidate is
        // simply skipped; the next pass re-evaluates it from scratch.
        const removed = await this.deps.tokens.deleteIfUnchanged(identity, updatedAt)
        if (!removed) continue
        // The row is gone — correct either way, it was dead weight in its own organization. The
        // REVOKE is the irreversible half, and its question is global: revoking acts on the
        // app↔workspace grant, so it must be decided against other organizations' state, not this
        // row's. That answer cannot be carried down from the listing — a different organization can
        // complete a connect for this same workspace without touching anything the guarded delete
        // above looks at — so it is re-asked durably, under the identity's advisory lock, with the
        // revoke itself inside that lock. Releasing first would only narrow the window: a winner
        // admitted in between still loses the grant it just obtained.
        const revoked = await this.deps.tokens.withIdentityOwnership(identity, async (owned) => {
          if (owned) return false
          return this.deps.service.revokeAccessToken(removed.accessToken, identity)
        })
        this.deps.log?.info(
          { orgId: identity.orgId, organizationId: identity.organizationId, revoked },
          'linear-orphan-token: collected a grant no bot references'
        )
      } catch (err) {
        this.deps.log?.warn({ err, orgId: identity.orgId }, 'linear-orphan-token: row sweep failed')
      }
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(
      () => void this.tick(),
      this.deps.intervalMs ?? LINEAR_ORPHAN_SWEEP_INTERVAL_MS
    )
  }
}
