'use client'

// Shell-style recall of the viewer's earlier prompts in the session composer. Up/Down on an
// EMPTY draft enters history mode on the newest entry; Up walks older, Down walks newer and past
// the newest returns to the empty prompt. Editing the recalled text leaves history mode but keeps
// the text; Escape leaves it and clears the draft.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface UseComposerHistoryInput {
  /** The viewer's own prompts, oldest first. */
  history: readonly string[]
  value: string
  setValue: (next: string) => void
}

export interface UseComposerHistoryResult {
  /** `History i/n` while recalling, null otherwise — rendered above the textarea. */
  label: string | null
  /** Call from onKeyDown BEFORE the pickers' handlers; `true` means the key was consumed. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerHistory({ history, value, setValue }: UseComposerHistoryInput): UseComposerHistoryResult {
  // Index into `history` while recalling; null when the composer is a plain draft.
  const [index, setIndex] = useState<number | null>(null)
  // The text this hook last wrote, so a draft that moved on (an edit, a send clearing it) is detectable.
  const recalledRef = useRef<string | null>(null)

  useEffect(() => {
    if (index !== null && value !== recalledRef.current) {
      setIndex(null)
      recalledRef.current = null
    }
  }, [value, index])

  const recall = (next: number): void => {
    const text = history[next]
    if (text === undefined) return
    recalledRef.current = text
    setIndex(next)
    setValue(text)
  }
  const leave = (clear: boolean): void => {
    recalledRef.current = clear ? '' : null
    setIndex(null)
    if (clear) setValue('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false
    if (index === null) {
      if (value !== '' || history.length === 0) return false
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
      event.preventDefault()
      recall(history.length - 1)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index > 0) recall(index - 1)
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

  return { label: index === null ? null : `History ${index + 1}/${history.length}`, handleKeyDown }
}

/** The viewer's own prompts from transcript rows, oldest first, without empty or repeated entries. */
export function composerHistoryFromRows(
  rows: ReadonlyArray<{ sender: string; text: string; postId?: string }>,
  isSelf: (sender: string) => boolean
): string[] {
  const out: string[] = []
  const seenPosts = new Set<string>()
  for (const row of rows) {
    if (!isSelf(row.sender)) continue
    if (row.postId) {
      if (seenPosts.has(row.postId)) continue
      seenPosts.add(row.postId)
    }
    const text = row.text
    if (!text.trim() || out[out.length - 1] === text) continue
    out.push(text)
  }
  return out
}
