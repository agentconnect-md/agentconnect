import { z } from 'zod'
import { atomicWrite, redactEvaluationValue } from './artifacts.js'
import { EVALUATION_EVENT_SCHEMA_VERSION, type EvaluationEvent } from './events.js'
import { evaluationTokenMetricsFromUsage } from './token-metrics.js'

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7' as const

export interface AtifToolCall {
  tool_call_id: string
  function_name: string
  arguments: Record<string, unknown>
  extra?: Record<string, unknown>
}

export interface AtifObservationResult {
  source_call_id?: string
  content?: string
  extra?: Record<string, unknown>
}

export interface AtifStep {
  step_id: number
  timestamp?: string
  source: 'system' | 'user' | 'agent'
  model_name?: string
  message: string
  reasoning_content?: string
  tool_calls?: AtifToolCall[]
  observation?: { results: AtifObservationResult[] }
  metrics?: {
    prompt_tokens?: number
    completion_tokens?: number
    cached_tokens?: number
    cost_usd?: number
    extra?: Record<string, unknown>
  }
  extra?: Record<string, unknown>
  llm_call_count?: number
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION
  session_id?: string
  trajectory_id?: string
  agent: {
    name: string
    version: string
    model_name?: string
    extra?: Record<string, unknown>
  }
  steps: AtifStep[]
  notes?: string
  final_metrics?: {
    total_prompt_tokens?: number
    total_completion_tokens?: number
    total_cached_tokens?: number
    total_cost_usd?: number
    total_steps?: number
    extra?: Record<string, unknown>
  }
  extra?: Record<string, unknown>
  subagent_trajectories?: AtifTrajectory[]
}

const JsonObjectSchema = z.record(z.string(), z.unknown())

export const AtifToolCallSchema: z.ZodType<AtifToolCall> = z.object({
  tool_call_id: z.string().min(1),
  function_name: z.string().min(1),
  arguments: JsonObjectSchema,
  extra: JsonObjectSchema.optional()
})

export const AtifObservationResultSchema: z.ZodType<AtifObservationResult> = z.object({
  source_call_id: z.string().min(1).optional(),
  content: z.string().optional(),
  extra: JsonObjectSchema.optional()
})

export const AtifStepSchema: z.ZodType<AtifStep> = z
  .object({
    step_id: z.number().int().positive(),
    timestamp: z.string().datetime().optional(),
    source: z.enum(['system', 'user', 'agent']),
    model_name: z.string().min(1).optional(),
    message: z.string(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(AtifToolCallSchema).optional(),
    observation: z
      .object({
        results: z.array(AtifObservationResultSchema)
      })
      .optional(),
    metrics: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        cached_tokens: z.number().int().nonnegative().optional(),
        cost_usd: z.number().nonnegative().optional(),
        extra: JsonObjectSchema.optional()
      })
      .optional(),
    extra: JsonObjectSchema.optional(),
    llm_call_count: z.number().int().nonnegative().optional()
  })
  .superRefine((step, context) => {
    if (step.source !== 'agent') {
      for (const field of ['model_name', 'reasoning_content', 'tool_calls', 'metrics'] as const) {
        if (step[field] !== undefined) {
          context.addIssue({ code: 'custom', path: [field], message: `${field} is agent-only in ATIF` })
        }
      }
    }
    if (step.llm_call_count === 0 && (step.metrics !== undefined || step.reasoning_content !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['llm_call_count'],
        message: 'ATIF deterministic agent steps cannot carry metrics or reasoning'
      })
    }
    const callIds = new Set(step.tool_calls?.map((call) => call.tool_call_id) ?? [])
    for (const [index, result] of (step.observation?.results ?? []).entries()) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) {
        context.addIssue({
          code: 'custom',
          path: ['observation', 'results', index, 'source_call_id'],
          message: 'ATIF observation source_call_id must reference a tool call in the same step'
        })
      }
    }
  })

