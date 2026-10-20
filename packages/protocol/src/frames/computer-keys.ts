// One key-name normalization for the desktop that presses keys and the agent daemon that gates them (computer-use.md §4.2).

/** Spellings the desktop folds onto one driver key name. */
export const COMPUTER_KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'return',
  esc: 'escape',
  control: 'ctrl',
  option: 'alt'
}

/** A key name as the desktop presses it: trimmed, lowercased, then aliased. */
export function normalizeComputerKey(key: string): string {
  const lowered = key.trim().toLowerCase()
  return COMPUTER_KEY_ALIASES[lowered] ?? lowered
}

/** Keys that submit what was typed, after normalization. */
export const COMPUTER_SUBMIT_KEYS: ReadonlySet<string> = new Set(['return', 'kp_enter'])
