import { metrics } from '@opentelemetry/api'

/** Fixed-enum labels only: never message ids, channel names, or agent ids. */
export interface DecisionGateMetrics {
  verdict(disposition: 'match' | 'skip' | 'unavailable', reason: string): void
  finished(state: 'admitted' | 'canceled' | 'skipped', reason: string): void
  capacity(scope: string): void
  tokens(direction: 'input' | 'output', count: number): void
  latency(disposition: 'match' | 'skip' | 'unavailable', ms: number): void
}

const meter = metrics.getMeter('@agentconnect.md/daemon-decision-gate', '1.0.0')
const verdicts = meter.createCounter('decision_gate_verdicts_total')
const finished = meter.createCounter('decision_gate_finished_total')
const capacity = meter.createCounter('decision_gate_capacity_total')
const tokens = meter.createCounter('decision_gate_tokens_total')
const latency = meter.createHistogram('decision_gate_latency_ms', { unit: 'ms' })

export const defaultDecisionGateMetrics: DecisionGateMetrics = {
  verdict(disposition, reason) {
    verdicts.add(1, { disposition, reason })
  },
  finished(state, reason) {
    finished.add(1, { state, reason })
  },
  capacity(scope) {
    capacity.add(1, { scope })
  },
  tokens(direction, count) {
    if (count > 0) tokens.add(count, { direction })
  },
  latency(disposition, ms) {
    latency.record(ms, { disposition })
  }
}
