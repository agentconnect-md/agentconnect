import { metrics } from '@opentelemetry/api'

export type DelegatedIsolationEvent = 'created' | 'resumed' | 'destroyed' | 'failed'
export type DelegatedIsolationFailureReason = 'cell_creation' | 'host_start' | 'cleanup' | 'broker_registration'
export type DelegatedIsolationDenialReason =
  'broker_validation' | 'fence' | 'capacity' | 'token_mismatch' | 'capability_probe_failed'
export type DelegatedMcpRequestStage = 'mint_ws' | 'mcp_http'
export type DelegatedMcpRequestOutcome = 'succeeded' | 'failed'

interface CounterInstrument {
  add(value: number, attributes?: Record<string, string>): void
}

interface HistogramInstrument {
  record(value: number, attributes?: Record<string, string>): void
}

/** Injection seam for deterministic tests and alternative metric exporters. */
export interface DelegatedMcpMetricInstruments {
  isolation: CounterInstrument
  denial: CounterInstrument
  duration: HistogramInstrument
}

/** Identifier-free, low-cardinality metrics for the private MCP broker. */
export interface DelegatedMcpMetrics {
  isolation(event: DelegatedIsolationEvent, reason?: DelegatedIsolationFailureReason, count?: number): void
  denied(reason: DelegatedIsolationDenialReason, count?: number): void
  requestDuration(stage: DelegatedMcpRequestStage, durationMs: number, outcome: DelegatedMcpRequestOutcome): void
}

const meter = metrics.getMeter('@agentconnect.md/daemon-delegated-mcp', '1.0.0')

const defaultInstruments: DelegatedMcpMetricInstruments = {
  isolation: meter.createCounter('agentconnect.delegated_mcp.isolation.transitions', {
    unit: '{transition}',
    description: 'Conversation-private MCP isolation-cell transitions'
  }),
  denial: meter.createCounter('agentconnect.delegated_mcp.isolation.denials', {
    unit: '{denial}',
    description: 'Conversation-private MCP isolation denials'
  }),
  duration: meter.createHistogram('agentconnect.delegated_mcp.request.duration', {
    unit: 'ms',
    description: 'Delegated MCP assertion-mint and HTTP latency'
  })
}

function safeObserve(observe: () => void): void {
  try {
    observe()
  } catch {
    // Exporter failures never participate in broker serving or cleanup.
  }
}

function safeCount(count: number | undefined): number {
  return Number.isSafeInteger(count) && count! > 0 ? count! : 1
}

function isEmptyCount(count: number | undefined): boolean {
  return count !== undefined && Number.isFinite(count) && count <= 0
}

function safeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
}

export function createDelegatedMcpMetrics(
  instruments: DelegatedMcpMetricInstruments = defaultInstruments
): DelegatedMcpMetrics {
  return {
    isolation(event, reason, count) {
      if (isEmptyCount(count)) return
      safeObserve(() =>
        instruments.isolation.add(safeCount(count), event === 'failed' && reason ? { event, reason } : { event })
      )
    },
    denied(reason, count) {
      if (isEmptyCount(count)) return
      safeObserve(() => instruments.denial.add(safeCount(count), { reason }))
    },
    requestDuration(stage, durationMs, outcome) {
      safeObserve(() => instruments.duration.record(safeDuration(durationMs), { stage, outcome }))
    }
  }
}

export const defaultDelegatedMcpMetrics = createDelegatedMcpMetrics()
