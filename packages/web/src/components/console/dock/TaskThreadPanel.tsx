'use client'

// One coordinator task's thread in the dock (auto-session-mode.md §10): what it and its people said, and a composer that continues it console-only.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { MessageText } from '@/components/console/MessageText'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { StateMark, taskStateKey, taskTone } from '@/components/console/task-list'
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

  const listRef = useRef<HTMLDivElement | null>(null)
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
  return (
    <div data-task-thread={id} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-[6px] border-b border-(--border-subtle) px-3 py-[10px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-1 py-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            onClick={onBack}
          >
            <Icon name="arrow-left" size={14} />
            {t('back')}
          </button>
          <Link
            href={orgPath(`/sessions/${encodeURIComponent(id)}`)}
            className="iconbtn ml-auto flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm"
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
  const [answered, setAnswered] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
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
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!draft.trim() || answered !== null) return
            setAnswered(draft)
            onAnswer(question.requestId, draft)
          }}
        >
          <input
            aria-label={t('answer')}
            placeholder={t('answer')}
            value={draft}
            disabled={answered !== null}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-sm border border-(--border-default) bg-(--surface-card) px-2 py-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-primary) outline-none focus:border-(--brand)"
          />
          <Button variant="primary" size="xs" type="submit" disabled={answered !== null || !draft.trim()}>
            {t('send')}
          </Button>
        </form>
      ) : question.choices ? (
        <div className="flex flex-wrap gap-2">
          {question.choices.map((choice) => (
            <Button
              key={choice.value}
              variant={answered === choice.value ? 'primary' : 'secondary'}
              size="xs"
              disabled={answered !== null}
              onClick={() => {
                setAnswered(choice.value)
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
