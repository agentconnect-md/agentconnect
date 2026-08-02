// The ?focus landing's decision function (merged-conversation-view.md §5.3),
// pure so the route-transition lifecycle is unit-testable: the persistent
// /conversations layout survives key-to-key navigation, and the deciding
// inputs must be SCOPED to the current key — never the previous
// conversation's leftover state.

export type FocusAction =
  /** Current key's transcript not loaded yet (or a page in flight) — do nothing. */
  | 'wait'
  /** Target visible — scroll/flash and complete. */
  | 'scroll'
  /** Not visible, history remains, budget left — auto-load an older window. */
  | 'page'
  /** Budget exhausted with history remaining — stay armed for manual paging. */
  | 'pause'
  /** History exhausted without a target — complete quietly. */
  | 'give-up'

export function focusAction(input: {
  /** The focused participant's block exists in the CURRENT merge. */
  targetVisible: boolean
  /** The CURRENT key's initial transcript load has completed — a stale
   *  previous conversation's state must read as not-ready. */
  transcriptReady: boolean
  hasEarlier: boolean
  paging: boolean
  pagesUsed: number
  pageBudget: number
}): FocusAction {
  if (!input.transcriptReady) return 'wait'
  if (input.targetVisible) return 'scroll'
  if (input.hasEarlier) {
    if (input.paging) return 'wait'
    return input.pagesUsed < input.pageBudget ? 'page' : 'pause'
  }
  return 'give-up'
}
