'use client'

// One coordinator task's thread in the dock (auto-session-mode.md §10): what it and its people said, and a composer that continues it console-only.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { MessageText } from '@/components/console/MessageText'
import { Scrim } from '@/components/console/Scrim'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { StateMark, taskStateKey, taskTone } from '@/components/console/task-list'
import { typedInvalidReason } from '@/components/console/session-work'
import {
  threadEntries,
  threadMessages,
  useTaskRow,
  useTaskThread,
  type ThreadEntry
} from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import { fetchSessionDetail } from '@/lib/api'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'
import { useOrgs } from '@/lib/org-context'

export function TaskThreadPanel({
  agentId,
  agentName,
  task,
  parentSessionId,
  onBack
}: {
  /** The coordinator's agent, which runs the task. */
  agentId: string
  agentName: string
  task: TaskLink
  /** The conversation whose task list carries this one's state; null reads the task alone. */
  parentSessionId: string | null
  onBack: () => void
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const { getLiveSteps, isPgBusy, markSessionTarget, pgSend, setPgInput, reconcileLiveSteps, pgAnswerElicitation } =
    usePlayground()
  const id = task.sessionId
  const row = useTaskRow(agentId, id, parentSessionId)
  // Shown large over the page, for a long thread the dock is too narrow to read.
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  // The thread's own node, created once on the client and moved between the two slots below.
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null
    const node = document.createElement('div')
    node.className = 'flex min-h-0 flex-1 flex-col'
    return node
  })
  const dockSlot = useRef<HTMLDivElement | null>(null)
  const dialogSlot = useRef<HTMLDivElement | null>(null)
  // Where the list was scrolled when the thread last moved: a detached node loses its scroll position.
  const scrollTop = useRef<number | null>(null)
  const toggleExpanded = (next: boolean): void => {
    scrollTop.current = listRef.current?.scrollTop ?? null
    setExpanded(next)
  }
  useLayoutEffect(() => {
    const slot = expanded ? dialogSlot.current : dockSlot.current
    if (!host || !slot || host.parentNode === slot) return
    slot.appendChild(host)
    if (scrollTop.current !== null && listRef.current) listRef.current.scrollTop = scrollTop.current
    scrollTop.current = null
  }, [expanded, host])
  const busy = isPgBusy(id)
  const { page, error, reload } = useTaskThread(id, row, { busy })
  // The server decides who may continue a task, by its parent's audience; absent or false keeps it read-only.
  const { data: detail } = useSWR(['session-detail', id], ([, sid]) => fetchSessionDetail(sid), CONSOLE_SWR_CONFIG)
  const canReply = detail?.canContinue === true
  const messages = threadMessages(page)
  const entries = threadEntries(messages, getLiveSteps(id), agentId)

  // A read that lands after the turn ends retires the live copy of what it now carries.
  useEffect(() => {
    if (page && !busy) reconcileLiveSteps(id, page.messages, agentId)
  }, [agentId, busy, id, page, reconcileLiveSteps])

  // A turn's end is when its answer lands on the record.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) void reload()
    wasBusy.current = busy
  }, [busy, reload])

  const last = entries[entries.length - 1]
  const tail = `${entries.length}:${last?.text.length ?? 0}`
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [tail])

  const send = (): void => {
    if (!canReply) return
    markSessionTarget(id)
    pgSend(id, agentId)
  }

  const title = row?.title ?? task.title
  const thread = (
    <div data-task-thread={id} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-[6px] border-b border-(--border-subtle) px-3 py-[10px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-1 py-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            onClick={() => {
              toggleExpanded(false)
              onBack()
            }}
          >
            <Icon name="arrow-left" size={14} />
            {t('back')}
          </button>
          <button
            type="button"
            data-task-thread-expand=""
            className="iconbtn ml-auto flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm"
            title={expanded ? t('collapse') : t('expand')}
            aria-label={expanded ? t('collapse') : t('expand')}
            aria-pressed={expanded}
            onClick={() => toggleExpanded(!expanded)}
          >
            <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={14} />
          </button>
          <Link
            href={orgPath(`/sessions/${encodeURIComponent(id)}`)}
            className="iconbtn flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm"
            title={t('openPage', { title })}
            aria-label={t('openPage', { title })}
          >
            <Icon name="external-link" size={14} />
          </Link>
        </div>
        <div className="flex min-w-0 items-center gap-2 px-1">
          {row ? <StateMark tone={taskTone(row, null)} inline /> : null}
          <h3 className="m-0 min-w-0 flex-1 truncate font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {title}
          </h3>
          {row ? (
            <span className="flex-none font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {tl(taskStateKey(row))}
            </span>
          ) : null}
        </div>
        {row?.summary ? (
          <p className="m-0 px-1 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            {row.summary}
          </p>
        ) : null}
      </div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        {page?.nextCursor ? (
          <Link
            href={orgPath(`/sessions/${encodeURIComponent(id)}`)}
            className="w-fit font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:underline"
          >
            {t('earlier')}
          </Link>
        ) : null}
        {!page && !error ? (
          <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('loading')}
          </span>
        ) : null}
        {error && !page ? (
          <span role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            {t('loadFailed')}
          </span>
        ) : null}
        {entries.map((entry) => (
          <ThreadMessage
            key={entry.key}
            entry={entry}
            agentName={agentName}
            you={t('you')}
            person={t('person')}
            time={entry.at ? format.dateTime(new Date(entry.at), { hour: 'numeric', minute: '2-digit' }) : null}
          >
            {entry.question ? (
              <ThreadQuestion
                question={entry.question}
                pageHref={orgPath(`/sessions/${encodeURIComponent(id)}`)}
                onAnswer={(requestId, value) => {
                  markSessionTarget(id)
                  pgAnswerElicitation(id, agentId, requestId, value)
                }}
              />
            ) : null}
          </ThreadMessage>
        ))}
        {busy ? (
          <span role="status" className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('working', { agent: agentName })}
          </span>
        ) : null}
      </div>
      <ThreadComposer
        sessionId={id}
        canReply={canReply}
        checking={detail === undefined}
        placeholder={t('replyPlaceholder')}
        readOnly={t('readOnly')}
        sendLabel={t('send')}
        onSend={send}
        setDraft={(text) => setPgInput(id, text)}
      />
    </div>
  )
  // One mounted thread whose node moves between the dock and the large view, so its drafts, answers and scroll survive the switch.
  return (
    <>
      {expanded ? (
        <div
          data-task-thread-placeholder=""
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          {t('expandedElsewhere')}
          <Button variant="secondary" size="xs" onClick={() => toggleExpanded(false)}>
            {t('collapse')}
          </Button>
        </div>
      ) : (
        <div ref={dockSlot} className="flex min-h-0 flex-1 flex-col" />
      )}
      {expanded
        ? createPortal(
            <Scrim
              onEscape={() => toggleExpanded(false)}
              onClick={(e) => e.target === e.currentTarget && toggleExpanded(false)}
            >
              <div
                ref={dialogSlot}
                role="dialog"
                aria-modal
                aria-label={title}
                className="flex h-full max-h-[92vh] w-full max-w-[960px] flex-col overflow-hidden rounded-lg border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xl) max-desktop:max-h-none max-desktop:rounded-none max-desktop:border-0"
              />
            </Scrim>,
            document.body
          )
        : null}
      {host ? createPortal(thread, host) : null}
    </>
  )
}

