/**
 * `McpOauthRefresher` — the sweep that keeps a relay binding's OAuth credential fresh, and
 * the reaper that bounds how long an abandoned funnel's sealed verifier lingers.
 *
 * A relay binding only changes when the CP pushes it, so an access token inside one goes
 * stale on its own clock. This loop renews before expiry and re-pushes, which is the whole
 * reason `auth: oauth2` works at all. It also fixes the CP's outage window honestly: while
 * the CP is up, an OAuth provider never serves an expired token; while it is down, one
 * expires after its remaining lifetime and the relay's containment turns the failure into
 * an opaque 502. That is the documented cost of the design, not a bug to hide.
 *
 * TWO ordering rules, and skipping either is a real defect rather than a race to shrug at:
 *
 *  - The NETWORK refresh happens OUTSIDE the provider's serialization chain. An upstream
 *    round-trip takes real time, and holding a `(orgId, name)` chain across it would block
 *    every CRUD operation on that provider for its duration.
 *  - The PUSH happens INSIDE that chain, and re-reads the provider row and its active grants
 *    there. Without that, a push landing after a concurrent DELETE would RESURRECT a binding
 *    for a provider that no longer exists — callable pool-wide, with a live grant hash, and
 *    with nothing left that would ever unassign it. That is a revocation bypass, not a
 *    cosmetic ordering problem.
 *
 * Shape and lifecycle follow `gitlab/rotator.ts`: a self-rescheduling timer on the injected
 * Clock, built in the graph and armed only by `startBackground()`, so tests drive
 * `refreshDueConnections()` directly instead of waiting on wall time.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type {
  McpGrantRepo,
  McpProviderOauthRepo,
  McpProviderOauthStateStore,
  McpProviderRepo
} from '../persistence/ports.js'
import type { McpProviderTokenService } from './token-service.js'

/** Swept often enough to stay ahead of the shortest token lifetime worth accepting. */
export const SWEEP_INTERVAL_MS = 60_000
const FIRST_SWEEP_DELAY_MS = 15_000
/** Jitter keeps several CP restarts from lining their sweeps up on one authorization server. */
const SWEEP_JITTER_MS = 10_000
/** One sweep's ceiling — a backlog drains over several passes rather than in one burst. */
const SWEEP_BATCH = 50

export interface McpOauthRefresherDeps {
  providers: McpProviderRepo
  oauth: McpProviderOauthRepo
  grants: McpGrantRepo
  states: McpProviderOauthStateStore
  tokens: McpProviderTokenService
  /** Re-bind on the relay pool, already inside the provider's serialization chain. */
  pushBinding: (orgId: OrgId, providerId: string, providerName: string) => Promise<void>
  clock: Clock
  log?: { warn(obj: object, msg: string): void }
}

export class McpOauthRefresher {
  private timer: TimerHandle | null = null
  private stopped = false

  constructor(private readonly deps: McpOauthRefresherDeps) {}

  start(): void {
    this.stopped = false
    this.arm(FIRST_SWEEP_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      void this.sweep().finally(() => this.arm(SWEEP_INTERVAL_MS + Math.floor(Math.random() * SWEEP_JITTER_MS)))
    }, delayMs)
  }

  private async sweep(): Promise<void> {
    try {
      await this.deps.states.reapExpired(new Date(this.deps.clock.now()))
    } catch (err) {
      this.deps.log?.warn({ err }, 'mcp oauth: state reap failed')
    }
    try {
      await this.refreshDueConnections()
    } catch (err) {
      this.deps.log?.warn({ err }, 'mcp oauth: refresh sweep failed')
    }
  }

  /** One pass. Returns how many grants were renewed and re-pushed. */
  async refreshDueConnections(): Promise<number> {
    const due = await this.deps.oauth.dueForRefresh(new Date(this.deps.clock.now()), SWEEP_BATCH)
    let renewed = 0
    for (const row of due) {
      try {
        // Outside the chain on purpose: an upstream round-trip must not block this
        // provider's CRUD for its duration.
        const result = await this.deps.tokens.refresh(row.orgId, row.mcpProviderId)
        if (!result.ok || !result.rotated) continue
        await this.deps.pushBinding(row.orgId, row.mcpProviderId, row.providerName)
        renewed++
      } catch (err) {
        // One bad provider must not starve the rest of the sweep.
        this.deps.log?.warn({ providerId: row.mcpProviderId, err }, 'mcp oauth: refresh failed — skipped')
      }
    }
    return renewed
  }
}
