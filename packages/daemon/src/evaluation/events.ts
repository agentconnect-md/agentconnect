import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const EVALUATION_EVENT_SCHEMA_VERSION = 'agentconnect.eval/v1' as const

export const EvaluationEventTypeSchema = z.enum([
  'turn.accepted',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.timed_out',
  'turn.context_changed',
  'turn.regeneration_started',
  'acp.update',
  'memory.recall.requested',
  'memory.recall.completed',
  'memory.recall.failed',
  'memory.capture.requested',
  'memory.capture.completed',
  'memory.capture.failed',
  'memory.dream.started',
  'memory.dream.completed',
  'memory.dream.failed',
  'memory.dream.adopted',
  'memory.dream.skill_accepted',
  'memory.dream.skill_dismissed',
  'permission.requested',
  'permission.auto_allowed',
  'permission.prompted',
  'permission.resolved',
  'permission.cancelled',
  'collaboration.delivery.admitted',
  'collaboration.delivery.rejected',
  'collaboration.delivery.deduplicated',
  'orchestration.state'
])

export type EvaluationEventType = z.infer<typeof EvaluationEventTypeSchema>

export const EvaluationCapabilityProfileSchema = z.object({
  memory: z.enum(['off', 'configured']),
  collaboration: z.enum(['off', 'configured'])
})

export type EvaluationCapabilityProfile = z.infer<typeof EvaluationCapabilityProfileSchema>

export const EvaluationEventSchema = z.object({
  schemaVersion: z.literal(EVALUATION_EVENT_SCHEMA_VERSION),
  runId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  type: EvaluationEventTypeSchema,
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).default({})
})

export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>

export interface EvaluationEventInput {
  type: EvaluationEventType
  agentId?: string
  sessionId?: string
  turnId?: string
  platform?: string
  channel?: string
  data?: Record<string, unknown>
}

/**
 * Optional evaluation-only tap. Implementations must return promptly and must not
 * mutate the event. The daemon contains observer failures so evaluation can never
 * change the product decision being measured.
 */
export interface EvaluationObserver {
  emit(event: EvaluationEvent): void
}

export interface EvaluationEventEmitterOptions {
  observer?: EvaluationObserver
  runId?: string
  now?: () => number
  onObserverError?: (error: unknown) => void
}

/**
 * Adds stable envelope fields and validates every semantic event before delivery.
 * `emit()` returns the accepted event for deterministic tests and returns undefined
 * when no observer is installed or an observer/validation error was contained.
 */
export class EvaluationEventEmitter {
  readonly runId: string
  private sequence = 0
  private readonly now: () => number

  constructor(private readonly options: EvaluationEventEmitterOptions = {}) {
    this.runId = options.runId?.trim() || randomUUID()
    this.now = options.now ?? Date.now
  }

  get enabled(): boolean {
    return this.options.observer !== undefined
  }

  emit(input: EvaluationEventInput): EvaluationEvent | undefined {
    if (!this.options.observer) return undefined
    try {
      const sequence = ++this.sequence
      const event = EvaluationEventSchema.parse({
        schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
        runId: this.runId,
        eventId: `${this.runId}:${sequence}`,
        sequence,
        occurredAt: new Date(this.now()).toISOString(),
        ...input,
        data: input.data ?? {}
      })
      this.options.observer.emit(event)
      return event
    } catch (error) {
      try {
        this.options.onObserverError?.(error)
      } catch {
        // Error reporting is itself observer-only and must remain non-interfering.
      }
      return undefined
    }
  }
}

export function compositeEvaluationObserver(...observers: Array<EvaluationObserver | undefined>): EvaluationObserver {
  const active = observers.filter((observer): observer is EvaluationObserver => observer !== undefined)
  return {
    emit(event) {
      const errors: unknown[] = []
      for (const observer of active) {
        try {
          observer.emit(event)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'one or more evaluation observers failed')
    }
  }
}
