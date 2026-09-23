import type { DecisionRuntimeTarget } from '@agentconnect.md/protocol/decision'

// Run-setting edits re-send the displayed (possibly preferred) model; only a different pick may replace the stored one.
export function storedModelAfterPick(
  target: DecisionRuntimeTarget,
  runtime: string,
  displayedModel: string,
  storedModel: string
): string {
  return target.runtime !== runtime || target.model !== displayedModel ? target.model : storedModel
}
