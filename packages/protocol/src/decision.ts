import { z } from 'zod'

const Text = z.string().trim().min(1)
const Id = Text.max(128)
const Key = z
  .string()
  .min(1)
  .max(64)
  .refine((key) => key.trim().length > 0)
const Probability = z.number().min(0).max(1)

export const DecisionQuestion = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('choice'),
      instructions: Text,
      criteria: z
        .record(Key, Text)
        .refine((criteria) => Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 32)
    }),
    z.strictObject({
      type: z.literal('boolean'),
      instructions: Text,
      criteria: z.strictObject({ true: Text, false: Text })
    }),
    z.strictObject({ type: z.literal('score'), instructions: Text, criteria: z.array(Text).min(2).max(10) })
  ])
  .refine((question) => new TextEncoder().encode(JSON.stringify(question)).byteLength <= 16 * 1024, {
    message: 'The complete question must fit within 16 KiB.'
  })
export type DecisionQuestion = z.infer<typeof DecisionQuestion>

export const AgentDecisionIds = z
  .array(z.string().uuid())
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Decision IDs must be unique.'
  })

export const DecisionDraft = z
  .strictObject({
    name: Text.max(120),
    providerId: Id,
    model: Id,
    question: DecisionQuestion,
    visibility: z.enum(['org', 'restricted']).default('org'),
    sharedWith: z.array(Id).default([])
  })
  .superRefine((draft, ctx) => {
    if (draft.visibility === 'restricted' && draft.sharedWith.length === 0)
      ctx.addIssue({ code: 'custom', path: ['sharedWith'], message: 'Select at least one organization member.' })
    if (new Set(draft.sharedWith).size !== draft.sharedWith.length)
      ctx.addIssue({ code: 'custom', path: ['sharedWith'], message: 'Audience members must be unique.' })
  })
export type DecisionDraft = z.infer<typeof DecisionDraft>
export type DecisionDraftInput = z.input<typeof DecisionDraft>
export type DecisionDefinition = DecisionDraft & {
  id: string
  orgId: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  canEdit?: boolean
}

// The adapter catalog is versioned with the application; credentials and readiness are resolved separately.
export const DECISION_PROVIDER_PROFILES = [
  {
    id: 'typesafe',
    name: 'TypeSafe',
    kind: 'typesafe',
    models: [
      { id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean', 'choice', 'score'] },
      { id: 'jev-latest', label: 'Jev latest', questionTypes: ['boolean', 'choice', 'score'] },
      { id: 'jev-preview', label: 'Jev preview', questionTypes: ['boolean', 'choice', 'score'] }
    ]
  }
] satisfies Array<{
  id: string
  name: string
  kind: string
  models: Array<{ id: string; label: string; questionTypes: DecisionQuestion['type'][] }>
}>

// The catalog shape `supportsDecision` reads; the default is the application's own.
export type DecisionProviderCatalog = ReadonlyArray<{
  id: string
  models: ReadonlyArray<{ id: string; questionTypes: ReadonlyArray<DecisionQuestion['type']> }>
}>

export function supportsDecision(
  decision: Pick<DecisionDraft, 'providerId' | 'model'> & { question: Pick<DecisionQuestion, 'type'> },
  catalog: DecisionProviderCatalog = DECISION_PROVIDER_PROFILES
): boolean {
  return catalog.some(
    (provider) =>
      provider.id === decision.providerId &&
      provider.models.some(
        (model) => model.id === decision.model && model.questionTypes.includes(decision.question.type)
      )
  )
}

// The evaluator the per-session repository selector asks (multi-repository-workspaces.md decision 15); the daemon writes the question.
export const AgentRepositorySelector = z.object({ providerId: Id, model: Id })
export type AgentRepositorySelector = z.infer<typeof AgentRepositorySelector>

// The selector asks Choice questions, so its evaluator must answer them.
export function supportsRepositorySelector(
  selector: AgentRepositorySelector,
  catalog: DecisionProviderCatalog = DECISION_PROVIDER_PROFILES
): boolean {
  return supportsDecision({ ...selector, question: { type: 'choice' } }, catalog)
}

export const DecisionCondition = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('choice'), thresholds: z.record(Key, Probability) }),
    z.strictObject({
      type: z.literal('boolean'),
      values: z
        .array(z.boolean())
        .max(2)
        .refine((values) => new Set(values).size === values.length, 'Values must be unique.')
    }),
    z.strictObject({ type: z.literal('score'), min: z.number().nonnegative(), max: z.number().nonnegative() })
  ])
  .superRefine((condition, ctx) => {
    if (condition.type === 'score' && condition.min >= condition.max)
      ctx.addIssue({ code: 'custom', path: ['max'], message: 'The upper bound must exceed the lower bound.' })
  })
export type DecisionCondition = z.infer<typeof DecisionCondition>

export const DECISION_CHAIN_MAX_STEPS = 8

export interface DecisionChainStep {
  decisionId: string
}

export function decisionChainIds(
  chain: (DecisionChainStep & { steps?: readonly DecisionChainStep[] }) | null | undefined
): string[] {
  return chain ? [...new Set([chain.decisionId, ...(chain.steps ?? []).map((step) => step.decisionId)])] : []
}

function validateDecisionChain<T extends DecisionChainStep>(
  chain: T & { steps?: Array<T & { id: string }> },
  edges: (step: T) => Array<{ id: string; path: Array<string | number> }>,
  ctx: z.RefinementCtx
): void {
  const steps = new Map(chain.steps?.map((step) => [step.id, step]))
  if (steps.size !== (chain.steps?.length ?? 0))
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Step IDs must be unique.' })
  const visited = new Set<string>()
  const visit = (step: T, ancestors: Set<string>, path: Array<string | number>) => {
    for (const edge of edges(step)) {
      const target = steps.get(edge.id)
      if (!target || ancestors.has(edge.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, ...edge.path],
          message: target ? 'Decision steps must not form a cycle.' : 'Choose an existing next step.'
        })
        continue
      }
      if (visited.has(target.id)) continue
      visited.add(target.id)
      visit(target, new Set([...ancestors, target.id]), ['steps', chain.steps!.indexOf(target)])
    }
  }
  visit(chain, new Set(), [])
  chain.steps?.forEach((step, index) => {
    if (!visited.has(step.id))
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index],
        message: 'Every step must be reachable from the first Decision.'
      })
  })
}

