// The daemon's OWN ask: a private (capture-excluded) session's memory write needs the human in the
// session to consent before it reaches the agent's cross-user memory (session-visibility.md §5.1).
// It rides the elicitation machinery as one synthetic form so every surface renders it unchanged.
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { MemoryWriteAsk } from '../mcp/ops/memory.js'

/** The one field the card asks. */
export const MEMORY_WRITE_APPROVAL_PROP = 'decision'

/** The three answers, in card order; `deny` is offered explicitly even though Dismiss also declines. */
export const MEMORY_WRITE_APPROVAL_OPTIONS = [
  { value: 'allow_once', label: 'Allow once' },
  { value: 'allow_session', label: 'Allow for this session' },
  { value: 'deny', label: 'Deny' }
] as const

/** How the ask ended: one of the two grants, a decline of any kind, or nobody to ask. */
export type MemoryWriteApprovalOutcome = 'allow_once' | 'allow_session' | 'denied' | 'no_approver'

/** The first line is the question (the card's head); the lines below name the write. */
export function memoryWriteApprovalMessage(ask: MemoryWriteAsk): string {
  const lines = [
    'Allow this write to shared agent memory from a private session?',
    `${ask.tool} → ${ask.target}`,
    ...(ask.summary ? [ask.summary] : [])
  ]
  return lines.join('\n')
}

/** The synthetic form: one required single-select, so every card surface shows a button per option. */
export function memoryWriteApprovalElicitation(sessionId: string, ask: MemoryWriteAsk): CreateElicitationRequest {
  return {
    sessionId,
    mode: 'form',
    message: memoryWriteApprovalMessage(ask),
    requestedSchema: {
      type: 'object',
      properties: {
        [MEMORY_WRITE_APPROVAL_PROP]: {
          type: 'string',
          title: 'Shared memory write',
          oneOf: MEMORY_WRITE_APPROVAL_OPTIONS.map((o) => ({ const: o.value, title: o.label }))
        }
      },
      required: [MEMORY_WRITE_APPROVAL_PROP]
    }
  } as CreateElicitationRequest
}

/** Read the answer back: only an explicit grant allows; a bare `accept` (the editor queue's Allow)
 *  is one write; decline, cancel and an unshown card (`undefined`) never are. */
export function memoryWriteApprovalFrom(res: CreateElicitationResponse | undefined): MemoryWriteApprovalOutcome {
  if (res === undefined) return 'no_approver'
  if (res.action !== 'accept') return 'denied'
  const picked = (res.content as Record<string, unknown> | undefined)?.[MEMORY_WRITE_APPROVAL_PROP]
  if (picked === 'allow_session') return 'allow_session'
  if (picked === 'deny') return 'denied'
  return 'allow_once'
}
