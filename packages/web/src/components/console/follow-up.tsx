'use client'

// What the Tasks tab, Activity and a task's own page share about a follow-up (assistant-mode.md §5.12): its state, its recent checks, the toggle that shows them, how it is ended, and one a proposal would take.

import { useState, type ReactNode } from 'react'
import { useFormatter, useTimeZone, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import {
  fetchAssistantSubsession,
  type AssistantFollowUpCheckDto,
  type AssistantFollowUpEvent,
  stopAssistantFollowUp,
  stopAssistantSubsession,
  type AssistantFollowUpDto,
  type AssistantProposalFollowUpDto,
  type AssistantSubsessionDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/** A row's follow-up, or null for any other task and for every row from a daemon without follow-ups. */
export function followUpOf(row: AssistantSubsessionDto): AssistantFollowUpDto | null {
  return row.kind === 'follow-up' && row.followUp ? row.followUp : null
}

/** The label a follow-up row wears: a getting-to-know task reads its place once (assistant-mode.md §5.13). */
export function followUpKindKey(followUp: AssistantFollowUpDto): 'kind' | 'gettingToKnow' {
  return followUp.gettingToKnow ? 'gettingToKnow' : 'kind'
}

/** A follow-up runs only while it checks; any other task while it is open. */
export function taskRunning(row: AssistantSubsessionDto): boolean {
  const followUp = followUpOf(row)
  return followUp ? followUp.status === 'checking' : row.state === 'open'
}

/** What a row is stopped by: its session, else a follow-up's own id before its first check; null when neither is offered. */
export function taskStopKey(row: AssistantSubsessionDto): string | null {
  if (row.sessionId) return row.sessionId
  const id = followUpOf(row)?.id
  return id && row.parent ? `follow-up:${id}` : null
}

/** Stop a task by its session, or end a follow-up by its id while it has none. */
export async function stopTask(
  agentId: string,
  row: AssistantSubsessionDto
): Promise<{ result: 'stopped' | 'not_running' }> {
  const id = followUpOf(row)?.id
  if (!row.sessionId && id && row.parent) return await stopAssistantFollowUp(agentId, id, row.parent.sessionId)
  return await stopAssistantSubsession(agentId, row.sessionId!)
}

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const

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

const WATCH_REASONS = ['no_access', 'not_found', 'unsupported', 'limit', 'access_lost'] as const
type WatchReason = (typeof WATCH_REASONS)[number]
const isWatchReason = (reason: string | null): reason is WatchReason =>
  (WATCH_REASONS as readonly (string | null)[]).includes(reason)

/** The events a wake took, in words, as one list ("merged, CI finished"). */
function useEventWords(): (events: AssistantFollowUpEvent[]) => string {
  const t = useTranslations('Common.followUp.events')
  const format = useFormatter()
  return (events) =>
    format.list(
      events.map((event) => t(event)),
      { type: 'unit', style: 'short' }
    )
}

/** What started a check: its time, a message, or the events that woke it; null from a daemon that does not say. */
function useCheckTrigger(): (check: AssistantFollowUpCheckDto) => string | null {
  const t = useTranslations('Common.followUp.startedBy')
  const words = useEventWords()
  return (check) => {
    if (check.startedBy === 'wake')
      return check.events?.length ? t('wakeBy', { events: words(check.events) }) : t('wake')
    return check.startedBy ? t(check.startedBy) : null
  }
}

/** What a follow-up watches (assistant-mode.md §5.14), linked to it, and its latest check's wake; why it is not or no longer watched. */
export function FollowUpWatchLine({ followUp }: { followUp: AssistantFollowUpDto }) {
  const t = useTranslations('Common.followUp.watch')
  const shortTime = useShortTime()
  const words = useEventWords()
  const watch = followUp.watch
  if (!watch) return null
  const latest = followUp.recentChecks[0]
  const woken = latest?.startedBy === 'wake' ? latest : null
  // Only a web URL is a link; the label stands alone otherwise.
  const label = watch.target ?? watch.url.replace(/^https?:\/\//, '')
  const link = (chunks: ReactNode) =>
    /^https?:\/\//.test(watch.url) ? (
      <a
        href={watch.url}
        target="_blank"
        rel="noreferrer"
        className="text-(--text-secondary) no-underline hover:underline"
      >
        {chunks}
      </a>
    ) : (
      chunks
    )
  const reason = isWatchReason(watch.reason) ? t(`reason.${watch.reason}`) : t('reason.other')
  const text =
    watch.state === 'watching'
      ? t.rich('watching', { target: label, link })
      : watch.state === 'pending'
        ? t.rich('pending', { target: label, link })
        : watch.state === 'refused'
          ? t('refused', { reason })
          : t('ended', { reason })
  return (
    <div
      data-follow-up-watch={watch.state}
      className="flex min-w-0 items-center gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)"
    >
      <Icon name="eye" size={12} className="flex-none" />
      <span className="min-w-0 truncate">
        {text}
        {woken ? (
          <span data-follow-up-woken="">
            <span aria-hidden="true"> · </span>
            {woken.events?.length
              ? t('wokenBy', { time: shortTime(woken.at), events: words(woken.events) })
              : t('woken', { time: shortTime(woken.at) })}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// A task page re-reads its follow-up often while a check runs, rarely while it waits, and not once it ended.
const CHECKING_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000

/** "Waiting · next check <time>" while one is scheduled, else the state alone. */
export function useFollowUpStatusText(): (followUp: AssistantFollowUpDto) => string {
  const t = useTranslations('Common.followUp')
  const format = useFormatter()
  return (followUp) =>
    followUp.status === 'waiting' && followUp.nextCheck
      ? t('status.waitingNext', { time: format.dateTime(new Date(followUp.nextCheck), DATE_TIME) })
      : t(`status.${followUp.status}`)
}

export function FollowUpChecksToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const t = useTranslations('Common.followUp')
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? t('hideChecks') : t('showChecks')}
      onClick={onToggle}
      className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary)"
    >
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
    </button>
  )
}

/** What counts as done and the recent checks, newest first: when, what was seen, and whether it was reported. */
export function FollowUpChecks({
  followUp,
  withWatch = false
}: {
  followUp: AssistantFollowUpDto
  withWatch?: boolean
}) {
  const t = useTranslations('Common.followUp')
  const format = useFormatter()
  const trigger = useCheckTrigger()
  const watched = withWatch && !!followUp.watch
  const gap = followUp.doneWhen || watched ? 'mt-2' : ''
  return (
    <div data-follow-up-checks="" className="rounded-md bg-(--surface-sunken) px-3 py-2">
      {followUp.doneWhen ? (
        <div className="break-words font-sans text-[12px] font-normal leading-[1.5] text-(--text-primary)">
          {followUp.doneWhen}
        </div>
      ) : null}
      {watched ? <FollowUpWatchLine followUp={followUp} /> : null}
      {followUp.recentChecks.length === 0 ? (
        <div className={`font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) ${gap}`}>
          {t('noChecks')}
        </div>
      ) : (
        <ol className={`m-0 flex list-none flex-col gap-2 p-0 ${gap}`}>
          {followUp.recentChecks.map((check, i) => {
            const startedBy = trigger(check)
            return (
              <li
                key={`${check.at}:${i}`}
                data-follow-up-check={check.reported ? 'reported' : 'silent'}
                className="flex flex-col gap-[2px]"
              >
                <span className="flex flex-wrap items-center gap-x-2 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                  <time dateTime={check.at}>{format.dateTime(new Date(check.at), DATE_TIME)}</time>
                  {startedBy ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span data-follow-up-check-trigger={check.startedBy}>{startedBy}</span>
                    </>
                  ) : null}
                  <span aria-hidden="true">·</span>
                  <span className={check.reported ? 'text-(--status-info)' : ''}>
                    {check.reported ? t('reported') : t('notReported')}
                  </span>
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
                  {check.observation}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** What a proposal's follow-up form would take once approved (assistant-mode.md §5.13): its label, what counts as done and its first check. */
export function ProposedFollowUp({
  followUp,
  compact = false
}: {
  followUp: AssistantProposalFollowUpDto
  compact?: boolean
}) {
  const t = useTranslations('Common.followUp')
  const format = useFormatter()
  const size = compact ? 'text-[12px]' : 'text-[12.5px]'
  return (
    <div
      data-proposed-follow-up=""
      className="flex flex-col gap-1 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2"
    >
      <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
        {t('proposed.takes')}
      </span>
      <span className={`break-words font-sans ${size} font-semibold leading-[1.5] text-(--text-primary)`}>
        {followUp.title}
      </span>
      <span
        className={`whitespace-pre-wrap break-words font-sans ${size} font-normal leading-[1.5] text-(--text-secondary)`}
      >
        {followUp.doneWhen}
      </span>
      {followUp.watch ? (
        <span
          data-proposed-watch=""
          className="min-w-0 break-words font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          {t('proposed.watches', { url: followUp.watch })}
        </span>
      ) : null}
      <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        {followUp.nextCheck
          ? t('proposed.firstCheck', { time: format.dateTime(new Date(followUp.nextCheck), DATE_TIME) })
          : t('proposed.noCheck')}
      </span>
    </div>
  )
}

/** A follow-up's own page: its state, what counts as done and its recent checks; nothing for any other task. */
export function FollowUpTaskSummary({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const tf = useTranslations('Common.followUp')
  const { activeOrg } = useOrgs()
  const statusText = useFollowUpStatusText()
  const [expanded, setExpanded] = useState(true)
  const { data } = useSWR(
    consoleKeys.assistantSubsession(activeOrg?.id, agentId, sessionId),
    () => fetchAssistantSubsession(agentId, sessionId),
    {
      refreshInterval: (row) => (row?.state !== 'open' ? 0 : taskRunning(row) ? CHECKING_POLL_MS : IDLE_POLL_MS),
      shouldRetryOnError: false
    }
  )
  const followUp = data?.visible ? followUpOf(data) : null
  if (!followUp) return null
  return (
    <div
      data-follow-up-summary={followUp.status}
      className="flex min-w-0 flex-col gap-[6px] max-desktop:border-b max-desktop:border-(--border-subtle) max-desktop:bg-(--surface-card) max-desktop:px-4 max-desktop:py-2 desktop:mb-3"
    >
      <div className="flex min-w-0 items-center gap-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
        <Icon name="clock" size={13} color="var(--text-tertiary)" className="flex-none" />
        <span className="min-w-0 flex-1 break-words">
          {tf(followUpKindKey(followUp))}
          <span aria-hidden="true"> · </span>
          <span data-follow-up-status="">{statusText(followUp)}</span>
        </span>
        <FollowUpChecksToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      </div>
      {expanded ? (
        <div className="max-h-[30vh] overflow-y-auto">
          <FollowUpChecks followUp={followUp} withWatch />
        </div>
      ) : null}
    </div>
  )
}
