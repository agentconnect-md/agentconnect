import { metrics } from '@opentelemetry/api'

export type Mem0Operation = 'recall' | 'capture' | 'status' | 'list' | 'get' | 'create' | 'delete' | 'history'
export type Mem0Outcome =
  'ok' | 'auth' | 'rate_limited' | 'upstream_5xx' | 'upstream_rejected' | 'network' | 'protocol' | 'cancelled'

export interface Mem0Metrics {
  request(result: { operation: Mem0Operation; outcome: Mem0Outcome; durationMs: number }): void
}

/** Backward-compatible Cloud names; both adapters share the same body-free instruments. */
export type Mem0CloudOperation = Mem0Operation
export type Mem0CloudOutcome = Mem0Outcome
export type Mem0CloudMetrics = Mem0Metrics

const meter = metrics.getMeter('@agentconnect.md/memory-plugin-mem0', '1.0.0')
const requests = meter.createCounter('agentconnect.memory.mem0.requests', {
  unit: '{request}',
  description: 'Mem0 backend requests by body-free, low-cardinality outcome'
})
const duration = meter.createHistogram('agentconnect.memory.mem0.request.duration', {
  unit: 'ms',
  description: 'Mem0 backend request latency'
})

export const defaultMem0Metrics: Mem0Metrics = {
  request(result) {
    const attributes = { operation: result.operation, outcome: result.outcome }
    requests.add(1, attributes)
    duration.record(result.durationMs, attributes)
  }
}

export const defaultMem0CloudMetrics = defaultMem0Metrics
