// Reached chain steps as a Recent evaluations detail shows them (decisions.md §10.7).
import type { DecisionChainDetail } from '@agentconnect.md/protocol'

export { chainStepDetails } from '@agentconnect.md/protocol'

/** Clears later steps' provider bodies, the last step's first, until the detail fits. */
export function dropStepRaw(steps: DecisionChainDetail | undefined, fits: () => boolean): void {
  for (const step of [...(steps ?? [])].reverse())
    for (const key of ['rawRequest', 'rawResponse'] as const) {
      if (fits()) return
      if (step[key]) step[key] = null
    }
}
