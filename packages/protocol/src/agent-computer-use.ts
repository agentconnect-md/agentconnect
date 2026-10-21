import { z } from 'zod'
import { COMPUTER_MANAGED_MODES } from './frames/computer-pool.js'

/** The most Computers one agent may name. */
export const AGENT_COMPUTERS_MAX = 32

/** An agent's computer use setting (computer-use.md §4.1); each named Computer's own policy must also grant the agent. */
export const AgentComputerUse = z.object({
  enabled: z.boolean().default(false),
  computers: z
    .array(z.uuid())
    .max(AGENT_COMPUTERS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'computer ids must be unique' })
    .default([]),
  // An agent-driven managed computer from the pool (§15.1): a fresh one per session, or the agent's own kept one.
  managed: z.object({ mode: z.enum(COMPUTER_MANAGED_MODES) }).optional()
})
export type AgentComputerUse = z.infer<typeof AgentComputerUse>
