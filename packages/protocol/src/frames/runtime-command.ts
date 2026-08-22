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
    hint: z.string().nullable(),
    /** Classified from the RAW advertisement at record time (`isSkillCommand`), BEFORE the
     *  description is capped — the claude marker is a description suffix, so classifying after
     *  truncation silently demotes any skill with a long description. Absent on daemons that
     *  predate the field; readers fall back to the heuristic then. */
    skill: z.boolean().optional()
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
    /** The session it came from, by its outward id (§1.1) — a worktree-isolated session can advertise its own set. */
    sessionId: z.string().optional(),
    commands: z.array(RuntimeCommand)
  })
  .strict()
export type RuntimeCommandsList = z.infer<typeof RuntimeCommandsList>

/** Whether an advertised command is a SKILL — content loaded on request — rather than a harness
 *  built-in. Only skills are dispatchable through a plain-text instruction, so the daemon's
 *  invocation translation and the console's pickers both gate on this. The markers are each
 *  adapter's own convention: codex advertises skills as `$name`; claude-agent-acp suffixes the
 *  SKILL.md scope onto the description (`(user)` / `(project)`) and names plugin skills
 *  `plugin:skill`; `mcp:`-prefixed names are MCP prompts, not skills. */
export function isSkillCommand(command: Pick<RuntimeCommand, 'name' | 'description'>): boolean {
  if (command.name.startsWith('$')) return true
  if (command.name.startsWith('mcp:')) return false
  if (command.name.includes(':')) return true
  return /\((?:user|project)\)$/.test(command.description.trimEnd())
}