export const AtifTrajectorySchema: z.ZodType<AtifTrajectory> = z.lazy(() =>
  z
    .object({
      schema_version: z.literal(ATIF_SCHEMA_VERSION),
      session_id: z.string().min(1).optional(),
      trajectory_id: z.string().min(1).optional(),
      agent: z.object({
        name: z.string().min(1),
        version: z.string().min(1),
        model_name: z.string().min(1).optional(),
        extra: JsonObjectSchema.optional()
      }),
      steps: z.array(AtifStepSchema).min(1),
      notes: z.string().optional(),
      final_metrics: z
        .object({
          total_prompt_tokens: z.number().int().nonnegative().optional(),
          total_completion_tokens: z.number().int().nonnegative().optional(),
          total_cached_tokens: z.number().int().nonnegative().optional(),
          total_cost_usd: z.number().nonnegative().optional(),
          total_steps: z.number().int().nonnegative().optional(),
          extra: JsonObjectSchema.optional()
        })
        .optional(),
      extra: JsonObjectSchema.optional(),
      subagent_trajectories: z.array(AtifTrajectorySchema).optional()
    })
    .superRefine((trajectory, context) => {
      trajectory.steps.forEach((step, index) => {
        if (step.step_id !== index + 1) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'step_id'],
            message: `ATIF step ids must be sequential from 1; expected ${index + 1}`
          })
        }
      })
      const embeddedIds = new Set<string>()
      trajectory.subagent_trajectories?.forEach((subagent, index) => {
        if (!subagent.trajectory_id) {
          context.addIssue({
            code: 'custom',
            path: ['subagent_trajectories', index, 'trajectory_id'],
            message: 'ATIF-v1.7 embedded subagents require trajectory_id'
          })
        } else if (embeddedIds.has(subagent.trajectory_id)) {
          context.addIssue({
            code: 'custom',
            path: ['subagent_trajectories', index, 'trajectory_id'],
            message: 'ATIF-v1.7 embedded subagent trajectory_id must be unique'
          })
        } else embeddedIds.add(subagent.trajectory_id)
      })
    })
)

export interface AtifAgentMetadata {
  name: string
  version: string
  modelName?: string
  extra?: Record<string, unknown>
}

