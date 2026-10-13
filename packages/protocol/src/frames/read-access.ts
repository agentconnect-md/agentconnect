import { z } from 'zod'

/** Who asks: a console user, or a chat member on one of the agent's bots whom the Control Plane resolves to one. */
export const ReadAccessAsker = z.union([
  z.object({ consoleUserId: z.string().min(1).max(256) }),
  z.object({ integrationId: z.string().uuid(), memberId: z.string().min(1).max(256) })
])
export type ReadAccessAsker = z.infer<typeof ReadAccessAsker>

// `agent/read-access` (D→C REQ): which of an agent's sessions the console user behind an asker could see, for the read rule (assistant-mode.md §5.5).
export const AgentReadAccess = z.object({
  agentId: z.string().uuid(),
  asker: ReadAccessAsker,
  // Outward session ids; empty asks only whether the asker is a linked console user.
  sessionIds: z.array(z.string().min(1).max(256)).max(8),
  // A DM or webchat source: only sessions the asker owns count, whoever else the console shows them to.
  ownerOnly: z.boolean().optional(),
  // With `read-access-linked-v1`: also answer which chat identity the asker's console user linked in this bot's workspace.
  linkedOn: z.string().uuid().optional()
})
export type AgentReadAccess = z.infer<typeof AgentReadAccess>

/** `linked`: a console user of the agent's organization; `unlinked`: a chat member who linked no console account; `unidentifiable`: neither can be told. */
export const ReadAccessAskerState = z.enum(['linked', 'unlinked', 'unidentifiable'])
export type ReadAccessAskerState = z.infer<typeof ReadAccessAskerState>

// `agent/read-access/ok` (C→D REP): the session-visibility verdict the console itself would give that user.
export const AgentReadAccessOk = z.object({
  asker: ReadAccessAskerState,
  visibleSessionIds: z.array(z.string().min(1).max(256)).max(8),
  // The console user a `linked` asker resolved to, which keys their memory layer; absent from an older Control Plane.
  consoleUserId: z.string().min(1).max(256).optional(),
  // The member id the asker's console user linked in `linkedOn`'s workspace, null for none; absent from an older Control Plane.
  linkedMemberId: z.string().min(1).max(256).nullable().optional()
})
export type AgentReadAccessOk = z.infer<typeof AgentReadAccessOk>