export const DecisionGateStep = z.strictObject({
  decisionId: Id,
  when: DecisionCondition,
  nextStepId: Id.optional(),
  elseStepId: Id.optional()
})
export type DecisionGateStep = z.infer<typeof DecisionGateStep>

export const ChannelDecisionGate = DecisionGateStep.extend({
  type: z.literal('gate'),
  steps: z
    .array(DecisionGateStep.extend({ id: Id }))
    .max(DECISION_CHAIN_MAX_STEPS - 1)
    .optional()
}).superRefine((gate, ctx) =>
  validateDecisionChain<DecisionGateStep>(
    gate,
    (step) =>
      (['nextStepId', 'elseStepId'] as const).flatMap((key) => (step[key] ? [{ id: step[key]!, path: [key] }] : [])),
    ctx
  )
)
export type ChannelDecisionGate = z.infer<typeof ChannelDecisionGate>

export const DecisionRuntimeTarget = z.strictObject({
  runtime: Text.max(128),
  model: Text.max(256),
  effort: z.string().trim().max(128).optional(),
  permissionMode: Text.max(128).optional(),
  fastMode: z.boolean().optional()
})
export type DecisionRuntimeTarget = z.infer<typeof DecisionRuntimeTarget>

export const DecisionModelTarget = z.union([DecisionRuntimeTarget, z.strictObject({ nextStepId: Id })])
export type DecisionModelTarget = z.infer<typeof DecisionModelTarget>

const DecisionModelRule = z.union([
  DecisionRuntimeTarget.extend({ when: DecisionCondition }),
  z.strictObject({ nextStepId: Id, when: DecisionCondition })
])

export const DecisionModelStep = z.strictObject({
  decisionId: z.string().uuid(),
  rules: z.array(DecisionModelRule).min(1).max(32)
})
export type DecisionModelStep = z.infer<typeof DecisionModelStep>

export const AgentModelSelection = DecisionModelStep.extend({
  steps: z
    .array(DecisionModelStep.extend({ id: Id }))
    .max(DECISION_CHAIN_MAX_STEPS - 1)
    .optional()
}).superRefine((selection, ctx) =>
  validateDecisionChain<DecisionModelStep>(
    selection,
    (step) =>
      step.rules.flatMap((rule, index) =>
        'nextStepId' in rule ? [{ id: rule.nextStepId, path: ['rules', index, 'nextStepId'] }] : []
      ),
    ctx
  )
)
export type AgentModelSelection = z.infer<typeof AgentModelSelection>

export const modelSelectionDecisionIds = decisionChainIds

export function modelSelectionTargets(selection: AgentModelSelection): DecisionRuntimeTarget[] {
  return [selection, ...(selection.steps ?? [])].flatMap((step) =>
    step.rules.flatMap(({ when: _when, ...target }) => ('runtime' in target ? [target] : []))
  )
}

export const ChannelDecisionBinding = z.discriminatedUnion('type', [
  ChannelDecisionGate,
  z.strictObject({ type: z.literal('shared_bot_routing') })
])
export type ChannelDecisionBinding = z.infer<typeof ChannelDecisionBinding>

// Only the executable fields travel; visibility, audience, and audit fields are CP authorization metadata.
export const DecisionBundleDefinition = z.object({
  id: Id,
  orgId: z.string().min(1).max(64),
  name: Text.max(120),
  providerId: Id,
  model: Id,
  question: DecisionQuestion
})
export type DecisionBundleDefinition = z.infer<typeof DecisionBundleDefinition>

export const DecisionBundleBinding = z.object({
  channel: z.string().min(1),
  consumer: ChannelDecisionBinding,
  enabled: z.boolean(),
  disabledReason: z.enum(['needs_review', 'access_revoked', 'paused']).optional()
})
export type DecisionBundleBinding = z.infer<typeof DecisionBundleBinding>

export const DecisionChannelSettings = z.discriminatedUnion('trigger', [
  z.strictObject({ trigger: z.enum(['off', 'mention', 'auto']) }),
  z.strictObject({ trigger: z.literal('decision'), decisionBinding: ChannelDecisionBinding })
])
export type DecisionChannelSettings = z.infer<typeof DecisionChannelSettings>

export const RoutingAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('agent'), agentId: Id }),
  z.strictObject({ type: z.literal('skip') }),
  z.strictObject({ type: z.literal('decision'), nextStepId: Id })
])
export type RoutingAction = z.infer<typeof RoutingAction>

export const DecisionRoutingStep = z.strictObject({
  decisionId: Id,
  rules: z.array(z.strictObject({ id: Id, when: DecisionCondition, action: RoutingAction })).max(32)
})
export type DecisionRoutingStep = z.infer<typeof DecisionRoutingStep>

export const SharedBotDecisionRouting = DecisionRoutingStep.extend({
  enabled: z.boolean(),
  otherwise: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('default_agent') }),
    z.strictObject({ type: z.literal('skip') })
  ]),
  steps: z
    .array(DecisionRoutingStep.extend({ id: Id }))
    .max(DECISION_CHAIN_MAX_STEPS - 1)
    .optional()
}).superRefine((routing, ctx) => {
  validateDecisionChain<DecisionRoutingStep>(
    routing,
    (step) =>
      step.rules.flatMap((rule, index) =>
        rule.action.type === 'decision'
          ? [{ id: rule.action.nextStepId, path: ['rules', index, 'action', 'nextStepId'] }]
          : []
      ),
    ctx
  )
  const rules = [routing, ...(routing.steps ?? [])].flatMap((step) => step.rules)
  if (rules.length > 32 || new Set(rules.map((rule) => rule.id)).size !== rules.length)
    ctx.addIssue({ code: 'custom', path: ['rules'], message: 'Use at most 32 rules with unique IDs across the chain.' })
})
export type SharedBotDecisionRouting = z.infer<typeof SharedBotDecisionRouting>

