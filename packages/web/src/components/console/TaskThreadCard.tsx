'use client'

// A coordinator's task in its conversation (auto-session-mode.md §10): a card that opens the task's thread beside the chat, its reply count on its right.

import { useEffect, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { taskStateKey, taskTone } from '@/components/console/task-list'
import { StateIcon } from '@/components/console/StateIcon'
import { useTaskRow } from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import { useOrgs } from '@/lib/org-context'
import { shortAgo } from '@/components/console/session-work'

/** How often "· 39s" redraws: every second while it counts seconds, else every 30s; arithmetic, no request. */
const tickMs = (lastReplyAt: string | undefined, now: number) =>
  lastReplyAt && now - Date.parse(lastReplyAt) < 60_000 ? 1_000 : 30_000

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
  /** Opens the thread beside the chat on a plain click; a modified click, or none given, goes to the task's own page. */
  onOpen?: () => void
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const row = useTaskRow(agentId, link.sessionId, parentSessionId)
  const [now, setNow] = useState(() => Date.now())
  const tick = tickMs(row?.lastReplyAt, now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tick)
    return () => clearInterval(timer)
  }, [tick])

  const title = row?.title ?? link.title
  const state = row ? tl(taskStateKey(row)) : null
  const href = orgPath(`/sessions/${encodeURIComponent(link.sessionId)}`)
  const cardClass = `card click flex w-full max-w-[520px] min-w-0 items-center gap-[10px] px-[14px] py-[11px] text-left no-underline ${
    selected ? 'border-(--border-strong) bg-(--surface-hover) shadow-none' : ''
  }`
  const replies = row?.replies ?? 0
  const lastReplyAt = row?.lastReplyAt ? new Date(row.lastReplyAt) : null
  const repliesLabel = replies > 0 ? t('replies', { count: replies }) : t('reply')
  const face = (
    <>
      <StateIcon state={row ? taskTone(row, null) : 'idle'} label={state ?? tl('state.idle')} />
      <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] font-medium leading-normal text-(--text-primary)">
        {title}
      </span>
      <span
        data-task-card-replies=""
        className="flex-none whitespace-nowrap font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        {...(replies > 0 && lastReplyAt
          ? {
              title: t('repliesTitle', {
                replies: repliesLabel,
                time: format.relativeTime(lastReplyAt, { now, style: 'narrow' })
              })
            }
          : {})}
      >
        <span className="font-semibold text-(--brand)">{repliesLabel}</span>
        {replies > 0 && lastReplyAt ? (
          <time dateTime={row!.lastReplyAt!}> · {shortAgo(lastReplyAt.getTime(), now)}</time>
        ) : null}
      </span>
    </>
  )

  // A plain click opens the thread beside the chat; a modified or middle click keeps the link's own new-tab behaviour.
  const openBeside = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen()
  }

  return (
    <div data-task-card={link.sessionId} className="flex min-w-0 flex-col">
      <Link
        className={cardClass}
        href={href}
        onClick={openBeside}
        {...(onOpen ? { 'aria-expanded': selected === true } : {})}
        aria-label={onOpen ? t('open', { title }) : t('openPage', { title })}
        title={onOpen ? t('open', { title }) : undefined}
      >
        {face}
      </Link>
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
