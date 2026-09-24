// The shared-bot Routing editor's draft, its validation, and the save lifecycle as one reducer (decisions.md §9.2).

import {
  decisionRoutingIssues,
  type DecisionCondition,
  type DecisionQuestion,
  type DecisionRoutingStep,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol/decision'
import { reachableSteps } from './chain'
import type { DecisionRoutingDetail, DecisionRoutingSave } from '@agentconnect.md/protocol/decision-api'

export type RoutingDraftAction =
  { type: 'agent'; agentId: string | null } | { type: 'skip' } | { type: 'decision'; nextStepId: string }
export interface RoutingDraftRule {
  id: string
  when: DecisionCondition | null
  action: RoutingDraftAction
}
export type RemovalTrigger = 'off' | 'mention' | 'auto'
export interface RoutingRemoval {
  trigger: RemovalTrigger | null
  agentId?: string
}
export interface RoutingDraft {
  steps?: Array<{ id: string; decisionId: string; rules: RoutingDraftRule[] }>
  enabled: boolean
  decisionId: string | null
  rules: RoutingDraftRule[]
  otherwise: 'default_agent' | 'skip'
  channelIds: string[]
  /** Replacement settings for each saved channel the draft removes. */
  removals: Record<string, RoutingRemoval>
}

export type RoutingIssueCode =
  'decision_required' | 'target_required' | 'target_removed' | 'trigger_required' | 'condition_required'
export interface RoutingIssue {
  path: Array<string | number>
  /** The protocol's validation text; draft-only issues carry a code instead. */
  message?: string
  code?: RoutingIssueCode
}

/** The draft a saved configuration opens as; none starts enabled, empty, with Otherwise = Do not activate. */
export function draftFromDetail(detail: Pick<DecisionRoutingDetail, 'config' | 'channelIds'>): RoutingDraft {
  const config = detail.config
  if (!config)
    return {
      enabled: true,
      decisionId: null,
      rules: [],
      otherwise: 'skip',
      channelIds: [...detail.channelIds],
      removals: {}
    }
  return {
    ...(config.steps?.length ? { steps: structuredClone(config.steps) } : {}),
    enabled: config.enabled,
    decisionId: config.decisionId,
    rules: config.rules.map((rule) => ({
      id: rule.id,
      when: structuredClone(rule.when),
      action: structuredClone(rule.action)
    })),
    otherwise: config.otherwise.type,
    channelIds: [...detail.channelIds],
    removals: {}
  }
}

/** The draft's routing configuration, or null while a rule lacks a condition or target. */
export function draftConfig(draft: RoutingDraft): SharedBotDecisionRouting | null {
  if (!draft.decisionId) return null
  const convert = (step: { decisionId: string | null; rules: RoutingDraftRule[] }): DecisionRoutingStep | null => {
    if (
      !step.decisionId ||
      step.rules.some((rule) => !rule.when || (rule.action.type === 'agent' && !rule.action.agentId))
    )
      return null
    return {
      decisionId: step.decisionId,
      rules: step.rules.map((rule) => ({
        id: rule.id,
        when: rule.when!,
        action: rule.action.type === 'agent' ? { type: 'agent', agentId: rule.action.agentId! } : rule.action
      }))
    }
  }
  const root = convert(draft)
  const steps = reachableSteps<{ rules: RoutingDraftRule[] }>(draft, draft.steps ?? [], (step) =>
    step.rules.flatMap((rule) => (rule.action.type === 'decision' ? [rule.action.nextStepId] : []))
  )
  const converted = steps.map((step) => ({
    ...convert(step as NonNullable<RoutingDraft['steps']>[number]),
    id: step.id
  }))
  if (!root || converted.some((step) => !step.decisionId)) return null
  return {
    ...root,
    enabled: draft.enabled,
    otherwise: { type: draft.otherwise },
    ...(converted.length ? { steps: converted as NonNullable<SharedBotDecisionRouting['steps']> } : {})
  }
}

/** The complete save body, or null while a required field is missing. */
export function toSave(draft: RoutingDraft, savedChannelIds: readonly string[]): DecisionRoutingSave | null {
  const config = draftConfig(draft)
  if (!config) return null
  const removals: DecisionRoutingSave['removals'] = []
  for (const channelId of savedChannelIds) {
    if (draft.channelIds.includes(channelId)) continue
    const removal = draft.removals[channelId]
    if (!removal?.trigger) return null
    removals.push({
      channelId,
      settings: { trigger: removal.trigger },
      ...(removal.agentId ? { agentId: removal.agentId } : {})
    })
  }
  return { config, channelIds: [...draft.channelIds], removals }
}

/** Row and field issues: the protocol's rule checks plus targets, removals, and the Decision itself. */
export function routingDraftIssues(
  draft: RoutingDraft,
  question: DecisionQuestion | null,
  context: {
    savedChannelIds: readonly string[]
    memberIds: ReadonlySet<string>
    questions?: ReadonlyMap<string, DecisionQuestion>
  }
): RoutingIssue[] {
  const issues: RoutingIssue[] = []
  if (!draft.decisionId || !question) issues.push({ path: ['decisionId'], code: 'decision_required' })
  draft.rules.forEach((rule, index) => {
    if (!rule.when) issues.push({ path: ['rules', index, 'when'], code: 'condition_required' })
    if (rule.action.type === 'agent') {
      if (!rule.action.agentId) issues.push({ path: ['rules', index, 'action'], code: 'target_required' })
      else if (!context.memberIds.has(rule.action.agentId))
        issues.push({ path: ['rules', index, 'action'], code: 'target_removed' })
    }
  })
  if (question && draft.decisionId && draft.rules.every((rule) => rule.when)) {
    const config = {
      enabled: draft.enabled,
      decisionId: draft.decisionId,
      rules: draft.rules.map((rule) => ({ id: rule.id, when: rule.when!, action: { type: 'skip' as const } })),
      otherwise: { type: draft.otherwise }
    }
    issues.push(
      ...decisionRoutingIssues(question, config).map((issue) => ({ path: issue.path, message: issue.message }))
    )
  }
  const reached = reachableSteps<{ rules: RoutingDraftRule[] }>(draft, draft.steps ?? [], (step) =>
    step.rules.flatMap((rule) => (rule.action.type === 'decision' ? [rule.action.nextStepId] : []))
  )
  for (const [index, step] of (draft.steps ?? []).entries()) {
    if (!reached.some((entry) => entry.id === step.id)) continue
    const next = context.questions?.get(step.decisionId)
    if (!next) issues.push({ path: ['steps', index, 'decisionId'], code: 'decision_required' })
    else
      issues.push(
        ...routingDraftIssues({ ...draft, ...step, steps: undefined, removals: {} }, next, {
          savedChannelIds: [],
          memberIds: context.memberIds
        }).map((issue) => ({ ...issue, path: ['steps', index, ...issue.path] }))
      )
  }
  const config = draftConfig(draft)
  if (config && question && context.questions)
    issues.push(...decisionRoutingIssues(question, config, context.questions))
  for (const channelId of context.savedChannelIds)
    if (!draft.channelIds.includes(channelId) && !draft.removals[channelId]?.trigger)
      issues.push({ path: ['removals', channelId], code: 'trigger_required' })
  return issues
}

/** The issues that belong to one rule row, its condition first. */
export function ruleIssues(issues: readonly RoutingIssue[], index: number): RoutingIssue[] {
  return issues.filter((issue) => issue.path[0] === 'rules' && issue.path[1] === index)
}

const scoreMax = (question: DecisionQuestion): number => (question.type === 'score' ? question.criteria.length - 1 : 1)

/** Display order: Choice and Boolean keep theirs, Score rows sort by lower bound. */
export function displayOrder(
  question: DecisionQuestion | null,
  rules: ReadonlyArray<{ when: DecisionCondition | null }>
): number[] {
  const order = rules.map((_, index) => index)
  if (question?.type !== 'score') return order
  const lower = (rule: { when: DecisionCondition | null }) =>
    rule.when?.type === 'score' ? rule.when.min : Number.POSITIVE_INFINITY
  return order.sort((a, b) => lower(rules[a]!) - lower(rules[b]!) || a - b)
}

/** Each rule id's number as the editor shows it, so Try and Recent evaluations name the same row. */
export function ruleNumbers(
  question: DecisionQuestion | null,
  rules: ReadonlyArray<{ id: string; when: DecisionCondition | null }>
): Map<string, number> {
  return new Map(displayOrder(question, rules).map((index, position) => [rules[index]!.id, position + 1]))
}

/** Score ranges no rule covers; each one uses Otherwise. */
export function scoreGaps(
  question: DecisionQuestion | null,
  rules: readonly RoutingDraftRule[]
): Array<{ min: number; max: number }> {
  if (question?.type !== 'score') return []
  const max = scoreMax(question)
  const intervals = rules
    .flatMap((rule) => (rule.when?.type === 'score' ? [{ min: rule.when.min, max: rule.when.max }] : []))
    .sort((a, b) => a.min - b.min)
  const gaps: Array<{ min: number; max: number }> = []
  let cursor = 0
  for (const interval of intervals) {
    if (interval.min > cursor) gaps.push({ min: cursor, max: Math.min(interval.min, max) })
    cursor = Math.max(cursor, interval.max)
  }
  if (cursor < max) gaps.push({ min: cursor, max })
  return gaps.filter((gap) => gap.max > gap.min)
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rule-${Math.random().toString(36).slice(2)}`

/** A new row: the first unassigned key at 50%, the unassigned Boolean value, or the first Score gap. */
export function newRule(question: DecisionQuestion | null, rules: readonly RoutingDraftRule[]): RoutingDraftRule {
  const action: RoutingDraftAction = { type: 'agent', agentId: null }
  if (!question) return { id: newId(), when: null, action }
  if (question.type === 'choice') {
    const used = new Set(
      rules.flatMap((rule) => (rule.when?.type === 'choice' ? Object.keys(rule.when.thresholds) : []))
    )
    const key = Object.keys(question.criteria).find((entry) => !used.has(entry))
    return { id: newId(), when: { type: 'choice', thresholds: key ? { [key]: 0.5 } : {} }, action }
  }
  if (question.type === 'boolean') {
    const used = new Set(rules.flatMap((rule) => (rule.when?.type === 'boolean' ? rule.when.values : [])))
    const value = [true, false].find((entry) => !used.has(entry))
    return { id: newId(), when: { type: 'boolean', values: value === undefined ? [] : [value] }, action }
  }
  const gap = scoreGaps(question, rules)[0] ?? { min: 0, max: scoreMax(question) }
  return { id: newId(), when: { type: 'score', min: gap.min, max: gap.max }, action }
}

export type RoutingPhase = 'loading' | 'load_error' | 'editing' | 'saving' | 'save_error' | 'saved'
export interface RoutingEditorState {
  phase: RoutingPhase
  saved: DecisionRoutingDetail | null
  draft: RoutingDraft | null
  lastAttempt: DecisionRoutingSave | null
  error: unknown
}
export type RoutingEvent =
  | { type: 'LOADED'; detail: DecisionRoutingDetail }
  | { type: 'LOAD_FAIL'; error: unknown }
  | { type: 'EDIT'; patch: Partial<RoutingDraft> | ((draft: RoutingDraft) => RoutingDraft) }
  | { type: 'ADD_RULE'; rule: RoutingDraftRule }
  | { type: 'REMOVE_RULE'; id: string }
  | { type: 'RESET'; detail: DecisionRoutingDetail }
  | { type: 'TOGGLE_CHANNEL'; channelId: string }
  | { type: 'ADD_CHANNEL'; channelId: string }
  | { type: 'SET_REMOVAL'; channelId: string; removal: RoutingRemoval }
  | { type: 'SELECT_DECISION'; decisionId: string; stepId?: string }
  | { type: 'CANCEL' }
  | { type: 'SAVE_START'; body: DecisionRoutingSave }
  | { type: 'SAVE_OK'; detail: DecisionRoutingDetail }
  | { type: 'SAVE_FAIL'; error: unknown }
  | { type: 'RETRY' }

export const INITIAL_ROUTING_STATE: RoutingEditorState = {
  phase: 'loading',
  saved: null,
  draft: null,
  lastAttempt: null,
  error: null
}

// An edit leaves a finished or failed save behind: the error is dropped and the phase returns to editing.
function edited(state: RoutingEditorState, draft: RoutingDraft): RoutingEditorState {
  if (state.phase === 'saving') return state
  return { ...state, draft, phase: 'editing', error: null }
}

export function routingReducer(state: RoutingEditorState, event: RoutingEvent): RoutingEditorState {
  const draft = state.draft
  switch (event.type) {
    case 'LOADED':
      // A reload never discards an edit in progress.
      if (draft && state.saved && state.phase !== 'loading' && state.phase !== 'load_error')
        return { ...state, saved: event.detail }
      return {
        phase: 'editing',
        saved: event.detail,
        draft: draftFromDetail(event.detail),
        lastAttempt: null,
        error: null
      }
    case 'RESET':
      // A fresh editing session: the latest saved state, with no edit or attempt carried over from another row.
      if (state.phase === 'saving') return state
      return {
        phase: 'editing',
        saved: event.detail,
        draft: draftFromDetail(event.detail),
        lastAttempt: null,
        error: null
      }
    case 'LOAD_FAIL':
      return draft ? state : { ...state, phase: 'load_error', error: event.error }
    case 'EDIT':
      if (!draft) return state
      return edited(state, typeof event.patch === 'function' ? event.patch(draft) : { ...draft, ...event.patch })
    case 'ADD_RULE':
      return draft ? edited(state, { ...draft, rules: [...draft.rules, event.rule] }) : state
    case 'REMOVE_RULE':
      return draft ? edited(state, { ...draft, rules: draft.rules.filter((rule) => rule.id !== event.id) }) : state
    case 'TOGGLE_CHANNEL': {
      if (!draft) return state
      const saved = state.saved?.channelIds.includes(event.channelId) ?? false
      if (draft.channelIds.includes(event.channelId)) {
        const removals = saved
          ? { ...draft.removals, [event.channelId]: draft.removals[event.channelId] ?? { trigger: null } }
          : draft.removals
        return edited(state, {
          ...draft,
          channelIds: draft.channelIds.filter((id) => id !== event.channelId),
          removals
        })
      }
      const { [event.channelId]: _restored, ...removals } = draft.removals
      return edited(state, { ...draft, channelIds: [...draft.channelIds, event.channelId], removals })
    }
    case 'ADD_CHANNEL': {
      // Idempotent, unlike a toggle, so a repeated dispatch never takes the channel back out.
      if (!draft || draft.channelIds.includes(event.channelId)) return state
      const { [event.channelId]: _restored, ...removals } = draft.removals
      return edited(state, { ...draft, channelIds: [...draft.channelIds, event.channelId], removals })
    }
    case 'SET_REMOVAL':
      return draft
        ? edited(state, { ...draft, removals: { ...draft.removals, [event.channelId]: event.removal } })
        : state
    case 'SELECT_DECISION':
      // The rules stay as they are and are revalidated against the new question; nothing is reselected.
      return draft
        ? edited(
            state,
            event.stepId
              ? {
                  ...draft,
                  steps: draft.steps?.map((step) =>
                    step.id === event.stepId ? { ...step, decisionId: event.decisionId } : step
                  )
                }
              : { ...draft, decisionId: event.decisionId }
          )
        : state
    case 'CANCEL':
      if (!state.saved || state.phase === 'saving') return state
      return { ...state, phase: 'editing', draft: draftFromDetail(state.saved), error: null }
    case 'SAVE_START':
      return { ...state, phase: 'saving', lastAttempt: event.body, error: null }
    case 'SAVE_OK':
      return {
        phase: 'saved',
        saved: event.detail,
        draft: draftFromDetail(event.detail),
        lastAttempt: null,
        error: null
      }
    case 'SAVE_FAIL':
      return { ...state, phase: 'save_error', error: event.error }
    case 'RETRY':
      return state.lastAttempt ? { ...state, phase: 'saving', error: null } : state
  }
}

/** Unsaved: a new configuration, or a draft whose save body differs from the saved one. */
export function routingDirty(state: RoutingEditorState): boolean {
  if (!state.draft || !state.saved) return false
  if (!state.saved.config) return true
  const saved = toSave(draftFromDetail(state.saved), state.saved.channelIds)
  return (
    JSON.stringify(toSave(state.draft, state.saved.channelIds)) !== JSON.stringify(saved) ||
    !toSave(state.draft, state.saved.channelIds)
  )
}

export function routingCanSave(state: RoutingEditorState, issues: readonly RoutingIssue[], canWrite: boolean): boolean {
  return canWrite && state.phase !== 'saving' && routingDirty(state) && issues.length === 0 && state.draft !== null
}

/** Saved but not yet applied everywhere it must be. */
export function routingPendingSync(state: RoutingEditorState): boolean {
  return state.saved?.config != null && state.saved.readiness.status === 'pending_sync'
}
