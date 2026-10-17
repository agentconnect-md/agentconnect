import { z } from 'zod'

/** The per-agent assistant mode policy (assistant-mode.md §5.1), carried beside the memory binding on the agent spec. */
export const AssistantModePolicy = z
  .object({
    enabled: z.boolean(),
    timezone: z.string().min(1).max(64).optional(),
    instructions: z.string().max(4096).optional(),
    limits: z
      .object({
        maxConcurrentSubsessions: z.number().int().min(1).max(50).optional(),
        dailyCheckBudget: z.number().int().min(1).max(500).optional(),
        permissionWaitHours: z.number().int().min(1).max(72).optional()
      })
      .optional()
  })
  .strict()
export type AssistantModePolicy = z.infer<typeof AssistantModePolicy>

/** At most this many names of each kind travel as research hints (assistant-mode.md §5.15). */
export const ASSISTANT_ONBOARDING_HINTS_MAX = 10

/** The public names research starts its web search from: never an address, never a public mail provider's domain. */
export const AssistantOnboardingHints = z.object({
  organization: z.string().min(1).max(200).optional(),
  workspaces: z.array(z.string().min(1).max(200)).max(ASSISTANT_ONBOARDING_HINTS_MAX).optional(),
  emailDomains: z.array(z.string().min(1).max(253)).max(ASSISTANT_ONBOARDING_HINTS_MAX).optional()
})
export type AssistantOnboardingHints = z.infer<typeof AssistantOnboardingHints>

/** The first time assistant mode was switched on for an agent (assistant-mode.md §5.15): written once by the Control Plane, never cleared. */
export const AssistantOnboarding = z.object({
  /** The console user whose edit switched it on; absent when no person made the edit. */
  enabledByUserId: z.string().min(1).max(256).optional(),
  enabledAt: z.string().datetime(),
  hints: AssistantOnboardingHints.optional()
})
export type AssistantOnboarding = z.infer<typeof AssistantOnboarding>
