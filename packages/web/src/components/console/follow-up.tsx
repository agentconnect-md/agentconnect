'use client'

// What the Tasks tab, Activity and a task's own page share about a follow-up (assistant-mode.md §5.12): its state, its recent checks, the toggle that shows them, and how it is ended.

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import {
  fetchAssistantSubsession,
  stopAssistantFollowUp,
  stopAssistantSubsession,
  type AssistantFollowUpDto,
  type AssistantSubsessionDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/** A row's follow-up, or null for any other task and for every row from a daemon without follow-ups. */
export function followUpOf(row: AssistantSubsessionDto): AssistantFollowUpDto | null {
  return row.kind === 'follow-up' && row.followUp ? row.followUp : null
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
export function FollowUpChecks({ followUp }: { followUp: AssistantFollowUpDto }) {
  const t = useTranslations('Common.followUp')
  const format = useFormatter()
  const gap = followUp.doneWhen ? 'mt-2' : ''
  return (
    <div data-follow-up-checks="" className="rounded-md bg-(--surface-sunken) px-3 py-2">
      {followUp.doneWhen ? (
        <div className="break-words font-sans text-[12px] font-normal leading-[1.5] text-(--text-primary)">
          {t('doneWhen', { text: followUp.doneWhen })}
        </div>
      ) : null}
      {followUp.recentChecks.length === 0 ? (
        <div className={`font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary) ${gap}`}>
          {t('noChecks')}
        </div>
      ) : (
        <ol className={`m-0 flex list-none flex-col gap-2 p-0 ${gap}`}>
          {followUp.recentChecks.map((check, i) => (
            <li
              key={`${check.at}:${i}`}
              data-follow-up-check={check.reported ? 'reported' : 'silent'}
              className="flex flex-col gap-[2px]"
            >
              <span className="flex flex-wrap items-center gap-x-2 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                <time dateTime={check.at}>{format.dateTime(new Date(check.at), DATE_TIME)}</time>
                <span aria-hidden="true">·</span>
                <span className={check.reported ? 'text-(--status-info)' : ''}>
                  {check.reported ? t('reported') : t('notReported')}
                </span>
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
                {check.observation}
              </span>
            </li>
          ))}
        </ol>
      )}
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
          {tf('kind')}
          <span aria-hidden="true"> · </span>
          <span data-follow-up-status="">{statusText(followUp)}</span>
        </span>
        <FollowUpChecksToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      </div>
      {expanded ? (
        <div className="max-h-[30vh] overflow-y-auto">
          <FollowUpChecks followUp={followUp} />
        </div>
      ) : null}
    </div>
  )
}
