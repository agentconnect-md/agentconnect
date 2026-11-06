'use client'

// A thread's footer under its root (webchat-threads.md §3, §6.1): its holding task's card, then its replies line; a legacy task card is the same footer read from the task's row.

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { taskStateKey, taskTone } from '@/components/console/task-list'
import { StateIcon, type StateKind } from '@/components/console/StateIcon'
import { useTaskRow } from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import type { AssistantSubsessionDto, SessionThreadAuthorDto, SessionThreadSummaryDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'

/** How often "last reply 1m ago" redraws; arithmetic, no request. */
const TICK_MS = 30_000

/** What a footer draws, from a thread's summary or a task's row alike. */
export interface ThreadFooterView {
  replies: number
  lastReplyAt?: string
  lastReply?: SessionThreadAuthorDto & { excerpt?: string }
  /** Repliers, newest first. */
  participants: SessionThreadAuthorDto[]
  /** The holding task; `title` is null where the reader may not see it. */
  task?: { sessionId?: string; title: string | null; tone: StateKind; stateKey: TaskStateKey }
  running: boolean
  /** False when a task the reader may not view holds the thread: a count with no content, opening nothing. */
  readable: boolean
}

type TaskStateKey = ReturnType<typeof taskStateKey>

/** A thread's footer as the daemon summarized it and the CP filtered it; a held thread rests between its turns, as a threaded task does. */
export function footerOfSummary(summary: SessionThreadSummaryDto): ThreadFooterView {
  const running = summary.running === true
  const task = summary.task
  return {
    replies: summary.replies,
    ...(summary.lastReplyAt ? { lastReplyAt: summary.lastReplyAt } : {}),
    ...(summary.lastReply ? { lastReply: summary.lastReply } : {}),
    participants: summary.participants,
    ...(task
      ? {
          task: {
            ...(task.sessionId ? { sessionId: task.sessionId } : {}),
            title: summary.readable ? (task.title ?? summary.rootExcerpt ?? '') : null,
            tone: running ? 'running' : task.state === 'failed' ? 'failed' : 'idle',
            stateKey: running ? 'state.open' : task.state === 'failed' ? 'state.failed' : 'state.idle'
          }
        }
      : {}),
    running,
    readable: summary.readable
  }
}

/** A task's own footer, from its row once read: a legacy link card, or a card under the turn that answered its message. */
export function footerOfTaskRow(link: TaskLink, row: AssistantSubsessionDto | undefined): ThreadFooterView {
  return {
    replies: row?.replies ?? 0,
    ...(row?.lastReplyAt ? { lastReplyAt: row.lastReplyAt } : {}),
    participants: [],
    task: {
      sessionId: link.sessionId,
      title: row?.title ?? link.title,
      tone: row ? taskTone(row, null) : 'idle',
      stateKey: row ? taskStateKey(row) : 'state.idle'
    },
    running: false,
    readable: true
  }
}

const authorName = (author: SessionThreadAuthorDto): string => author.senderName ?? author.sender

/** A person's or agent's initials for a participant's mark. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${[...words[0]!][0]}${[...words[1]!][0]}`.toUpperCase()
  return ([...(words[0] ?? '?')][0] ?? '?').toUpperCase()
}

export function ThreadFooter({
  footer,
  rootId,
  href,
  selected = false,
  onOpen,
  nameOf = authorName
}: {
  footer: ThreadFooterView
  /** The thread's root, which names it; absent for a task's card read from its row. */
  rootId?: string
  /** The holding task's own page, which a modified click opens. */
  href?: string
  /** Its thread is the one open beside the chat. */
  selected?: boolean
  /** Opens the thread beside the chat on a plain click; a modified click, or none given, goes to `href`. */
  onOpen?: () => void
  /** How a participant or the latest reply's author is named. */
  nameOf?: (author: SessionThreadAuthorDto) => string
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const format = useFormatter()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const { task, readable } = footer
  // An unreadable thread opens nothing: its panel and its task's page would both show no content.
  const open = readable ? onOpen : undefined
  const to = readable ? href : undefined
  const title = task?.title ?? t('hiddenTask')
  const openLabel = task ? t('open', { title }) : t('openThread')

  // A plain click opens the thread beside the chat; a modified or middle click keeps the link's own new-tab behaviour.
  const openBeside = (event: MouseEvent<HTMLElement>) => {
    if (!open || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    open()
  }
  const target = (className: string, children: ReactNode, extra: Record<string, unknown> = {}) =>
    to ? (
      <Link className={className} href={to} onClick={openBeside} {...extra}>
        {children}
      </Link>
    ) : open ? (
      <button type="button" className={`${className} cursor-pointer border-0 bg-transparent`} onClick={open} {...extra}>
        {children}
      </button>
    ) : (
      <div className={className} {...extra}>
        {children}
      </div>
    )

  const cardClass = `card flex w-full max-w-[520px] min-w-0 items-center gap-[10px] px-[14px] py-[11px] text-left no-underline ${
    open || to ? 'click' : ''
  } ${selected ? 'border-(--brand) [box-shadow:0_0_0_3px_var(--brand-ring)]' : ''}`
  const card = task
    ? target(
        cardClass,
        <>
          <StateIcon state={task.tone} label={tl(task.stateKey)} />
          <span
            className={`min-w-0 flex-1 truncate font-sans text-[13.5px] font-medium leading-normal ${
              task.title === null ? 'text-(--text-tertiary)' : 'text-(--text-primary)'
            }`}
          >
            {title}
          </span>
          {open || to ? (
            <Icon name="panel-right-open" size={15} color="var(--text-tertiary)" className="flex-none" />
          ) : null}
        </>,
        {
          ...(open ? { 'aria-expanded': selected === true } : {}),
          ...(open || to ? { 'aria-label': open ? openLabel : t('openPage', { title }) } : {}),
          ...(open ? { title: openLabel } : {})
        }
      )
    : null

  const { replies, participants, lastReply } = footer
  const repliesLine = (
    <>
      <Icon name="reply" size={13} color="var(--brand)" className="flex-none" />
      {participants.length > 0 ? (
        <span data-thread-participants="" className="flex flex-none items-center">
          {participants.map((author, i) => (
            <span
              key={author.sender}
              title={nameOf(author)}
              data-thread-participant={author.sender}
              className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border border-(--surface-card) bg-(--brand-soft) font-sans text-[8.5px] font-semibold leading-none text-(--brand-soft-text) ${
                i > 0 ? 'ml-[-5px]' : ''
              }`}
            >
              {initials(nameOf(author))}
            </span>
          ))}
        </span>
      ) : null}
      {replies > 0 ? (
        <>
          <span className="flex-none font-semibold text-(--brand)">{t('replies', { count: replies })}</span>
          {footer.lastReplyAt ? (
            <time dateTime={footer.lastReplyAt} className="flex-none text-(--text-tertiary)">
              {t('lastReply', { time: format.relativeTime(new Date(footer.lastReplyAt), { now, style: 'narrow' }) })}
            </time>
          ) : null}
        </>
      ) : (
        <span className="flex-none font-semibold text-(--brand)">{t('reply')}</span>
      )}
      {lastReply?.excerpt ? (
        <span data-thread-preview="" className="min-w-0 truncate text-(--text-secondary)">
          <span className="font-medium">{nameOf(lastReply)}</span>: {lastReply.excerpt}
        </span>
      ) : null}
      {footer.running ? (
        <span role="status" data-thread-working="" className="flex-none text-(--text-tertiary)">
          {t('footerWorking')}
        </span>
      ) : null}
    </>
  )
  const lineClass = `flex w-fit max-w-full min-w-0 items-center gap-[6px] px-[2px] font-sans text-[12.5px] font-normal leading-normal no-underline ${
    open || to ? 'hover:underline' : ''
  }`

  return (
    <div
      {...(task?.sessionId ? { 'data-task-card': task.sessionId } : {})}
      {...(rootId ? { 'data-thread-footer': rootId } : {})}
      {...(readable ? {} : { 'data-thread-unreadable': '' })}
      className="flex min-w-0 flex-col gap-[6px]"
    >
      {card}
      {target(lineClass, repliesLine, {
        'data-task-card-replies': '',
        ...(!task && open ? { 'aria-label': openLabel, 'aria-expanded': selected === true } : {})
      })}
    </div>
  )
}

/** A coordinator's task drawn as its thread's footer from its own row (auto-session-mode.md §10), until its root carries the footer. */
export function TaskThreadFooter({
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
  selected?: boolean
  onOpen?: () => void
}) {
  const { orgPath } = useOrgs()
  const row = useTaskRow(agentId, link.sessionId, parentSessionId)
  return (
    <ThreadFooter
      footer={footerOfTaskRow(link, row)}
      href={orgPath(`/sessions/${encodeURIComponent(link.sessionId)}`)}
      selected={selected}
      {...(onOpen ? { onOpen } : {})}
    />
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
