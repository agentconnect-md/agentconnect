'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { formatTurnDuration, turnDurationMs } from '@/components/console/session-work'
import { AGENT_NAME, TURN_FOLD } from '@/components/console/transcript-bubbles'

/** What an agent turn's fold line reports about the work it folds. */
export interface TurnWork {
  /** The work summary ("Ran 2 commands"); empty falls back to a generic label. */
  summary: string
  open: boolean
  onToggle: () => void
  /** The turn is still streaming: "Working for", ticking, with no completion check yet. */
  running: boolean
  /** The first and last of the turn's own step timestamps; null omits the duration. */
  span: { startMs: number; endMs: number } | null
  /** The running step's first line, and the identity that replays its fade-in when the step changes. */
  liveLine?: string | undefined
  liveKey?: string | undefined
}

/** The current time, re-read every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

/** An agent turn's one header line: its name, then — when it did work — a fold control that opens that work. */
export function AgentTurnHeader({ name, work, children }: { name: string; work?: TurnWork; children?: ReactNode }) {
  return (
    <div className="mb-[5px] flex min-w-0 items-center gap-[7px]">
      <span className={`${AGENT_NAME} max-w-[50%] flex-none truncate`}>{name}</span>
      {children}
      {work && <TurnFold work={work} />}
    </div>
  )
}

function TurnFold({ work }: { work: TurnWork }) {
  const t = useTranslations('Sessions.detail')
  const now = useNow(work.running && work.span !== null)
  const live = turnDurationMs(work.span, work.running, now)
  // A live stream may stamp every step with the turn's start, so a turn that just finished keeps the time it ticked to.
  const [lastLive, setLastLive] = useState<number | null>(null)
  if (work.running && live !== null && live !== lastLive) setLastLive(live)
  const ms = live ?? (work.running ? null : lastLive)
  const duration = ms === null ? null : formatTurnDuration(ms)
  return (
    <button
      type="button"
      onClick={work.onToggle}
      aria-expanded={work.open}
      data-turn-fold=""
      className={TURN_FOLD}
      title={work.open ? t('hideWork') : t('showWork')}
    >
      {work.running && <Icon name="loader" size={12} color="var(--text-tertiary)" className="flex-none animate-spin" />}
      {duration && (
        <span className="flex-none">
          {work.running ? t('turnWorking', { duration }) : t('turnWorked', { duration })}
          {' ·'}
        </span>
      )}
      <span className="min-w-0 truncate desktop:flex-none">{work.summary || t('details')}</span>
      {!work.running && <Icon name="check" size={13} color="var(--text-tertiary)" className="flex-none" />}
      {work.liveLine && (
        // Keyed by step identity + content so a new step remounts the span and replays its fade-in.
        <span key={work.liveKey} className="work-live min-w-0 truncate">
          · {work.liveLine}
        </span>
      )}
      <Icon name={work.open ? 'chevron-down' : 'chevron-right'} size={13} className="flex-none" />
    </button>
  )
}
