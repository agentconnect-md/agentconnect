import { metrics } from '@opentelemetry/api'
import type { MemoryCaptureOutboxStats } from '../store/local-store.js'

/** Low-cardinality application metrics for the external-memory lifecycle. */
export interface MemoryPluginMetrics {
  recall(result: { durationMs: number; outcome: 'ok' | 'empty' | 'error'; resultCount: number }): void
  /** Exact bytes of the final trailing reference block appended to the prompt. */
  recallInjected(bytes: number): void
  captureState(
    state: 'completed' | 'accepted' | 'failed' | 'ambiguous' | 'retry',
    observation?: {
      /** Age of this durable operation at the transition. */
      ageMs?: number
      /** Batch transitions recovered/expired by one SQLite statement. */
      count?: number
      /** Fixed daemon-authored code only; never a plugin error string. */
      reason?:
        | 'plugin_completed'
        | 'plugin_failed'
        | 'plugin_ambiguous'
        | 'connection_revision_changed'
        | 'plugin_id_changed'
        | 'manifest_mismatch'
        | 'idempotency_changed'
        | 'retry_exhausted'
        | 'invalid_persisted_config'
        | 'capture_delivery_unknown'
        | 'accepted_without_backend_operation'
        | 'capture_retry'
        | 'restart_retry'
        | 'restart_after_send'
        | 'retention_expired'
    }
  ): void
  outbox(stats: MemoryCaptureOutboxStats, now: number): void
}

const meter = metrics.getMeter('@agentconnect.md/daemon-memory', '1.0.0')
const recallDuration = meter.createHistogram('agentconnect.memory.recall.duration', {
  unit: 'ms',
  description: 'External-memory recall latency'
})
const recallResults = meter.createHistogram('agentconnect.memory.recall.results', {
  unit: '{record}',
  description: 'Validated records returned by external-memory recall'
})
const recallBytes = meter.createHistogram('agentconnect.memory.recall.injected_bytes', {
  unit: 'By',
  description: 'Exact bytes of the external-memory reference block injected into a prompt'
})
const recallErrors = meter.createCounter('agentconnect.memory.recall.errors', {
  unit: '{error}',
  description: 'External-memory recall failures (body-free)'
})
const captureStates = meter.createCounter('agentconnect.memory.capture.transitions', {
  unit: '{transition}',
  description: 'External-memory capture terminal/accepted/retry transitions'
})
const captureAge = meter.createHistogram('agentconnect.memory.capture.operation_age', {
  unit: 'ms',
  description: 'Age of a durable external-memory capture at a state transition'
})
const outboxDepth = meter.createHistogram('agentconnect.memory.outbox.depth', {
  unit: '{operation}',
  description: 'Active external-memory capture operations'
})
const outboxBytes = meter.createHistogram('agentconnect.memory.outbox.bytes', {
  unit: 'By',
  description: 'Bounded turn payload bytes retained in the active capture outbox'
})
const outboxOldestAge = meter.createHistogram('agentconnect.memory.outbox.oldest_age', {
  unit: 'ms',
  description: 'Age of the oldest active external-memory capture operation'
})
const pluginLifecycle = meter.createCounter('agentconnect.memory.plugin.lifecycle', {
  unit: '{event}',
  description: 'Body-free memory-plugin conformance and local-process lifecycle events'
})

export type MemoryPluginLifecycleEvent =
  'manifest_mismatch' | 'stdio_restart_attempt' | 'stdio_restart_succeeded' | 'stdio_restart_failed'

export function recordMemoryPluginLifecycle(event: MemoryPluginLifecycleEvent): void {
  pluginLifecycle.add(1, { event })
}

export const defaultMemoryPluginMetrics: MemoryPluginMetrics = {
  recall(result) {
    const attributes = { outcome: result.outcome }
    recallDuration.record(result.durationMs, attributes)
    recallResults.record(result.resultCount, attributes)
    if (result.outcome === 'error') recallErrors.add(1)
  },
  recallInjected(bytes) {
    recallBytes.record(bytes)
  },
  captureState(state, observation) {
    const attributes = { state, reason: observation?.reason ?? 'none' }
    captureStates.add(observation?.count ?? 1, attributes)
    if (observation?.ageMs !== undefined) captureAge.record(observation.ageMs, attributes)
  },
  outbox(stats, now) {
    outboxDepth.record(stats.activeCount)
    outboxBytes.record(stats.activeBytes)
    outboxOldestAge.record(stats.oldestActiveAt === undefined ? 0 : Math.max(0, now - stats.oldestActiveAt))
  }
}
