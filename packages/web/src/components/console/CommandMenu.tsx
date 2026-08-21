'use client'

// The `/command` picker's floating list. Like MentionMenu it owns no focus — the textarea keeps it
// and drives `activeIndex` through useCommandAutocomplete.handleKeyDown.
//
// The pane beside the list is the point of this menu: ACP makes `description` a REQUIRED field on
// every advertised command, and a name alone ("/tdd", "/handoff") does not say what running it
// does. Zed's ACP picker drops the description and its users ask for it back
// (zed-industries/zed discussion #49085), so the data is there and the affordance is the gap.

import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'
import type { CommandCandidate } from '@/components/console/runtime-command-menu'
import type { RuntimeCommandsGap } from '@/components/console/useRuntimeCommands'
import { COMMAND_MENU_MAX_HEIGHT } from '@/components/console/useCommandAutocomplete'
import type { MentionCoords } from '@/components/console/useMentionAutocomplete'

const LIST_WIDTH = 240
const DETAIL_WIDTH = 260

export function CommandMenu({
  options,
  activeIndex,
  coords,
  /** Icons by agentId — a multi-participant conversation marks whose command each row is. */
  iconOf,
  gaps,
  /** Whether to show the owning agent at all (a one-agent conversation has nothing to disambiguate). */
  showOwner,
  onHover,
  onPick
}: {
  options: readonly CommandCandidate[]
  activeIndex: number
  coords: MentionCoords | null
  iconOf: (agentId: string) => { icon: AgentIcon | null | undefined; runtime: string } | undefined
  showOwner: boolean
  /** Participants that contributed nothing, and why — a partial roster reads as partial, not empty. */
  gaps?: ReadonlyArray<{ agentId: string; agentName: string; reason: RuntimeCommandsGap }>
  onHover: (index: number) => void
  onPick: (option: CommandCandidate) => void
}) {
  // Render for gaps alone too: a roster whose every participant is a gap must say so, not vanish.
  if ((options.length === 0 && (gaps?.length ?? 0) === 0) || !coords) return null
  const active = options[activeIndex]
  const position = coords.openUpward
    ? { bottom: coords.elHeight - coords.top + 4 }
    : { top: coords.top + coords.height + 4 }
  // Clamp like MentionMenu: near a narrow composer's right edge `left` would otherwise push the
  // whole popover past it. Clamped against the list alone — the pane is desktop-only and fixed.
  const left = Math.min(Math.max(0, coords.left - 4), Math.max(0, coords.elWidth - LIST_WIDTH))
  // Anchored by whichever edge faces the caret: opening upward, the wrapper's BOTTOM is the fixed
  // edge, so the cards must bottom-align — top-aligning there leaves the shorter card (usually the
  // list, the primary surface) floating high above the composer while only the taller pane touches
  // it. Downward, the top edge faces the caret and top-alignment is correct.
  return (
    <div
      style={{ ...position, left }}
      className={`absolute z-50 flex gap-1 ${coords.openUpward ? 'items-end' : 'items-start'}`}
    >
      <div
        role="listbox"
        aria-label="Run a command"
        style={{ maxHeight: COMMAND_MENU_MAX_HEIGHT }}
        className="w-[240px] flex-none overflow-y-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
      >
        {options.map((option, index) => {
          const owner = iconOf(option.agentId)
          return (
            <button
              key={`${option.agentId}:${option.name}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`fopt min-h-8 w-full gap-2 rounded-md px-2 py-[5px] text-[12px] ${
                index === activeIndex ? 'bg-(--surface-hover)' : ''
              }`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // preventDefault keeps focus in the textarea so pick() can restore the caret.
                event.preventDefault()
                onPick(option)
              }}
            >
              {showOwner && owner && (
                <span className="av h-[18px] w-[18px] flex-none rounded-xs">
                  <AgentIconView icon={owner.icon} runtime={owner.runtime} size={18} />
                </span>
              )}
              <span className="min-w-0 flex-1 text-left">
                <span className="mono block truncate text-[12px]">/{option.name}</span>
                {(option.description || showOwner) && (
                  <span className="block truncate font-sans text-[11px] leading-normal font-normal text-(--text-tertiary) desktop:hidden">
                    {showOwner ? `${option.agentName} · ` : ''}
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          )
        })}
        {(gaps ?? []).map((gap) => (
          <div
            key={gap.agentId}
            className="border-t border-(--border-subtle) px-2 py-[5px] font-sans text-[11px] leading-normal font-normal text-(--text-tertiary)"
          >
            {gap.agentName || 'One agent'}
            {gap.reason === 'unreported'
              ? ' hasn’t reported its skills yet — they appear after its next session starts'
              : ' is unreachable'}
          </div>
        ))}
      </div>
      {active && (
        <div
          style={{ maxHeight: COMMAND_MENU_MAX_HEIGHT, width: DETAIL_WIDTH }}
          className="hidden flex-none overflow-y-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) p-3 shadow-(--shadow-lg) desktop:block"
        >
          <div className="mono text-[12px] break-all text-(--text-primary)">/{active.name}</div>
          {active.hint && (
            <div className="mono mt-[3px] text-[11px] break-all text-(--text-tertiary)">{active.hint}</div>
          )}
          <p className="mt-2 font-sans text-[12px] leading-[1.5] font-normal text-(--text-secondary)">
            {active.description || 'This command has no description.'}
          </p>
          {showOwner && (
            <div className="mt-2 border-t border-(--border-subtle) pt-2 font-sans text-[11px] font-normal text-(--text-tertiary)">
              Runs on {active.agentName}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
