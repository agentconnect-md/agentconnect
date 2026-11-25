'use client'

import { useEffect } from 'react'
import { markSessionsRead } from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'

/** Sorts unread rows first and keeps the list's own order inside each group. */
export function unreadFirst<T extends { unread?: boolean }>(rows: readonly T[]): T[] {
  return [...rows.filter((row) => row.unread), ...rows.filter((row) => !row.unread)]
}

/**
 * Marks the open conversation's sessions read for the signed-in member: on arrival, whenever
 * `activityAt` moves while the tab is showing, and once more on leaving or hiding the tab.
 */
export function useMarkSessionsRead(sessionIds: readonly string[], activityAt: string | null | undefined): void {
  const key = [...sessionIds].sort().join(',')
  useEffect(() => {
    if (MOCK_MODE || !key) return
    const ids = key.split(',')
    // Best effort, and never a throw: with no active organization the request cannot even be addressed.
    const mark = () => void (async () => markSessionsRead(ids))().catch(() => {})
    // Hidden activity stays unread: only a tab the member can see moves the mark.
    const markIfVisible = () => {
      if (document.visibilityState === 'visible') mark()
    }
    markIfVisible()
    // Hiding marks too: everything up to the moment of leaving was on screen.
    document.addEventListener('visibilitychange', mark)
    return () => {
      document.removeEventListener('visibilitychange', mark)
      markIfVisible()
    }
  }, [key, activityAt])
}
