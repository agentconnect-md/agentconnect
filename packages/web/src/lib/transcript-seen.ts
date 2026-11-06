'use client'

// How far this browser has read each session's transcript, kept in web storage so a NEW line can mark what arrived since.

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'agentconnect.transcript-seen'
/** Sessions remembered at most; the least recently read fall out first. */
export const SEEN_SESSIONS_MAX = 200

type SeenMap = Record<string, number>

function readMap(): SeenMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SeenMap) : {}
  } catch {
    return {}
  }
}

/** The newest moment this browser saw in a session's transcript, or null when it never read it here. */
export function readSeen(sessionId: string): number | null {
  const at = readMap()[sessionId]
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/** Records that the transcript was read up to `at`; it never moves back, and the map keeps its most recent sessions. */
export function writeSeen(sessionId: string, at: number): void {
  const map = readMap()
  if ((map[sessionId] ?? -Infinity) >= at) return
  delete map[sessionId]
  map[sessionId] = at
  const ids = Object.keys(map)
  for (const id of ids.slice(0, Math.max(0, ids.length - SEEN_SESSIONS_MAX))) delete map[id]
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage full or blocked: the line is a convenience, so reading goes on without it.
  }
}

/** Whether the reader is looking at the page now: it is visible and has focus. */
function looking(): boolean {
  return document.visibilityState !== 'hidden' && document.hasFocus()
}

/**
 * Where the NEW line goes: what this browser had read when the page loaded, re-taken each time the page
 * regains focus; `markSeen` advances the record only while the reader is looking and following the end.
 */
export function useSeenMarker(
  sessionId: string | null,
  following: boolean
): { marker: number | null; markSeen: (at: number) => void } {
  const [taken, setTaken] = useState<{ id: string | null; at: number | null }>({ id: null, at: null })
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    setTaken({ id: sessionId, at: readSeen(sessionId) })
    setActive(looking())
    // Coming back is when the line moves: to what was read before the reader left.
    const regain = () => {
      if (!looking()) {
        setActive(false)
        return
      }
      setTaken({ id: sessionId, at: readSeen(sessionId) })
      setActive(true)
    }
    const leave = () => setActive(false)
    window.addEventListener('focus', regain)
    window.addEventListener('blur', leave)
    document.addEventListener('visibilitychange', regain)
    return () => {
      window.removeEventListener('focus', regain)
      window.removeEventListener('blur', leave)
      document.removeEventListener('visibilitychange', regain)
    }
  }, [sessionId])

  // A new identity whenever looking or following starts, so the recorder re-records what is on screen then.
  const markSeen = useCallback(
    (at: number) => {
      if (sessionId && active && following) writeSeen(sessionId, at)
    },
    [active, following, sessionId]
  )
  return { marker: taken.id === sessionId ? taken.at : null, markSeen }
}

/** The first turn, after the first, that started after `marker`; -1 when none did or nothing was read here before. */
export function newDividerIndex(startsMs: readonly (number | undefined)[], marker: number | null): number {
  if (marker === null) return -1
  for (let i = 1; i < startsMs.length; i++) {
    const at = startsMs[i]
    if (at !== undefined && at > marker) return i
  }
  return -1
}
