import { z } from 'zod'

// D→C REQ: admit a new session for the agent's organization before it starts (org-session-policy.md, Admission).
export const SessionAdmitRequest = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1), // the session's outward identity, the same id `event/session` carries
  // A maintenance run the CP may exempt from the count; an older CP strips it and counts the session as usual.
  purpose: z.literal('memory-dream').optional()
})
export type SessionAdmitRequest = z.infer<typeof SessionAdmitRequest>

// Discriminated on `admitted`, so a refusal variant joins as a new member; `counted` is false for a session the CP already knew.
export const SessionAdmitResult = z.discriminatedUnion('admitted', [
  z.object({ admitted: z.literal(true), counted: z.boolean() })
])
export type SessionAdmitResult = z.infer<typeof SessionAdmitResult>
