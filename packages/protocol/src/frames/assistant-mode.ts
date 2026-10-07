import { z } from 'zod'

/** One conversation an agent's integration is in: the integration and the platform's own conversation id. */
export const ConversationRef = z
  .object({
    integrationId: z.string().uuid(),
    channelId: z.string().min(1).max(256)
  })
  .strict()
export type ConversationRef = z.infer<typeof ConversationRef>

/** The per-agent assistant mode policy (assistant-mode.md §5.1), carried beside the memory binding on the agent spec. */
export const AssistantModePolicy = z
  .object({
    enabled: z.boolean(),
    /** Where undeliverable reports and unclaimed items go; at least one */
    responsibleUserId: z.string().optional(),
    fallbackConversation: ConversationRef.optional(),
    /** Patrol cadence; absent ⇒ events and each item's own nextCheck only */
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
  .refine((p) => !p.enabled || p.responsibleUserId !== undefined || p.fallbackConversation !== undefined, {
    message: 'an enabled assistant mode needs a responsible user or a fallback conversation',
    path: ['responsibleUserId']
  })
export type AssistantModePolicy = z.infer<typeof AssistantModePolicy>
