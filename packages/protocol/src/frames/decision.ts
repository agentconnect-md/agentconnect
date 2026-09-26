import { z } from 'zod'
import {
  DecisionDraft,
  DecisionEvaluation,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  DecisionModelEvaluationRecordDetail,
  DecisionModelEvaluationRecordPage,
  DecisionQuestion,
  DecisionRoutingEvaluationRecordDetail,
  DecisionRoutingEvaluationRecordPage
} from '../decision.js'

export const DECISION_PREVIEW_V1_FEATURE = 'decision-preview-v1'
// The peer understands BindMatch{kind:'decision'}, core.decisions and rd/msg.decisionId, and never treats them as Any.
export const DECISION_TRIGGER_V1_FEATURE = 'decision-trigger-v1'
// The peer understands routedConversations/evaluationDaemonId, shared_bot_routing bindings and bundle.sharedBotRouting, never as Any.
export const DECISION_ROUTING_V1_FEATURE = 'decision-routing-v1'
// The relay forwards a routed conversation once to its evaluationDaemonId and serves rd/route; routing-v1 alone only parses.
export const DECISION_ROUTING_FORWARD_V1_FEATURE = 'decision-routing-forward-v1'
export const DECISION_TOOLS_V1_FEATURE = 'decision-tools-v1'
export const DECISION_MODEL_SELECTION_V1_FEATURE = 'decision-model-selection-v1'
export const DECISION_CHAIN_V1_FEATURE = 'decision-chain-v1'
// The peer answers decision/evaluations and decision/evaluation from its decision_verdict rows.
export const DECISION_EVALUATIONS_V1_FEATURE = 'decision-evaluations-v1'
export const DECISION_MODEL_EVALUATIONS_V1_FEATURE = 'decision-model-evaluations-v1'
// The peer answers decision/routing-evaluations and decision/routing-evaluation from its router verdicts.
export const DECISION_ROUTING_EVALUATIONS_V1_FEATURE = 'decision-routing-evaluations-v1'
// The peer returns rawRequest/rawResponse on evaluation details when a request sets includeRaw.
export const DECISION_EVALUATION_RAW_V1_FEATURE = 'decision-evaluation-raw-v1'
// The peer hosts code-host hook routing (rd/msg hook `routing`, AgentSpec.hookRoutings) and reads its lanes, or the relay forwards to one.
export const HOOK_DECISION_ROUTING_V1_FEATURE = 'hook-decision-routing-v1'
// The peer also routes GitLab and Gitea hooks: their routed rules and hookRoutings projections go only to such a peer.
export const HOOK_DECISION_ROUTING_V2_FEATURE = 'hook-decision-routing-v2'
// The relay seats an ownerAsDefault assignment's decision route as the channel default, below keyword and continuity.
export const OWNER_DEFAULT_DECISION_V1_FEATURE = 'owner-default-decision-v1'
export const DECISION_LIST_MAX_BYTES = 32 * 1024
export const DECISION_EVALUATION_DETAIL_MAX_BYTES = 64 * 1024

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

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
  decisionId: z.string().uuid(),
  purpose: z.literal('model_selection').optional()
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
    state: z.record(z.string(), z.unknown()),
    budgetMs: z.number().int().min(1).max(5000).optional()
  })
  .refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 32 * 1024, {
    message: 'The preview must fit within 32 KiB.'
  })
export type DecisionPreviewRequest = z.infer<typeof DecisionPreviewRequest>
export const DecisionPreviewReply = z.object({ evaluation: DecisionEvaluation })
export type DecisionPreviewReply = z.infer<typeof DecisionPreviewReply>

