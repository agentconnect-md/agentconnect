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

/** Why a configured Git skill Source did not install (source-cache.md §11): an enumerated code, never Git's or the CLI's raw output. */
export const SkillSourceFailureCode = z.enum([
  'resolution_failed',
  'access_denied',
  'ref_moved',
  'commit_unavailable',
  'sha_fetch_refused',
  'fetch_failed',
  'limits_exceeded',
  'cli_failed'
])
export type SkillSourceFailureCode = z.infer<typeof SkillSourceFailureCode>

export const MAX_AGENT_SKILL_STATUS_SOURCES = 64

/** daemon → CP EVT `agent/skill-status`, sent only to a CP advertising `agent-skill-status-v1`: one completed reconcile's failed Sources by name; a Source not listed installed. */
export const AgentSkillStatus = z
  .object({
    agentId: z.string().uuid(),
    failed: z
      .array(z.object({ name: z.string().min(1).max(64), code: SkillSourceFailureCode }).strict())
      .max(MAX_AGENT_SKILL_STATUS_SOURCES)
      .refine((failed) => new Set(failed.map((entry) => entry.name)).size === failed.length, {
        message: 'skill source names must be unique'
      }),
    ts: z.string().datetime()
  })
  .strict()
export type AgentSkillStatus = z.infer<typeof AgentSkillStatus>
