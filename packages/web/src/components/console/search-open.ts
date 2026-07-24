'use client'

import { createContext, useContext } from 'react'

// Opens the console's global search. The Shell provides a breakpoint-aware
// implementation (mobile → the full-screen search overlay, desktop → the top-bar
// box), so a page can trigger search without reaching into Shell-local state.
//
// The default (used if a consumer renders outside the Shell) dispatches the same
// ⌘K keydown the desktop GlobalSearch already listens for — a safe no-crash
// fallback that opens the desktop box.
function dispatchCmdK() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  }
}

export const SearchOpenContext = createContext<() => void>(dispatchCmdK)

export function useSearchOpen(): () => void {
  return useContext(SearchOpenContext)
}
