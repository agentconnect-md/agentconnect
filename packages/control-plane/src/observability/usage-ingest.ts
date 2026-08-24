/**
 * `observability/usage-ingest.ts` — the usage path's counters: one for the write path,
 * one for a read that failed its own arithmetic.
 *
 * A cumulative checkpoint only ever moves forward. When a late retry arrives carrying
 * LOWER counters than the checkpoint already stored at that instant, the store ignores
 * it — silently, as far as the caller is concerned, because the caller is a collector
 * replaying a batch and there is nothing for it to do differently. This counter is how
 * that shows up in operations: a rising `ignored` rate means an upstream is reporting
 * a cumulative that went backwards, which is a metering bug worth chasing.
 */
import { metrics } from '@opentelemetry/api'
import type { UsageSource } from '../persistence/ports.js'

const meter = metrics.getMeter('@agentconnect.md/control-plane-usage', '1.0.0')

const checkpointRegressions = meter.createCounter('agentconnect.usage.checkpoint.regressions', {
  unit: '{report}',
  description: 'Usage checkpoints ignored because the reported cumulative went backwards'
})

/** Count one ignored regressive checkpoint. Never throws into the write path. */
export function countCheckpointRegression(source: UsageSource): void {
  try {
    checkpointRegressions.add(1, { source })
  } catch {
    // A metrics exporter never participates in whether usage is stored.
  }
}

const attributionDrift = meter.createCounter('agentconnect.usage.attribution.drift', {
  unit: '{aggregate}',
  description: 'Usage aggregates whose per-agent rollup plus residual did not equal the totals'
})

/** Count one aggregate that failed its attribution invariant. The caller throws right
 *  after, so this exists to make a bug that only reproduces in production visible
 *  without waiting for someone to reconcile a dashboard against an invoice. */
export function countUsageAttributionDrift(): void {
  try {
    attributionDrift.add(1)
  } catch {
    // A metrics exporter never decides whether the caller reports the failure.
  }
}
