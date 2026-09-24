'use client'

// Organization-scoped Decision APIs, route-surviving binding drafts, and mock-only channel gates.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import {
  decisionConditionIssues,
  decisionConditionNeedsReview,
  type ChannelDecisionGate,
  type DecisionCondition,
  type DecisionDefinition,
  type DecisionQuestion,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol/decision'
import type { DecisionApi, DecisionProviderOption, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { useOrgs } from '@/lib/org-context'
import { createDecisionMockApi } from './mock-api'
import { createDecisionApi } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import type { BindingSaveError } from './binding'
import { INITIAL_ROUTING_STATE, routingReducer, type RoutingEditorState, type RoutingEvent } from './routing-draft'

/** A Stage 1 fixed-target gate: one conversation, one decision, one trigger condition. */
export interface DecisionGateBinding extends Pick<ChannelDecisionGate, 'steps' | 'nextStepId' | 'elseStepId'> {
  decisionId: string
  when: DecisionCondition
  /** The room's name as the console prints it, so a usage list can name it without console data. */
  channelName: string
  /** Set when an edit to the decision stranded this condition; cleared by saving the gate again. */
  needsReview?: boolean
}

/** An unsaved By decision edit for one conversation; it outlives the strip so inline Create can return to it. */
export interface DecisionBindingDraft extends Pick<ChannelDecisionGate, 'steps' | 'nextStepId' | 'elseStepId'> {
  decisionId: string | null
  when: DecisionCondition | null
  phase: 'editing' | 'saving' | 'error'
  error?: BindingSaveError
  /** Set when the user asked to choose a Decision, so no first entry is auto-picked for them. */
  explicitPick?: boolean
  /** Set on a repair whose saved condition no longer fits the question type; Save waits for an explicit choice. */
  awaitingCondition?: boolean
}

type DraftUpdate =
  DecisionBindingDraft | null | ((current: DecisionBindingDraft | undefined) => DecisionBindingDraft | null)

/** Where an inline Create decision returns: a conversation's binding draft, or a bot's routing draft. */
export type InlineCreateTarget = { kind: 'binding'; key: string } | { kind: 'routing'; botId: string; stepId?: string }

/** The stored form: the store stamps the organization, so a caller cannot misfile it. */
type StoredGate = DecisionGateBinding & { orgId: string }

/** One conversation a decision is bound to, for the editor's `Used by` card and delete guard. */
export interface DecisionGateUsage {
  channelId: string
  channelName: string
  when: DecisionCondition
  needsReview: boolean
}

/** Gate identity includes the organization and owning bot because bots may share a channel. */
export function gateKey(orgId: string | null | undefined, botId: string | null | undefined, channelId: string): string {
  return `${orgId ?? ''}|${botId ?? ''}|${channelId}`
}

interface DecisionsPrototype {
  api: DecisionApi
  /** Every visible decision — one read, shared by the list, the pickers, and the editor. */
  decisions: DecisionSummary[]
  loading: boolean
  error: string | null
  /** Re-read the decision list after a write. */
  reload: () => Promise<unknown>
  /** Gate binding by {@link gateKey} — the conversation owns it, as on the CP. */
  gates: Readonly<Record<string, StoredGate>>
  /** This store's identity for one conversation, organization included. */
  gateKeyFor: (botId: string | null | undefined, channelId: string) => string
  setGate: (key: string, binding: DecisionGateBinding) => void
  clearGate: (key: string) => void
  /** The active organization's gates on one decision — never another tenant's. */
  gateUsages: (decisionId: string) => DecisionGateUsage[]
  /** The organization this store is currently partitioned by. */
  orgId: string
  /** Flag the gates this edit invalidated, before the caller re-reads. */
  markGatesForReview: (decisionId: string, previous: DecisionQuestion, next: DecisionQuestion) => void
  /** Unsaved binding edits by {@link gateKey}, shared by every mounted copy of a row. */
  bindingDrafts: Readonly<Record<string, DecisionBindingDraft>>
  /** Replace, update, or (with null) drop one draft; a functional update sees the latest draft. */
  setBindingDraft: (key: string, next: DraftUpdate) => void
  /** Routing editor state by bot, so an inline Create decision returns to the same draft. */
  routingDrafts: Readonly<Record<string, RoutingEditorState>>
  /** This store's identity for one bot's routing draft. */
  routingKeyFor: (botId: string) => string
  dispatchRouting: (botId: string, event: RoutingEvent) => void
  /** Remember which draft an inline Create decision should return to; a bare key is a binding draft. */
  beginInlineCreate: (target: string | InlineCreateTarget) => void
  /** Select a just-created Decision on the draft that started the inline create. */
  completeInlineCreate: (decision: DecisionDefinition) => void
}

const DecisionsContext = createContext<DecisionsPrototype | null>(null)

export function DecisionsPrototypeProvider({ children }: { children: ReactNode }) {
  // The API, cached reads, and prototype gates stay partitioned by organization.
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? ''
  const [apis] = useState(() => new Map<string, DecisionApi>())
  const api = useMemo(() => {
    const cached = apis.get(orgId)
    if (cached) return cached
    const created = MOCK_MODE ? createDecisionMockApi() : createDecisionApi(orgId)
    apis.set(orgId, created)
    return created
  }, [apis, orgId])
  const [gates, setGates] = useState<Record<string, StoredGate>>({})
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, DecisionBindingDraft>>({})
  const [routingDrafts, setRoutingDrafts] = useState<Record<string, RoutingEditorState>>({})
  const [pendingCreate, setPendingCreate] = useState<InlineCreateTarget | null>(null)
  // An unresolved organization must not make API requests.
  const { data, error, isLoading, mutate } = useSWR(orgId ? ['decisions', api.mode, orgId] : null, () =>
    api.listDecisions()
  )
  const reload = useCallback(async () => mutate(), [mutate])
  const gateKeyFor = useCallback(
    (botId: string | null | undefined, channelId: string) => gateKey(orgId, botId, channelId),
    [orgId]
  )
  // The org is stamped here, so a binding cannot land in another tenant's partition.
  const setGate = useCallback(
    (key: string, binding: DecisionGateBinding) => {
      setGates((current) => ({ ...current, [key]: { ...binding, orgId } }))
    },
    [orgId]
  )
  const gateUsagesFor = useCallback((decisionId: string) => gateUsagesIn(gates, orgId, decisionId), [gates, orgId])
  const clearGate = useCallback((key: string) => {
    setGates((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)))
  }, [])
  // Local mock gates track invalidation, including Score rubric changes (§6.1).
  const markGatesForReview = useCallback(
    (decisionId: string, previous: DecisionQuestion, next: DecisionQuestion) => {
      setGates((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, binding]) => [
            key,
            binding.orgId === orgId &&
            [binding, ...(binding.steps ?? [])].some(
              (step) => step.decisionId === decisionId && decisionConditionNeedsReview(previous, next, step.when)
            )
              ? { ...binding, needsReview: true }
              : binding
          ])
        )
      )
    },
    [orgId]
  )
  const setBindingDraft = useCallback((key: string, next: DraftUpdate) => {
    setBindingDrafts((current) => {
      const resolved = typeof next === 'function' ? next(current[key]) : next
      if (resolved === (current[key] ?? null)) return current
      if (resolved) return { ...current, [key]: resolved }
      return Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key))
    })
  }, [])
  const routingKeyFor = useCallback((botId: string) => gateKey(orgId, botId, 'routing'), [orgId])
  const dispatchRouting = useCallback(
    (botId: string, event: RoutingEvent) => {
      const key = gateKey(orgId, botId, 'routing')
      setRoutingDrafts((current) => {
        const next = routingReducer(current[key] ?? INITIAL_ROUTING_STATE, event)
        return next === current[key] ? current : { ...current, [key]: next }
      })
    },
    [orgId]
  )
  const beginInlineCreate = useCallback(
    (target: string | InlineCreateTarget) =>
      setPendingCreate(typeof target === 'string' ? { kind: 'binding', key: target } : target),
    []
  )
  const completeInlineCreate = useCallback(
    (decision: DecisionDefinition) => {
      if (!pendingCreate) return
      if (pendingCreate.kind === 'routing')
        dispatchRouting(pendingCreate.botId, {
          type: 'SELECT_DECISION',
          decisionId: decision.id,
          ...(pendingCreate.stepId ? { stepId: pendingCreate.stepId } : {})
        })
      else {
        const key = pendingCreate.key
        setBindingDrafts((current) => ({
          ...current,
          [key]: { decisionId: decision.id, when: defaultConditionFor(decision), phase: 'editing' }
        }))
      }
      setPendingCreate(null)
    },
    [pendingCreate, dispatchRouting]
  )
  const value = useMemo<DecisionsPrototype>(
    () => ({
      api,
      decisions: data ?? [],
      loading: isLoading && !data,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      reload,
      gates,
      gateKeyFor,
      setGate,
      clearGate,
      gateUsages: gateUsagesFor,
      orgId,
      markGatesForReview,
      bindingDrafts,
      setBindingDraft,
      routingDrafts,
      routingKeyFor,
      dispatchRouting,
      beginInlineCreate,
      completeInlineCreate
    }),
    [
      api,
      data,
      isLoading,
      error,
      reload,
      gates,
      gateKeyFor,
      setGate,
      clearGate,
      gateUsagesFor,
      orgId,
      markGatesForReview,
      bindingDrafts,
      setBindingDraft,
      routingDrafts,
      routingKeyFor,
      dispatchRouting,
      beginInlineCreate,
      completeInlineCreate
    ]
  )
  return <DecisionsContext.Provider value={value}>{children}</DecisionsContext.Provider>
}

