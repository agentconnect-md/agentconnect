import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  AGENT_PERMISSION_MAX_OPTIONS,
  AgentPermissionOption,
  type AgentPermissionDecision
} from '@agentconnect.md/protocol'

/** The request's options as the console renders them, or undefined when the record cannot carry them whole (#1969). */
export function consolePermissionOptions(params: RequestPermissionRequest): AgentPermissionOption[] | undefined {
  if (!params.options.length || params.options.length > AGENT_PERMISSION_MAX_OPTIONS) return undefined
  const options: AgentPermissionOption[] = []
  for (const option of params.options) {
    const parsed = AgentPermissionOption.safeParse({
      optionId: option.optionId,
      name: (option.name.replace(/\s+/g, ' ').trim() || option.optionId).slice(0, 240),
      kind: option.kind
    })
    // A partial list would misreport a pick from it as the decision on the whole request, so none is offered.
    if (!parsed.success) return undefined
    options.push(parsed.data)
  }
  return options
}

/** Whether an ACP option grants the request. */
export function isAllowOption(option: Pick<PermissionOption, 'kind'>): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

/** The option a console decision selects: its `optionId` re-derived against this request's own options (#1815). */
export function editorDecisionOption(
  options: readonly PermissionOption[],
  req: Pick<AgentPermissionDecision, 'decision' | 'optionId'>
): { ok: true; option: PermissionOption | undefined } | { ok: false; reason: string } {
  if (req.optionId !== undefined) {
    const option = options.find((candidate) => candidate.optionId === req.optionId)
    if (!option) return { ok: false, reason: 'runtime did not offer that option' }
    if (isAllowOption(option) !== (req.decision === 'allow')) {
      return { ok: false, reason: 'decision does not match the chosen option' }
    }
    return { ok: true, option }
  }
  // An older console answers Allow/Deny only: that picks the narrowest grant, and a deny with no reject option cancels.
  const option =
    req.decision === 'allow'
      ? (options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always'))
      : (options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always'))
  if (req.decision === 'allow' && !option) return { ok: false, reason: 'runtime did not offer an allow option' }
  return { ok: true, option }
}