function ThreadMessage({
  entry,
  agentName,
  you,
  person,
  time,
  children
}: {
  entry: ThreadEntry
  agentName: string
  you: string
  person: string
  time: string | null
  children?: ReactNode
}) {
  const agent = entry.who === 'agent'
  const name = agent ? agentName : (entry.name ?? (entry.live ? you : person))
  return (
    <div data-thread-message={entry.who} className="flex min-w-0 flex-col gap-[3px]">
      <div className="flex items-baseline gap-2">
        <span
          className={`font-sans text-[13px] font-semibold leading-normal ${
            agent
              ? 'text-[color:color-mix(in_oklab,var(--indigo-500)_62%,var(--text-primary))]'
              : 'text-(--text-primary)'
          }`}
        >
          {name}
        </span>
        {time ? (
          <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">{time}</span>
        ) : null}
      </div>
      {entry.text.trim() ? (
        <div className="min-w-0 whitespace-pre-wrap break-words font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary)">
          <MessageText text={entry.text} platform="webchat" />
        </div>
      ) : null}
      {children}
    </div>
  )
}

/** The agent's open question: a plain choice or a line of text answers here; any other form is shown on the task's page. */
function ThreadQuestion({
  question,
  pageHref,
  onAnswer
}: {
  question: NonNullable<ThreadEntry['question']>
  pageHref: string
  onAnswer: (requestId: string, value: string) => void
}) {
  const t = useTranslations('Common.taskThread')
  // What was last sent: the control stays live, so an answer the daemon refuses can be corrected, until it settles the question and the thread drops it.
  const [sent, setSent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const invalid = question.text ? typedInvalidReason({ text: question.text }, draft) : undefined
  return (
    <div
      data-thread-question={question.requestId}
      className="mt-1 flex flex-col gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2"
    >
      <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
        {t('question')}
      </span>
      {question.text ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (invalid) return
            setSent(draft)
            onAnswer(question.requestId, draft)
          }}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label={t('answer')}
              placeholder={t('answer')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-w-0 flex-1 rounded-sm border border-(--border-default) bg-(--surface-card) px-2 py-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) outline-none focus:border-(--brand)"
            />
            <Button variant="primary" size="xs" type="submit" disabled={invalid !== undefined || draft === sent}>
              {t('send')}
            </Button>
          </div>
          {draft && invalid ? (
            <span
              data-thread-question-invalid=""
              className="font-sans text-[11.5px] font-normal leading-normal text-(--status-error)"
            >
              {invalid}
            </span>
          ) : sent !== null ? (
            <span role="status" className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('answerSent')}
            </span>
          ) : null}
        </form>
      ) : question.choices ? (
        <div className="flex flex-wrap gap-2">
          {question.choices.map((choice) => (
            <Button
              key={choice.value}
              variant={sent === choice.value ? 'primary' : 'secondary'}
              size="xs"
              onClick={() => {
                setSent(choice.value)
                onAnswer(question.requestId, choice.value)
              }}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : (
        <Link
          href={pageHref}
          className="w-fit font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) hover:underline"
        >
          {t('answerOnPage')}
        </Link>
      )}
    </div>
  )
}

function ThreadComposer({
  sessionId,
  canReply,
  checking,
  placeholder,
  readOnly,
  sendLabel,
  onSend,
  setDraft
}: {
  sessionId: string
  canReply: boolean
  checking: boolean
  placeholder: string
  readOnly: string
  sendLabel: string
  onSend: () => void
  setDraft: (text: string) => void
}) {
  const draft = usePgDraft(sessionId)
  const hasText = usePgDraftHasText(sessionId)
  if (!canReply && !checking)
    return (
      <div className="flex-none border-t border-(--border-subtle) px-4 py-3 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {readOnly}
      </div>
    )
  return (
    <div className="flex-none px-3 pt-2 pb-3">
      <div className="flex items-end gap-2 rounded-[11px] border border-(--border-default) bg-(--surface-card) py-2 pr-2 pl-3 shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--brand) focus-within:[box-shadow:0_0_0_3px_var(--brand-ring)]">
        <textarea
          aria-label={placeholder}
          placeholder={placeholder}
          rows={2}
          value={draft}
          disabled={!canReply}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
          className="max-h-[160px] min-h-[40px] min-w-0 flex-1 resize-none border-0 bg-transparent p-0 font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
        />
        <button
          type="button"
          className="sendbtn h-[26px] w-[26px] flex-none rounded-[7px]"
          aria-label={sendLabel}
          disabled={!canReply || !hasText}
          onClick={onSend}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  )
}
