'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { mentionQueryAt, mentionSpanEnd } from '@/lib/conversation-addressing'
import { caretCoordinates } from '@/components/console/caret-coordinates'

export interface MentionCandidate {
  id: string
  name: string
}

/** Mirrors MentionMenu's `max-h` — the worst-case list height used to decide
 *  whether "below the caret" still fits the viewport. */
export const MENTION_MENU_MAX_HEIGHT = 220

export interface MentionCoords {
  /** Caret's line, relative to the textarea's own box (post-scroll). */
  top: number
  left: number
  height: number
  /** The textarea's own box height — lets the menu anchor by `bottom` when
   *  flipped upward without knowing its own rendered height in advance. */
  elHeight: number
  /** The textarea's own box width — lets the menu clamp its right edge to the
   *  composer instead of overflowing a narrow one. */
  elWidth: number
  /** True when there isn't room below the caret in the viewport (a
   *  SessionDetail composer pinned near the bottom of the screen) — the menu
   *  opens upward from the caret's line instead. */
  openUpward: boolean
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
  /** May join the conversation over the network (SessionDetail's mid-conversation
   *  add) — while any such join is in flight, `joining` is true so composers can
   *  hold off sending until the roster actually reflects the pick(s) instead of
   *  racing an Enter against them. The promise settling is NOT itself success —
   *  return `false` for a refusal/failure (a `void`/sync return, e.g. Home's, is
   *  never a failure — there was nothing to join) — a `false` rolls back the
   *  optimistically-inserted "@Name " if it's still there untouched, since that
   *  agent never actually joined and the mention would otherwise look routable
   *  while resolving to nobody. */
  onPick?: (candidate: T) => void | Promise<boolean>
}) {
  const { ref, value, setValue, candidates, onPick } = params
  const [anchor, setAnchor] = useState<{ start: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // A COUNT, not a bool: two quick non-roster picks overlap their joins, and
  // whichever settles first must not clear the gate out from under the other
  // still-pending one.
  const [pendingJoins, setPendingJoins] = useState(0)
  const joining = pendingJoins > 0
  // Mirrors `value` for pick()'s rollback, which can run long after the pick
  // that started it (an async join settling) — by then `value` has moved on
  // via further edits, and closing over the pick-time value would roll back
  // against a draft that no longer exists.
  const valueRef = useRef(value)
  valueRef.current = value
  // Where the triggering `@` sits on screen, so the list drops right under the
  // line being typed — not the textarea's edge, which reads as broken on a
  // tall, mostly-empty composer (a multi-row textarea's bottom can be far from
  // a first-line "@").
  const [coords, setCoords] = useState<MentionCoords | null>(null)

  const matches = useMemo(() => {
    if (!anchor) return []
    const q = anchor.query.toLowerCase()
    return candidates.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [anchor, candidates])

  const open = matches.length > 0

  /** Call from the textarea's onChange AND onSelect with the current value +
   *  caret — re-deriving the anchor on every caret move (not just typing) is
   *  what keeps `pick()`'s replace range live: arrow keys, Home/End, or a
   *  click can move the caret without an onChange, and picking against a
   *  stale anchor either duplicates or drops the token's tail. */
  const sync = (nextValue: string, caret: number) => {
    const next = mentionQueryAt(nextValue, caret)
    setAnchor(next)
    setActiveIndex(0)
    const el = ref.current
    if (!next || !el) {
      setCoords(null)
      return
    }
    const c = caretCoordinates(el, next.start)
    // Viewport-relative Y just below the caret's line — a SessionDetail
    // composer pinned near the bottom of the screen often has no room there.
    const belowY = el.getBoundingClientRect().top + c.top + c.height
    const openUpward = window.innerHeight - belowY < MENTION_MENU_MAX_HEIGHT + 8
    setCoords({ ...c, elHeight: el.offsetHeight, elWidth: el.offsetWidth, openUpward })
  }

  const close = () => {
    setAnchor(null)
    setCoords(null)
  }

  // A draft can change out from under the anchor without going through
  // `sync` — a queued send clearing it, a session switch, an external reset —
  // and picking against a now-mismatched anchor would splice the replacement
  // into the wrong place. Cheap invariant: the anchor's `@` must still be
  // there; if `value` moved on without it, drop the stale anchor.
  useEffect(() => {
    if (anchor && value[anchor.start] !== '@') close()
  }, [value, anchor])

  const pick = (candidate: T) => {
    if (!anchor) return
    const el = ref.current
    // The token's FULL extent, not just the prefix up to the caret — the
    // caret can sit mid-token (see `sync`'s note), and replacing only up to
    // it would leave the token's tail dangling as stray text.
    const end = mentionSpanEnd(value, anchor.start)
    const before = value.slice(0, anchor.start)
    const after = value.slice(end)
    const insertedText = `@${candidate.name} `
    setValue(before + insertedText + after)
    close()
    const pos = before.length + insertedText.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
    const result = onPick?.(candidate)
    if (result instanceof Promise) {
      const insertStart = before.length
      const insertEnd = insertStart + insertedText.length
      setPendingJoins((n) => n + 1)
      result
        .then((success) => {
          if (success !== false) return
          // Best-effort, bounded rollback: only remove the token if it's
          // EXACTLY what this pick inserted and nothing since has touched
          // that range — never eat into unrelated edits the user made while
          // the join was in flight.
          const cur = valueRef.current
          if (cur.slice(insertStart, insertEnd) === insertedText) {
            setValue(cur.slice(0, insertStart) + cur.slice(insertEnd))
          }
        })
        .finally(() => setPendingJoins((n) => n - 1))
    }
  }

  /** Call from the textarea's onKeyDown BEFORE any Enter-sends handling — a
   *  `true` return means the key was consumed by the picker. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    // An IME candidate window uses Enter/arrows too (to confirm/navigate a
    // composition) — let those through untouched instead of the picker
    // hijacking them while composing.
    if (event.nativeEvent.isComposing) return false
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

  return { open, matches, activeIndex, setActiveIndex, coords, joining, sync, handleKeyDown, pick, close }
}