export function useDecisionsPrototype(): DecisionsPrototype {
  const value = useContext(DecisionsContext)
  if (!value) throw new Error('useDecisionsPrototype must be used inside DecisionsPrototypeProvider')
  return value
}

/** The prototype, or null where it is not mounted — a host that must still render without it. */
export function useOptionalDecisionsPrototype(): DecisionsPrototype | null {
  return useContext(DecisionsContext)
}

/** The decision a binding names, or null once it is gone — the "decision removed" case. */
export function boundDecision(
  decisions: readonly DecisionSummary[],
  binding: DecisionGateBinding | null
): DecisionSummary | null {
  if (!binding) return null
  return decisions.find((entry) => entry.id === binding.decisionId) ?? null
}

/** The daemon catalog a preview resolves against, read from the active organization's API. */
export function useDecisionProviders(): {
  providers: DecisionProviderOption[]
  daemonId: string | null
  error: string | null
} {
  const { api, orgId } = useDecisionsPrototype()
  const { data, error } = useSWR(orgId ? ['decision-providers', api.mode, orgId] : null, () => api.listProviders(), {
    refreshInterval: 30000
  })
  return {
    providers: data ?? [],
    daemonId: data?.[0]?.daemonId ?? null,
    error: error instanceof Error ? error.message : error ? String(error) : null
  }
}

