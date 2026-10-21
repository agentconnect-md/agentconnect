// AC_COMPUTER_PLAN (computer-use.md §15.4, §15.5): default quotas, the managed volume size metering bills, and egress choices.
import { parseEnvDocument } from '@agentconnect.md/object-store'
import { z } from 'zod'
import {
  ComputerQuotaOverrideSchema,
  DEFAULT_COMPUTER_QUOTAS,
  effectiveQuotas,
  type ComputerQuotas
} from '../domain/computerQuotas.js'

export const COMPUTER_PLAN_ENV = 'AC_COMPUTER_PLAN'

export const ComputerPlanConfigSchema = z
  .strictObject({
    version: z.literal(1),
    // Defaults every organization gets; any key left out keeps the built-in default, null is unlimited.
    quotas: ComputerQuotaOverrideSchema.default({}),
    // The size of one managed desktop's home volume (the chart's computerPool.home.size), billed as kept storage.
    volumeGib: z.number().positive().max(65_536).default(5),
    egress: z
      .strictObject({
        // Whether an organization may send its managed desktops' browser traffic through its own proxy.
        orgProxy: z.boolean().default(true),
        // One line the console shows about the deployment's own egress, such as its region or provider.
        description: z.string().trim().min(1).max(300).optional()
      })
      .prefault({})
  })
  .transform((doc) => ({ ...doc, quotas: effectiveQuotas(DEFAULT_COMPUTER_QUOTAS, doc.quotas) }))

export interface ComputerPlanConfig {
  quotas: ComputerQuotas
  volumeGib: number
  egress: { orgProxy: boolean; description?: string | undefined }
}

export const DEFAULT_COMPUTER_PLAN: ComputerPlanConfig = {
  quotas: DEFAULT_COMPUTER_QUOTAS,
  volumeGib: 5,
  egress: { orgProxy: true }
}

/** Parse the plan document; the built-in defaults when unset, a thrown error (never echoing values) when invalid. */
export function loadComputerPlanConfig(env: NodeJS.ProcessEnv): ComputerPlanConfig {
  return parseEnvDocument(env, COMPUTER_PLAN_ENV, ComputerPlanConfigSchema) ?? DEFAULT_COMPUTER_PLAN
}
