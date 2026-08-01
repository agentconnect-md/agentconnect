import { metrics } from '@opentelemetry/api'
import type { ContextCompleteness } from './thread-context.js'

type Platform = string
type RefreshPhase = 'start' | 'final'

export interface TurnOutputMetrics {
  refresh(input: {
    platform: Platform
    phase: RefreshPhase
    completeness: ContextCompleteness
    result: 'ok' | 'degraded'
    durationMs: number
  }): void
  events(platform: Platform, source: 'provider' | 'observed', count: number): void
  regeneration(platform: Platform, outcome: 'started' | 'accepted' | 'failed'): void
  generations(count: number): void
  candidateDiscarded(reason: 'context_changed' | 'context_churn' | 'interrupted' | 'failed'): void
  queueCoalesced(platform: Platform, count: number): void
  contextChurnExhausted(platform: Platform): void
}

const meter = metrics.getMeter('@agentconnect.md/daemon-turn-output', '1.0.0')
const contextRefresh = meter.createCounter('turn_context_refresh_total')
const contextEvents = meter.createCounter('turn_context_events_total')
const regeneration = meter.createCounter('turn_regeneration_total')
const generations = meter.createHistogram('turn_regeneration_generations', { unit: '{generation}' })
const candidateDiscarded = meter.createCounter('turn_candidate_discarded_total')
const snapshotDuration = meter.createHistogram('turn_context_snapshot_duration_ms', { unit: 'ms' })
const queueCoalesced = meter.createCounter('turn_queue_coalesced_total')
const churnExhausted = meter.createCounter('turn_context_churn_exhausted_total')

export const defaultTurnOutputMetrics: TurnOutputMetrics = {
  refresh(input) {
    const attributes = {
      platform: input.platform,
      phase: input.phase,
      completeness: input.completeness,
      result: input.result
    }
    contextRefresh.add(1, attributes)
    snapshotDuration.record(input.durationMs, attributes)
  },
  events(platform, source, count) {
    if (count > 0) contextEvents.add(count, { platform, source })
  },
  regeneration(platform, outcome) {
    regeneration.add(1, { platform, outcome })
  },
  generations(count) {
    generations.record(count)
  },
  candidateDiscarded(reason) {
    candidateDiscarded.add(1, { reason })
  },
  queueCoalesced(platform, count) {
    if (count > 0) queueCoalesced.add(count, { platform })
  },
  contextChurnExhausted(platform) {
    churnExhausted.add(1, { platform })
  }
}