// Bounded, daemon-owned Recent evaluations reads; the CP proxies them and never persists the bodies.
// A hook routing lane names the routing as `integrationId` and `channel`; `source` is sent only to a hook-decision-routing-v1 peer.
const EvaluationLane = {
  agentId: z.string().uuid(),
  integrationId: z.string().min(1).max(128),
  channel: z.string().min(1).max(512),
  source: z.literal('hook_routing').optional()
}
export const DecisionEvaluationsRequest = z.strictObject({
  ...EvaluationLane,
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type DecisionEvaluationsRequest = z.infer<typeof DecisionEvaluationsRequest>
export type DecisionEvaluationsRequestInput = z.input<typeof DecisionEvaluationsRequest>
// The lane's durable session namespace (platform, tenantScope), so the CP checks that install's audience only.
export const DecisionEvaluationConversation = z.strictObject({
  platform: z.string().min(1).max(64),
  tenantScope: z.string().min(1).max(256).nullable()
})
export type DecisionEvaluationConversation = z.infer<typeof DecisionEvaluationConversation>
// Optional only so a reply without it parses and the CP can fail closed on it; the cap covers the whole reply.
export const DecisionEvaluationsReply = DecisionEvaluationRecordPage.extend({
  conversation: DecisionEvaluationConversation.optional()
}).refine((page) => encodedBytes(page) <= DECISION_LIST_MAX_BYTES, {
  message: 'The evaluation page must fit within 32 KiB.'
})
export type DecisionEvaluationsReply = z.infer<typeof DecisionEvaluationsReply>

// includeRaw is sent only to a peer advertising decision-evaluation-raw-v1, so an older strict peer never sees it.
export const DecisionEvaluationRequest = z.strictObject({
  ...EvaluationLane,
  seq: z.number().int().nonnegative(),
  includeRaw: z.literal(true).optional()
})
export type DecisionEvaluationRequest = z.infer<typeof DecisionEvaluationRequest>
export const DecisionEvaluationReply = z
  .strictObject({
    evaluation: DecisionEvaluationRecordDetail.nullable(),
    conversation: DecisionEvaluationConversation.optional()
  })
  .refine((reply) => encodedBytes(reply) <= DECISION_EVALUATION_DETAIL_MAX_BYTES, {
    message: 'The evaluation detail must fit within 64 KiB.'
  })
export type DecisionEvaluationReply = z.infer<typeof DecisionEvaluationReply>

export const DecisionModelEvaluationsRequest = z.strictObject({
  agentId: z.string().uuid(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type DecisionModelEvaluationsRequest = z.infer<typeof DecisionModelEvaluationsRequest>
export type DecisionModelEvaluationsRequestInput = z.input<typeof DecisionModelEvaluationsRequest>
export const DecisionModelEvaluationsReply = DecisionModelEvaluationRecordPage.refine(
  (page) => encodedBytes(page) <= DECISION_LIST_MAX_BYTES,
  { message: 'The evaluation page must fit within 32 KiB.' }
)
export type DecisionModelEvaluationsReply = z.infer<typeof DecisionModelEvaluationsReply>
export const DecisionModelEvaluationRequest = z.strictObject({
  agentId: z.string().uuid(),
  seq: z.number().int().positive()
})
export type DecisionModelEvaluationRequest = z.infer<typeof DecisionModelEvaluationRequest>
export const DecisionModelEvaluationReply = z
  .strictObject({
    evaluation: DecisionModelEvaluationRecordDetail.nullable()
  })
  .refine((reply) => encodedBytes(reply) <= DECISION_EVALUATION_DETAIL_MAX_BYTES, {
    message: 'The evaluation detail must fit within 64 KiB.'
  })
export type DecisionModelEvaluationReply = z.infer<typeof DecisionModelEvaluationReply>

// A bot's router verdicts across the channels the CP may read; the lane is the served member, the subject `router:<botId>`.
const RoutingLane = {
  agentId: z.string().uuid(),
  integrationId: z.string().min(1).max(128),
  botId: z.string().uuid()
}
export const DecisionRoutingEvaluationsRequest = z.strictObject({
  ...RoutingLane,
  channels: z.array(z.string().min(1).max(512)).min(1).max(100),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type DecisionRoutingEvaluationsRequest = z.infer<typeof DecisionRoutingEvaluationsRequest>
export type DecisionRoutingEvaluationsRequestInput = z.input<typeof DecisionRoutingEvaluationsRequest>
export const DecisionRoutingEvaluationsReply = DecisionRoutingEvaluationRecordPage.extend({
  conversation: DecisionEvaluationConversation.optional()
}).refine((page) => encodedBytes(page) <= DECISION_LIST_MAX_BYTES, {
  message: 'The evaluation page must fit within 32 KiB.'
})
export type DecisionRoutingEvaluationsReply = z.infer<typeof DecisionRoutingEvaluationsReply>

export const DecisionRoutingEvaluationRequest = z.strictObject({
  ...RoutingLane,
  channel: z.string().min(1).max(512),
  seq: z.number().int().nonnegative(),
  includeRaw: z.literal(true).optional()
})
export type DecisionRoutingEvaluationRequest = z.infer<typeof DecisionRoutingEvaluationRequest>
export const DecisionRoutingEvaluationReply = z
  .strictObject({
    evaluation: DecisionRoutingEvaluationRecordDetail.nullable(),
    conversation: DecisionEvaluationConversation.optional()
  })
  .refine((reply) => encodedBytes(reply) <= DECISION_EVALUATION_DETAIL_MAX_BYTES, {
    message: 'The evaluation detail must fit within 64 KiB.'
  })
export type DecisionRoutingEvaluationReply = z.infer<typeof DecisionRoutingEvaluationReply>
