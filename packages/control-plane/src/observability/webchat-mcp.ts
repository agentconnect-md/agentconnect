import { metrics } from '@opentelemetry/api'
import type { InvocationAssertionDenialReason } from '../http/mcp/invocation-authenticator.js'
import type { DelegationDenialReason } from '../registry/webchatMcpDelegationService.js'

export type DelegationMetricEvent = 'established' | 'reused' | 'rotated' | 'expired' | 'denied'
export type AssertionMetricEvent = 'minted' | 'claimed' | 'expired' | 'replayed' | 'conflicted' | 'denied'
export type InvocationMetricOutcome = 'succeeded' | 'failed' | 'in_progress_retry' | 'ambiguous'
export type ControlPlaneMcpRequestStage = 'nested_rest' | 'mcp_http'
export type ControlPlaneMcpRequestOutcome = 'succeeded' | 'failed'

interface CounterInstrument {
  add(value: number, attributes?: Record<string, string>): void
}

interface HistogramInstrument {
  record(value: number, attributes?: Record<string, string>): void
}

/** Injection seam for deterministic tests and alternative metric exporters. */
export interface WebchatMcpMetricInstruments {
  delegation: CounterInstrument
  assertion: CounterInstrument
  invocation: CounterInstrument
  duration: HistogramInstrument
}

/** Body-free, low-cardinality metrics for delegated webchat MCP authority. */
export interface WebchatMcpMetrics {
  delegation(event: DelegationMetricEvent, reason?: DelegationDenialReason, count?: number): void
  assertion(event: AssertionMetricEvent, reason?: InvocationAssertionDenialReason, count?: number): void
  invocation(outcome: InvocationMetricOutcome, count?: number): void
  requestDuration(stage: ControlPlaneMcpRequestStage, durationMs: number, outcome: ControlPlaneMcpRequestOutcome): void
}

const meter = metrics.getMeter('@agentconnect.md/control-plane-webchat-mcp', '1.0.0')

const defaultInstruments: WebchatMcpMetricInstruments = {
  delegation: meter.createCounter('agentconnect.webchat_mcp.delegation.transitions', {
    unit: '{transition}',
    description: 'Delegated webchat MCP authority transitions'
  }),
  assertion: meter.createCounter('agentconnect.webchat_mcp.assertion.transitions', {
    unit: '{transition}',
    description: 'One-time delegated MCP assertion transitions'
  }),
  invocation: meter.createCounter('agentconnect.webchat_mcp.invocation.transitions', {
    unit: '{transition}',
    description: 'Delegated MCP invocation state transitions'
  }),
  duration: meter.createHistogram('agentconnect.webchat_mcp.request.duration', {
    unit: 'ms',
    description: 'Delegated MCP route and nested REST request latency'
  })
}

function safeObserve(observe: () => void): void {
  try {
    observe()
  } catch {
    // Metrics exporters and custom observers never participate in auth or execution.
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

export function createWebchatMcpMetrics(
  instruments: WebchatMcpMetricInstruments = defaultInstruments
): WebchatMcpMetrics {
  return {
    delegation(event, reason, count) {
      if (isEmptyCount(count)) return
      safeObserve(() =>
        instruments.delegation.add(safeCount(count), event === 'denied' && reason ? { event, reason } : { event })
      )
    },
    assertion(event, reason, count) {
      if (isEmptyCount(count)) return
      safeObserve(() =>
        instruments.assertion.add(safeCount(count), event === 'denied' && reason ? { event, reason } : { event })
      )
    },
    invocation(outcome, count) {
      if (isEmptyCount(count)) return
      safeObserve(() => instruments.invocation.add(safeCount(count), { outcome }))
    },
    requestDuration(stage, durationMs, outcome) {
      safeObserve(() => instruments.duration.record(safeDuration(durationMs), { stage, outcome }))
    }
  }
}

export const defaultWebchatMcpMetrics = createWebchatMcpMetrics()
