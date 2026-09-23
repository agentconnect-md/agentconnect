/** A verdict that can still admit its row (decisions.md §8.3); `settled` means not yet released. */
export const DECISION_VERDICT_PENDING_STATES = ['reserved', 'evaluating', 'settled'] as const
/** A verdict that will never admit again. */
export const DECISION_VERDICT_TERMINAL_STATES = ['skipped', 'admitted', 'canceled'] as const

/** An SQL `IN` list of fixed state literals. */
export const sqlStates = (states: readonly string[]): string => `(${states.map((state) => `'${state}'`).join(', ')})`
