// The answers one pending approval offers every surface, and the ACP result each settles with (slack-approval-dm.md §11.2).
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import {
  AGENT_PERMISSION_MAX_OPTIONS,
  AgentPermissionOption,
  type AgentPermissionDecision
} from '@agentconnect.md/protocol'
import { elicitTarget, SLACK_DM_ELICIT_SURFACE } from '../slack/render.js'
import { isAllowOption } from './editor-options.js'

/** One answer a pending approval offers: the console's projection of it, and what choosing it resolves with. */
export interface ApprovalChoice<R> {
  option: AgentPermissionOption
  response: R
}

/** Whether a choice grants the request. */
export function isAllowChoice(choice: ApprovalChoice<unknown>): boolean {
  return isAllowOption(choice.option)
}

/** A permission request's choices: one per ACP option, exactly as the runtime offered them. */
export function permissionChoices(params: RequestPermissionRequest): ApprovalChoice<RequestPermissionResponse>[] {
  return params.options.map((option) => ({
    option: { optionId: option.optionId, name: option.name, kind: option.kind },
    response: { outcome: { outcome: 'selected', optionId: option.optionId } }
  }))
}

/** The id of an elicitation approval's refusal; option ids are positions, so it cannot collide with one. */
export const ELICIT_APPROVAL_DENY = 'deny'

/** An MCP tool approval's choices: each option of its one single-select field, then Deny; undefined for any other shape. */
export function elicitationApprovalChoices(
  params: CreateElicitationRequest
): ApprovalChoice<CreateElicitationResponse>[] | undefined {
  // The DM card's reduction, so the console offers the very field an approval DM does.
  const target = elicitTarget(params, SLACK_DM_ELICIT_SURFACE)
  if (target?.kind !== 'enum' || !target.options.length) return undefined
  if (target.options.length >= AGENT_PERMISSION_MAX_OPTIONS) return undefined
  const choices: ApprovalChoice<CreateElicitationResponse>[] = []
  for (const [index, option] of target.options.entries()) {
    const parsed = AgentPermissionOption.safeParse({
      optionId: `option:${index}`,
      name: (option.label.replace(/\s+/g, ' ').trim() || option.value).slice(0, 240),
      kind: 'allow_once'
    })
    if (!parsed.success) return undefined
    choices.push({ option: parsed.data, response: { action: 'accept', content: { [target.propName]: option.value } } })
  }
  choices.push(elicitationDenyChoice())
  return choices
}

/** An elicitation approval's explicit refusal: MCP's `decline`, as the chat card's Dismiss sends. */
export function elicitationDenyChoice(name = 'Deny'): ApprovalChoice<CreateElicitationResponse> {
  return { option: { optionId: ELICIT_APPROVAL_DENY, name, kind: 'reject_once' }, response: { action: 'decline' } }
}

/** The choice a clicked or tapped id names, or undefined when this request never offered it (#1815). */
export function choiceById<R>(
  choices: readonly ApprovalChoice<R>[] | undefined,
  id: string
): PickedChoice<R> | undefined {
  const choice = choices?.find((candidate) => candidate.option.optionId === id)
  return choice && picked(choice)
}

/** The choice a console decision selects: its `optionId` re-derived against the request's own choices, else the binary fallback. */
export function pickChoice<R>(
  choices: readonly ApprovalChoice<R>[] | undefined,
  req: Pick<AgentPermissionDecision, 'decision' | 'optionId'>,
  fallback: (allow: boolean) => PickedChoice<R> | { ok: false; reason: string }
): PickedChoice<R> | { ok: false; reason: string } {
  if (req.optionId === undefined) return fallback(req.decision === 'allow')
  if (!choices) return { ok: false, reason: 'request offers no options' }
  const choice = choices.find((candidate) => candidate.option.optionId === req.optionId)
  if (!choice) return { ok: false, reason: 'runtime did not offer that option' }
  if (isAllowChoice(choice) !== (req.decision === 'allow')) {
    return { ok: false, reason: 'decision does not match the chosen option' }
  }
  return picked(choice)
}

/** An older console's Allow/Deny on a permission request: the narrowest grant, and a deny with no reject option cancels. */
export function permissionFallback(
  choices: readonly ApprovalChoice<RequestPermissionResponse>[]
): (allow: boolean) => PickedChoice<RequestPermissionResponse> | { ok: false; reason: string } {
  const byKind = (...kinds: AgentPermissionOption['kind'][]) =>
    kinds.map((kind) => choices.find((c) => c.option.kind === kind)).find((c) => c !== undefined)
  return (allow) => {
    const choice = allow ? byKind('allow_once', 'allow_always') : byKind('reject_once', 'reject_always')
    if (choice) return picked(choice)
    if (allow) return { ok: false, reason: 'runtime did not offer an allow option' }
    return { ok: true, allow: false, label: 'Denied', response: { outcome: { outcome: 'cancelled' } } }
  }
}

/** An Allow/Deny with no choice on an elicitation approval: a bare `accept`, or `cancel`, as it always was. */
export function elicitationFallback(allow: boolean): PickedChoice<CreateElicitationResponse> {
  return allow
    ? { ok: true, allow, label: 'Allowed', response: { action: 'accept' } }
    : { ok: true, allow, label: 'Denied', response: { action: 'cancel' } }
}

function picked<R>(choice: ApprovalChoice<R>): PickedChoice<R> {
  return { ok: true, allow: isAllowChoice(choice), label: choice.option.name, response: choice.response }
}

/** What a decision resolved to: whether it grants, the words a settled card says, and the ACP answer. */
export type PickedChoice<R> = { ok: true; allow: boolean; label: string; response: R }
