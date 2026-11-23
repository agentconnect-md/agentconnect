import { z } from 'zod'

// D→C REQ: admit a new session for the agent's organization before it starts (org-session-policy.md, Admission).
export const SessionAdmitRequest = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1), // the session's outward identity, the same id `event/session` carries
  // A maintenance run the CP may exempt from the count; an older CP strips it and counts the session as usual.
  purpose: z.literal('memory-dream').optional()
})
export type SessionAdmitRequest = z.infer<typeof SessionAdmitRequest>

/** Why an admission was refused; a definite answer for that attempt, never retried under the same policy. */
export const SESSION_LIMIT_REACHED = 'session_limit_reached'

// Discriminated on `admitted`; `enforcing` says whether the organization refuses past its limit now, absent from an older CP.
export const SessionAdmitResult = z.discriminatedUnion('admitted', [
  // `counted` is false for a session the CP already knew or exempted.
  z.object({ admitted: z.literal(true), counted: z.boolean(), enforcing: z.boolean().optional() }),
  // Sent only to a daemon advertising SESSION_ADMIT_REFUSAL_FEATURE; `resetsAt` starts the next UTC month.
  z.object({
    admitted: z.literal(false),
    reason: z.literal(SESSION_LIMIT_REACHED),
    limit: z.number().int().min(0),
    used: z.number().int().min(0),
    resetsAt: z.string().datetime(),
    enforcing: z.boolean()
  })
])
export type SessionAdmitResult = z.infer<typeof SessionAdmitResult>