/** The gate's inline errors, as the editor renders them. */
export function gateIssues(
  decision: DecisionDefinition | null,
  when: DecisionCondition | null
): DecisionValidationIssue[] {
  if (!decision || !when) return []
  return decisionConditionIssues(decision.question, when)
}

/** The active organization's gates on one decision, in binding order. */
export function gateUsagesIn(
  gates: Readonly<Record<string, StoredGate>>,
  orgId: string,
  decisionId: string
): DecisionGateUsage[] {
  return Object.entries(gates)
    .filter(
      ([, binding]) =>
        binding.orgId === orgId && [binding, ...(binding.steps ?? [])].some((step) => step.decisionId === decisionId)
    )
    .map(([key, binding]) => ({
      channelId: key,
      channelName: binding.channelName,
      when: binding.when,
      needsReview: binding.needsReview === true
    }))
}

/** A repair's starting condition: nothing selected, or null for Score, which has no empty interval. */
export function emptyConditionFor(decision: DecisionDefinition): DecisionCondition | null {
  const question = decision.question
  if (question.type === 'boolean') return { type: 'boolean', values: [] }
  if (question.type === 'choice') return { type: 'choice', thresholds: {} }
  return null
}

/** Fresh mock gates accept every Choice key at 50%, both Booleans, or the whole Score rubric. */
export function defaultConditionFor(decision: DecisionDefinition): DecisionCondition {
  const question = decision.question
  if (question.type === 'boolean') return { type: 'boolean', values: [true, false] }
  if (question.type === 'score') return { type: 'score', min: 0, max: question.criteria.length - 1 }
  return {
    type: 'choice',
    thresholds: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, 0.5]))
  }
}
