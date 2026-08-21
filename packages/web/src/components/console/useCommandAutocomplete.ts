'use client'

// Composer `/skill` picker. A sibling of useMentionAutocomplete rather than a mode of it: the two
// share the caret anchoring and the key contract, but a mention resolves a RECIPIENT (and may join
// the conversation, with a rollback) while a command resolves one agent's runtime capability. What
// they must share is the textarea's onKeyDown — the caller offers this one first, and only one can
// be open at a time because the trigger rules do not overlap.
//
// A pick writes ONLY the `/name ` token; the owner is addressed structurally via `onPicked` (the
// caller merges it into the send's `mentions[]`). Inline `@Name` text would displace the command
// from the leading position the daemon's translation matches on.

import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { commandQueryAt, tokenSpanEnd } from '@/lib/conversation-addressing'
import { caretCoordinates } from '@/components/console/caret-coordinates'
import { commandInsertion, matchCommands, type CommandCandidate } from '@/components/console/runtime-command-menu'
import type { MentionCoords } from '@/components/console/useMentionAutocomplete'

/** Mirrors CommandMenu's `max-h` — the worst-case height used to decide whether the list fits below. */
export const COMMAND_MENU_MAX_HEIGHT = 280
const MAX_MATCHES = 8

export function useCommandAutocomplete(params: {
  ref: RefObject<HTMLTextAreaElement | null>
  value: string
  setValue: (v: string) => void
  candidates: readonly CommandCandidate[]
  /** A pick names its owner — the caller validates the token still leads at send time and merges
   *  the owner into `mentions[]`, narrowing the turn to the agent that can actually run it. */
  onPicked?: (target: { agentId: string; agentName: string; name: string }) => void
}) {
  const { ref, value, setValue, candidates, onPicked } = params
  const [anchor, setAnchor] = useState<{ start: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [coords, setCoords] = useState<MentionCoords | null>(null)

  const matches = useMemo(
    () => (anchor ? matchCommands(candidates, anchor.query, MAX_MATCHES) : []),
    [anchor, candidates]
  )
  const open = matches.length > 0

  /** Call from the textarea's onChange AND onSelect — see useMentionAutocomplete for why both. */
  const sync = (nextValue: string, caret: number) => {
    const next = commandQueryAt(nextValue, caret)
    setAnchor(next)
    setActiveIndex(0)
    const el = ref.current
    if (!next || !el) {
      setCoords(null)
      return
    }
    const c = caretCoordinates(el, next.start)
    const belowY = el.getBoundingClientRect().top + c.top + c.height
    const openUpward = window.innerHeight - belowY < COMMAND_MENU_MAX_HEIGHT + 8
    setCoords({ ...c, elHeight: el.offsetHeight, elWidth: el.offsetWidth, openUpward })
  }

  const close = () => {
    setAnchor(null)
    setCoords(null)
  }

  // The draft can move without going through `sync` (a queued send clearing it, a session switch).
  useEffect(() => {
    if (anchor && value[anchor.start] !== '/') close()
  }, [value, anchor])

  const pick = (candidate: CommandCandidate) => {
    if (!anchor) return
    const el = ref.current
    const next = commandInsertion({
      text: value,
      anchorStart: anchor.start,
      spanEnd: tokenSpanEnd(value, anchor.start),
      command: candidate
    })
    setValue(next.text)
    close()
    onPicked?.({ agentId: candidate.agentId, agentName: candidate.agentName, name: candidate.name })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.caret, next.caret)
    })
  }

  /** Call from onKeyDown BEFORE the mention picker's and before Enter-sends. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((i) => (i + step + matches.length) % matches.length)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const candidate = matches[activeIndex]
      if (!candidate) return false
      event.preventDefault()
      pick(candidate)
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
