'use client'

// The session header's who: the agent's mark with its people's faces stacked, opening who is in the session and who can see it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { SessionAgentFocusOption } from '@/components/console/SessionAgentFocusMenu'

export interface HeaderPerson {
  id: string
  name: string
  /** Their handle and where they wrote from, under the name. */
  sub?: string
  /** A 22px face. */
  face: ReactNode
}

/** A person's line under their name: their handle and platform, or the platform alone when the handle is a raw member id. */
export function personSub(handle: string, platform: string): string {
  return handle.startsWith('@') && handle !== '@you' ? `${handle} · ${platform}` : platform
}

const ROW =
  'flex w-full min-w-0 items-center gap-[10px] rounded-[7px] px-2 py-[6px] text-left font-sans text-[13px] font-medium leading-normal text-(--text-primary)'
const LABEL =
  'px-2 pt-[6px] pb-[3px] font-mono text-[10.5px] font-semibold leading-normal tracking-[.08em] text-(--text-tertiary) uppercase'

export function HeaderPeople({
  agents,
  focusAgentId,
  onFocusChange,
  agentSub,
  cron,
  people,
  footer
}: {
  /** The session's agents; several means the focus picks whose workspace the dock reads. */
  agents: SessionAgentFocusOption[]
  focusAgentId: string
  onFocusChange: (agentId: string) => void
  /** The focused agent's model and machine, quiet under its name. */
  agentSub?: string
  /** A scheduled session's schedule, in place of people. */
  cron?: { href: string; name: string }
  people: HeaderPerson[]
  /** Who can see the session, and changing it. */
  footer?: ReactNode
}) {
  const t = useTranslations('Sessions.detail.headerPeople')
  // Hover shows it; a click, tap or Enter keeps it open until clicked again, Escape or a click outside.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || pinned
  const wrapRef = useRef<HTMLDivElement>(null)
  const focused = agents.find((agent) => agent.agentId === focusAgentId) ?? agents[0]

  const closeAll = () => {
    setHovered(false)
    setPinned(false)
  }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeAll()
    }
    // Captured and marked handled, so Escape closes this popover without also closing what it is drawn inside.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAll()
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const names = [focused?.label, ...people.map((person) => person.name)].filter(Boolean).join(', ')
  return (
    // Mouse only: a tap's emulated enter would otherwise hold the popover open past a second tap.
    <div
      ref={wrapRef}
      className="flex flex-none items-center desktop:relative"
      onPointerEnter={(event) => event.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && setHovered(false)}
    >
      <button
        type="button"
        data-header-people=""
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('open', { names })}
        onClick={() => (pinned ? closeAll() : setPinned(true))}
        className="flex cursor-pointer items-center rounded-full border-0 bg-transparent px-1 py-[2px] transition-colors hover:bg-(--surface-hover)"
      >
        {focused ? (
          <span className="av relative z-[3] h-[22px] w-[22px] flex-none rounded-[6px] shadow-[0_0_0_2px_var(--surface-app)]">
            {focused.avatar}
          </span>
        ) : null}
        {people.slice(0, 2).map((person, i) => (
          <span
            key={person.id}
            style={{ zIndex: 2 - i }}
            className="relative ml-[-4px] flex h-[22px] w-[22px] flex-none overflow-hidden rounded-full shadow-[0_0_0_2px_var(--surface-app)]"
          >
            {person.face}
          </span>
        ))}
      </button>
      {open ? (
        // The transparent top padding bridges trigger and panel, so the hover survives the gap.
        <div className="absolute top-full right-4 left-4 z-50 pt-[6px] desktop:right-0 desktop:left-auto">
          <div
            role="dialog"
            aria-label={t('dialog')}
            data-header-people-dialog=""
            className="max-h-[60vh] overflow-auto rounded-[10px] border border-(--border-default) bg-(--surface-card) p-[6px] shadow-(--shadow-lg) desktop:min-w-[280px]"
          >
            <div className={LABEL}>{agents.length > 1 ? t('agents') : t('agent')}</div>
            {agents.map((agent) => {
              const on = agent.agentId === focused?.agentId
              const body = (
                <>
                  <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">{agent.avatar}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{agent.label}</span>
                    {on && agentSub ? (
                      <span className="truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                        {agentSub}
                      </span>
                    ) : null}
                  </span>
                </>
              )
              return (
                <div key={agent.agentId} className="flex min-w-0 items-center gap-1">
                  {agents.length > 1 ? (
                    <button
                      type="button"
                      aria-pressed={on}
                      data-header-people-agent={agent.agentId}
                      onClick={() => onFocusChange(agent.agentId)}
                      className={`${ROW} cursor-pointer border-0 hover:bg-(--surface-hover) ${on ? 'bg-(--surface-hover)' : 'bg-transparent'}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <span className={ROW}>{body}</span>
                  )}
                  {agent.href ? (
                    <Link
                      href={agent.href}
                      title={t('openAgent', { agent: agent.label })}
                      aria-label={t('openAgent', { agent: agent.label })}
                      className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[6px] text-(--text-tertiary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary)"
                    >
                      <Icon name="arrow-up-right" size={14} />
                    </Link>
                  ) : null}
                </div>
              )
            })}
            {cron ? (
              <>
                <div className={LABEL}>{t('schedule')}</div>
                <Link href={cron.href} className={`${ROW} no-underline transition-colors hover:bg-(--surface-hover)`}>
                  <Icon name="calendar-clock" size={15} color="var(--text-tertiary)" className="flex-none" />
                  <span className="truncate">{cron.name}</span>
                </Link>
              </>
            ) : null}
            {people.length > 0 ? (
              <>
                <div className={LABEL}>{t('people')}</div>
                {people.map((person) => (
                  <div key={person.id} data-header-person="" className={ROW}>
                    <span className="flex h-[22px] w-[22px] flex-none overflow-hidden rounded-full">{person.face}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{person.name}</span>
                      {person.sub ? (
                        <span className="truncate text-[11.5px] font-normal text-(--text-tertiary)">{person.sub}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
            {footer ? (
              <div className="mt-[6px] flex items-center border-t border-(--border-subtle) px-2 pt-[6px]">{footer}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
