'use client'

// A coordinator's task in its conversation (auto-session-mode.md §10): a card that opens the task's thread beside the chat, and its replies line.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { taskStateKey, taskTone } from '@/components/console/task-list'
import { StateIcon } from '@/components/console/StateIcon'
import { useTaskRow } from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import { useOrgs } from '@/lib/org-context'

/** How often "last reply 1m ago" redraws; arithmetic, no request. */
const TICK_MS = 30_000

export function TaskThreadCard({
  agentId,
  link,
  parentSessionId,
  selected = false,
  onOpen
}: {
  /** The coordinator's agent, which runs the task. */
  agentId: string
  link: TaskLink
  /** The conversation whose task list carries this one's state; null reads the task alone. */
  parentSessionId: string | null
  /** Its thread is the one open beside the chat. */
  selected?: boolean
  /** Opens the thread beside the chat; without it the card goes to the task's own page. */
  onOpen?: () => void
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const row = useTaskRow(agentId, link.sessionId, parentSessionId)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const title = row?.title ?? link.title
  const state = row ? tl(taskStateKey(row)) : null
  const href = orgPath(`/sessions/${encodeURIComponent(link.sessionId)}`)
  const cardClass = `card click flex w-full max-w-[520px] min-w-0 items-center gap-[10px] px-[14px] py-[11px] text-left no-underline ${
    selected ? 'border-(--brand) [box-shadow:0_0_0_3px_var(--brand-ring)]' : ''
  }`
  const face = (
    <>
      <StateIcon state={row ? taskTone(row, null) : 'idle'} label={state ?? tl('state.idle')} />
      <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] font-medium leading-normal text-(--text-primary)">
        {title}
      </span>
      <Icon name="panel-right-open" size={15} color="var(--text-tertiary)" className="flex-none" />
    </>
  )
  const replies = row?.replies ?? 0
  const repliesLine =
    replies > 0 ? (
      <>
        <span className="font-semibold text-(--brand)">{t('replies', { count: replies })}</span>
        {row?.lastReplyAt ? (
          <time dateTime={row.lastReplyAt} className="text-(--text-tertiary)">
            {t('lastReply', { time: format.relativeTime(new Date(row.lastReplyAt), { now, style: 'narrow' }) })}
          </time>
        ) : null}
      </>
    ) : (
      <span className="font-semibold text-(--brand)">{t('reply')}</span>
    )

  return (
    <div data-task-card={link.sessionId} className="flex min-w-0 flex-col gap-[6px]">
      {onOpen ? (
        <button
          type="button"
          className={cardClass}
          aria-expanded={selected}
          aria-label={t('open', { title })}
          title={t('open', { title })}
          onClick={onOpen}
        >
          {face}
        </button>
      ) : (
        <Link className={cardClass} href={href} aria-label={t('openPage', { title })}>
          {face}
        </Link>
      )}
      {onOpen ? (
        <button
          type="button"
          data-task-card-replies=""
          className="flex w-fit cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[2px] py-0 font-sans text-[12.5px] font-normal leading-normal hover:underline"
          onClick={onOpen}
        >
          <Icon name="reply" size={13} color="var(--brand)" className="flex-none" />
          {repliesLine}
        </button>
      ) : (
        <Link
          data-task-card-replies=""
          href={href}
          className="flex w-fit items-center gap-[6px] px-[2px] font-sans text-[12.5px] font-normal leading-normal no-underline hover:underline"
        >
          <Icon name="reply" size={13} color="var(--brand)" className="flex-none" />
          {repliesLine}
        </Link>
      )}
    </div>
  )
}

/** A thread's reply count, as a dock row carries it; nothing until it has one. */
export function ThreadReplyCount({ replies }: { replies: number | undefined }) {
  const t = useTranslations('Common.taskThread')
  if (!replies) return null
  return (
    <span
      data-thread-reply-count=""
      title={t('replies', { count: replies })}
      className="flex flex-none items-center gap-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
    >
      <Icon name="reply" size={13} />
      {replies}
    </span>
  )
}
