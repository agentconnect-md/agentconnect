'use client'

// A repository's pull-request reviewer Decision, held in this tab only until the control plane stores one.

import { useSyncExternalStore } from 'react'
import type { RoutingDraftRule } from './routing-draft'

/** Which Decision picks a pull request's reviewers, each answer's agent, and what an unmatched PR gets. */
export interface CodeHostReviewDecision {
  decisionId: string
  rules: RoutingDraftRule[]
  /** `default_agent` sends an unmatched PR to every watching agent, as without a Decision. */
  otherwise: 'default_agent' | 'skip'
}

const store = new Map<string, CodeHostReviewDecision>()
const listeners = new Set<() => void>()
let version = 0

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The store key: one Decision per organization and repository. */
export const codeHostReviewKey = (orgId: string | null | undefined, repo: string) => `${orgId ?? ''}|${repo}`

export function setCodeHostReviewDecision(key: string, value: CodeHostReviewDecision | null) {
  if (value) store.set(key, value)
  else store.delete(key)
  version += 1
  for (const listener of listeners) listener()
}

/** Every stored Decision, re-read whenever one changes. */
export function useCodeHostReviewDecisions(): ReadonlyMap<string, CodeHostReviewDecision> {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  )
  return store
}

/** Tests start from an empty store. */
export function resetCodeHostReviewDecisions() {
  store.clear()
  version += 1
}
