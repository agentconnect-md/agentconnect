'use client'

import { useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { mentionQueryAt } from '@/lib/conversation-addressing'
import { caretCoordinates } from '@/components/console/caret-coordinates'

export interface MentionCandidate {
  id: string
  name: string
}

/** Composer @mention autocomplete (webchat-multi-agents.md §9.1/§9.2). Typing
 *  `@` opens a picker over `candidates`; picking one inserts `@Name ` at the
 *  query's start. That inline text is the whole contract with the send path —
 *  conversation-addressing.ts's typedMentionIds already resolves an `@Name`
 *  run against the roster into a structural mention, so the picker only has
 *  to land the exact display-name text, not maintain its own chip model.
 */
export function useMentionAutocomplete<T extends MentionCandidate>(params: {
  ref: RefObject<HTMLTextAreaElement | null>
  value: string
  setValue: (v: string) => void
  candidates: readonly T[]
  onPick?: (candidate: T) => void
}) {
  const { ref, value, setValue, candidates, onPick } = params
  const [anchor, setAnchor] = useState<{ start: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Where the triggering `@` sits on screen, so the list drops right under the
  // line being typed — not the textarea's edge, which reads as broken on a
  // tall, mostly-empty composer (a multi-row textarea's bottom can be far from
  // a first-line "@").
  const [coords, setCoords] = useState<{ top: number; left: number; height: number } | null>(null)

  const matches = useMemo(() => {
    if (!anchor) return []
    const q = anchor.query.toLowerCase()
    return candidates.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [anchor, candidates])

  const open = matches.length > 0

  /** Call from the textarea's onChange with the just-committed value + caret. */
  const sync = (nextValue: string, caret: number) => {
    const next = mentionQueryAt(nextValue, caret)
    setAnchor(next)
    setActiveIndex(0)
    const el = ref.current
    setCoords(next && el ? caretCoordinates(el, next.start) : null)
  }

  const close = () => {
    setAnchor(null)
    setCoords(null)
  }

  const pick = (candidate: T) => {
    if (!anchor) return
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, anchor.start)
    const after = value.slice(caret)
    const insertedText = `@${candidate.name} `
    setValue(before + insertedText + after)
    onPick?.(candidate)
    close()
    const pos = before.length + insertedText.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  /** Call from the textarea's onKeyDown BEFORE any Enter-sends handling — a
   *  `true` return means the key was consumed by the picker. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (i + 1) % matches.length)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(matches[activeIndex]!)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return true
    }
    return false
  }

  return { open, matches, activeIndex, setActiveIndex, coords, sync, handleKeyDown, pick, close }
}
