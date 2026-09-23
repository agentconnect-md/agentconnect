import { z } from 'zod'
import { DecisionDraft, DecisionEvaluation, DecisionQuestion } from '../decision.js'

export const DECISION_PREVIEW_V1_FEATURE = 'decision-preview-v1'
export const DECISION_TOOLS_V1_FEATURE = 'decision-tools-v1'
export const DECISION_LIST_MAX_BYTES = 32 * 1024

// Saved configuration only: agent evaluation inputs and results never travel on these frames.
export const DecisionToolDefinition = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  providerId: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  question: DecisionQuestion
})
export type DecisionToolDefinition = z.infer<typeof DecisionToolDefinition>

export const DecisionListRequest = z.strictObject({
  requesterAgentId: z.string().uuid(),
  query: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(20).default(10)
})
export type DecisionListRequest = z.infer<typeof DecisionListRequest>
export const DecisionListReply = z.strictObject({
  items: z.array(DecisionToolDefinition).max(20),
  nextCursor: z.string().uuid().nullable()
})
export type DecisionListReply = z.infer<typeof DecisionListReply>

export const DecisionGetRequest = z.strictObject({
  requesterAgentId: z.string().uuid(),
  decisionId: z.string().uuid()
})
export type DecisionGetRequest = z.infer<typeof DecisionGetRequest>
export const DecisionGetReply = z.strictObject({ decision: DecisionToolDefinition.nullable() })
export type DecisionGetReply = z.infer<typeof DecisionGetReply>

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
