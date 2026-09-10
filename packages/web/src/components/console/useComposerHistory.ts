'use client'

// Shell-style recall of the viewer's earlier prompts in the session composer. Up/Down on an
// EMPTY draft enters history mode on the newest entry; Up walks older, Down walks newer and past
// the newest returns to the empty prompt. Editing the recalled text leaves history mode but keeps
// the text; Escape leaves it and clears the draft. The pool is only the LOADED transcript window,
// so Up at the oldest loaded entry pages earlier history in and keeps walking once it arrives.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface ComposerHistoryEntry {
  /** Stable row identity, so a page of earlier rows prepending does not move the recalled entry. */
  key: string
  text: string
}

export interface UseComposerHistoryInput {
  /** The viewer's own prompts in the loaded window, oldest first. */
  history: readonly ComposerHistoryEntry[]
  value: string
  setValue: (next: string) => void
  /** The transcript has earlier pages not yet loaded. */
  hasEarlier?: boolean
  /** Loads the next earlier page; resolves once the rows are in (or the read failed). */
  loadEarlier?: () => Promise<void>
  /** Transcript rows loaded so far — a page that adds none ends the walk, so a failing read cannot loop. */
  loadedRows?: number
}

export interface UseComposerHistoryResult {
  /** `History i/n` while recalling (`n+` with earlier pages unloaded), null otherwise. */
  label: string | null
  /** Call from onKeyDown BEFORE the pickers' handlers; `true` means the key was consumed. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

// Sentinel `pending` value: no entry yet, land on the newest one the next page brings.
const ENTER_ON_ARRIVAL = ''

export function useComposerHistory({
  history,
  value,
  setValue,
  hasEarlier = false,
  loadEarlier,
  loadedRows
}: UseComposerHistoryInput): UseComposerHistoryResult {
  // Key of the recalled entry while in history mode; null for a plain draft.
  const [current, setCurrent] = useState<string | null>(null)
  // Key of the entry an Up is waiting to walk past once an earlier page lands (or ENTER_ON_ARRIVAL).
  const [pending, setPending] = useState<string | null>(null)
  // The text this hook last wrote, so a draft that moved on (an edit, a send clearing it) is detectable.
  const recalledRef = useRef<string | null>(null)
  const inflightRef = useRef(false)
  // Progress measure when the last page was requested; null before the first request of a walk.
  const rowsAtRequestRef = useRef<number | null>(null)
  // Bumps after each page settles so the walk re-evaluates even when the pool identity did not change.
  const [settled, setSettled] = useState(0)

  const found = current === null ? -1 : history.findIndex((entry) => entry.key === current)
  const index = found === -1 ? null : found
  const rows = loadedRows ?? history.length

  useEffect(() => {
    if ((current !== null || pending !== null) && value !== recalledRef.current) {
      setCurrent(null)
      setPending(null)
      recalledRef.current = null
    }
  }, [value, current, pending])

  const recall = useCallback(
    (next: number): void => {
      const entry = history[next]
      if (!entry) return
      recalledRef.current = entry.text
      setCurrent(entry.key)
      setValue(entry.text)
    },
    [history, setValue]
  )
  const leave = (clear: boolean): void => {
    recalledRef.current = clear ? '' : null
    setCurrent(null)
    setPending(null)
    if (clear) setValue('')
  }
  const startWalk = (from: string): void => {
    rowsAtRequestRef.current = null
    setPending(from)
  }

  // Resolve a pending walk against the pool as pages arrive.
  useEffect(() => {
    if (pending === null) return
    const from = pending === ENTER_ON_ARRIVAL ? history.length : history.findIndex((entry) => entry.key === pending)
    if (from > 0) {
      setPending(null)
      recall(from - 1)
      return
    }
    if (inflightRef.current) return
    const grew = rowsAtRequestRef.current === null || rows > rowsAtRequestRef.current
    if (from === -1 || !hasEarlier || !loadEarlier || !grew) {
      setPending(null)
      return
    }
    inflightRef.current = true
    rowsAtRequestRef.current = rows
    void loadEarlier().finally(() => {
      inflightRef.current = false
      setSettled((n) => n + 1)
    })
  }, [pending, history, rows, hasEarlier, loadEarlier, settled, recall])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false
    // A page walk in flight, with or without an entry under it yet: Escape and Down cancel it.
    if (pending !== null) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Escape') return false
      event.preventDefault()
      if (event.key === 'Escape') leave(true)
      else if (event.key === 'ArrowDown') setPending(null)
      return true
    }
    if (index === null) {
      if (value !== '') return false
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
      if (history.length > 0) {
        event.preventDefault()
        recall(history.length - 1)
        return true
      }
      if (event.key === 'ArrowUp' && hasEarlier && loadEarlier) {
        event.preventDefault()
        recalledRef.current = ''
        startWalk(ENTER_ON_ARRIVAL)
        return true
      }
      return false
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index > 0) recall(index - 1)
      else if (hasEarlier && loadEarlier && current !== null) startWalk(current)
      return true
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (index < history.length - 1) recall(index + 1)
      else leave(true)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      leave(true)
      return true
    }
    return false
  }

  const loading = pending !== null
  const label =
    index !== null
      ? `History ${index + 1}/${history.length}${hasEarlier ? '+' : ''}${loading ? ' · loading earlier…' : ''}`
      : loading
        ? 'History · loading earlier…'
        : null
  return { label, handleKeyDown }
}

/** The viewer's own prompts from transcript rows, oldest first, without empty or repeated entries. */
export function composerHistoryFromRows<Row extends { sender: string; text: string; postId?: string }>(
  rows: ReadonlyArray<Row>,
  isSelf: (sender: string) => boolean,
  keyOf: (row: Row) => string
): ComposerHistoryEntry[] {
  const out: ComposerHistoryEntry[] = []
  const seenPosts = new Set<string>()
  for (const row of rows) {
    if (!isSelf(row.sender)) continue
    if (row.postId) {
      if (seenPosts.has(row.postId)) continue
      seenPosts.add(row.postId)
    }
    const text = row.text
    if (!text.trim() || out[out.length - 1]?.text === text) continue
    out.push({ key: row.postId ?? keyOf(row), text })
  }
  return out
}
