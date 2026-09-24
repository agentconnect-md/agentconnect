import type { AgentModelSelection, DecisionCondition, DecisionQuestion } from '@agentconnect.md/protocol/decision'
import { intervalText } from './DecisionConditionFields'

// A rule's condition in one line, e.g. `feature ≥ 60%`, `2 ≤ score < 4` or `true`.
export function conditionText(when: DecisionCondition, question?: DecisionQuestion): string {
  if (when.type === 'choice')
    return Object.entries(when.thresholds)
      .map(([key, probability]) => `${key} ≥ ${Math.round(probability * 100)}%`)
      .join(' · ')
  if (when.type === 'score')
    return question?.type === 'score' ? intervalText(when, question.criteria.length) : `${when.min}–${when.max}`
  return when.values.map(String).join(', ')
}

// Each rule as `condition → model`; a runtime-only target names its runtime.
export function ruleSummaries(
  selection: AgentModelSelection,
  question?: DecisionQuestion
): { when: string; then: string }[] {
  return selection.rules.map((rule) => ({
    when: conditionText(rule.when, question),
    then: 'runtime' in rule ? rule.model || rule.runtime : 'Decision'
  }))
}
