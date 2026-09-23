// Delivers a platform connection's explicit credential revocations to the CP (`integration/revoked`), the daemon side of the relay's `rc/bot-revoked` queue.
import { WireError, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import type { IntegrationRevoked, IntegrationRevokedOk } from '@agentconnect.md/protocol'
import type { Logger } from '../log.js'

/** One explicit revocation a connection observed: why, when the platform says it happened, and the connection's own identity. */
export type CredentialRevocation = Pick<IntegrationRevoked, 'reason' | 'eventAtMs' | 'botUserId' | 'workspaceId'>

/** The slice of the CP client the reporter drives. */
export interface RevocationReportSink {
  connected(): boolean
  reportIntegrationRevoked(payload: IntegrationRevoked): Promise<IntegrationRevokedOk | 'unsupported'>
}

const RETRY_INITIAL_MS = 5_000
const RETRY_MAX_MS = 60_000

/** Keeps each integration's report until the CP commits a verdict: the platform never redelivers the event, so a lost report is a lost revocation. */
export class CredentialRevocationReporter {
  private readonly pending = new Map<string, CredentialRevocation>()
  private timer: TimerHandle | undefined
  private delayMs = RETRY_INITIAL_MS
  private flushRun: Promise<void> | undefined
  private again = false
  private stopped = false
  private unsupportedNoted = false

  constructor(
    private readonly deps: { cp: () => RevocationReportSink | undefined; clock: () => Clock; log: () => Logger }
  ) {}

  /** Queue a revocation for the integrations one connection serves, then try to deliver it. */
  report(integrationIds: readonly string[], revocation: CredentialRevocation): void {
    for (const id of integrationIds) {
      const queued = this.pending.get(id)
      // A later event passes every fence an earlier one does, so the newest per integration is the one to keep.
      if (!queued || queued.eventAtMs < revocation.eventAtMs) this.pending.set(id, revocation)
    }
    void this.flush()
  }

  /** Re-send what is still unacknowledged; wired to the CP's ready edge, where a fresh link also resets the backoff. */
  replay(): Promise<void> {
    this.delayMs = RETRY_INITIAL_MS
    return this.flush()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clock().clearTimeout(this.timer)
    this.timer = undefined
  }

  /** One pass at a time; a call during a pass joins it and makes it go round once more. */
  private flush(): Promise<void> {
    if (this.flushRun) {
      this.again = true
      return this.flushRun
    }
    this.flushRun = (async () => {
      try {
        do {
          this.again = false
          await this.sendPending()
        } while (this.again)
      } finally {
        this.flushRun = undefined
      }
    })()
    return this.flushRun
  }

  private async sendPending(): Promise<void> {
    const cp = this.deps.cp()
    if (this.stopped || this.pending.size === 0 || !cp?.connected()) return
    // One frame per observed event: every integration of the connection shares that event's revocation object.
    const batches = new Map<CredentialRevocation, string[]>()
    for (const [id, revocation] of this.pending) batches.set(revocation, [...(batches.get(revocation) ?? []), id])
    const log = this.deps.log()
    let retry = false
    for (const [revocation, integrationIds] of batches) {
      try {
        const verdict = await cp.reportIntegrationRevoked({ integrationIds, ...revocation })
        if (verdict === 'unsupported') {
          // An older CP would refuse the frame: keep the report for a CP that understands it.
          if (!this.unsupportedNoted) log.info('platform: the control plane does not take revocation reports yet')
          this.unsupportedNoted = true
          continue
        }
        this.settle(integrationIds, revocation)
        log.info(`platform: credential revocation ${verdict.applied ? 'applied' : 'refused'} by the control plane`)
      } catch (err) {
        if (err instanceof WireError && !err.retryable) {
          this.settle(integrationIds, revocation)
          log.warn(`platform: credential revocation rejected (${err.code})`)
          continue
        }
        retry = true
        log.warn(`platform: credential revocation unacknowledged: ${(err as Error).message}`)
      }
    }
    if (retry) this.arm()
    else if (this.pending.size === 0) this.delayMs = RETRY_INITIAL_MS
  }

  /** Clear only entries that are still exactly the report the verdict answers; a newer one queued meanwhile stays. */
  private settle(integrationIds: readonly string[], revocation: CredentialRevocation): void {
    for (const id of integrationIds) if (this.pending.get(id) === revocation) this.pending.delete(id)
  }

  private arm(): void {
    if (this.timer !== undefined || this.stopped) return
    const delay = this.delayMs
    this.delayMs = Math.min(this.delayMs * 2, RETRY_MAX_MS)
    this.timer = this.deps.clock().setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
  }
}
