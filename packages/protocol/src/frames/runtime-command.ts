import { z } from 'zod'

// The slash commands an agent's ACP runtime advertises (`available_commands_update`) — skills,
// plugin skills and the harness's own built-ins arrive as one list, so this is what the runtime
// can actually be asked to run rather than what a workspace scan guesses (`skills/local`).

export const RuntimeCommand = z
  .object({
    /** Name as typed after `/` — e.g. `code-review`, `superpowers:brainstorming`, `mcp:srv:cmd`. */
    name: z.string(),
    /** The runtime's own description; empty when it advertised none. */
    description: z.string(),
    /** ACP `input.hint` — an argument hint, or null when the command takes no argument. */
    hint: z.string().nullable()
  })
  .strict()
export type RuntimeCommand = z.infer<typeof RuntimeCommand>

/** CP → daemon: what can this agent's runtime be asked to run? */
export const RuntimeCommandsReq = z.object({ agentId: z.string().min(1) }).strict()
export type RuntimeCommandsReq = z.infer<typeof RuntimeCommandsReq>

/** daemon → CP: the last advertised list. `reported:false` means no session has advertised one
 *  yet, so the empty list is "unknown", not "no commands". */
export const RuntimeCommandsList = z
  .object({
    reported: z.boolean(),
    /** When that advertisement arrived; the list survives the host stopping, so it can be stale. */
    updatedAt: z.string().optional(),
    /** The ACP session it came from — a worktree-isolated session can advertise its own set. */
    sessionId: z.string().optional(),
    commands: z.array(RuntimeCommand)
  })
  .strict()
export type RuntimeCommandsList = z.infer<typeof RuntimeCommandsList>
