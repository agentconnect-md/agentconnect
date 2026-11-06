'use client'

// Composer `/` and `!` picker: console commands, then skills, whose pick writes only `/name ` and names its owner via onPicked.

import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { commandArgAt, commandQueryAt, tokenSpanEnd, type CommandPrefix } from '@/lib/conversation-addressing'
import { caretCoordinates } from '@/components/console/caret-coordinates'
import { commandInsertion, matchCommands, type CommandCandidate } from '@/components/console/runtime-command-menu'
import {
  draftWithoutCommandLine,
  matchChoices,
  matchControls,
  resolveControl,
  type ControlChoice,
  type ControlCommand
} from '@/components/console/composer-control-commands'
import type { MentionCoords } from '@/components/console/useMentionAutocomplete'

/** Mirrors CommandMenu's `max-h` — the worst-case height used to decide whether the list fits below. */
export const COMMAND_MENU_MAX_HEIGHT = 280
const MAX_MATCHES = 8
const NO_CONTROLS: readonly ControlCommand[] = []

/** One row of the picker: a console command, one of its choices, or a participant's skill. */
export type CommandMenuEntry =
  | { kind: 'control'; control: ControlCommand }
  | { kind: 'choice'; control: ControlCommand; choice: ControlChoice }
  | { kind: 'skill'; candidate: CommandCandidate }

/** What the caret is on: the command word, or (`arg` set) a console command's argument. */
interface Anchor {
  start: number
  prefix: CommandPrefix
  query: string
  arg: string | null
}

export function useCommandAutocomplete(params: {
  ref: RefObject<HTMLTextAreaElement | null>
  value: string
  setValue: (v: string) => void
  candidates: readonly CommandCandidate[]
  /** Console commands, offered before the skills and run as console actions on pick. */
  controls?: readonly ControlCommand[]
  /** A skill pick's owner; the caller merges it into `mentions[]` while the token still leads at send. */
  onPicked?: (target: { agentId: string; agentName: string; name: string }) => void
}) {
  const { ref, value, setValue, candidates, controls = NO_CONTROLS, onPicked } = params
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [coords, setCoords] = useState<MentionCoords | null>(null)

  const matches = useMemo<CommandMenuEntry[]>(() => {
    if (!anchor) return []
    if (anchor.arg !== null) {
      const control = resolveControl(controls, anchor.query)
      if (!control?.choices) return []
      return matchChoices(control.choices, anchor.arg).map((choice) => ({ kind: 'choice', control, choice }))
    }
    return [
      ...matchControls(controls, anchor.query).map((control) => ({ kind: 'control' as const, control })),
      ...matchCommands(candidates, anchor.query, MAX_MATCHES).map((candidate) => ({
        kind: 'skill' as const,
        candidate
      }))
    ]
  }, [anchor, candidates, controls])
  const open = matches.length > 0

  const place = (start: number) => {
    const el = ref.current
    if (!el) return setCoords(null)
    const c = caretCoordinates(el, start)
    const belowY = el.getBoundingClientRect().top + c.top + c.height
    const openUpward = window.innerHeight - belowY < COMMAND_MENU_MAX_HEIGHT + 8
    setCoords({ ...c, elHeight: el.offsetHeight, elWidth: el.offsetWidth, openUpward })
  }

  /** Call from the textarea's onChange AND onSelect — see useMentionAutocomplete for why both. */
  const sync = (nextValue: string, caret: number) => {
    const word = commandQueryAt(nextValue, caret)
    const withArg = word ? null : commandArgAt(nextValue, caret)
    // An argument only keeps the picker open for a console command that has choices to narrow.
    const argControl = withArg ? resolveControl(controls, withArg.word) : undefined
    const next: Anchor | null = word
      ? { ...word, arg: null }
      : withArg && argControl?.choices
        ? { start: withArg.start, prefix: withArg.prefix, query: withArg.word, arg: withArg.arg }
        : null
    setAnchor(next)
    setActiveIndex(0)
    if (next) place(next.start)
    else setCoords(null)
  }

  const close = () => {
    setAnchor(null)
    setCoords(null)
  }

  // The draft can move without going through `sync` (a queued send clearing it, a session switch).
  useEffect(() => {
    if (anchor && value[anchor.start] !== anchor.prefix) close()
  }, [value, anchor])

  const moveCaret = (caret: number) => {
    const el = ref.current
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const pick = (entry: CommandMenuEntry) => {
    if (!anchor) return
    if (entry.kind === 'skill') {
      const next = commandInsertion({
        text: value,
        anchorStart: anchor.start,
        spanEnd: tokenSpanEnd(value, anchor.start),
        command: entry.candidate
      })
      setValue(next.text)
      close()
      const { agentId, agentName, name } = entry.candidate
      onPicked?.({ agentId, agentName, name })
      moveCaret(next.caret)
      return
    }
    if (entry.kind === 'control' && entry.control.choices) {
      // Second level: write `/name ` and list its choices, narrowed by whatever is typed next.
      const head = value.slice(0, anchor.start)
      const inserted = `${anchor.prefix}${entry.control.name} `
      // Trim spaces only: a newline must survive, or picking a choice consumes the message below the command.
      setValue(head + inserted + value.slice(tokenSpanEnd(value, anchor.start)).replace(/^[ \t]+/, ''))
      setAnchor({ start: anchor.start, prefix: anchor.prefix, query: entry.control.name, arg: '' })
      setActiveIndex(0)
      moveCaret(head.length + inserted.length)
      return
    }
    const rest = draftWithoutCommandLine(value, anchor.start)
    setValue(rest)
    close()
    entry.control.run(entry.kind === 'choice' ? entry.choice.value : null)
    moveCaret(Math.min(anchor.start, rest.length))
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
      const entry = matches[activeIndex]
      if (!entry) return false
      event.preventDefault()
      pick(entry)
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
