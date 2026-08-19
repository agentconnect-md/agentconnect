/**
 * The evaluation harness view of one dispatched turn: a small reporter that owns
 * the "exactly one terminal event per turn" rule and the failed/timed-out
 * classification, so `dispatchOne` carries a named handle instead of a pair of
 * closures over mutable locals.
 */
import { turnFailureCode } from '../acp/acp-host.js'
import type { EvaluationEventInput } from '../evaluation/events.js'

export type TurnTerminalEvaluationEvent = 'turn.completed' | 'turn.failed' | 'turn.cancelled' | 'turn.timed_out'

export interface TurnEvaluationReporter {
  /** Emit this turn's single terminal evaluation event. Later calls are ignored. */
  finishEvaluation(type: TurnTerminalEvaluationEvent, data?: Record<string, unknown>): void
  /** Terminal event for a thrown error, split into failed vs timed out by its code/name. */
  failEvaluation(error: unknown): void
  /** Attribute every later event to this ACP session; known only after sessions.handle(). */
  bindSessionId(sessionId: string): void
}

export interface TurnEvaluationReporterInput {
  emit: (event: EvaluationEventInput) => void
  agentId: string
  platform: string
  channel: string
  turnId: string
  /** An initialize-only turn runs no model work, so it reports no terminal event at all. */
  initializeOnly: boolean
}

export function turnEvaluationReporter(input: TurnEvaluationReporterInput): TurnEvaluationReporter {
  let sessionId: string | undefined
  let terminal = false
  const finishEvaluation = (type: TurnTerminalEvaluationEvent, data: Record<string, unknown> = {}): void => {
    if (input.initializeOnly) return
    if (terminal) return
    terminal = true
    input.emit({
      type,
      agentId: input.agentId,
      ...(sessionId ? { sessionId } : {}),
      turnId: input.turnId,
      platform: input.platform,
      channel: input.channel,
      data
    })
  }
  return {
    finishEvaluation,
    failEvaluation: (error: unknown): void => {
      const code = turnFailureCode(error)
      const timedOut = /tim(?:e|ed)[-_ ]?out/i.test(`${code} ${error instanceof Error ? error.name : ''}`)
      finishEvaluation(timedOut ? 'turn.timed_out' : 'turn.failed', {
        code,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    },
    bindSessionId: (id: string): void => {
      sessionId = id
    }
  }
}
