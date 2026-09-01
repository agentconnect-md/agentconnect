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
 *  - REVOKE only when NO organization's Bot holds the identity. The same app + workspace backs the
 *    winner's live install, so a loser-initiated revoke would tear it down.
 *
 * The grace window is what keeps the sweep off a callback in flight: a row younger than it may be
 * seconds away from its create tail, so it is never a candidate.
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
    for (const { identity, claimedElsewhere } of orphans) {
      try {
        // Revoke FIRST — the access token it needs lives in the row this is about to delete.
        if (!claimedElsewhere) await this.deps.service.revoke(identity)
        await this.deps.tokens.delete(identity)
        this.deps.log?.info(
          { orgId: identity.orgId, organizationId: identity.organizationId, revoked: !claimedElsewhere },
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