export function decisionRoutingAgentIds(routing: Pick<SharedBotDecisionRouting, 'rules' | 'steps'>): string[] {
  return [
    ...new Set(
      [routing, ...(routing.steps ?? [])].flatMap((step) =>
        step.rules.flatMap((rule) => (rule.action.type === 'agent' ? [rule.action.agentId] : []))
      )
    )
  ]
}

// The bot's routing config for exactly the conversations this recipient hosts, with each resolved default agent.
export const SharedBotRoutingProjection = z.object({
  botId: Id,
  config: SharedBotDecisionRouting,
  channels: z.array(z.object({ channel: z.string().min(1), defaultAgentId: z.string().uuid().optional() })).max(1000)
})
export type SharedBotRoutingProjection = z.infer<typeof SharedBotRoutingProjection>

// The complete per-integration Decision configuration (decisions.md §7.1); an empty bundle clears.
export const DecisionBundle = z.object({
  bindings: z.array(DecisionBundleBinding).max(1000).default([]),
  definitions: z.array(DecisionBundleDefinition).max(1000).default([]),
  sharedBotRouting: SharedBotRoutingProjection.optional()
})
export type DecisionBundle = z.infer<typeof DecisionBundle>

export const EMPTY_DECISION_BUNDLE: DecisionBundle = { bindings: [], definitions: [] }

// Code-host routing (code-host-decisions.md §3): one per organization, provider, repository and subject family.
export const CODE_HOST_ROUTING_FAMILIES = ['issues', 'pull_request', 'merge_request'] as const
export const CodeHostRoutingFamily = z.enum(CODE_HOST_ROUTING_FAMILIES)
export type CodeHostRoutingFamily = z.infer<typeof CodeHostRoutingFamily>

// Kept equal to CODE_HOST_PROVIDERS by a test: this leaf module may not import code-host.ts.
export const CODE_HOST_ROUTING_PROVIDERS = ['github', 'gitlab', 'gitea'] as const
export const CodeHostRoutingProvider = z.enum(CODE_HOST_ROUTING_PROVIDERS)
export type CodeHostRoutingProvider = z.infer<typeof CodeHostRoutingProvider>

// Each provider's routable families, in the names its hook rows store.
export const CODE_HOST_ROUTING_PROVIDER_FAMILIES: Record<CodeHostRoutingProvider, readonly CodeHostRoutingFamily[]> = {
  github: ['issues', 'pull_request'],
  gitlab: ['issues', 'merge_request'],
  gitea: ['issues', 'merge_request']
}

export function isCodeHostRoutingScope(provider: string, family: string | null | undefined): boolean {
  const families = CODE_HOST_ROUTING_PROVIDER_FAMILIES[provider as CodeHostRoutingProvider] as
    readonly string[] | undefined
  return families !== undefined && families.includes(family ?? '')
}

// What the evaluation host needs: the config, its Decision, and every watching hook a rule may name.
export const HookRoutingProjection = z
  .object({
    routingId: Id,
    provider: CodeHostRoutingProvider,
    repoId: z.string().min(1).max(64),
    repoFullName: z.string().min(1).max(256),
    family: CodeHostRoutingFamily,
    config: SharedBotDecisionRouting,
    definition: DecisionBundleDefinition,
    definitions: z.array(DecisionBundleDefinition).max(DECISION_CHAIN_MAX_STEPS).optional(),
    members: z.array(z.object({ agentId: z.string().uuid(), hookId: z.string().uuid() })).max(64)
  })
  .refine((projection) => isCodeHostRoutingScope(projection.provider, projection.family), {
    path: ['family'],
    message: 'The family is not routable for this provider.'
  })
export type HookRoutingProjection = z.infer<typeof HookRoutingProjection>

export const DecisionAnswer = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('boolean'), value: z.boolean(), probability: Probability }),
  z.strictObject({
    type: z.literal('choice'),
    value: Key,
    probabilities: z.record(Key, Probability),
    confidence: Probability
  }),
  z.strictObject({
    type: z.literal('score'),
    value: z.number().nonnegative(),
    probabilities: z.array(Probability),
    confidence: Probability
  })
])
export type DecisionAnswer = z.infer<typeof DecisionAnswer>

export const DecisionEvaluation = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('answered'),
    answer: DecisionAnswer,
    model: Id,
    usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['timeout', 'capacity', 'credentials', 'provider', 'invalid_response', 'unsupported_input'])
  })
])
export type DecisionEvaluation = z.infer<typeof DecisionEvaluation>

export const DecisionChainTrace = z
  .array(
    z.strictObject({
      stepId: z.string().max(128),
      decisionId: Id,
      evaluation: DecisionEvaluation
    })
  )
  .max(DECISION_CHAIN_MAX_STEPS)
export type DecisionChainTrace = z.infer<typeof DecisionChainTrace>

// A Gate Try sample: ordered history lines with sender ids, then the message being judged.
export const DecisionPreviewSample = z.strictObject({
  history: z
    .array(z.strictObject({ sender: z.string().trim().min(1).max(128), text: z.string().max(16 * 1024) }))
    .max(50),
  currentMessage: z.strictObject({
    sender: z.string().trim().min(1).max(128).optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024)
  })
})
export type DecisionPreviewSample = z.infer<typeof DecisionPreviewSample>

// The answer a Recent evaluations row shows: the value and its confidence, never a probability vector.
export const DecisionAnswerSummary = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('boolean'), value: z.boolean(), probability: Probability }),
  z.strictObject({ type: z.literal('choice'), value: Key, confidence: Probability }),
  z.strictObject({ type: z.literal('score'), value: z.number().nonnegative(), confidence: Probability })
])
export type DecisionAnswerSummary = z.infer<typeof DecisionAnswerSummary>

// One frozen state entry as the daemon evaluated it; the current message is never truncated, so it may exceed 16 KiB.
export const DecisionEvaluationEntry = z.object({
  id: z.string().max(256),
  sender: z.object({ id: z.string().max(256) }),
  text: z.string().max(32 * 1024),
  quote: z.object({ sender: z.string().max(256).optional(), text: z.string().max(32 * 1024) }).optional(),
  threadId: z.string().max(512).nullable(),
  time: z.string().max(64).optional(),
  truncated: z.literal(true).optional()
})
export type DecisionEvaluationEntry = z.infer<typeof DecisionEvaluationEntry>

