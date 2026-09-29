// Reached chain steps as a Recent evaluations detail shows them (decisions.md §10.7).
import {
  DecisionChainDetail,
  DecisionCondition,
  type DecisionChainStepDetail,
  type DecisionChainTrace
} from '@agentconnect.md/protocol'

type StepRaw = Pick<DecisionChainStepDetail, 'rawRequest' | 'rawResponse'>

/** Each reached step as frozen, aligned with the trace; none unless every step's Decision is known. */
export function chainStepDetails(input: {
  trace: DecisionChainTrace
  definition(decisionId: string): Pick<DecisionChainStepDetail, 'providerId' | 'model' | 'question'> | undefined
  condition?(stepId: string): unknown
  raw?(index: number): StepRaw | undefined
}): DecisionChainDetail | undefined {
  const steps = input.trace.map((step, index) => {
    const definition = input.definition(step.decisionId)
    const condition = DecisionCondition.safeParse(input.condition?.(step.stepId))
    return definition
      ? {
          stepId: step.stepId,
          decisionId: step.decisionId,
          providerId: definition.providerId,
          model: definition.model,
          question: definition.question,
          ...(condition.success ? { condition: condition.data } : {}),
          ...(index > 0 ? input.raw?.(index) : {})
        }
      : undefined
  })
  if (steps.some((step) => !step)) return undefined
  const parsed = DecisionChainDetail.safeParse(steps)
  return parsed.success ? parsed.data : undefined
}

/** Clears later steps' provider bodies, the last step's first, until the detail fits. */
export function dropStepRaw(steps: DecisionChainDetail | undefined, fits: () => boolean): void {
  for (const step of [...(steps ?? [])].reverse())
    for (const key of ['rawRequest', 'rawResponse'] as const) {
      if (fits()) return
      if (step[key]) step[key] = null
    }
}