export interface EvaluationEventsToAtifOptions {
  runId: string
  rootAgentId?: string
  defaultAgentVersion: string
  agents?: Record<string, AtifAgentMetadata>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function content(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toolCallFrom(update: Record<string, unknown>, fallbackId: string): AtifToolCall {
  const rawInput = record(update.rawInput)
  const args = record(rawInput?.arguments) ?? rawInput ?? {}
  return {
    tool_call_id: string(update.toolCallId) ?? fallbackId,
    function_name: string(rawInput?.tool) ?? string(update.title) ?? 'unknown_tool',
    arguments: args,
    extra: {
      ...(string(rawInput?.server) ? { server: rawInput!.server } : {}),
      ...(string(update.kind) ? { kind: update.kind } : {}),
      ...(string(update.status) ? { status: update.status } : {})
    }
  }
}

function tokenMetricsFromUsage(usage: Record<string, unknown> | undefined): AtifStep['metrics'] | undefined {
  const metrics = evaluationTokenMetricsFromUsage(usage)
  if (
    metrics.promptTokens === undefined &&
    metrics.completionTokens === undefined &&
    metrics.cachedTokens === undefined
  )
    return undefined
  return {
    ...(metrics.promptTokens !== undefined ? { prompt_tokens: metrics.promptTokens } : {}),
    ...(metrics.completionTokens !== undefined ? { completion_tokens: metrics.completionTokens } : {}),
    ...(metrics.cachedTokens !== undefined ? { cached_tokens: metrics.cachedTokens } : {})
  }
}

function buildSteps(events: readonly EvaluationEvent[], modelName?: string): AtifStep[] {
  const steps: AtifStep[] = []
  const toolSteps = new Map<string, AtifStep>()
  const agentSteps = new Map<string, AtifStep>()

  const push = (step: Omit<AtifStep, 'step_id'>): AtifStep => {
    const complete = { step_id: steps.length + 1, ...step }
    steps.push(complete)
    return complete
  }

  const turnKey = (event: EvaluationEvent): string => event.turnId ?? event.sessionId ?? event.eventId
  const agentStep = (event: EvaluationEvent): AtifStep => {
    const key = turnKey(event)
    const existing = agentSteps.get(key)
    if (existing) return existing
    const created = push({
      source: 'agent',
      timestamp: event.occurredAt,
      ...(modelName ? { model_name: modelName } : {}),
      message: '',
      llm_call_count: 1,
      extra: { turn_id: event.turnId }
    })
    agentSteps.set(key, created)
    return created
  }

  for (const event of events) {
    if (event.type === 'turn.started') {
      push({
        source: 'user',
        timestamp: event.occurredAt,
        message: string(event.data.input) ?? '',
        extra: { agentconnect_event_id: event.eventId, turn_id: event.turnId }
      })
      continue
    }

    if (event.type === 'acp.update') {
      const update = record(event.data.update) ?? {}
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = string(record(update.content)?.text) ?? ''
          const step = agentStep(event)
          step.message += text
          step.extra = { ...(step.extra ?? {}), agentconnect_last_event_id: event.eventId }
          break
        }
        case 'agent_thought_chunk': {
          const reasoning = string(record(update.content)?.text) ?? ''
          const step = agentStep(event)
          step.reasoning_content = `${step.reasoning_content ?? ''}${reasoning}`
          step.extra = { ...(step.extra ?? {}), agentconnect_last_event_id: event.eventId }
          break
        }
        case 'tool_call': {
          const call = toolCallFrom(update, event.eventId)
          const step = agentStep(event)
          step.tool_calls ??= []
          step.tool_calls.push(call)
          step.extra = { ...(step.extra ?? {}), agentconnect_last_event_id: event.eventId }
          toolSteps.set(`${turnKey(event)}:${call.tool_call_id}`, step)
          break
        }
        case 'tool_call_update': {
          const callId = string(update.toolCallId)
          const step = callId ? toolSteps.get(`${turnKey(event)}:${callId}`) : undefined
          const result: AtifObservationResult = {
            ...(callId ? { source_call_id: callId } : {}),
            content: content(update.rawOutput ?? update.content ?? update.status ?? ''),
            extra: {
              ...(string(update.status) ? { status: update.status } : {}),
              agentconnect_event_id: event.eventId
            }
          }
          if (step && callId) {
            step.observation ??= { results: [] }
            step.observation.results.push(result)
          } else {
            push({
              source: 'system',
              timestamp: event.occurredAt,
              message: 'Unmatched ACP tool update',
              observation: { results: [{ ...result, source_call_id: undefined }] },
              extra: { agentconnect_event_id: event.eventId, turn_id: event.turnId }
            })
          }
          break
        }
        case 'usage_update': {
          const step = agentStep(event)
          step.metrics ??= {}
          step.metrics.extra = {
            ...(step.metrics.extra ?? {}),
            context_used: update.used,
            context_size: update.size,
            ...(record(update.cost) ? { reported_cost: update.cost } : {})
          }
          break
        }
        default:
          push({
            source: 'system',
            timestamp: event.occurredAt,
            message: `ACP update: ${string(update.sessionUpdate) ?? 'unknown'}`,
            observation: { results: [{ content: content(update) }] },
            extra: { agentconnect_event_id: event.eventId, turn_id: event.turnId }
          })
      }
      continue
    }

    if (event.type === 'turn.completed') {
      const step = agentStep(event)
      if (!step.message && typeof event.data.output === 'string') step.message = event.data.output
      const metrics = tokenMetricsFromUsage(record(event.data.usage))
      if (metrics) step.metrics = { ...(step.metrics ?? {}), ...metrics }
      step.extra = {
        ...(step.extra ?? {}),
        agentconnect_terminal_event_id: event.eventId,
        ...(string(event.data.stopReason) ? { stop_reason: event.data.stopReason } : {})
      }
      agentSteps.delete(turnKey(event))
      continue
    }

    push({
      source: 'system',
      timestamp: event.occurredAt,
      message: event.type,
      observation: { results: [{ content: content(event.data) }] },
      extra: { agentconnect_event_id: event.eventId, turn_id: event.turnId }
    })
    if (event.type === 'turn.failed' || event.type === 'turn.cancelled' || event.type === 'turn.timed_out') {
      agentSteps.delete(turnKey(event))
    }
  }

