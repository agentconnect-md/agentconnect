import { z } from 'zod'
import { COMPUTER_MANAGED_MODES } from './frames/computer-pool.js'

/** The most Computers one agent may name. */
export const AGENT_COMPUTERS_MAX = 32

/** The agent spec's computer use (computer-use.md §4.1): `computers` is derived from the Computers' agent access, `enabled` from it and `managed`. */
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

/** What an agent itself sets (computer-use.md §4.1): only the managed computer mode; access lives on each Computer. */
export const AgentComputerSetting = z
  .object({ managed: z.object({ mode: z.enum(COMPUTER_MANAGED_MODES) }).optional() })
  .strict()
export type AgentComputerSetting = z.infer<typeof AgentComputerSetting>

/** The spec value an agent ships: its derived Computers and managed mode, or null when it has neither. */
export function agentComputerUseOf(
  setting: AgentComputerSetting | undefined,
  computers: readonly string[]
): AgentComputerUse | null {
  const managed = setting?.managed
  const listed = computers.slice(0, AGENT_COMPUTERS_MAX)
  if (listed.length === 0 && !managed) return null
  return { enabled: true, computers: listed, ...(managed ? { managed } : {}) }
}