export const DecisionEvaluationOutcome = z.enum(['triggered', 'skipped', 'unavailable', 'canceled', 'pending'])
export type DecisionEvaluationOutcome = z.infer<typeof DecisionEvaluationOutcome>

// The frozen input an evaluation saw: the current message, bounded history, and context trimming.
export const DecisionEvaluationInput = z.strictObject({
  currentMessage: DecisionEvaluationEntry,
  history: z.array(DecisionEvaluationEntry).max(100),
  historyOmitted: z.number().int().nonnegative(),
  context: z.strictObject({
    partial: z.boolean(),
    reasons: z.array(z.string().max(64)).max(8),
    omittedMessages: z.number().int().nonnegative()
  })
})
export type DecisionEvaluationInput = z.infer<typeof DecisionEvaluationInput>

// Raw provider JSON as sent or received, capped; `truncated` marks a cut body.
export const DECISION_RAW_JSON_MAX_CHARS = 16 * 1024
export const DecisionRawJson = z.strictObject({
  text: z.string().max(DECISION_RAW_JSON_MAX_CHARS),
  truncated: z.boolean()
})
export type DecisionRawJson = z.infer<typeof DecisionRawJson>

// A Recent evaluations summary row, read from the daemon's decision_verdict (decisions.md §9.5).
export const DecisionEvaluationRecord = z.strictObject({
  seq: z.number().int().nonnegative(),
  at: z.string().max(64),
  messageId: z.string().max(256).nullable(),
  decisionId: Id,
  outcome: DecisionEvaluationOutcome,
  reason: z.string().max(128).nullable(),
  answer: DecisionAnswerSummary.nullable(),
  matchedKeys: z.array(Key).max(32),
  latencyMs: z.number().int().nonnegative().nullable(),
  requestedModel: Id,
  actualModel: z.string().max(256).nullable(),
  usage: z
    .strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
    .nullable(),
  detailsExpired: z.boolean()
})
export type DecisionEvaluationRecord = z.infer<typeof DecisionEvaluationRecord>

// The frozen snapshot, input, and answer of one evaluation; never rebuilt from current definitions.
export const DecisionEvaluationRecordDetail = DecisionEvaluationRecord.extend({
  snapshot: z
    .strictObject({
      decisionId: Id,
      providerId: Id,
      model: Id,
      question: DecisionQuestion,
      condition: DecisionCondition,
      sessionMode: z.string().max(64)
    })
    .nullable(),
  input: DecisionEvaluationInput.nullable(),
  fullAnswer: DecisionAnswer.nullable(),
  chain: DecisionChainTrace.optional(),
  // Present only when the CP asked for it (decision-evaluation-raw-v1); null once retention strips bodies.
  rawRequest: DecisionRawJson.nullable().optional(),
  rawResponse: DecisionRawJson.nullable().optional(),
  evidence: z
    .strictObject({
      snapshotSeq: z.number().int().nonnegative(),
      suppliedBackground: z.number().int().nonnegative().nullable()
    })
    .nullable()
})
export type DecisionEvaluationRecordDetail = z.infer<typeof DecisionEvaluationRecordDetail>

export const DecisionEvaluationRecordPage = z.strictObject({
  items: z.array(DecisionEvaluationRecord).max(50),
  nextCursor: z.number().int().positive().nullable()
})
export type DecisionEvaluationRecordPage = z.infer<typeof DecisionEvaluationRecordPage>

const Usage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative()
})

// Router outcomes (decisions.md §9.5); Partially routed is at least one admitted and one rejected or unavailable target.
export const DecisionRoutingEvaluationOutcome = z.enum([
  'routed',
  'partially_routed',
  'skipped',
  'fallback',
  'unavailable',
  'canceled',
  'pending'
])
export type DecisionRoutingEvaluationOutcome = z.infer<typeof DecisionRoutingEvaluationOutcome>

export const RoutingTargetEffectSchema = z.enum([
  'participant',
  'kept',
  'selected',
  'default_agent',
  'fallback_constrained',
  'fallback_default'
])
export const RoutingTargetDisposition = z.enum(['pending', 'admitted', 'rejected', 'unavailable'])
export type RoutingTargetDisposition = z.infer<typeof RoutingTargetDisposition>

// One frozen router target and its admission status; never a message body.
export const DecisionRoutingTargetRecord = z.strictObject({
  agentId: Id,
  effect: RoutingTargetEffectSchema,
  via: z.enum(['mention', 'implicit']),
  participant: z.boolean(),
  disposition: RoutingTargetDisposition,
  reason: z.string().max(128).nullable()
})
export type DecisionRoutingTargetRecord = z.infer<typeof DecisionRoutingTargetRecord>

// A routing Recent evaluations row, read from a router verdict (subject `router:<botId>`).
export const DecisionRoutingEvaluationRecord = z.strictObject({
  seq: z.number().int().nonnegative(),
  at: z.string().max(64),
  channel: z.string().max(512),
  messageId: z.string().max(256).nullable(),
  decisionId: Id,
  outcome: DecisionRoutingEvaluationOutcome,
  reason: z.string().max(128).nullable(),
  evaluated: z.boolean(),
  answer: DecisionAnswerSummary.nullable(),
  matchedKeys: z.array(Key).max(32),
  matchedRuleIds: z.array(Id).max(32),
  usedOtherwise: z.boolean(),
  fallback: z.enum(['constrained', 'default', 'none']).nullable(),
  targets: z.array(DecisionRoutingTargetRecord).max(64),
  latencyMs: z.number().int().nonnegative().nullable(),
  requestedModel: Id,
  actualModel: z.string().max(256).nullable(),
  usage: Usage.nullable(),
  detailsExpired: z.boolean()
})
export type DecisionRoutingEvaluationRecord = z.infer<typeof DecisionRoutingEvaluationRecord>

