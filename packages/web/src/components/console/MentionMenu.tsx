'use client'

import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'
import { MENTION_MENU_MAX_HEIGHT, type MentionCoords } from '@/components/console/useMentionAutocomplete'

const MENU_WIDTH = 220

export interface MentionOption {
  id: string
  name: string
  icon: AgentIcon | null | undefined
  runtime: string
  /** Already a conversation participant — picking it only inserts the name.
   *  Not yet in the roster — picking it also joins the conversation. */
  inRoster: boolean
  /** Offline / no signed-in runtime — shown dimmed with `description` as the
   *  reason, but still pickable: matches ComposerMenu's existing add-agent
   *  options ("Render the option dimmed (still selectable)"), so picking one
   *  here has the exact same consequence picking it there already does —
   *  Send disables once the roster has an unready member, with the reason in
   *  the Send button's own tooltip (see HomeView's `notReadyMember`). */
  dimmed?: boolean
  description?: string
}

/** The @mention picker's floating list (webchat-multi-agents.md §9.1/§9.2).
 *  Markup mirrors ComposerMenu's dropdown, but it owns no focus/trigger of its
 *  own — the textarea keeps focus throughout typing, and its onKeyDown drives
 *  `activeIndex` via useMentionAutocomplete.handleKeyDown. */
export function MentionMenu({
  options,
  activeIndex,
  coords,
  onHover,
  onPick
}: {
  options: readonly MentionOption[]
  activeIndex: number
  /** Where the triggering `@` sits inside the textarea (useMentionAutocomplete's
   *  `coords`) — the list anchors right under (or, near the bottom of the
   *  viewport, above) that line, not the textarea's edge. */
  coords: MentionCoords | null
  onHover: (index: number) => void
  onPick: (option: MentionOption) => void
}) {
  if (options.length === 0 || !coords) return null
  const position = coords.openUpward
    ? { bottom: coords.elHeight - coords.top + 4 }
    : { top: coords.top + coords.height + 4 }
  // Clamp the LEFT edge too: near the right side of a narrow composer,
  // `max-w-[calc(100%-15px)]` bounds the menu's own width but not how far
  // `left` can push it past the textarea's right edge.
  const left = Math.min(Math.max(0, coords.left - 4), Math.max(0, coords.elWidth - MENU_WIDTH))
  return (
    <div
      role="listbox"
      aria-label="Mention an agent"
      style={{ ...position, left, maxHeight: MENTION_MENU_MAX_HEIGHT }}
      className="absolute z-50 w-[220px] max-w-[calc(100%-15px)] overflow-y-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          title={option.description}
          className={`fopt min-h-8 w-full gap-2 rounded-md px-2 py-[5px] text-[12px] ${
            index === activeIndex ? 'bg-(--surface-hover)' : ''
          } ${option.dimmed ? 'opacity-55' : ''}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            // preventDefault keeps focus in the textarea — a plain click
            // would blur it, and `pick()` needs `ref.current` still pointed
            // at the live element to restore the caret afterward.
            event.preventDefault()
            onPick(option)
          }}
        >
          <span className="av h-[18px] w-[18px] flex-none rounded-xs">
            <AgentIconView icon={option.icon} runtime={option.runtime} size={18} />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{option.name}</span>
          {!option.inRoster && <span className="flex-none font-sans text-[10.5px] text-(--text-tertiary)">Add</span>}
        </button>
      ))}
    </div>
  )
}
