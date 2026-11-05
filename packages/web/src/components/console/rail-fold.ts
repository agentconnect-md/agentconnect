'use client'

// A page that needs the width (an expanded task) folds the site navigation to icons while it is open; the reader's own toggle then wins until it closes.

import { createContext, useContext, useEffect } from 'react'

/** Set by the shell: asks for, or releases, the fold. */
export const RailFoldContext = createContext<(fold: boolean) => void>(() => {})

/** Folds the site navigation to icons while `active`, without touching the reader's saved choice. */
export function useRailFold(active: boolean): void {
  const setFold = useContext(RailFoldContext)
  useEffect(() => {
    if (!active) return
    setFold(true)
    return () => setFold(false)
  }, [active, setFold])
}
