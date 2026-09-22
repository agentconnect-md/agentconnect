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
  type DecisionCondition,
  type DecisionDefinition,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol/decision'
import type { DecisionApi, DecisionProviderOption, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { createDecisionMockApi } from './mock-api'

/** A Stage 1 fixed-target gate: one conversation, one decision, one trigger condition. */
export interface DecisionGateBinding {
  decisionId: string
  when: DecisionCondition
  /** The room's name as the console prints it, so a usage list can name it without console data. */
  channelName: string
}

/** One conversation a decision is bound to, for the editor's `Used by` card and delete guard. */
export interface DecisionGateUsage {
  channelId: string
  channelName: string
  when: DecisionCondition
}

interface DecisionsPrototype {
  api: DecisionApi
  /** Every visible decision — one read, shared by the list, the pickers, and the editor. */
  decisions: DecisionSummary[]
  loading: boolean
  error: string | null
  /** Re-read after a write; a failed read is reported to the caller instead. */
  reload: () => Promise<unknown>
  /** Gate binding by conversation id — the conversation owns it, as on the CP. */
  gates: Readonly<Record<string, DecisionGateBinding>>
  setGate: (channelId: string, binding: DecisionGateBinding) => void
  clearGate: (channelId: string) => void
}

const DecisionsContext = createContext<DecisionsPrototype | null>(null)

export function DecisionsPrototypeProvider({ children }: { children: ReactNode }) {
  // The instance must outlive every render: one created per render would reset saved state.
  const [api] = useState<DecisionApi>(() => createDecisionMockApi())
  const [gates, setGates] = useState<Record<string, DecisionGateBinding>>({})
  // A null key while the flag is off is what keeps the mock opt-in: no page reads it
  // unless a deployment asked for this surface.
  const { data, error, isLoading, mutate } = useSWR(
    featureFlagEnabled('decisions') ? ['decisions-prototype'] : null,
    () => api.listDecisions()
  )
  const reload = useCallback(async () => mutate(), [mutate])
  const setGate = useCallback((channelId: string, binding: DecisionGateBinding) => {
    setGates((current) => ({ ...current, [channelId]: binding }))
  }, [])
  const clearGate = useCallback((channelId: string) => {
    setGates((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== channelId)))
  }, [])
  const value = useMemo<DecisionsPrototype>(
    () => ({
      api,
      decisions: data ?? [],
      loading: isLoading && !data,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      reload,
      gates,
      setGate,
      clearGate
    }),
    [api, data, isLoading, error, reload, gates, setGate, clearGate]
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

/** The daemon catalog a preview resolves against. One logical provider in the prototype. */
export function useDecisionProviders(): { providers: DecisionProviderOption[]; daemonId: string | null } {
  const { api } = useDecisionsPrototype()
  const { data } = useSWR(['decisions-prototype-providers'], () => api.listProviders())
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

/** Every conversation currently gated on one decision — in binding order, so the list is stable. */
export function gateUsages(
  gates: Readonly<Record<string, DecisionGateBinding>>,
  decisionId: string
): DecisionGateUsage[] {
  return Object.entries(gates)
    .filter(([, binding]) => binding.decisionId === decisionId)
    .map(([channelId, binding]) => ({ channelId, channelName: binding.channelName, when: binding.when }))
}

/** A gate whose saved condition can no longer be evaluated against the decision as it stands. */
export function gateNeedsReview(decision: DecisionDefinition | null, when: DecisionCondition): boolean {
  return gateIssues(decision, when).length > 0
}

/** A condition matching the decision's question type, with the design's defaults. */
export function defaultConditionFor(decision: DecisionDefinition): DecisionCondition {
  const question = decision.question
  if (question.type === 'boolean') return { type: 'boolean', values: [true] }
  if (question.type === 'score') return { type: 'score', min: 0, max: question.criteria.length - 1 }
  return {
    type: 'choice',
    thresholds: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, 0.3]))
  }
}