// The frozen routing snapshot, target constraint, and input of one router verdict.
export const DecisionRoutingEvaluationRecordDetail = DecisionRoutingEvaluationRecord.extend({
  snapshot: z
    .strictObject({
      decisionId: Id,
      providerId: Id,
      model: Id,
      question: DecisionQuestion,
      routing: SharedBotDecisionRouting,
      defaultAgentId: Id.nullable()
    })
    .nullable(),
  constraint: z
    .array(z.strictObject({ agentId: Id, participant: z.boolean(), via: z.enum(['mention', 'implicit']) }))
    .max(64)
    .nullable(),
  input: DecisionEvaluationInput.nullable(),
  fullAnswer: DecisionAnswer.nullable(),
  chain: DecisionChainTrace.optional(),
  rawRequest: DecisionRawJson.nullable().optional(),
  rawResponse: DecisionRawJson.nullable().optional()
})
export type DecisionRoutingEvaluationRecordDetail = z.infer<typeof DecisionRoutingEvaluationRecordDetail>

export const DecisionRoutingEvaluationRecordPage = z.strictObject({
  items: z.array(DecisionRoutingEvaluationRecord).max(50),
  nextCursor: z.number().int().positive().nullable()
})
export type DecisionRoutingEvaluationRecordPage = z.infer<typeof DecisionRoutingEvaluationRecordPage>

export interface DecisionValidationIssue {
  path: Array<string | number>
  message: string
}

export function decisionConditionIssues(
  question: DecisionQuestion,
  condition: DecisionCondition,
  routing = false
): DecisionValidationIssue[] {
  const issues: DecisionValidationIssue[] = []
  const parsed = DecisionCondition.safeParse(condition)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  if (question.type !== condition.type) return [{ path: ['type'], message: 'Condition type must match the question.' }]
  if (question.type === 'choice' && condition.type === 'choice') {
    for (const key of Object.keys(condition.thresholds)) {
      if (!Object.hasOwn(question.criteria, key))
        issues.push({ path: ['thresholds', key], message: 'Choice no longer exists.' })
    }
    if (routing && Object.keys(condition.thresholds).length === 0)
      issues.push({ path: ['thresholds'], message: 'Select at least one choice for a routing rule.' })
  }
  if (routing && condition.type === 'boolean' && condition.values.length === 0)
    issues.push({ path: ['values'], message: 'Select at least one value for a routing rule.' })
  if (question.type === 'score' && condition.type === 'score' && condition.max > question.criteria.length - 1)
    issues.push({ path: ['max'], message: 'The interval exceeds the rubric maximum.' })
  return issues
}

export function decisionRoutingIssues(
  question: DecisionQuestion,
  routing: SharedBotDecisionRouting,
  questions?: ReadonlyMap<string, DecisionQuestion>
): DecisionValidationIssue[] {
  const parsed = SharedBotDecisionRouting.safeParse(routing)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return [
    ...decisionRuleIssues(question, routing.rules),
    ...(routing.steps ?? []).flatMap((step, index) => {
      const next = questions?.get(step.decisionId)
      return next
        ? decisionRuleIssues(next, step.rules).map((issue) => ({ ...issue, path: ['steps', index, ...issue.path] }))
        : []
    })
  ]
}

export function decisionGateIssues(
  question: DecisionQuestion,
  gate: ChannelDecisionGate,
  questions?: ReadonlyMap<string, DecisionQuestion>
): DecisionValidationIssue[] {
  const parsed = ChannelDecisionGate.safeParse(gate)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return [
    ...decisionConditionIssues(question, gate.when),
    ...(gate.steps ?? []).flatMap((step, index) => {
      const next = questions?.get(step.decisionId)
      return next
        ? decisionConditionIssues(next, step.when).map((issue) => ({
            ...issue,
            path: ['steps', index, 'when', ...issue.path]
          }))
        : []
    })
  ]
}

export function nextGateStep(
  question: DecisionQuestion,
  step: DecisionGateStep,
  answer: DecisionAnswer
): { matched: boolean; matchedKeys: string[]; nextStepId?: string } {
  const match = matchDecisionCondition(question, step.when, answer)
  const nextStepId = match.matched ? step.nextStepId : step.elseStepId
  return { ...match, ...(nextStepId ? { nextStepId } : {}) }
}

const DUPLICATE_ANSWER = 'An answer can appear in only one routing rule.'
const OVERLAPPING_INTERVALS = 'Score intervals must not overlap.'

// Both rows of a duplicated key or an overlapping interval are marked, so the editor can flag each one.
function decisionRuleIssues(
  question: DecisionQuestion,
  rules: readonly { when: DecisionCondition }[]
): DecisionValidationIssue[] {
  const issues: DecisionValidationIssue[] = []
  const conflicts = new Map<number, Set<string>>()
  const mark = (index: number, message: string) => {
    const marked = conflicts.get(index) ?? new Set<string>()
    marked.add(message)
    conflicts.set(index, marked)
  }
  const assigned = new Map<string, number>()
  const intervals: Array<{ index: number; min: number; max: number }> = []
  rules.forEach((rule, index) => {
    const path = ['rules', index, 'when']
    issues.push(
      ...decisionConditionIssues(question, rule.when, true).map((issue) => ({
        ...issue,
        path: [...path, ...issue.path]
      }))
    )
    const condition = rule.when
    const keys =
      condition.type === 'choice'
        ? Object.keys(condition.thresholds)
        : condition.type === 'boolean'
          ? condition.values.map(String)
          : []
    for (const key of keys) {
      const prior = assigned.get(key)
      if (prior !== undefined) {
        mark(prior, DUPLICATE_ANSWER)
        mark(index, DUPLICATE_ANSWER)
      } else assigned.set(key, index)
    }
    if (condition.type === 'score') {
      for (const other of intervals)
        if (condition.min < other.max && other.min < condition.max) {
          mark(other.index, OVERLAPPING_INTERVALS)
          mark(index, OVERLAPPING_INTERVALS)
        }
      intervals.push({ index, min: condition.min, max: condition.max })
    }
  })
  for (const [index, messages] of [...conflicts].sort(([a], [b]) => a - b))
    for (const message of messages) issues.push({ path: ['rules', index, 'when'], message })
  return issues
}

