'use client'

// A thread's footer under its root (webchat-threads.md §3, §6.1): its reply line, then its holding task's card; a legacy task card is the same footer read from the task's row.

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
import { SessionShareButton } from '@/components/console/SessionShare'
import { shortAgo } from '@/components/console/session-work'

/** How often "· 39s" redraws: every second while it counts seconds, else every 30s; arithmetic, no request. */
const tickMs = (lastReplyAt: string | undefined, now: number) =>
  lastReplyAt && now - Date.parse(lastReplyAt) < 60_000 ? 1_000 : 30_000

/** What a footer draws, from a thread's summary or a task's row alike. */
export interface ThreadFooterView {
  replies: number
  lastReplyAt?: string
  lastReply?: SessionThreadAuthorDto & { excerpt?: string }
  /** Repliers, newest first. */
  participants: SessionThreadAuthorDto[]
  /** The holding task; `title` is null where the reader may not see it. */
  task?: { sessionId?: string; title: string | null; summary?: string; tone: StateKind; stateKey: TaskStateKey }
  running: boolean
  /** False when a task the reader may not view holds the thread: a count with no content, opening nothing. */
  readable: boolean
}

type TaskStateKey = ReturnType<typeof taskStateKey>

/** A thread's footer as the daemon summarized it and the CP filtered it; a held thread rests between its turns, as a threaded task does. */
export function footerOfSummary(summary: SessionThreadSummaryDto, taskSummary?: string): ThreadFooterView {
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
            ...(summary.readable && taskSummary ? { summary: taskSummary } : {}),
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
      ...(row?.summary ? { summary: row.summary } : {}),
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
  nameOf = authorName,
  align = 'start',
  onReply,
  markOf
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
  /** Which edge the card and its line hug: a person's message sits on the right, so its footer does too. */
  align?: 'start' | 'end'
  /** A replier's picture or agent icon for their mark; null falls back to their initials. */
  markOf?: (author: SessionThreadAuthorDto) => ReactNode | null
  /** The card's hover toolbar Reply: opens the thread ready to write in; absent, Reply opens it to read. */
  onReply?: () => void
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const format = useFormatter()
  const [now, setNow] = useState(() => Date.now())
  const [previewShown, setPreviewShown] = useState(false)
  const tick = tickMs(footer.lastReplyAt, now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tick)
    return () => clearInterval(timer)
  }, [tick])

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
  } ${selected ? 'border-(--border-strong) bg-(--surface-hover) shadow-none' : ''}`
  const { replies, participants, lastReply } = footer
  const lastReplyAt = footer.lastReplyAt ? new Date(footer.lastReplyAt) : null
  const repliesLabel = replies > 0 ? t('replies', { count: replies }) : t('reply')
  const card = task
    ? target(
        cardClass,
        <>
          <StateIcon state={task.tone} label={tl(task.stateKey)} />
          {/* The title on its first line; the task's summary, where it wrote one, beneath it in a lighter face. */}
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span
              className={`min-w-0 truncate font-sans text-[13.5px] font-medium leading-normal ${
                task.title === null ? 'text-(--text-tertiary)' : 'text-(--text-primary)'
              }`}
            >
              {title}
            </span>
            {task.summary ? (
              <span
                data-task-card-summary=""
                className="min-w-0 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
              >
                {task.summary}
              </span>
            ) : null}
          </span>
        </>,
        {
          'data-task-card-open': '',
          ...(open ? { 'aria-expanded': selected === true } : {}),
          ...(open || to ? { 'aria-label': open ? openLabel : t('openPage', { title }) } : {})
        }
      )
    : null

  const people =
    participants.length > 0 ? (
      <span data-thread-participants="" className="flex flex-none items-center">
        {participants.map((author, i) => (
          <span
            key={author.sender}
            title={nameOf(author)}
            data-thread-participant={author.sender}
            className={`flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full border border-(--surface-card) bg-(--brand-soft) font-sans text-[8.5px] font-semibold leading-none text-(--brand-soft-text) ${
              i > 0 ? 'ml-[-5px]' : ''
            }`}
          >
            {markOf?.(author) ?? initials(nameOf(author))}
          </span>
        ))}
      </span>
    ) : null
  const working = footer.running ? (
    <span role="status" data-thread-working="" className="flex-none text-(--text-tertiary)">
      {t('footerWorking')}
    </span>
  ) : null
  // The latest reply is a hover card over the line, not inline text.
  const preview = lastReply?.excerpt ? (
    <span
      role="tooltip"
      data-thread-preview=""
      className={`pointer-events-none absolute bottom-full z-[5] mb-[6px] hidden w-max max-w-[360px] rounded-[8px] border border-(--border-default) bg-(--surface-card) px-[10px] py-[6px] font-sans text-[12.5px] font-normal leading-[1.45] text-(--text-primary) shadow-(--shadow-md) [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden ${previewShown ? '[display:-webkit-box]' : 'group-focus-within:[display:-webkit-box]'} ${
        align === 'end' ? 'right-0' : 'left-0'
      }`}
    >
      <span className="font-semibold">{nameOf(lastReply)}</span>: {lastReply.excerpt}
    </span>
  ) : null

  // Slack's message toolbar on a hovered card's top edge: Reply, then the task session's Share, as its own page offers it.
  const reply = onReply ?? open
  const share = readable ? task?.sessionId : undefined
  const toolButton =
    'flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent p-0 text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'
  const toolbar =
    reply || share ? (
      <div
        role="toolbar"
        data-task-card-toolbar=""
        aria-label={t('cardActions')}
        className="absolute -top-[17px] right-[10px] z-[5] hidden items-center gap-[2px] rounded-[8px] border border-(--border-default) bg-(--surface-card) p-[2px] shadow-(--shadow-md) group-hover/card:flex group-focus-within/card:flex"
      >
        {reply ? (
          <button
            type="button"
            data-task-card-reply=""
            aria-label={t('replyInThread')}
            title={t('replyInThread')}
            onClick={reply}
            className={toolButton}
          >
            <Icon name="message-square" size={15} />
          </button>
        ) : null}
        {share ? (
          <SessionShareButton sessionId={share} title={title} className={toolButton} data-task-card-share="" />
        ) : null}
      </div>
    ) : null

  // Every thread, held or not, shows its replies the same way under its root: "people 3 replies · 1m", which opens it.
  const line = (
    <div className="group relative flex max-w-full min-w-0">
      {target(
        'flex w-fit max-w-full min-w-0 items-center gap-[6px] px-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) no-underline',
        <>
          {people}
          <span
            data-thread-count=""
            className="whitespace-nowrap"
            // Only the count shows the latest reply; a replier's mark names just that replier.
            onMouseEnter={() => setPreviewShown(true)}
            onMouseLeave={() => setPreviewShown(false)}
            // The hover card names the latest reply; a native tooltip on top of it would only cover it.
            {...(replies > 0 && lastReplyAt && !preview
              ? {
                  title: t('repliesTitle', {
                    replies: repliesLabel,
                    time: format.relativeTime(lastReplyAt, { now, style: 'narrow' })
                  })
                }
              : {})}
          >
            <span className={`font-semibold text-(--brand) ${open || to ? 'hover:underline' : ''}`}>
              {repliesLabel}
            </span>
            {replies > 0 && lastReplyAt ? (
              <time dateTime={footer.lastReplyAt!}> · {shortAgo(lastReplyAt.getTime(), now)}</time>
            ) : null}
          </span>
          {working}
        </>,
        {
          'data-task-card-replies': '',
          'data-thread-line': '',
          ...(open ? { 'aria-label': openLabel, 'aria-expanded': selected === true } : {})
        }
      )}
      {preview}
    </div>
  )

  return (
    <div
      {...(task?.sessionId ? { 'data-task-card': task.sessionId } : {})}
      {...(rootId ? { 'data-thread-footer': rootId } : {})}
      {...(readable ? {} : { 'data-thread-unreadable': '' })}
      className={`flex min-w-0 flex-col gap-[6px] ${align === 'end' ? 'items-end' : ''}`}
    >
      {line}
      {card ? (
        <div data-task-card-hover="" className="group/card relative flex w-full max-w-[520px] min-w-0">
          {card}
          {toolbar}
        </div>
      ) : null}
    </div>
  )
}

/** A root's footer from its thread's summary, its card taking the holding task's summary from the conversation's task list. */
export function RootThreadFooter({
  agentId,
  parentSessionId,
  summary,
  ...rest
}: Omit<Parameters<typeof ThreadFooter>[0], 'footer'> & {
  agentId: string
  parentSessionId: string
  summary: SessionThreadSummaryDto
}) {
  const row = useTaskRow(agentId, summary.task?.sessionId ?? null, parentSessionId)
  return <ThreadFooter footer={footerOfSummary(summary, row?.summary)} {...rest} />
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
