'use client'

// What the session's Tasks tab and the agent's Activity share: groups, state marks, one-line rows, the finished toggle and stopping a task.

import { useCallback, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useFormatter, useTimeZone, useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'
import { FollowUpChecks, followUpKindKey, followUpOf, stopTask, taskStopKey } from '@/components/console/follow-up'
import { ApiError, type AssistantFollowUpDto, type AssistantSubsessionDto } from '@/lib/api'
import { chatPlaceName } from '@/lib/platform-labels'
import { useOrgs } from '@/lib/org-context'

/** How long a running task has been running: `s`, then `m s`, then `h m`, never negative from a daemon clock ahead of ours. */
export function formatTaskElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return ''
  const seconds = Math.max(0, Math.round((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A clock time today in the viewer's time zone, else a short date with it. */
export function useShortTime(): (at: string) => string {
  const format = useFormatter()
  const timeZone = useTimeZone()
  const day = (date: Date) => date.toLocaleDateString('en-CA', { timeZone })
  return (at) => {
    const date = new Date(at)
    const today = day(date) === day(new Date())
    return today
      ? format.dateTime(date, { hour: 'numeric', minute: '2-digit' })
      : format.dateTime(date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
}

export type MarkTone = 'running' | 'open' | 'paused' | 'waiting' | 'done' | 'failed' | 'stopped'

const MARK: Record<MarkTone, string> = {
  running: 'bg-(--status-info)',
  open: 'border-[1.5px] border-(--status-info)',
  paused: 'border-[1.5px] border-(--status-paused)',
  waiting: 'bg-(--status-paused)',
  done: 'bg-(--status-online)',
  failed: 'bg-(--status-error)',
  stopped: 'border-[1.5px] border-(--border-strong)'
}

export function StateMark({ tone }: { tone: MarkTone }) {
  return <span aria-hidden data-state-mark={tone} className={`mt-[6px] h-2 w-2 flex-none rounded-full ${MARK[tone]}`} />
}

/** A group: its sentence-case name and how many rows it shows; the caller leaves out a group with none. */
export function TaskGroup({
  id,
  title,
  count,
  children
}: {
  id: string
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section data-task-group={id} aria-label={title} className="flex flex-none flex-col">
      <h3 className="m-0 flex items-baseline gap-[6px] px-[2px] pb-[2px] font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
        {title}
        <span data-task-group-count="" className="font-normal text-(--text-tertiary)">
          {count}
        </span>
      </h3>
      {children}
    </section>
  )
}

/** One row: a state mark and its name, its actions at the right, then one meta line and an optional preview line, which run under the actions on a phone. */
export function TaskRow({
  tone,
  title,
  meta,
  preview,
  actions,
  dim = false,
  after,
  attrs
}: {
  tone: MarkTone
  title: ReactNode
  meta: ReactNode
  preview?: ReactNode
  actions?: ReactNode
  dim?: boolean
  after?: ReactNode
  attrs?: Record<`data-${string}`, string | undefined>
}) {
  return (
    <div
      {...attrs}
      className={`group grid flex-none grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-[7px] ${dim ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-[10px] max-desktop:self-center">
        <StateMark tone={tone} />
        <div className="flex min-w-0 flex-1 items-center gap-2 font-sans text-[13px] font-medium leading-[1.5] text-(--text-primary)">
          {title}
        </div>
      </div>
      {actions ? (
        <div className="col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-2 desktop:row-span-2 desktop:self-start">
          {actions}
        </div>
      ) : null}
      <div className="col-span-2 col-start-1 row-start-2 mt-px flex min-w-0 flex-col pl-[18px] desktop:col-span-1">
        {meta}
        {preview}
      </div>
      {after ? <div className="col-span-2 col-start-1 flex flex-col pl-[18px]">{after}</div> : null}
    </div>
  )
}

/** Its parts joined by a middle dot, led by a platform's mark; a toggle when it opens a follow-up's checks. */
export function MetaLine({
  platform,
  parts,
  toggle
}: {
  platform?: string | null
  parts: ReactNode[]
  toggle?: { expanded: boolean; onToggle: () => void; label: string }
}) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '')
  const body = (
    <>
      {platform ? <PlaceMark platform={platform} /> : null}
      <span className="min-w-0 truncate">
        {shown.map((part, i) => (
          <span key={i}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            {part}
          </span>
        ))}
      </span>
      {toggle ? <Icon name={toggle.expanded ? 'chevron-up' : 'chevron-down'} size={13} className="flex-none" /> : null}
    </>
  )
  const cls =
    'flex min-w-0 items-center gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)'
  if (!toggle)
    return (
      <div data-meta-line="" className={cls}>
        {body}
      </div>
    )
  return (
    <button
      type="button"
      data-meta-line=""
      aria-expanded={toggle.expanded}
      aria-label={toggle.label}
      onClick={toggle.onToggle}
      className={`${cls} w-fit max-w-full cursor-pointer border-0 bg-transparent p-0 text-left`}
    >
      {body}
    </button>
  )
}

/** A platform's mark at the meta line's size. */
export function PlaceMark({ platform }: { platform: string }) {
  return (
    <span aria-hidden className="flex h-[13px] w-[13px] flex-none items-center justify-center">
      <PlatformMark platform={platform} fillPct={100} />
    </span>
  )
}

/** A long text cut to one ellipsised line, `quiet` in the meta line's tone; expanding wraps it in full and shows what follows it. */
export function PreviewLine({
  text,
  mono = false,
  quiet = false,
  expanded,
  onToggle,
  children
}: {
  text: string
  mono?: boolean
  quiet?: boolean
  expanded: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        data-preview-line=""
        onClick={onToggle}
        className={`mt-[3px] flex w-full min-w-0 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left max-desktop:py-1 ${
          quiet ? 'text-(--text-tertiary)' : 'text-(--text-secondary)'
        }`}
      >
        <span
          className={`min-w-0 flex-1 ${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} ${
            mono ? 'font-mono text-[11.5px] leading-[1.6]' : 'font-sans text-[12.5px] leading-[1.5]'
          }`}
        >
          {text}
        </span>
        <Icon
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          className="mt-[2px] flex-none text-(--text-tertiary)"
        />
      </button>
      {expanded && children ? <div className="mt-2 flex flex-col gap-2">{children}</div> : null}
    </>
  )
}

/** Shows the finished rows back in their groups, dimmed. */
export function FinishedToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const t = useTranslations('Common.taskList')
  return (
    <button
      type="button"
      aria-expanded={open}
      data-finished-toggle=""
      onClick={onToggle}
      className="flex w-fit flex-none cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[2px] py-[6px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) max-desktop:min-h-11"
    >
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      {t('finished', { count })}
    </button>
  )
}

/** A row action: on hover on desktop, always on a phone at a 44px tap size. */
export function RowAction({
  label,
  onClick,
  disabled = false,
  pinned = false
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pinned?: boolean
}) {
  return (
    <Button
      variant="secondary"
      size="xs"
      className={`flex-none max-desktop:h-11 max-desktop:px-4 ${
        pinned ? '' : 'desktop:opacity-0 desktop:group-hover:opacity-100 desktop:focus-visible:opacity-100'
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

/** A decision button at the row's right, 44px tall on a phone. */
export function DecisionButton({
  label,
  primary,
  disabled,
  onClick
}: {
  label: string
  primary: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="xs"
      className="flex-none max-desktop:h-11 max-desktop:px-4"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

export type StopState = 'busy' | 'stopped' | 'not_running' | 'failed' | 'upgrade'

/** Stops by row, held per scope so a re-read keeps what a stop did; `onSettled` re-reads the list. */
export function useTaskStops(
  agentId: string,
  scope: string,
  onSettled: () => void
): {
  stopOf: (row: AssistantSubsessionDto) => StopState | undefined
  stop: (row: AssistantSubsessionDto) => Promise<void>
} {
  const [stops, setStops] = useState<{ scope: string; byId: Record<string, StopState> }>({ scope, byId: {} })
  const byId = stops.scope === scope ? stops.byId : {}
  const stop = useCallback(
    async (row: AssistantSubsessionDto) => {
      const id = taskStopKey(row)
      if (!id) return
      const mark = (state: StopState) =>
        setStops((prev) => ({ scope, byId: { ...(prev.scope === scope ? prev.byId : {}), [id]: state } }))
      mark('busy')
      try {
        mark((await stopTask(agentId, row)).result)
      } catch (e) {
        mark(e instanceof ApiError && e.code === 'DAEMON_FEATURE_MISSING' ? 'upgrade' : 'failed')
      }
      onSettled()
    },
    [agentId, onSettled, scope]
  )
  return {
    stopOf: (row) => {
      const id = taskStopKey(row)
      return id ? byId[id] : undefined
    },
    stop
  }
}

/** A row is finished once it reported, failed or ended. */
export const taskFinished = (row: AssistantSubsessionDto) => row.state !== 'open'

function taskTone(row: AssistantSubsessionDto, followUp: AssistantFollowUpDto | null): MarkTone {
  if (followUp) {
    if (followUp.status === 'checking') return 'running'
    if (followUp.status === 'waiting') return 'open'
    return followUp.status
  }
  return row.state === 'open' ? 'running' : row.state === 'failed' ? 'failed' : 'done'
}

const STOP_RESULT: Record<Exclude<StopState, 'busy'>, 'stopped' | 'notRunning' | 'stopFailed' | 'stopUpgrade'> = {
  stopped: 'stopped',
  not_running: 'notRunning',
  failed: 'stopFailed',
  upgrade: 'stopUpgrade'
}

const END_RESULT: Record<Exclude<StopState, 'busy' | 'upgrade'>, 'ended' | 'alreadyEnded' | 'endFailed'> = {
  stopped: 'ended',
  not_running: 'alreadyEnded',
  failed: 'endFailed'
}

// A task that has not reported has no turn to stop while a background process it started may still run.
const stopNotice = (stop: Exclude<StopState, 'busy'>, state: AssistantSubsessionDto['state']) =>
  stop === 'not_running' && state === 'open' ? 'notRunningBackground' : STOP_RESULT[stop]

/** A delegated task, approved proposal or follow-up; `withPlace` leads its meta line with the conversation it serves. */
export function BackgroundTaskRow({
  row,
  now,
  stop,
  onStop,
  withPlace = false,
  dim = false
}: {
  row: AssistantSubsessionDto
  now: number
  stop: StopState | undefined
  onStop: (row: AssistantSubsessionDto) => Promise<void>
  withPlace?: boolean
  dim?: boolean
}) {
  const t = useTranslations('Common.taskList')
  const tf = useTranslations('Common.followUp')
  const format = useFormatter()
  const shortTime = useShortTime()
  const { orgPath } = useOrgs()
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const followUp = followUpOf(row)
  const stoppable = row.state === 'open' && row.canStop && taskStopKey(row) !== null
  const parent = withPlace ? row.parent : null
  const ownPlace = withPlace && !parent ? (row.place ?? null) : null
  const lastCheck = followUp?.recentChecks[0]

  const title = row.sessionId ? (
    <Link
      className="min-w-0 truncate text-inherit no-underline hover:underline"
      href={orgPath(`/sessions/${encodeURIComponent(row.sessionId)}`)}
    >
      {row.title ?? t('untitled')}
    </Link>
  ) : row.visible && followUp ? (
    <span className="min-w-0 truncate">{row.title ?? t('untitled')}</span>
  ) : row.visible ? (
    <span className="min-w-0 truncate font-normal text-(--text-secondary)">{t('starting')}</span>
  ) : (
    <span className="min-w-0 truncate font-normal text-(--text-tertiary)">{t('hidden')}</span>
  )

  const place = parent ? (
    <ParentPlace parent={parent} />
  ) : ownPlace ? (
    <span data-task-place="">
      <PlaceName place={ownPlace} />
    </span>
  ) : null
  const parts: ReactNode[] = followUp
    ? [
        place,
        followUp.firstLook ? tf(followUpKindKey(followUp)) : null,
        <span key="state" data-subsession-state="">
          {followUp.status === 'waiting' && followUp.nextCheck
            ? tf('nextCheck', { time: shortTime(followUp.nextCheck) })
            : tf(`status.${followUp.status}`)}
        </span>,
        lastCheck ? t('lastCheck', { time: shortTime(lastCheck.at) }) : null
      ]
    : [
        place,
        <span key="state" data-subsession-state="">
          {t(`state.${row.state}`)}
        </span>,
        <time key="started" dateTime={row.startedAt}>
          {t('started', { time: format.relativeTime(new Date(row.startedAt), { now, style: 'narrow' }) })}
        </time>
      ]

  // A follow-up's checks open from its done-when line in Activity, else from its meta line.
  const checksOpen = followUp !== null && row.visible
  const viaPreview = checksOpen && withPlace && !!followUp.doneWhen
  const meta = (
    <MetaLine
      platform={parent?.platform ?? ownPlace?.platform}
      parts={parts}
      toggle={
        checksOpen && !viaPreview
          ? {
              expanded,
              onToggle: () => setExpanded((v) => !v),
              label: expanded ? tf('hideChecks') : tf('showChecks')
            }
          : undefined
      }
    />
  )
  const preview =
    viaPreview && followUp.doneWhen ? (
      <PreviewLine text={followUp.doneWhen} quiet expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        <FollowUpChecks followUp={{ ...followUp, doneWhen: null }} />
      </PreviewLine>
    ) : null

  return (
    <TaskRow
      tone={taskTone(row, followUp)}
      title={title}
      meta={meta}
      preview={preview}
      dim={dim}
      attrs={{ 'data-subsession-row': row.state, 'data-follow-up': followUp?.status }}
      actions={
        stoppable ? (
          <RowAction
            label={followUp ? t('end') : t('stop')}
            disabled={stop === 'busy' || confirming}
            pinned={stop === 'busy' || confirming}
            onClick={() => (followUp ? setConfirming(true) : void onStop(row))}
          />
        ) : null
      }
      after={
        <>
          {checksOpen && !viaPreview && expanded ? (
            <div className="mt-2">
              <FollowUpChecks followUp={followUp} />
            </div>
          ) : null}
          {confirming && stoppable ? (
            <ConfirmStrip
              prompt={tf('endConfirm')}
              confirm={tf('end')}
              keep={tf('keep')}
              busy={stop === 'busy'}
              onConfirm={() => void onStop(row).then(() => setConfirming(false))}
              onKeep={() => setConfirming(false)}
            />
          ) : null}
          {stop && stop !== 'busy' ? (
            <div
              role="status"
              data-subsession-stop={stop}
              className={`mt-1 font-sans text-[11.5px] font-normal leading-normal ${
                stop === 'failed' || stop === 'upgrade' ? 'text-(--status-error)' : 'text-(--text-secondary)'
              }`}
            >
              {followUp && stop !== 'upgrade' ? tf(END_RESULT[stop]) : t(stopNotice(stop, row.state))}
            </div>
          ) : null}
        </>
      }
    />
  )
}

/** The conversation a task serves, by its place's name, linked to it. */
export function ParentPlace({
  parent
}: {
  parent: { sessionId: string; title: string | null; platform: string | null; channelName: string | null }
}) {
  const { orgPath } = useOrgs()
  return (
    <Link
      className="text-inherit no-underline hover:underline"
      href={orgPath(`/sessions/${encodeURIComponent(parent.sessionId)}`)}
    >
      <PlaceName place={parent} />
    </Link>
  )
}

/** A place by its channel's name; a session's title is never its place, so with no name a neutral label stands in beside the platform mark. */
function PlaceName({ place }: { place: { platform: string | null; channelName: string | null } }) {
  const t = useTranslations('Common.taskList')
  if (place.channelName) return <>{chatPlaceName(place.platform ?? undefined, place.channelName)}</>
  return <>{place.platform === 'webchat' ? t('webchat') : t('conversation')}</>
}