export function decisionModelSelectionIssues(
  question: DecisionQuestion,
  selection: AgentModelSelection,
  questions?: ReadonlyMap<string, DecisionQuestion>
): DecisionValidationIssue[] {
  const parsed = AgentModelSelection.safeParse(selection)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return [
    ...decisionRuleIssues(question, selection.rules),
    ...(selection.steps ?? []).flatMap((step, index) => {
      const question = questions?.get(step.decisionId)
      return question
        ? decisionRuleIssues(question, step.rules).map((issue) => ({ ...issue, path: ['steps', index, ...issue.path] }))
        : []
    })
  ]
}

// A model consumer selects one winner; equal choice probabilities retain the configured rule order.
export function selectDecisionTarget(
  question: DecisionQuestion,
  selection: DecisionModelStep,
  answer: DecisionAnswer
): DecisionModelTarget | undefined {
  DecisionModelStep.parse({ decisionId: selection.decisionId, rules: selection.rules })
  requireValid(decisionRuleIssues(question, selection.rules))
  parseDecisionAnswer(question, answer)
  let selected: { target: DecisionModelTarget; probability: number } | undefined
  for (const { when, ...target } of selection.rules) {
    const match = matchDecisionCondition(question, when, answer)
    if (!match.matched) continue
    const probability =
      answer.type === 'choice' ? Math.max(...match.matchedKeys.map((key) => answer.probabilities[key]!)) : 1
    if (!selected || probability > selected.probability) selected = { target, probability }
  }
  return selected?.target
}

export function parseDecisionAnswer(question: DecisionQuestion, input: unknown): DecisionAnswer {
  return DecisionAnswer.superRefine((answer, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (question.type !== answer.type) return issue('Answer type must match the question.')
    if (answer.type === 'boolean') {
      const expected = answer.probability >= 0.5
      if (answer.value !== expected) issue('Boolean value must agree with the probability of Yes.')
    }
    if (question.type === 'choice' && answer.type === 'choice') {
      const keys = Object.keys(question.criteria)
      if (!Object.hasOwn(question.criteria, answer.value)) issue('Answer is not a declared choice.')
      if (
        Object.keys(answer.probabilities).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(answer.probabilities, key))
      )
        issue('Probabilities must cover exactly the declared choices.')
    }
    if (question.type === 'score' && answer.type === 'score') {
      if (answer.value > question.criteria.length - 1) issue('Score exceeds the rubric maximum.')
      if (answer.probabilities.length !== question.criteria.length) issue('Probabilities must cover every score level.')
    }
    if (answer.type !== 'boolean') {
      const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0)
      if (Math.abs(sum - 1) > 1e-5) issue('Probabilities must sum to one.')
    }
  }).parse(input)
}

function requireValid(issues: DecisionValidationIssue[]): void {
  if (issues.length) throw new z.ZodError(issues.map((issue) => ({ code: 'custom', ...issue })))
}

export function matchDecisionCondition(
  question: DecisionQuestion,
  condition: DecisionCondition,
  answer: DecisionAnswer
): { matched: boolean; matchedKeys: string[] } {
  requireValid(decisionConditionIssues(question, condition))
  parseDecisionAnswer(question, answer)
  if (condition.type === 'choice' && answer.type === 'choice') {
    const matchedKeys = Object.entries(condition.thresholds)
      .filter(([key, threshold]) => answer.probabilities[key]! >= threshold)
      .map(([key]) => key)
    return { matched: matchedKeys.length > 0, matchedKeys }
  }
  if (condition.type === 'boolean' && answer.type === 'boolean')
    return { matched: condition.values.includes(answer.value), matchedKeys: [] }
  if (question.type === 'score' && condition.type === 'score' && answer.type === 'score') {
    const includesMaximum = condition.max === question.criteria.length - 1
    return {
      matched:
        answer.value >= condition.min &&
        (answer.value < condition.max || (includesMaximum && answer.value === condition.max)),
      matchedKeys: []
    }
  }
  return { matched: false, matchedKeys: [] }
}

export interface DecisionRoutingMatch {
  matchedRuleIds: string[]
  matchedKeys: string[]
  agentIds: string[]
  usedOtherwise: boolean
  activates: boolean
}

export function matchDecisionRouting(
  question: DecisionQuestion,
  routing: SharedBotDecisionRouting,
  answer: DecisionAnswer,
  defaultAgentId?: string,
  chain?: ReadonlyMap<string, { question: DecisionQuestion; answer: DecisionAnswer }>
): DecisionRoutingMatch {
  requireValid(decisionRoutingIssues(question, routing))
  parseDecisionAnswer(question, answer)
  const result: DecisionRoutingMatch = {
    matchedRuleIds: [],
    matchedKeys: [],
    agentIds: [],
    usedOtherwise: false,
    activates: false
  }
  if (!routing.enabled) return result
  const visited = new Set<string>()
  const steps = new Map(routing.steps?.map((step) => [step.id, step]))
  const visit = (step: DecisionRoutingStep, question: DecisionQuestion, answer: DecisionAnswer) => {
    requireValid(decisionRuleIssues(question, step.rules))
    const matched = step.rules.filter((rule) => {
      const match = matchDecisionCondition(question, rule.when, answer)
      if (match.matched) result.matchedKeys.push(...match.matchedKeys)
      return match.matched
    })
    if (!matched.length) result.usedOtherwise = true
    for (const rule of matched) {
      result.matchedRuleIds.push(rule.id)
      if (rule.action.type === 'agent') result.agentIds.push(rule.action.agentId)
      if (rule.action.type === 'decision' && !visited.has(rule.action.nextStepId)) {
        const id = rule.action.nextStepId
        const next = steps.get(id)
        const evaluated = chain?.get(id)
        if (!next || !evaluated) throw new Error('Missing chained Decision answer.')
        visited.add(id)
        visit(next, evaluated.question, evaluated.answer)
      }
    }
  }
  visit(routing, question, answer)
  result.activates = result.agentIds.length > 0 || (result.usedOtherwise && routing.otherwise.type === 'default_agent')
  if (result.usedOtherwise && routing.otherwise.type === 'default_agent' && defaultAgentId)
    result.agentIds.push(defaultAgentId)
  result.matchedKeys = [...new Set(result.matchedKeys)].slice(0, 32)
  result.agentIds = [...new Set(result.agentIds)]
  return result
}

