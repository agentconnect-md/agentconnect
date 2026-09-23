import { z } from 'zod'
import { DecisionDraft, DecisionEvaluation } from '../decision.js'

export const DECISION_PREVIEW_V1_FEATURE = 'decision-preview-v1'
// The peer understands BindMatch{kind:'decision'}, core.decisions and rd/msg.decisionId, and never treats them as Any.
export const DECISION_TRIGGER_V1_FEATURE = 'decision-trigger-v1'

export const DecisionCatalogRequest = z.strictObject({})
export const DecisionCatalogReply = z.object({
  providers: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        kind: z.string().min(1).max(128),
        models: z
          .array(
            z.object({
              id: z.string().min(1).max(128),
              label: z.string().min(1).max(128),
              questionTypes: z.array(z.enum(['boolean', 'choice', 'score'])).max(3)
            })
          )
          .max(32),
        cloudAvailable: z.boolean()
      })
    )
    .max(16)
})
export type DecisionCatalogReply = z.infer<typeof DecisionCatalogReply>

export const DecisionPreviewRequest = z
  .strictObject({
    agentId: z.string().uuid(),
    evaluationId: z.string().uuid(),
    decision: DecisionDraft,
    state: z.record(z.string(), z.unknown())
  })
  .refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 32 * 1024, {
    message: 'The preview must fit within 32 KiB.'
  })
export type DecisionPreviewRequest = z.infer<typeof DecisionPreviewRequest>
export const DecisionPreviewReply = z.object({ evaluation: DecisionEvaluation })
export type DecisionPreviewReply = z.infer<typeof DecisionPreviewReply>
