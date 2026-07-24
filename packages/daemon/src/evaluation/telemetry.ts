import { createHash } from 'node:crypto'
import { SpanStatusCode, trace, type Attributes, type Tracer } from '@opentelemetry/api'
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME
} from '@opentelemetry/semantic-conventions/incubating'
import { startDaemonOpenTelemetry, type OpenTelemetryHandle } from '../observability.js'
import type { EvaluationEvent, EvaluationObserver } from './events.js'

export const EVALUATION_OTEL_SEMCONV_PACKAGE_VERSION = '1.41.1' as const

let evaluationShutdownRegistered = false

function tracerIsRecording(tracer: Tracer): boolean {
  const probe = tracer.startSpan('agentconnect.eval.telemetry.ready')
  const context = probe.spanContext()
  const recording = probe.isRecording() && !/^0{32}$/.test(context.traceId)
  probe.end()
  return recording
}

function registerEvaluationShutdown(telemetry: OpenTelemetryHandle): void {
  if (evaluationShutdownRegistered) return
  evaluationShutdownRegistered = true
  process.once('beforeExit', () => {
    void telemetry.shutdown().catch((error) => {
      console.error(`agentconnect: evaluation opentelemetry shutdown failed: ${(error as Error).message}`)
    })
  })
}

function evaluationTracer(instrumentationVersion: string): Tracer {
  const existing = trace.getTracer('agentconnect.evaluation', instrumentationVersion)
  if (tracerIsRecording(existing)) return existing

  const telemetry = startDaemonOpenTelemetry({ serviceVersion: instrumentationVersion })
  if (!telemetry.enabled) {
    throw new Error(
      'evaluation OpenTelemetry is enabled but no recording exporter is configured; set OTEL_TRACES_EXPORTER or an OTLP traces endpoint'
    )
  }
  registerEvaluationShutdown(telemetry)

  const started = trace.getTracer('agentconnect.evaluation', instrumentationVersion)
  if (!tracerIsRecording(started)) {
    throw new Error('evaluation OpenTelemetry started without a recording tracer provider')
  }
  return started
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function identifier(value: unknown): string | undefined {
  const candidate = string(value)
  if (!candidate || candidate.length > 128 || !/^[A-Za-z0-9_.:/-]+$/.test(candidate)) return undefined
  if (/^(?:sk_(?:agent|machine)_|sk-|gh[pousr]_|xox[baprs]-|eyJ)/.test(candidate)) return undefined
  return candidate
}

function opaqueIdentifier(value: unknown): string | undefined {
  const candidate = identifier(value)
  return candidate ? `sha256:${createHash('sha256').update(candidate).digest('hex').slice(0, 32)}` : undefined
}

export function evaluationEventAttributes(event: EvaluationEvent): Attributes {
  const attributes: Attributes = {
    'agentconnect.eval.schema_version': event.schemaVersion,
    'agentconnect.eval.run_id': event.runId,
    'agentconnect.eval.event_id': event.eventId,
    'agentconnect.eval.event_type': event.type,
    'agentconnect.eval.sequence': event.sequence
  }
  if (event.agentId) attributes[ATTR_GEN_AI_AGENT_ID] = event.agentId
  if (event.sessionId) {
    attributes['agentconnect.eval.session_id'] = event.sessionId
    attributes[ATTR_GEN_AI_CONVERSATION_ID] = event.sessionId
  }
  if (event.turnId) attributes['agentconnect.eval.turn_id'] = event.turnId
  if (event.channel) attributes['agentconnect.channel'] = event.channel
  if (event.platform) attributes['agentconnect.platform'] = event.platform

  if (event.type === 'acp.update') {
    const update = record(event.data.update)
    const rawInput = record(update?.rawInput)
    // ACP titles are free text and can embed commands or secret values. Export
    // only a bounded structured tool name, and hash the call id for correlation.
    const toolName = identifier(rawInput?.tool)
    const toolCallId = opaqueIdentifier(update?.toolCallId)
    if (toolName) attributes[ATTR_GEN_AI_TOOL_NAME] = toolName
    if (toolCallId) attributes[ATTR_GEN_AI_TOOL_CALL_ID] = toolCallId
  }
  return attributes
}

/**
 * Emits metadata-only spans. Prompt, reasoning, memory, tool arguments, and tool
 * results remain in the redacted local artifact rather than OTel attributes.
 */
export function createEvaluationOtelObserver(instrumentationVersion: string): EvaluationObserver {
  const tracer = evaluationTracer(instrumentationVersion)
  return {
    emit(event) {
      const span = tracer.startSpan(`agentconnect.eval.${event.type}`, {
        attributes: evaluationEventAttributes(event),
        startTime: new Date(event.occurredAt)
      })
      if (event.type.endsWith('.failed') || event.type === 'turn.timed_out') {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
      span.end(new Date(event.occurredAt))
    }
  }
}
