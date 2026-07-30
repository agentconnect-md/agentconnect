import type { Clock, TimerHandle } from '../domain/clock.js'
import type { McpInvocationRepo, WebchatMcpDelegationRepo } from '../persistence/ports.js'

export { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../domain/mcp-invocation.js'

/** Short enough to recover expired 30-second assertions without a hot loop. */
export const MCP_INVOCATION_REAP_INTERVAL_MS = 30_000

interface ReaperLog {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/**
 * Recovers the durable invocation state machine, then removes delegation rows
 * only after their dependent invocation ledger has become reapable.
 */
export class McpInvocationReaper {
  private timer: TimerHandle | undefined
  private stopped = true

  constructor(
    private readonly invocations: Pick<McpInvocationRepo, 'reap'>,
    private readonly delegations: Pick<WebchatMcpDelegationRepo, 'reapExpired'>,
    private readonly clock: Clock,
    private readonly log?: ReaperLog
  ) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), MCP_INVOCATION_REAP_INTERVAL_MS)
  }

  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const now = new Date(this.clock.now())
      const invocationResult = await this.invocations.reap(now)
      const deletedDelegations = await this.delegations.reapExpired(now)
      if (invocationResult.markedAmbiguous > 0 || invocationResult.deleted > 0 || deletedDelegations > 0) {
        this.log?.info(
          { ...invocationResult, deletedDelegations, at: now.toISOString() },
          'delegated MCP invocation reaper converged durable authority'
        )
      }
    } catch (err) {
      this.log?.error({ err }, 'delegated MCP invocation reaper failed')
    } finally {
      this.arm()
    }
  }
}