  return steps
}

function finalMetrics(steps: readonly AtifStep[]): NonNullable<AtifTrajectory['final_metrics']> {
  const values = (field: keyof NonNullable<AtifStep['metrics']>): number[] =>
    steps
      .map((step) => step.metrics?.[field])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const prompt = values('prompt_tokens')
  const completion = values('completion_tokens')
  const cached = values('cached_tokens')
  const cost = values('cost_usd')
  return {
    ...(prompt.length ? { total_prompt_tokens: prompt.reduce((sum, value) => sum + value, 0) } : {}),
    ...(completion.length ? { total_completion_tokens: completion.reduce((sum, value) => sum + value, 0) } : {}),
    ...(cached.length ? { total_cached_tokens: cached.reduce((sum, value) => sum + value, 0) } : {}),
    ...(cost.length ? { total_cost_usd: cost.reduce((sum, value) => sum + value, 0) } : {}),
    total_steps: steps.length
  }
}

export function evaluationEventsToAtif(
  events: readonly EvaluationEvent[],
  options: EvaluationEventsToAtifOptions
): AtifTrajectory {
  const agentIds = [...new Set(events.map((event) => event.agentId).filter((agentId): agentId is string => !!agentId))]
  const rootAgentId = options.rootAgentId ?? agentIds[0] ?? 'agentconnect'
  if (!agentIds.includes(rootAgentId)) agentIds.unshift(rootAgentId)

  const trajectoryFor = (agentId: string): AtifTrajectory => {
    const metadata = options.agents?.[agentId]
    const agentEvents = events.filter((event) => (event.agentId ?? rootAgentId) === agentId)
    const observedSteps = buildSteps(agentEvents, metadata?.modelName)
    const steps =
      observedSteps.length > 0
        ? observedSteps
        : [
            {
              step_id: 1,
              source: 'system' as const,
              message: 'No semantic events were recorded before the evaluation ended.',
              extra: { agentconnect_synthetic_terminal_step: true }
            }
          ]
    return AtifTrajectorySchema.parse({
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: options.runId,
      trajectory_id: `${options.runId}:${agentId}`,
      agent: {
        name: metadata?.name ?? agentId,
        version: metadata?.version ?? options.defaultAgentVersion,
        ...(metadata?.modelName ? { model_name: metadata.modelName } : {}),
        ...(metadata?.extra ? { extra: metadata.extra } : {})
      },
      steps,
      final_metrics: finalMetrics(steps),
      extra: {
        agentconnect_event_schema: EVALUATION_EVENT_SCHEMA_VERSION,
        agentconnect_event_count: agentEvents.length,
        agentconnect_agent_id: agentId
      }
    })
  }

  const root = trajectoryFor(rootAgentId)
  const subagents = agentIds.filter((agentId) => agentId !== rootAgentId).map(trajectoryFor)
  if (subagents.length > 0) root.subagent_trajectories = subagents
  root.extra = {
    ...(root.extra ?? {}),
    agentconnect_participant_agent_ids: agentIds
  }
  return AtifTrajectorySchema.parse(root)
}

export function writeAtifTrajectory(path: string, trajectory: AtifTrajectory, secrets: readonly string[] = []): void {
  const validated = AtifTrajectorySchema.parse(redactEvaluationValue(trajectory, secrets))
  atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`)
}
