/**
 * `observability/usage-ingest.ts` — one counter for the usage write path.
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
