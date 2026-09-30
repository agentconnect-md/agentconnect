import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { AGENT_PERMISSION_MAX_OPTIONS, AgentPermissionOption } from '@agentconnect.md/protocol'

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
