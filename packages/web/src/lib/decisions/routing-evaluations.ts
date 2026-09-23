// Pure projections of routing Recent evaluations rows (decisions.md §9.5) for the console.

import type {
  DecisionRoutingEvaluationOutcome,
  DecisionRoutingEvaluationRecord,
  DecisionRoutingTargetRecord
} from '@agentconnect.md/protocol/decision'
import type { OutcomeTone } from './evaluations'

/** Routed reads as success; Partially routed and Fallback as warnings; Unavailable as an error. */
export function routingOutcomeTone(outcome: DecisionRoutingEvaluationOutcome): OutcomeTone | 'warning' {
  if (outcome === 'routed') return 'success'
  if (outcome === 'partially_routed' || outcome === 'fallback') return 'warning'
  if (outcome === 'unavailable') return 'error'
  if (outcome === 'canceled') return 'muted'
  if (outcome === 'pending') return 'pending'
  return 'neutral'
}

export const ROUTING_OUTCOME_BADGE: Record<OutcomeTone | 'warning', string> = {
  success: 'bg-(--status-online-soft) text-(--status-online)',
  warning: 'bg-(--status-paused-soft) text-(--amber-500)',
  neutral: 'bg-(--surface-active) text-(--text-secondary)',
  error: 'bg-(--status-error-soft) text-(--red-600)',
  muted: 'bg-(--surface-active) text-(--text-tertiary)',
  pending: 'bg-(--brand-soft) text-(--brand-soft-text)'
}

/** A target's name, or its id when the viewer's roster does not name it. */
export function targetName(target: Pick<DecisionRoutingTargetRecord, 'agentId'>, names: ReadonlyMap<string, string>) {
  return names.get(target.agentId) ?? target.agentId
}

/** One line per row: each target with its admission, e.g. "Billing ✓, Sales ✕". */
export function targetsText(
  record: Pick<DecisionRoutingEvaluationRecord, 'targets'>,
  names: ReadonlyMap<string, string>
): string | null {
  if (record.targets.length === 0) return null
  const mark = { admitted: '✓', rejected: '✕', unavailable: '✕', pending: '…' } as const
  return record.targets.map((target) => `${targetName(target, names)} ${mark[target.disposition]}`).join(', ')
}

/** What matched: the rule numbers, else Otherwise, else nothing. */
export function matchedRuleNumbers(
  record: Pick<DecisionRoutingEvaluationRecord, 'matchedRuleIds'>,
  numbers: ReadonlyMap<string, number>
): number[] {
  return record.matchedRuleIds.flatMap((id) => {
    const number = numbers.get(id)
    return number === undefined ? [] : [number]
  })
}