export function decisionConditionNeedsReview(
  previous: DecisionQuestion,
  next: DecisionQuestion,
  condition: DecisionCondition
): boolean {
  return (
    decisionConditionIssues(next, condition).length > 0 ||
    (previous.type === 'score' && next.type === 'score' && previous.criteria.length !== next.criteria.length)
  )
}

/** A constrained recipient as the host received it; `participant` is the relay's participant flag. */
export interface RoutingConstraintInput {
  agentId: string
  participant: boolean
  daemonId?: string | null
  integrationId?: string
  via?: 'mention' | 'implicit'
}

export interface RoutingCandidate {
  agentId: string
  daemonId: string
  integrationId?: string
}

export type RoutingTargetEffect =
  'participant' | 'kept' | 'selected' | 'default_agent' | 'fallback_constrained' | 'fallback_default'

export interface RoutingTarget {
  agentId: string
  daemonId: string | null
  integrationId?: string
  participant: boolean
  effect: RoutingTargetEffect
  via: 'mention' | 'implicit'
  unavailableReason?: 'not_member'
}

/** message-intake.md §6 step 3: participants are unconditional, the rest decision-eligible; evaluate iff unconstrained or any eligible. */
export function partitionRoutingConstraint<T extends RoutingConstraintInput>(
  constraint: readonly T[]
): { participants: T[]; eligible: T[]; evaluate: boolean } {
  const byAgent = new Map<string, T>()
  for (const entry of constraint) {
    const prior = byAgent.get(entry.agentId)
    // One entry per agent; participation wins over an eligible duplicate.
    if (!prior || (!prior.participant && entry.participant)) byAgent.set(entry.agentId, entry)
  }
  const entries = [...byAgent.values()]
  const participants = entries.filter((entry) => entry.participant)
  const eligible = entries.filter((entry) => !entry.participant)
  return { participants, eligible, evaluate: entries.length === 0 || eligible.length > 0 }
}

export interface RoutingSettlement {
  evaluate: boolean
  targets: RoutingTarget[]
  disposition: 'match' | 'skip' | 'unavailable'
  fallback?: 'constrained' | 'default' | 'none'
  match?: DecisionRoutingMatch
}

/** decisions.md §3.2 settlement of one router verdict: the frozen, deduplicated target set, or skip. */
export function resolveRoutingTargets(input: {
  question: DecisionQuestion
  routing: SharedBotDecisionRouting
  answer: DecisionAnswer | 'unavailable' | undefined
  constraint: readonly RoutingConstraintInput[]
  defaultAgentId?: string
  candidates: readonly RoutingCandidate[]
  chain?: ReadonlyMap<string, { question: DecisionQuestion; answer: DecisionAnswer }>
}): RoutingSettlement {
  const { participants, eligible, evaluate } = partitionRoutingConstraint(input.constraint)
  const constrained = participants.length + eligible.length > 0
  const fromEntry = (entry: RoutingConstraintInput, effect: RoutingTargetEffect): RoutingTarget => ({
    agentId: entry.agentId,
    daemonId: entry.daemonId ?? null,
    ...(entry.integrationId ? { integrationId: entry.integrationId } : {}),
    participant: entry.participant,
    effect,
    via: entry.via ?? 'implicit'
  })
  const kept = participants.map((entry) => fromEntry(entry, 'participant'))
  const fromCandidate = (agentId: string, effect: RoutingTargetEffect): RoutingTarget => {
    const candidate = input.candidates.find((c) => c.agentId === agentId)
    // A selected agent missing from the directory is Target unavailable, never a reroute (§3.3).
    if (!candidate)
      return { agentId, daemonId: null, participant: false, effect, via: 'implicit', unavailableReason: 'not_member' }
    return {
      agentId,
      daemonId: candidate.daemonId,
      ...(candidate.integrationId ? { integrationId: candidate.integrationId } : {}),
      participant: false,
      effect,
      via: 'implicit'
    }
  }
  // Every recipient participates: the set settles with no model call.
  if (!evaluate) return { evaluate, targets: kept, disposition: 'match' }
  // An eligible message with no answer is an evaluation failure: keep the constrained, or use the default.
  if (input.answer === 'unavailable' || input.answer === undefined) {
    if (constrained) {
      const targets = [...kept, ...eligible.map((entry) => fromEntry(entry, 'fallback_constrained'))]
      return { evaluate, targets, disposition: 'unavailable', fallback: 'constrained' }
    }
    if (!input.defaultAgentId) return { evaluate, targets: [], disposition: 'unavailable', fallback: 'none' }
    return {
      evaluate,
      targets: [fromCandidate(input.defaultAgentId, 'fallback_default')],
      disposition: 'unavailable',
      fallback: 'default'
    }
  }
  const match = matchDecisionRouting(input.question, input.routing, input.answer, input.defaultAgentId, input.chain)
  let targets: RoutingTarget[]
  if (constrained) {
    // An activating result keeps the eligible recipients; it never adds or replaces them (§3.2 step 5).
    targets = match.activates ? [...kept, ...eligible.map((entry) => fromEntry(entry, 'kept'))] : kept
  } else {
    const ruleAgents = new Set(
      [input.routing, ...(input.routing.steps ?? [])]
        .flatMap((step) => step.rules)
        .filter((rule) => match.matchedRuleIds.includes(rule.id) && rule.action.type === 'agent')
        .map((rule) => (rule.action as { agentId: string }).agentId)
    )
    targets = match.agentIds.map((agentId) =>
      fromCandidate(agentId, ruleAgents.has(agentId) ? 'selected' : 'default_agent')
    )
  }
  return { evaluate, targets, disposition: targets.length > 0 ? 'match' : 'skip', match }
}

/** Each rule's own match against an answer, in rule order, so a preview can show every threshold result. */
export function decisionRoutingRuleMatches(
  question: DecisionQuestion,
  routing: Pick<SharedBotDecisionRouting, 'rules'>,
  answer: DecisionAnswer
): Array<{ ruleId: string; matched: boolean; matchedKeys: string[] }> {
  return routing.rules.map((rule) => ({ ruleId: rule.id, ...matchDecisionCondition(question, rule.when, answer) }))
}

