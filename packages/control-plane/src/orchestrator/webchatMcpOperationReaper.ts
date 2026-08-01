import type { Clock, TimerHandle } from '../domain/clock.js'
import type { WebchatMcpOperationRepo, WebchatMcpDelegationRepo } from '../persistence/ports.js'
import type { WebchatMcpMetrics } from '../observability/webchat-mcp.js'

export const WEBCHAT_MCP_OPERATION_REAP_INTERVAL_MS = 30_000

interface ReaperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/**
 * Recovers attempt-fenced operations, then removes expired delegation rows only
 * after their dependent operation ledger permits it.
 */
export class WebchatMcpOperationReaper {
  private timer: TimerHandle | undefined
  private loopEnabled = false
  private shutdownRequested = false
  private activeTick: Promise<void> | undefined

  constructor(
    private readonly operations: Pick<WebchatMcpOperationRepo, 'reap'>,
    private readonly delegations: Pick<WebchatMcpDelegationRepo, 'reapExpired'>,
    private readonly clock: Clock,
    private readonly log?: ReaperLog,
    private readonly metrics?: Pick<WebchatMcpMetrics, 'delegation' | 'assertion' | 'invocation'>
  ) {}

  start(): void {
    this.loopEnabled = true
    this.shutdownRequested = false
    this.arm()
  }

  stop(): void {
    this.loopEnabled = false
    this.shutdownRequested = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Stop scheduling, cancel work between repository phases, and await the one active DB call. */
  async stopAndSettle(): Promise<void> {
    this.stop()
    await this.activeTick
  }

  private arm(): void {
    if (!this.loopEnabled || this.shutdownRequested) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), WEBCHAT_MCP_OPERATION_REAP_INTERVAL_MS)
  }

  tick(): Promise<void> {
    if (this.activeTick) return this.activeTick
    if (this.shutdownRequested) return Promise.resolve()
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    const active = this.runTick()
    this.activeTick = active
    void active.then(() => {
      if (this.activeTick === active) this.activeTick = undefined
    })
    return active
  }

  private async runTick(): Promise<void> {
    try {
      const now = new Date(this.clock.now())
      const operationResult = await this.operations.reap(now)
      this.observe(() => this.metrics?.invocation('ambiguous', operationResult.markedAmbiguous))
      if (this.shutdownRequested) return
      const delegationResult = await this.delegations.reapExpired(now)
      if (delegationResult.expired > 0) {
        this.observe(() => this.metrics?.delegation('expired', undefined, delegationResult.expired))
      }
      if (
        operationResult.markedAmbiguous > 0 ||
        operationResult.markedStale > 0 ||
        operationResult.evictedResponses > 0 ||
        delegationResult.deleted > 0
      ) {
        this.log?.info(
          { ...operationResult, deletedDelegations: delegationResult.deleted, at: now.toISOString() },
          'delegated MCP operation reaper converged durable authority'
        )
      }
    } catch (err) {
      this.log?.error({ err }, 'delegated MCP operation reaper failed')
    } finally {
      this.arm()
    }
  }

  private observe(fn: () => void): void {
    try {
      fn()
    } catch {
      // Reaping and scheduling never depend on metrics.
    }
  }
}
