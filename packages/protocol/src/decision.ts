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

export function supportsDecision(decision: Pick<DecisionDraft, 'providerId' | 'model' | 'question'>): boolean {
  return DECISION_PROVIDER_PROFILES.some(
    (provider) =>
      provider.id === decision.providerId &&
      provider.models.some(
        (model) => model.id === decision.model && model.questionTypes.includes(decision.question.type)
      )
  )
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

export const ChannelDecisionGate = z.strictObject({ type: z.literal('gate'), decisionId: Id, when: DecisionCondition })
export type ChannelDecisionGate = z.infer<typeof ChannelDecisionGate>

export const DecisionRuntimeTarget = z.strictObject({ runtime: Text.max(128), model: Text.max(256) })
export type DecisionRuntimeTarget = z.infer<typeof DecisionRuntimeTarget>

export const AgentModelSelection = z.strictObject({
  decisionId: z.string().uuid(),
  rules: z
    .array(DecisionRuntimeTarget.extend({ when: DecisionCondition }))
    .min(1)
    .max(32)
})
export type AgentModelSelection = z.infer<typeof AgentModelSelection>

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
  disabledReason: z.enum(['needs_review', 'access_revoked']).optional()
})
export type DecisionBundleBinding = z.infer<typeof DecisionBundleBinding>

// The complete per-integration Decision configuration (decisions.md §7.1); an empty bundle clears.
export const DecisionBundle = z.object({
  bindings: z.array(DecisionBundleBinding).max(1000).default([]),
  definitions: z.array(DecisionBundleDefinition).max(1000).default([])
})
export type DecisionBundle = z.infer<typeof DecisionBundle>

export const EMPTY_DECISION_BUNDLE: DecisionBundle = { bindings: [], definitions: [] }

export const DecisionChannelSettings = z.discriminatedUnion('trigger', [
  z.strictObject({ trigger: z.enum(['off', 'mention', 'auto']) }),
  z.strictObject({ trigger: z.literal('decision'), decisionBinding: ChannelDecisionBinding })
])
export type DecisionChannelSettings = z.infer<typeof DecisionChannelSettings>

export const RoutingAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('agent'), agentId: Id }),
  z.strictObject({ type: z.literal('skip') })
])
export type RoutingAction = z.infer<typeof RoutingAction>

export const SharedBotDecisionRouting = z
  .strictObject({
    enabled: z.boolean(),
    decisionId: Id,
    rules: z.array(z.strictObject({ id: Id, when: DecisionCondition, action: RoutingAction })).max(32),
    otherwise: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('default_agent') }),
      z.strictObject({ type: z.literal('skip') })
    ])
  })
  .refine((routing) => new Set(routing.rules.map((rule) => rule.id)).size === routing.rules.length, {
    path: ['rules'],
    message: 'Rule IDs must be unique.'
  })
export type SharedBotDecisionRouting = z.infer<typeof SharedBotDecisionRouting>

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
  routing: SharedBotDecisionRouting
): DecisionValidationIssue[] {
  const parsed = SharedBotDecisionRouting.safeParse(routing)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return decisionRuleIssues(question, routing.rules)
}

function decisionRuleIssues(
  question: DecisionQuestion,
  rules: readonly { when: DecisionCondition }[]
): DecisionValidationIssue[] {
  const issues: DecisionValidationIssue[] = []
  const assigned = new Set<string>()
  const intervals: Array<{ min: number; max: number }> = []
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
      if (assigned.has(key)) issues.push({ path, message: 'An answer can appear in only one routing rule.' })
      assigned.add(key)
    }
    if (condition.type === 'score') {
      if (intervals.some((other) => condition.min < other.max && other.min < condition.max))
        issues.push({ path, message: 'Score intervals must not overlap.' })
      intervals.push(condition)
    }
  })
  return issues
}

export function decisionModelSelectionIssues(
  question: DecisionQuestion,
  selection: AgentModelSelection
): DecisionValidationIssue[] {
  const parsed = AgentModelSelection.safeParse(selection)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }))
  return decisionRuleIssues(question, selection.rules)
}

// A model consumer selects one winner; equal choice probabilities retain the configured rule order.
export function selectDecisionTarget(
  question: DecisionQuestion,
  selection: AgentModelSelection,
  answer: DecisionAnswer
): DecisionRuntimeTarget | undefined {
  requireValid(decisionModelSelectionIssues(question, selection))
  parseDecisionAnswer(question, answer)
  let selected: { target: DecisionRuntimeTarget; probability: number } | undefined
  for (const rule of selection.rules) {
    const match = matchDecisionCondition(question, rule.when, answer)
    if (!match.matched) continue
    const probability =
      answer.type === 'choice' ? Math.max(...match.matchedKeys.map((key) => answer.probabilities[key]!)) : 1
    if (!selected || probability > selected.probability)
      selected = { target: { runtime: rule.runtime, model: rule.model }, probability }
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
  defaultAgentId?: string
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
  for (const rule of routing.rules) {
    const match = matchDecisionCondition(question, rule.when, answer)
    if (!match.matched) continue
    result.matchedRuleIds.push(rule.id)
    result.matchedKeys.push(...match.matchedKeys)
    if (rule.action.type === 'agent') result.agentIds.push(rule.action.agentId)
  }
  result.usedOtherwise = result.matchedRuleIds.length === 0
  result.activates = result.agentIds.length > 0 || (result.usedOtherwise && routing.otherwise.type === 'default_agent')
  if (result.usedOtherwise && routing.otherwise.type === 'default_agent' && defaultAgentId)
    result.agentIds.push(defaultAgentId)
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
