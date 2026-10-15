'use client'

// What the Tasks tab and Activity share about a follow-up (assistant-mode.md §5.12): its state, its recent checks, and the toggle that shows them.

import { useFormatter, useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { AssistantFollowUpDto, AssistantSubsessionDto } from '@/lib/api'

/** A row's follow-up, or null for any other task and for every row from a daemon without follow-ups. */
export function followUpOf(row: AssistantSubsessionDto): AssistantFollowUpDto | null {
  return row.kind === 'follow-up' && row.followUp ? row.followUp : null
}

/** A follow-up runs only while it checks; any other task while it is open. */
export function taskRunning(row: AssistantSubsessionDto): boolean {
  const followUp = followUpOf(row)
  return followUp ? followUp.status === 'checking' : row.state === 'open'
}

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const

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
