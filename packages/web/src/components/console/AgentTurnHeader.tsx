'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { formatWorkStatus, turnDurationMs } from '@/components/console/session-work'
import { AGENT_NAME, TURN_FOLD } from '@/components/console/transcript-bubbles'

/** What an agent turn's fold line reports about the work it folds. */
export interface TurnWork {
  /** The work summary ("Ran 2 commands"), shown only in the tooltip. */
  summary: string
  /** Tool calls that failed, said after the duration in the error colour. */
  failed: number
  /** Someone interrupted the turn. */
  stopped?: boolean
  open: boolean
  onToggle: () => void
  /** The turn is still streaming: a running dot and a ticking duration. */
  running: boolean
  /** The first and last of the turn's own step timestamps; null omits the duration. */
  span: { startMs: number; endMs: number } | null
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
export function AgentTurnHeader({
  name,
  href,
  work,
  children
}: {
  name: string
  /** The agent's page, which its name opens as its icon does; absent where the agent is not known. */
  href?: string
  work?: TurnWork
  children?: ReactNode
}) {
  // Held here, not in the fold: a regenerated answer can drop the turn's work for a render, which would unmount the fold.
  const ms = useTurnDuration(work)
  return (
    <div className="mb-[5px] flex min-w-0 items-center gap-[7px]">
      {href ? (
        <Link href={href} className={`${AGENT_NAME} max-w-[50%] flex-none truncate no-underline hover:underline`}>
          {name}
        </Link>
      ) : (
        <span className={`${AGENT_NAME} max-w-[50%] flex-none truncate`}>{name}</span>
      )}
      {children}
      {work && <TurnFold work={work} ms={ms} />}
    </div>
  )
}

/** The duration a turn shows: ticking while it runs, then held once it finishes until its own steps can measure it. */
export function useTurnDuration(work: TurnWork | undefined): number | null {
  const running = work?.running ?? false
  const now = useNow(running && !!work?.span)
  const live = work ? turnDurationMs(work.span, running, now) : null
  // A finished turn keeps the time it ticked to; seeming to run again (a new prompt not yet listed) does not extend it.
  const [held, setHeld] = useState<{ ms: number | null; settled: boolean }>({ ms: null, settled: false })
  if (work && running && !held.settled && live !== null && live !== held.ms) setHeld({ ms: live, settled: false })
  if (work && !running && held.ms !== null && !held.settled) setHeld({ ms: held.ms, settled: true })
  if (held.settled) return !running && live !== null ? live : held.ms
  return live ?? (running ? null : held.ms)
}

function TurnFold({ work, ms }: { work: TurnWork; ms: number | null }) {
  const t = useTranslations('Sessions.detail')
  const status = formatWorkStatus(
    { ms, running: work.running, stopped: work.stopped, failed: work.failed, summary: work.summary },
    t
  )
  const said = [status.lead, status.duration].filter(Boolean).join(' · ')
  const title = status.title || t('details')
  return (
    <button
      type="button"
      onClick={work.onToggle}
      aria-expanded={work.open}
      aria-label={`${title}. ${work.open ? t('hideWork') : t('showWork')}`}
      data-turn-fold=""
      className={TURN_FOLD}
      title={title}
    >
      {status.running && (
        <span
          data-turn-running=""
          aria-hidden
          className="h-[6px] w-[6px] flex-none animate-pulse rounded-full bg-(--brand)"
        />
      )}
      {said && <span className="flex-none">{said}</span>}
      {status.failed && (
        <span className="flex-none">
          {said ? '· ' : ''}
          <span className="text-(--status-error)">{status.failed}</span>
        </span>
      )}
      <Icon name={work.open ? 'chevron-down' : 'chevron-right'} size={13} className="flex-none" />
    </button>
  )
}
