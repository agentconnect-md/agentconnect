'use client'

// The `/` and `!` picker's floating list plus a desktop pane describing the highlighted row; the textarea keeps focus.

import { AgentIconView } from '@/components/marks'
import { Icon } from '@/components/ui'
import { useTranslations } from 'next-intl'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentIcon } from '@/lib/agent-icon'
import type { RuntimeCommandsGap } from '@/components/console/useRuntimeCommands'
import { COMMAND_MENU_MAX_HEIGHT, type CommandMenuEntry } from '@/components/console/useCommandAutocomplete'
import type { MentionCoords } from '@/components/console/useMentionAutocomplete'

const LIST_WIDTH = 240
const DETAIL_WIDTH = 260

const ROW = 'fopt min-h-8 w-full gap-2 rounded-md px-2 py-[5px] text-[12px]'
const SUBTEXT = 'block truncate font-sans text-[11px] leading-normal font-normal text-(--text-tertiary)'

function entryKey(entry: CommandMenuEntry): string {
  if (entry.kind === 'skill') return `skill:${entry.candidate.agentId}:${entry.candidate.name}`
  if (entry.kind === 'control') return `control:${entry.control.name}`
  return `choice:${entry.control.name}:${entry.choice.value}`
}

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
  options: readonly CommandMenuEntry[]
  activeIndex: number
  coords: MentionCoords | null
  iconOf: (agentId: string) => { icon: AgentIcon | null | undefined; runtime: string } | undefined
  showOwner: boolean
  /** Participants that contributed nothing, and why — a partial roster reads as partial, not empty. */
  gaps?: ReadonlyArray<{ agentId: string; agentName: string; reason: RuntimeCommandsGap }>
  onHover: (index: number) => void
  onPick: (option: CommandMenuEntry) => void
}) {
  const t = useTranslations('Common.commandMenu')
  // Choices are a second level: the skills' roster gaps say nothing about them.
  const first = options[0]
  const choosing = first?.kind === 'choice' ? first.control.name : null
  const shownGaps = choosing ? [] : (gaps ?? [])
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const [detailTop, setDetailTop] = useState(0)
  const openUpward = coords?.openUpward ?? false
  // Top-align the pane with the highlighted row; opening upward, a pane taller than the list grows up, never over the composer.
  const alignDetail = useCallback(() => {
    const row = listRef.current?.children[activeIndex] as HTMLElement | undefined
    const list = listRef.current
    if (!row || !list) return
    const rowTop = row.offsetTop - list.scrollTop
    const room = list.offsetHeight - (detailRef.current?.offsetHeight ?? 0)
    const top = Math.min(rowTop, room)
    setDetailTop(openUpward ? top : Math.max(0, top))
  }, [activeIndex, openUpward])
  useLayoutEffect(() => {
    const row = listRef.current?.children[activeIndex] as HTMLElement | undefined
    row?.scrollIntoView?.({ block: 'nearest' })
    alignDetail()
  }, [activeIndex, options, coords, alignDetail])
  // Render for gaps alone too: a roster whose every participant is a gap must say so, not vanish.
  if ((options.length === 0 && shownGaps.length === 0) || !coords) return null
  const active = options[activeIndex]
  const position = coords.openUpward
    ? { bottom: coords.elHeight - coords.top + 4 }
    : { top: coords.top + coords.height + 4 }
  // Clamp like MentionMenu: near a narrow composer's right edge `left` would otherwise push the popover past it.
  const left = Math.min(Math.max(0, coords.left - 4), Math.max(0, coords.elWidth - LIST_WIDTH))
  return (
    <div style={{ ...position, left }} className="absolute z-50">
      <div
        ref={listRef}
        role="listbox"
        aria-label={choosing ? t(`controls.${choosing}.title`) : t('runCommand')}
        style={{ maxHeight: COMMAND_MENU_MAX_HEIGHT }}
        onScroll={alignDetail}
        className="w-[240px] overflow-y-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
      >
        {options.map((option, index) => {
          const selected = index === activeIndex
          const divider = index > 0 && option.kind === 'skill' && options[index - 1]!.kind === 'control'
          return (
            <button
              key={entryKey(option)}
              type="button"
              role="option"
              aria-selected={selected}
              className={`${ROW} ${selected ? 'bg-(--surface-hover)' : ''} ${divider ? 'mt-1' : ''}`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // preventDefault keeps focus in the textarea so pick() can restore the caret.
                event.preventDefault()
                onPick(option)
              }}
            >
              <MenuRow option={option} iconOf={iconOf} showOwner={showOwner} />
            </button>
          )
        })}
        {shownGaps.map((gap) => (
          <div
            key={gap.agentId}
            className="border-t border-(--border-subtle) px-2 py-[5px] font-sans text-[11px] leading-normal font-normal text-(--text-tertiary)"
          >
            {gap.agentName || t('oneAgent')}
            {gap.reason === 'unreported' ? t('unreported') : t('unreachable')}
          </div>
        ))}
      </div>
      {active && active.kind !== 'choice' && (
        <div
          ref={detailRef}
          style={{ top: detailTop, left: LIST_WIDTH + 4, maxHeight: COMMAND_MENU_MAX_HEIGHT, width: DETAIL_WIDTH }}
          className="absolute hidden overflow-y-auto rounded-[9px] border border-(--border-default) bg-(--surface-card) p-3 shadow-(--shadow-lg) desktop:block"
        >
          {active.kind === 'skill' ? (
            <>
              <div className="mono text-[12px] break-all text-(--text-primary)">{active.candidate.name}</div>
              {active.candidate.hint && (
                <div className="mono mt-[3px] text-[11px] break-all text-(--text-tertiary)">
                  {active.candidate.hint}
                </div>
              )}
              <p className="mt-2 font-sans text-[12px] leading-[1.5] font-normal text-(--text-secondary)">
                {active.candidate.description || t('noDescription')}
              </p>
              {showOwner && (
                <div className="mt-2 border-t border-(--border-subtle) pt-2 font-sans text-[11px] font-normal text-(--text-tertiary)">
                  {t('runsOn', { agent: active.candidate.agentName })}
                </div>
              )}
            </>
          ) : (
            <p className="font-sans text-[12px] leading-[1.5] font-normal text-(--text-secondary)">
              {t(`controls.${active.control.name}.does`)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function MenuRow({
  option,
  iconOf,
  showOwner
}: {
  option: CommandMenuEntry
  iconOf: (agentId: string) => { icon: AgentIcon | null | undefined; runtime: string } | undefined
  showOwner: boolean
}) {
  const t = useTranslations('Common.commandMenu')
  if (option.kind === 'choice') {
    const { choice } = option
    return (
      <>
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center text-(--text-secondary)">
          {choice.current && <Icon name="check" size={13} />}
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-sans text-[12px]">{choice.label}</span>
          {choice.label !== choice.value && <span className={`mono ${SUBTEXT}`}>{choice.value}</span>}
        </span>
      </>
    )
  }
  if (option.kind === 'control') {
    const { name } = option.control
    return (
      <>
        <span className="min-w-0 flex-1 text-left">
          <span className="mono block truncate text-[12px]">{name}</span>
          <span className={`${SUBTEXT} desktop:hidden`}>{t(`controls.${name}.does`)}</span>
        </span>
      </>
    )
  }
  const { candidate } = option
  const owner = iconOf(candidate.agentId)
  return (
    <>
      {showOwner && owner && (
        <span className="av h-[18px] w-[18px] flex-none rounded-xs">
          <AgentIconView icon={owner.icon} runtime={owner.runtime} size={18} />
        </span>
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className="mono block truncate text-[12px]">{candidate.name}</span>
        {(candidate.description || showOwner) && (
          <span className={`${SUBTEXT} desktop:hidden`}>
            {showOwner ? `${candidate.agentName} · ` : ''}
            {candidate.description}
          </span>
        )}
      </span>
    </>
  )
}
