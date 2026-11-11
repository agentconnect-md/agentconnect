'use client'

// A thread's footer under its root (webchat-threads.md §3, §6.1): its reply line, then its holding task's card; a legacy task card is the same footer read from the task's row.

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { taskStateKey, taskTone } from '@/components/console/task-list'
import { StateIcon, type StateKind } from '@/components/console/StateIcon'
import { AgentTurnHeader } from '@/components/console/AgentTurnHeader'
import { AGENT_BUBBLE } from '@/components/console/transcript-bubbles'
import { useTaskRow } from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import type { AssistantSubsessionDto, SessionThreadAuthorDto, SessionThreadSummaryDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { SessionShareDialogFor } from '@/components/console/SessionShare'
import { MessageMenu } from '@/components/console/MessageMenu'
import { shortAgo } from '@/components/console/session-work'

/** How often "· 39s" redraws: every second while it counts seconds, else every 30s; arithmetic, no request. */
const tickMs = (lastReplyAt: string | undefined, now: number) =>
  lastReplyAt && now - Date.parse(lastReplyAt) < 60_000 ? 1_000 : 30_000

/** What a footer draws, from a thread's summary or a task's row alike. */
export interface ThreadFooterView {
  replies: number
  lastReplyAt?: string
  /** Repliers, newest first. */
  participants: SessionThreadAuthorDto[]
  /** The holding task; `title` is null where the reader may not see it, or may not yet while it is `starting`. */
  task?: {
    sessionId?: string
    title: string | null
    summary?: string
    tone: StateKind
    stateKey: TaskStateKey
    starting?: boolean
  }
  running: boolean
  /** False when a task the reader may not view holds the thread: a count with no content, opening nothing. */
  readable: boolean
}

type TaskStateKey = ReturnType<typeof taskStateKey>

/** A thread's footer as the daemon summarized it and the CP filtered it; a held thread rests between its turns, as a threaded task does. */
export function footerOfSummary(summary: SessionThreadSummaryDto, taskSummary?: string): ThreadFooterView {
  const task = summary.task
  const starting = !summary.readable && task?.starting === true
  const running = summary.running === true
  // A starting task is about to run its first turn, so its card shows it working.
  const busy = running || starting
  return {
    replies: summary.replies,
    ...(summary.lastReplyAt ? { lastReplyAt: summary.lastReplyAt } : {}),
    participants: summary.participants,
    ...(task
      ? {
          task: {
            ...(task.sessionId ? { sessionId: task.sessionId } : {}),
            title: summary.readable ? (task.title ?? summary.rootExcerpt ?? '') : null,
            ...(summary.readable && taskSummary ? { summary: taskSummary } : {}),
            tone: busy ? 'running' : task.state === 'failed' ? 'failed' : 'idle',
            stateKey: busy ? 'state.open' : task.state === 'failed' ? 'state.failed' : 'state.idle',
            ...(starting ? { starting } : {})
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
  markOf,
  part,
  from
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
  /** Only the replies line, or only the holding task's card; absent draws both. */
  part?: 'line' | 'card'
  /** Draws the card as this agent's message: its mark and name above a card showing the task's summary. */
  from?: { name: string; mark: ReactNode; href?: string }
  /** A replier's picture or agent icon for their mark; null falls back to their initials. */
  markOf?: (author: SessionThreadAuthorDto) => ReactNode | null
  /** The card's hover toolbar Reply: opens the thread ready to write in; absent, Reply opens it to read. */
  onReply?: () => void
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const [now, setNow] = useState(() => Date.now())
  const [shareOpen, setShareOpen] = useState(false)
  const tick = tickMs(footer.lastReplyAt, now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tick)
    return () => clearInterval(timer)
  }, [tick])

  const { task, readable } = footer
  // An unreadable thread opens nothing: its panel and its task's page would both show no content.
  const open = readable ? onOpen : undefined
  const to = readable ? href : undefined
  // A task whose session the CP has no row for yet is starting, not withheld; it opens once its session exists.
  const title = task?.title ?? (task?.starting ? t('startingTask') : t('hiddenTask'))
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
  const { replies, participants } = footer
  const lastReplyAt = footer.lastReplyAt ? new Date(footer.lastReplyAt) : null
  const repliesLabel = replies > 0 ? t('replies', { count: replies }) : t('reply')
  const card = task
    ? target(
        cardClass,
        <>
          {from ? (
            // As its agent's message: the task's summary alone, its title only where it has written none.
            <span
              data-task-card-summary=""
              className={`min-w-0 flex-1 font-sans text-[13.5px] font-normal leading-[1.55] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden ${
                task.title === null && !task.summary ? 'text-(--text-tertiary)' : 'text-(--text-primary)'
              }`}
            >
              {task.summary ?? title}
            </span>
          ) : (
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
                    className="min-w-0 overflow-hidden break-words font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                  >
                    {task.summary}
                  </span>
                ) : null}
              </span>
            </>
          )}
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

  // The card's hover menu above it, over its border and padding only: the menu every message shares, with Reply and the task session's Share.
  const shareSession = readable ? task?.sessionId : undefined
  const toolbar = (
    <MessageMenu
      group="card"
      label={t('cardActions')}
      onReply={onReply ?? open}
      onShare={shareSession ? () => setShareOpen(true) : undefined}
      className="right-[10px] bottom-full -mb-[6px]"
      data-task-card-toolbar=""
    />
  )
  const shareDialog = shareSession ? (
    <SessionShareDialogFor
      open={shareOpen}
      sessionId={shareSession}
      fallbackTitle={title}
      onClose={() => setShareOpen(false)}
    />
  ) : null

  // Every thread, held or not, shows its replies the same way under its root: "people 3 replies · 1m", which opens it.
  const line = (
    <div className="flex max-w-full min-w-0">
      {target(
        'flex w-fit max-w-full min-w-0 items-center gap-[6px] px-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) no-underline',
        <>
          {people}
          <span data-thread-count="" className="whitespace-nowrap">
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
    </div>
  )

  const cardBlock = card ? (
    <div data-task-card-hover="" className="group/card relative flex w-full max-w-[520px] min-w-0">
      {card}
      {toolbar}
    </div>
  ) : null
  // The card drawn as its agent's message: the agent's mark, its name and the task's state, then the card.
  const message =
    from && cardBlock && task ? (
      <div data-task-card-message="" className="flex w-full min-w-0 items-start gap-2 desktop:gap-[10px]">
        {from.href ? (
          <Link
            href={from.href}
            title={from.name}
            aria-label={from.name}
            className="av flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md"
          >
            {from.mark}
          </Link>
        ) : (
          <span className="av flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-md">
            {from.mark}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <AgentTurnHeader name={from.name} {...(from.href ? { href: from.href } : {})}>
            {task.tone !== 'idle' && task.tone !== 'done' ? (
              <StateIcon state={task.tone} label={tl(task.stateKey)} />
            ) : null}
          </AgentTurnHeader>
          <div className={AGENT_BUBBLE} data-agent-bubble="">
            {cardBlock}
          </div>
        </div>
      </div>
    ) : (
      cardBlock
    )

  return (
    <div
      {...(task?.sessionId ? { 'data-task-card': task.sessionId } : {})}
      {...(rootId ? { [part === 'card' ? 'data-thread-card' : 'data-thread-footer']: rootId } : {})}
      {...(readable ? {} : task?.starting ? { 'data-thread-starting': '' } : { 'data-thread-unreadable': '' })}
      className={`flex min-w-0 flex-col gap-[6px] ${align === 'end' ? 'items-end' : ''}`}
    >
      {part !== 'card' ? line : null}
      {part !== 'line' ? message : null}
      {shareDialog}
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
