// Pure projections of a Jev answer into the Model result distribution (decisions.md §9.5).

import type { DecisionAnswer, DecisionCondition, DecisionQuestion } from '@agentconnect.md/protocol/decision'

export interface DistributionRow {
  key: string
  label: string
  /** The option's criterion text from the frozen question, when the snapshot kept it. */
  description: string | null
  probability: number
  /** The option Jev answered with. */
  chosen: boolean
  /** The option that made the consumer act: a matched key, or the chosen option of a matched answer. */
  triggers: boolean
  /** A choice condition's threshold for this option, drawn as a tick on its bar. */
  threshold: number | null
  /** A score level inside the condition's interval. */
  inRange: boolean
}

/** One bar per option, in the question's criteria order, marking what Jev chose and what triggered. */
export function distributionRows(input: {
  question: DecisionQuestion | null
  answer: DecisionAnswer
  condition?: DecisionCondition | null
  matchedKeys: readonly string[]
  /** Whether the answer made the consumer act (a gate trigger or a matched routing rule). */
  matched: boolean
  words: { yes: string; no: string }
}): DistributionRow[] {
  const { question, answer, condition, matchedKeys, matched, words } = input
  if (answer.type === 'boolean') {
    const criteria = question?.type === 'boolean' ? question.criteria : null
    return [true, false].map((value) => ({
      key: String(value),
      label: value ? words.yes : words.no,
      description: criteria ? criteria[value ? 'true' : 'false'] : null,
      probability: value ? answer.probability : 1 - answer.probability,
      chosen: answer.value === value,
      triggers: matched && answer.value === value,
      threshold: null,
      inRange: false
    }))
  }
  if (answer.type === 'choice') {
    const criteria = question?.type === 'choice' ? question.criteria : {}
    const keys = [...new Set([...Object.keys(criteria), ...Object.keys(answer.probabilities)])]
    const thresholds = condition?.type === 'choice' ? condition.thresholds : {}
    return keys.map((key) => ({
      key,
      label: key,
      description: criteria[key] ?? null,
      probability: answer.probabilities[key] ?? 0,
      chosen: answer.value === key,
      triggers: matchedKeys.includes(key),
      threshold: thresholds[key] ?? null,
      inRange: false
    }))
  }
  const criteria = question?.type === 'score' ? question.criteria : []
  const chosen = Math.round(answer.value)
  const last = answer.probabilities.length - 1
  return answer.probabilities.map((probability, level) => ({
    key: String(level),
    label: String(level),
    description: criteria[level] ?? null,
    probability,
    chosen: level === chosen,
    triggers: matched && level === chosen,
    threshold: null,
    inRange:
      condition?.type === 'score' &&
      level >= condition.min &&
      (level < condition.max || (level === condition.max && condition.max === last))
  }))
}

/** The model line: the requested id, and the id that actually ran when an alias resolved elsewhere. */
export function modelLine(requested: string, actual: string | null | undefined): string {
  return actual && actual !== requested ? `${requested} → ${actual}` : requested
}

/** Raw provider JSON indented for reading; a body that does not parse is shown as it arrived. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
