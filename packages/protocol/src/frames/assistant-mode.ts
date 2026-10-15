import { z } from 'zod'

/** The per-agent assistant mode policy (assistant-mode.md §5.1), carried beside the memory binding on the agent spec. */
export const AssistantModePolicy = z
  .object({
    enabled: z.boolean(),
    /** Follow-up check cadence (not read yet); absent ⇒ each follow-up's own next check only */
    patrolSchedule: z.string().min(1).max(128).optional(),
    timezone: z.string().min(1).max(64).optional(),
    instructions: z.string().max(4096).optional(),
    limits: z
      .object({
        maxConcurrentSubsessions: z.number().int().min(1).max(50).optional(),
        dailyPatrolBudget: z.number().int().min(1).max(500).optional(),
        dailySubsessionsPerItem: z.number().int().min(1).max(50).optional(),
        permissionWaitHours: z.number().int().min(1).max(72).optional()
      })
      .optional()
  })
  .strict()
export type AssistantModePolicy = z.infer<typeof AssistantModePolicy>
