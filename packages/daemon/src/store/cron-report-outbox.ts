// A CP cron run's terminal outcome is persisted before it is sent and released only on the CP's ACK, so a disconnect cannot lose it (high-availability.md).
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { CronReport } from '@agentconnect.md/protocol'
import type { CpClient } from '../cp/client.js'
import { formatErr } from '../daemon/text.js'
import type { LocalStore } from './local-store.js'

/** Retry cadence after a retryable failure on a live link; a reconnect drains at once. */
const CRON_REPORT_RETRY_MS = 5_000
/** Rows read per pass; a drain re-reads until the outbox is empty. */
const CRON_REPORT_BATCH = 50

/** Exactly what the outbox touches on the Daemon. */
export interface CronReportOutboxHost {
  store(): LocalStore
  cpClient(): CpClient | undefined
  clock(): Clock
  /** The agents whose rows this member sends from a shared pool store. */
  servedAgentIds(): string[]
  draining(): boolean
  warn(message: string): void
  debug(message: string): void
}

export class CronReportOutbox {
  private drain?: Promise<void>
  private drainAgain = false
  private retryTimer?: TimerHandle
  private failing = false

  constructor(private readonly host: CronReportOutboxHost) {}

  /** Persist a terminal outcome, then send it; only the CP's ACK releases the row. */
  async record(report: CronReport): Promise<void> {
    try {
      await this.host.store().queueCronReport(report, this.host.clock().now())
    } catch (err) {
      // Without a durable row, the best-effort EVT is still better than dropping the outcome.
      this.host.warn(`cron report outbox persist failed (cron ${report.cronId}): ${formatErr(err)}`)
      this.host.cpClient()?.emitCronReport(report)
      return
    }
    await this.drainReports()
  }

  /** Start or join the sequential drain; one request at a time keeps a reconnect backlog off the CP's pool. */
  drainReports(): Promise<void> {
    if (this.drain) {
      this.drainAgain = true
      return this.drain
    }
    const cp = this.host.cpClient()
    if (this.host.draining() || !cp || (cp.state !== 'READY' && cp.state !== 'DRAINING')) return Promise.resolve()
    const drain = this.runDrain(cp).finally(() => {
      this.drain = undefined
      // A row queued after the last read gets one more pass instead of waiting for the next trigger.
      if (this.drainAgain) {
        this.drainAgain = false
        void this.drainReports()
      }
    })
    this.drain = drain
    return drain
  }

  /** The in-flight drain, joined by the daemon's shutdown path. */
  inFlightDrain(): Promise<void> | undefined {
    return this.drain
  }

  /** Timer teardown for Daemon.stop(); the drain promise is joined separately. */
  dispose(): void {
    if (this.retryTimer !== undefined) {
      this.host.clock().clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private async runDrain(cp: CpClient): Promise<void> {
    const store = this.host.store()
    while (!this.host.draining() && (cp.state === 'READY' || cp.state === 'DRAINING')) {
      let rows
      try {
        rows = await store.pendingCronReports(CRON_REPORT_BATCH, this.host.servedAgentIds())
      } catch (err) {
        this.host.warn(`cron report outbox read failed: ${formatErr(err)}`)
        this.scheduleRetry()
        return
      }
      if (rows.length === 0) return
      for (const row of rows) {
        const report = parseReport(row.report)
        try {
          if (!report) this.host.warn(`cron report outbox dropped an unreadable outcome for cron ${row.cronId}`)
          // An older CP cannot ACK: it gets the best-effort EVT once, as before this outbox.
          else if ((await cp.syncCronReport(report)) === 'unsupported') cp.emitCronReport(report)
          this.failing = false
        } catch (err) {
          const permanent = typeof err === 'object' && err !== null && 'retryable' in err && err.retryable === false
          if (!permanent) {
            const message = `cron report for cron ${row.cronId} retained for retry (${formatErr(err)})`
            if (this.failing) this.host.debug(message)
            else this.host.warn(message)
            this.failing = true
            this.scheduleRetry()
            return
          }
          this.host.warn(`cron report for cron ${row.cronId} permanently rejected (${formatErr(err)})`)
        }
        try {
          await store.acknowledgeCronReport(row.agentId, row.cronId, row.firedAt)
        } catch (err) {
          // Keeping an ACKed row only re-sends it; the CP's upsert is keyed on (cronId, firedAt).
          this.host.warn(`cron report outbox cleanup failed for cron ${row.cronId}: ${formatErr(err)}`)
          this.scheduleRetry()
          return
        }
      }
    }
  }

  private scheduleRetry(): void {
    if (this.host.draining() || this.retryTimer !== undefined) return
    this.retryTimer = this.host.clock().setTimeout(() => {
      this.retryTimer = undefined
      void this.drainReports()
    }, CRON_REPORT_RETRY_MS)
  }
}

// The row holds what this daemon serialized; the CP's decoder is what validates the shape.
function parseReport(text: string): CronReport | undefined {
  try {
    return JSON.parse(text) as CronReport
  } catch {
    return undefined
  }
}
