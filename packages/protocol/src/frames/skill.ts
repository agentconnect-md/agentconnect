import { z } from 'zod'

// Read-only inventory of the skills an agent's materialized workspace can load,
// so the console has one place to see them. Bodies stay daemon-local; this frame
// carries only per-skill metadata (name, description, origin, path).

export const LocalSkillOrigin = z.enum(['dream-accepted', 'managed', 'git-source', 'repo'])
export type LocalSkillOrigin = z.infer<typeof LocalSkillOrigin>

export const LocalSkillEntry = z
  .object({
    /** Skill name from SKILL.md frontmatter, falling back to the directory name. */
    name: z.string(),
    /** SKILL.md description, or null when absent/unparseable. */
    description: z.string().nullable(),
    origin: LocalSkillOrigin,
    /** Path relative to the workspace cwd, e.g. ".claude/skills/deploy". */
    path: z.string()
  })
  .strict()
export type LocalSkillEntry = z.infer<typeof LocalSkillEntry>

/** CP → daemon: list the skills the agent's workspace can load. */
export const LocalSkillsReq = z.object({ agentId: z.string().min(1) }).strict()
export type LocalSkillsReq = z.infer<typeof LocalSkillsReq>

/** daemon → CP: the inventory. `materialized` is false when the agent's
 *  workspace has not been prepared yet (so an empty list means "unknown", not
 *  "no skills"). */
export const LocalSkillsList = z.object({ materialized: z.boolean(), skills: z.array(LocalSkillEntry) }).strict()
export type LocalSkillsList = z.infer<typeof LocalSkillsList>
