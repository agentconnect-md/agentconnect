'use client'

// The console's prototype Decisions surface: ONE mock `DecisionApi` for the console's
// lifetime, the visible decision list every reader shares, and the channel gate bindings
// the Control Plane has no field for yet. Mounted inside the shell so a decision created
// on one route is still there after a navigation. This is never a production API and
// never a fallback for a failed request (docs/designs/decision-ui-foundation.md).

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import {
  decisionConditionIssues,
  decisionConditionNeedsReview,
  type DecisionCondition,
  type DecisionDefinition,
  type DecisionQuestion,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol/decision'
import type { DecisionApi, DecisionProviderOption, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { useOrgs } from '@/lib/org-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { createDecisionMockApi } from './mock-api'

/** A Stage 1 fixed-target gate: one conversation, one decision, one trigger condition. */
export interface DecisionGateBinding {
  decisionId: string
  when: DecisionCondition
  /** The room's name as the console prints it, so a usage list can name it without console data. */
  channelName: string
  /** Set when an edit to the decision stranded this condition; cleared by saving the gate again. */
  needsReview?: boolean
}

/** The stored form: the organization is stamped by the store, so a caller cannot get it wrong. */
type StoredGate = DecisionGateBinding & { orgId: string }

/** One conversation a decision is bound to, for the editor's `Used by` card and delete guard. */
export interface DecisionGateUsage {
  channelId: string
  channelName: string
  when: DecisionCondition
  needsReview: boolean
}

/**
 * The identity a gate is stored under. A platform conversation coordinate is NOT unique on
 * its own: two bots can both be installed in one Slack channel, and the shell-wide provider
 * survives an organization switch — so the organization and the owning bot belong in the key.
 * Sibling integrations of one bot deliberately share it, which is what converges the rows.
 */
export function gateKey(orgId: string | null | undefined, botId: string | null | undefined, channelId: string): string {
  return `${orgId ?? ''}|${botId ?? ''}|${channelId}`
}

interface DecisionsPrototype {
  api: DecisionApi
  /** Every visible decision — one read, shared by the list, the pickers, and the editor. */
  decisions: DecisionSummary[]
  loading: boolean
  error: string | null
  /** Re-read after a write; a failed read is reported to the caller instead. */
  reload: () => Promise<unknown>
  /** Gate binding by {@link gateKey} — the conversation owns it, as on the CP. */
  gates: Readonly<Record<string, StoredGate>>
  /** This store's identity for one conversation. The org is the store's, not the row's. */
  gateKeyFor: (botId: string | null | undefined, channelId: string) => string
  setGate: (key: string, binding: DecisionGateBinding) => void
  clearGate: (key: string) => void
  /** The active organization's gates on one decision — never another tenant's. */
  gateUsages: (decisionId: string) => DecisionGateUsage[]
  /** The organization this store is currently partitioned by. */
  orgId: string
  /** Flag the gates an edit to this decision invalidated, before the caller re-reads. */
  markGatesForReview: (decisionId: string, previous: DecisionQuestion, next: DecisionQuestion) => void
}

const DecisionsContext = createContext<DecisionsPrototype | null>(null)

export function DecisionsPrototypeProvider({ children }: { children: ReactNode }) {
  // The store sits inside OrgProvider, so it — not each conversation row — owns the tenant
  // half of a binding's identity. A row that had to ask would depend on the org context.
  const { activeOrg } = useOrgs()
  // The tenant is the store's, not a row's: this provider deliberately outlives an org switch,
  // so the API partition, the cached read, and the gate usages all move together with
  // `activeOrg.id` — the same way the real client is scoped by the caller's organization.
  const orgId = activeOrg?.id ?? ''
  const [apis] = useState(() => new Map<string, DecisionApi>())
  const api = useMemo(() => {
    const cached = apis.get(orgId)
    if (cached) return cached
    const created = createDecisionMockApi()
    apis.set(orgId, created)
    return created
  }, [apis, orgId])
  const [gates, setGates] = useState<Record<string, StoredGate>>({})
  // A null key while the flag is off is what keeps the mock opt-in: no page reads it
  // unless a deployment asked for this surface.
  const { data, error, isLoading, mutate } = useSWR(
    featureFlagEnabled('decisions') ? ['decisions-prototype', orgId] : null,
    () => api.listDecisions()
  )
  const reload = useCallback(async () => mutate(), [mutate])
  const gateKeyFor = useCallback(
    (botId: string | null | undefined, channelId: string) => gateKey(orgId, botId, channelId),
    [orgId]
  )
  // The org is stamped here rather than accepted from a caller, so a binding can never be
  // written into the wrong tenant's partition.
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
  // The mock service cannot see these bindings, so the invalidation the CP would record has
  // to be recorded here — including a Score rubric-length change, which leaves an interval
  // that still fits but no longer means what it did (docs/designs/decisions.md §6.1).
  const markGatesForReview = useCallback(
    (decisionId: string, previous: DecisionQuestion, next: DecisionQuestion) => {
      setGates((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, binding]) => [
            key,
            binding.orgId === orgId &&
            binding.decisionId === decisionId &&
            decisionConditionNeedsReview(previous, next, binding.when)
              ? { ...binding, needsReview: true }
              : binding
          ])
        )
      )
    },
    [orgId]
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
      markGatesForReview
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
      markGatesForReview
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
export function useDecisionProviders(): { providers: DecisionProviderOption[]; daemonId: string | null } {
  const { api, orgId } = useDecisionsPrototype()
  const { data } = useSWR(['decisions-prototype-providers', orgId], () => api.listProviders())
  return { providers: data ?? [], daemonId: data?.[0]?.daemonId ?? null }
}

/** The gate's inline errors, as the editor renders them. */
export function gateIssues(
  decision: DecisionDefinition | null,
  when: DecisionCondition | null
): DecisionValidationIssue[] {
  if (!decision || !when) return []
  return decisionConditionIssues(decision.question, when)
}

/** One organization's conversations gated on one decision, in binding order so the list is stable.
 *  A decision id is only unique within its tenant, so the org is part of the query, not a filter
 *  the caller may forget. */
export function gateUsagesIn(
  gates: Readonly<Record<string, StoredGate>>,
  orgId: string,
  decisionId: string
): DecisionGateUsage[] {
  return Object.entries(gates)
    .filter(([, binding]) => binding.orgId === orgId && binding.decisionId === decisionId)
    .map(([key, binding]) => ({
      channelId: key,
      channelName: binding.channelName,
      when: binding.when,
      needsReview: binding.needsReview === true
    }))
}

/** A condition matching the decision's question type, with the design's canonical defaults:
 *  every Choice key at 50%, both Boolean answers, the whole Score rubric. An untouched gate
 *  must not silently skip every No or activate a low-confidence answer. */
export function defaultConditionFor(decision: DecisionDefinition): DecisionCondition {
  const question = decision.question
  if (question.type === 'boolean') return { type: 'boolean', values: [true, false] }
  if (question.type === 'score') return { type: 'score', min: 0, max: question.criteria.length - 1 }
  return {
    type: 'choice',
    thresholds: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, 0.5]))
  }
}