export type RoutingPreviewOutcome = 'activate' | 'continue' | 'skip' | 'unavailable'

export interface RoutingPreviewSettlement extends RoutingSettlement {
  rules: Array<{ ruleId: string; matched: boolean; matchedKeys: string[] }>
  outcome: RoutingPreviewOutcome
  /** Set when the answer failed validation and settled like the router's `invalid_response`. */
  reason?: 'invalid_response'
}

/** The router's settlement (resolveRoutingTargets) plus per-rule detail; an invalid answer re-settles as unavailable. */
export function settleRoutingPreview(input: Parameters<typeof resolveRoutingTargets>[0]): RoutingPreviewSettlement {
  let settlement: RoutingSettlement
  let reason: 'invalid_response' | undefined
  try {
    settlement = resolveRoutingTargets(input)
  } catch {
    reason = 'invalid_response'
    settlement = resolveRoutingTargets({ ...input, answer: 'unavailable' })
  }
  const answer = reason || input.answer === 'unavailable' ? undefined : input.answer
  const rules = answer && settlement.evaluate ? decisionRoutingRuleMatches(input.question, input.routing, answer) : []
  const { participants, eligible } = partitionRoutingConstraint(input.constraint)
  const constrained = participants.length + eligible.length > 0
  const outcome: RoutingPreviewOutcome =
    settlement.disposition === 'unavailable'
      ? 'unavailable'
      : settlement.disposition === 'skip'
        ? 'skip'
        : constrained
          ? 'continue'
          : 'activate'
  return { ...settlement, rules, outcome, ...(reason ? { reason } : {}) }
}

/** Cancel reasons the router writes when settlement itself ended with no admitted target, not an interruption. */
const SETTLED_CANCEL_REASONS = new Set(['targets_rejected', 'no_default'])

/** A router verdict's Recent evaluations outcome from its state, disposition, and per-target admissions. */
export function routingEvaluationOutcome(input: {
  state: string
  disposition: 'match' | 'skip' | 'unavailable' | null
  targets: ReadonlyArray<{ disposition: RoutingTargetDisposition }>
  cancelReason?: string | null
}): DecisionRoutingEvaluationOutcome {
  if (input.state === 'canceled' && !SETTLED_CANCEL_REASONS.has(input.cancelReason ?? '')) return 'canceled'
  if (input.state === 'skipped' || input.disposition === 'skip') return 'skipped'
  if (
    input.state === 'reserved' ||
    input.state === 'evaluating' ||
    input.state === 'settled' ||
    input.disposition === null ||
    input.targets.some((target) => target.disposition === 'pending')
  )
    return 'pending'
  const admitted = input.targets.filter((target) => target.disposition === 'admitted').length
  if (input.disposition === 'unavailable') return admitted > 0 ? 'fallback' : 'unavailable'
  if (admitted === 0) return 'unavailable'
  const refused = input.targets.some(
    (target) => target.disposition === 'rejected' || target.disposition === 'unavailable'
  )
  return refused ? 'partially_routed' : 'routed'
}

export interface DecisionChainEvaluation {
  stepId: string
  decisionId: string
  evaluation: DecisionEvaluation
}

export function decisionChainUsage(trace: readonly DecisionChainEvaluation[]): {
  inputTokens: number
  outputTokens: number
} {
  return trace.reduce(
    (total, { evaluation }) =>
      evaluation.status === 'answered'
        ? {
            inputTokens: total.inputTokens + evaluation.usage.inputTokens,
            outputTokens: total.outputTokens + evaluation.usage.outputTokens
          }
        : total,
    { inputTokens: 0, outputTokens: 0 }
  )
}

// Each reached node executes once; all branches share the caller's snapshot and deadline.
export async function runDecisionChain<T extends DecisionChainStep>(input: {
  root: T
  steps?: readonly (T & { id: string })[]
  deadlineAt: number
  signal?: AbortSignal
  now?: () => number
  evaluate(step: T, index: number, signal: AbortSignal): Promise<DecisionEvaluation>
  next(step: T, evaluation: Extract<DecisionEvaluation, { status: 'answered' }>): readonly string[]
}): Promise<{ evaluation: DecisionEvaluation; trace: DecisionChainEvaluation[] }> {
  const timeout = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal
  const remaining = input.deadlineAt - (input.now?.() ?? performance.timeOrigin + performance.now())
  const timer = setTimeout(() => timeout.abort(), Math.max(0, remaining))
  const trace: DecisionChainEvaluation[] = []
  const steps = new Map(input.steps?.map((step) => [step.id, step]))
  const pending: Array<{ id: string; step: T }> = [{ id: '', step: input.root }]
  const visited = new Set<string>()
  try {
    if (remaining <= 0) return { evaluation: { status: 'unavailable', reason: 'timeout' }, trace }
    while (pending.length) {
      signal.throwIfAborted()
      const { id, step } = pending.shift()!
      if (visited.has(id)) continue
      if (visited.size >= DECISION_CHAIN_MAX_STEPS) throw new Error('Decision chain exceeds the step limit.')
      visited.add(id)
      const evaluation = await abortableDecision(input.evaluate(step, trace.length, signal), signal)
      signal.throwIfAborted()
      trace.push({ stepId: id, decisionId: step.decisionId, evaluation })
      if (evaluation.status === 'unavailable') return { evaluation, trace }
      let nextIds: readonly string[]
      try {
        nextIds = input.next(step, evaluation)
      } catch {
        return { evaluation: { status: 'unavailable', reason: 'invalid_response' }, trace }
      }
      for (const nextId of nextIds) {
        const next = steps.get(nextId)
        if (!next) return { evaluation: { status: 'unavailable', reason: 'invalid_response' }, trace }
        pending.push({ id: nextId, step: next })
      }
    }
    return { evaluation: trace[0]!.evaluation, trace }
  } catch (error) {
    input.signal?.throwIfAborted()
    if (!signal.aborted) throw error
    return { evaluation: { status: 'unavailable', reason: 'timeout' }, trace }
  } finally {
    clearTimeout(timer)
  }
}

function abortableDecision<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
