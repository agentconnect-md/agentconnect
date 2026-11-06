'use client'

// One coordinator task's thread in the dock (auto-session-mode.md §10): what it and its people said, and a composer that continues it console-only.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import { MessageText } from '@/components/console/MessageText'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { taskStateKey, taskTone, useTaskStops, type MarkTone } from '@/components/console/task-list'
import { taskStopKey } from '@/components/console/follow-up'
import { exchangePromptMs, turnSpan, typedInvalidReason, withPromptStart } from '@/components/console/session-work'
import { turnWork, WorkStepList } from '@/components/console/WorkPanel'
import { TranscriptApprovalsProvider, TurnApprovals, UnplacedApprovals } from '@/components/console/TurnApprovals'
import { approvalTurnStart, type ApprovalTurnAnchor } from '@/components/console/approval-placement'
import { AGENT_PROSE, SELF_BUBBLE } from '@/components/console/transcript-bubbles'
import { AgentTurnHeader } from '@/components/console/AgentTurnHeader'
import {
  threadEntries,
  threadMessages,
  useTaskRow,
  useTaskThread,
  type ThreadEntry
} from '@/components/console/task-thread'
import type { TaskLink } from '@/components/console/task-link'
import { useDockExpand } from '@/components/console/dock/SessionDock'
import { fetchSessionDetail } from '@/lib/api'
import { RunningCommandsDock } from '@/components/console/RunningCommandsDock'
import { agentToneColor } from '@/lib/agent-tone'
import { agentLabel, MOCK_MODE, type Agent, type DaemonRow } from '@/lib/data'
import { TaskRuntimePicker } from '@/components/console/dock/TaskRuntimePicker'
import { sessionAttributionAgentAuthors, sessionAttributionAgentId } from '@/lib/session-trigger'
import { CONSOLE_SWR_CONFIG } from '@/lib/console-swr'
import type { AgentIcon } from '@/lib/agent-icon'
import { useOrgs } from '@/lib/org-context'
import { approvalNotice, raisedIn, WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'

const HEADER_BTN =
  'flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none'

// The state pill's colours by tone, as the design's task badge draws them.
const BADGE: Record<MarkTone, string> = {
  running: 'bg-(--status-online-soft) text-(--status-online-text)',
  waiting: 'bg-(--status-paused-soft) text-(--text-primary)',
  paused: 'bg-(--status-paused-soft) text-(--text-primary)',
  failed: 'bg-(--status-error-soft) text-(--status-error)',
  open: 'bg-(--surface-active) text-(--text-tertiary)',
  done: 'bg-(--surface-active) text-(--text-tertiary)',
  stopped: 'bg-(--surface-active) text-(--text-tertiary)'
}
const BADGE_DOT: Record<MarkTone, string> = {
  running: 'bg-(--status-online)',
  waiting: 'bg-(--status-paused)',
  paused: 'border-[1.5px] border-(--status-paused)',
  failed: 'bg-(--status-error)',
  open: 'border-[1.5px] border-(--border-strong)',
  done: 'bg-(--border-strong)',
  stopped: 'border-[1.5px] border-(--border-strong)'
}

export function TaskThreadPanel({
  agentId,
  agentName,
  agentIcon,
  agentRuntime,
  agentById,
  platform = '',
  task,
  parentSessionId,
  approvals,
  onBack,
  variant = 'panel',
  onExpand,
  onShrink,
  branch,
  taskApprovals,
  runtimeContext
}: {
  /** The coordinator's agent, which runs the task. */
  agentId: string
  agentName: string
  /** The agent's avatar, as the transcript draws it beside its turns. */
  agentIcon?: AgentIcon | null | undefined
  agentRuntime?: string | undefined
  /** The org's agents, so another agent that speaks in the thread is drawn as itself. */
  agentById?: ReadonlyMap<string, Agent>
  /** The conversation's platform, whose bot attribution names a speaking agent. */
  platform?: string
  task: TaskLink
  /** The conversation whose task list carries this one's state; null reads the task alone. */
  parentSessionId: string | null
  /** The coordinator's webchat conversation, whose grant the task writes under: its writes wait for approval here. */
  approvals?: { orgId: string; conversationId: string }
  onBack: () => void
  /** `expanded` draws the task over its coordinator (crumb, branch, shrink); `panel` is the side panel's quick look. */
  variant?: 'panel' | 'expanded'
  /** The side panel's expand, which opens the task expanded. */
  onExpand?: () => void
  /** The expanded view's shrink and its "Coordinator" crumb, which put the task back in the side panel. */
  onShrink?: () => void
  /** The branch the task's own worktree is on, as its Git panel read it. */
  branch?: string | null
  /** Who may answer this task's approvals and the conversation they are read through: the coordinator page's own rules. */
  taskApprovals?: { listSessionId: string; enabled: boolean; conversationPermissions: boolean }
  /** What the task's runtime picker reads: the agent, its daemon's catalogs, and whether this reader may change settings. */
  runtimeContext?: {
    owner: Agent | undefined
    owningDaemon: DaemonRow | undefined
    agentRuntime: string
    editable: boolean
  }
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const td = useTranslations('Sessions.detail.sessionDock')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const {
    getLiveSteps,
    isPgBusy,
    markSessionTarget,
    pgSend,
    pgNotice,
    setPgInput,
    reconcileLiveSteps,
    pgAnswerElicitation,
    pgAttach
  } = usePlayground()
  const dock = useDockExpand()
  const id = task.sessionId
  const row = useTaskRow(agentId, id, parentSessionId)
  const { stopOf, stop } = useTaskStops(agentId, parentSessionId ?? id, () => {})
  const stopState = row ? stopOf(row) : undefined
  const stoppable = !!row && row.state === 'open' && taskStopKey(row) !== null && stopState !== 'stopped'
  const listRef = useRef<HTMLDivElement | null>(null)
  const busy = isPgBusy(id)
  const { page, error, reload } = useTaskThread(id, row, { busy })
  // The server decides who may continue a task, by its parent's audience; absent or false keeps it read-only.
  const { data: detail } = useSWR(['session-detail', id], ([, sid]) => fetchSessionDetail(sid), CONSOLE_SWR_CONFIG)
  const canReply = detail?.canContinue === true
  const messages = threadMessages(page)
  // The session page's own reading of a bot post: its sender is an agent, or its trusted attribution names one.
  const peerAgent = useMemo(() => {
    if (!agentById) return undefined
    const authors = sessionAttributionAgentAuthors(platform, messages, agentById)
    return (m: (typeof messages)[number]) =>
      agentById.has(m.sender) ? m.sender : (sessionAttributionAgentId(platform, m, agentById) ?? authors.get(m.sender))
  }, [agentById, platform, messages])
  const entries = threadEntries(messages, getLiveSteps(id), agentId, peerAgent)

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

  // Each entry as the prompt lookup reads it, so a turn its own rows cannot measure dates from the message it answers.
  const promptTurns = entries.map((entry) => ({
    kind: entry.who === 'person' ? 'user' : 'bot',
    ...(entry.at ? { timeMs: Date.parse(entry.at) } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {})
  }))
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
  const tone = row ? taskTone(row, null) : null
  const pageHref = orgPath(`/sessions/${encodeURIComponent(id)}`)
  const own: Speaker = {
    name: agentName,
    avatar: <AgentIconView icon={agentIcon ?? null} runtime={agentRuntime ?? ''} size={24} />,
    accent: { '--agent-accent': agentToneColor(agentId || agentName) } as CSSProperties
  }
  // Another agent speaks as itself: its name, its avatar, its accent.
  const speakerOf = (entry: ThreadEntry): Speaker => {
    const peer = entry.agentId ? agentById?.get(entry.agentId) : undefined
    if (!peer) return own
    return {
      name: agentLabel(peer),
      avatar: <AgentIconView icon={peer.icon ?? null} runtime={peer.runtime ?? ''} size={24} />,
      accent: { '--agent-accent': agentToneColor(peer.id) } as CSSProperties
    }
  }
  return (
    <div data-task-thread={id} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[43px] min-w-0 flex-none items-center gap-[6px] border-b border-(--border-subtle) pr-2 pl-[10px]">
        <button
          type="button"
          data-task-thread-back=""
          title={variant === 'expanded' ? t('coordinatorTitle') : t('backTitle')}
          onClick={variant === 'expanded' ? (onShrink ?? onBack) : onBack}
          className="flex-none cursor-pointer rounded-sm border-0 bg-transparent px-[2px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:text-(--text-primary) hover:underline"
        >
          {variant === 'expanded' ? t('coordinator') : t('back')}
        </button>
        <Icon name="chevron-right" size={13} color="var(--text-tertiary)" className="flex-none" />
        <h3
          title={title}
          className="m-0 min-w-0 flex-[0_1_auto] truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)"
        >
          {title}
        </h3>
        {row && tone ? (
          <span
            data-task-thread-state={tone}
            className={`inline-flex flex-none items-center gap-[5px] rounded-full px-2 py-[2px] font-sans text-[11px] font-semibold leading-normal ${BADGE[tone]}`}
          >
            <span aria-hidden className={`h-[6px] w-[6px] flex-none rounded-full ${BADGE_DOT[tone]}`} />
            {tl(taskStateKey(row))}
          </span>
        ) : null}
        {variant === 'expanded' && branch ? (
          <span
            data-task-thread-branch=""
            title={branch}
            className="inline-flex min-w-0 flex-[0_100_auto] items-center gap-1 rounded-sm bg-(--surface-sunken) px-[6px] py-[2px] font-mono text-[11px] leading-normal text-(--text-secondary)"
          >
            <Icon name="git-fork" size={11} className="flex-none" />
            <span className="truncate">{branch}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        {stoppable ? (
          <button
            type="button"
            data-task-thread-stop=""
            disabled={stopState === 'busy'}
            className={HEADER_BTN}
            title={tl('stop')}
            aria-label={tl('stop')}
            onClick={() => void stop(row)}
          >
            <Icon name="square" size={13} />
          </button>
        ) : null}
        <Link
          href={pageHref}
          className={HEADER_BTN}
          title={t('openPage', { title })}
          aria-label={t('openPage', { title })}
        >
          <Icon name="arrow-up-right" size={14} />
        </Link>
        {variant === 'expanded' && onShrink ? (
          <button
            type="button"
            data-task-thread-shrink=""
            className={HEADER_BTN}
            title={t('shrink')}
            aria-label={t('shrink')}
            onClick={onShrink}
          >
            <Icon name="minimize-2" size={14} />
          </button>
        ) : onExpand ? (
          <button
            type="button"
            data-task-thread-expand=""
            className={HEADER_BTN}
            title={td('expandPanel')}
            aria-label={td('expandPanel')}
            onClick={onExpand}
          >
            <Icon name="maximize-2" size={14} />
          </button>
        ) : dock.available ? (
          <button
            type="button"
            data-task-thread-expand=""
            className={HEADER_BTN}
            title={dock.expanded ? td('collapsePanel') : td('expandPanel')}
            aria-label={dock.expanded ? td('collapsePanel') : td('expandPanel')}
            aria-pressed={dock.expanded}
            onClick={() => dock.setExpanded(!dock.expanded)}
          >
            <Icon name={dock.expanded ? 'minimize-2' : 'maximize-2'} size={14} />
          </button>
        ) : null}
        <button
          type="button"
          data-task-thread-close=""
          className={HEADER_BTN}
          title={t('close')}
          aria-label={t('close')}
          onClick={onBack}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-auto px-4 pt-[14px] pb-[18px]">
        {row?.summary ? (
          <p
            data-task-thread-summary=""
            className="m-0 rounded-lg border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.55] whitespace-pre-wrap text-(--text-secondary)"
          >
            {row.summary}
          </p>
        ) : null}
        {page?.nextCursor ? (
          <Link
            href={pageHref}
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
        <ApprovalsScope taskSessionId={id} agentId={agentId} scope={taskApprovals} entries={entries}>
          {entries.map((entry, i) => (
            <ThreadMessage
              key={entry.key}
              entry={entry}
              sessionId={id}
              streaming={busy && i === entries.length - 1}
              promptMs={exchangePromptMs(promptTurns, i)}
              speaker={speakerOf(entry)}
              you={t('you')}
              person={t('person')}
              time={entry.at ? format.dateTime(new Date(entry.at), { hour: 'numeric', minute: '2-digit' }) : null}
            >
              {entry.question ? (
                <ThreadQuestion
                  question={entry.question}
                  pageHref={pageHref}
                  onAnswer={(requestId, value) => {
                    markSessionTarget(id)
                    pgAnswerElicitation(id, agentId, requestId, value)
                  }}
                />
              ) : null}
              {/* The task's own tool-call approvals, at the turn that asked, as the session page draws a conversation's. */}
              {entry.who === 'agent' && !entry.question ? <TurnApprovals turnKey={entry.key} /> : null}
            </ThreadMessage>
          ))}
          <UnplacedApprovals />
        </ApprovalsScope>
        {/* Until the agent's turn shows, which then says it is working in its header, as the session page does. */}
        {busy && !(last?.who === 'agent' && last.live && !last.agentId) ? (
          <div className="flex items-center gap-[9px]" style={own.accent}>
            <span className="av h-6 w-6 flex-none rounded-md">{own.avatar}</span>
            <span role="status" className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('working', { agent: agentName })}
            </span>
          </div>
        ) : null}
      </div>
      {approvals ? (
        <WebchatMcpApprovalCard
          orgId={approvals.orgId}
          agentId={agentId}
          conversationId={approvals.conversationId}
          className="mx-3 mt-2"
          raisedHere={raisedIn(page?.messages)}
          // The task asked and ended its turn, so the decision is news only a notice to it delivers.
          onDecided={(operation, decision, outcome) => {
            markSessionTarget(id)
            pgNotice(id, agentId, approvalNotice(operation, decision, outcome))
          }}
        />
      ) : null}
      <ThreadComposer
        sessionId={id}
        canReply={canReply}
        checking={detail === undefined}
        placeholder={t('replyPlaceholder')}
        hint={t('replyHint', { agent: agentName })}
        readOnly={t('readOnly')}
        sendLabel={t('send')}
        onSend={send}
        setDraft={(text) => setPgInput(id, text)}
        // Writing here opens the task's own session, which is what reports the settings its picker offers.
        onFocus={() => {
          if (!canReply) return
          markSessionTarget(id)
          pgAttach(id, agentId, '')
        }}
        runtime={
          runtimeContext ? (
            <TaskRuntimePicker
              sessionId={id}
              agentId={agentId}
              owner={runtimeContext.owner}
              owningDaemon={runtimeContext.owningDaemon}
              agentRuntime={runtimeContext.agentRuntime}
              editable={runtimeContext.editable}
            />
          ) : null
        }
        dock={MOCK_MODE ? null : <RunningCommandsDock agentId={agentId} sessionId={id} turnActive={busy} />}
      />
    </div>
  )
}

/** A person's initials for their avatar: the first letters of the first two words, else the first character. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${[...words[0]!][0]}${[...words[1]!][0]}`.toUpperCase()
  return ([...(words[0] ?? '?')][0] ?? '?').toUpperCase()
}

/** Who an agent entry is drawn as. */
interface Speaker {
  name: string
  avatar: ReactNode
  accent: CSSProperties
}

function ThreadMessage({
  entry,
  sessionId,
  streaming,
  promptMs,
  speaker,
  you,
  person,
  time,
  children
}: {
  entry: ThreadEntry
  /** The task's session, which a work row's full tool body is read from. */
  sessionId: string
  /** The task is still answering and this is its latest entry. */
  streaming: boolean
  /** When the message this turn answers was sent, for a turn whose own rows cannot measure it. */
  promptMs: number | undefined
  speaker: Speaker
  you: string
  person: string
  time: string | null
  children?: ReactNode
}) {
  const [openWork, setOpenWork] = useState(false)
  const said = entry.text.trim() ? <MessageText text={entry.text} platform="webchat" /> : null
  if (entry.who === 'agent') {
    // The same turn the session page draws: one header folding the work, then one prose block per message posted.
    const { workSteps, summary, liveLine, liveKey } = turnWork(entry.work ?? [], streaming)
    const prose = entry.prose ?? (entry.text.trim() ? [entry.text] : [])
    return (
      <div
        data-thread-message="agent"
        data-thread-agent={entry.agentId}
        className="group/turn flex min-w-0 items-start gap-[9px]"
        style={speaker.accent}
      >
        <span className="av h-6 w-6 flex-none rounded-md">{speaker.avatar}</span>
        <div className="min-w-0 flex-1">
          <AgentTurnHeader
            name={speaker.name}
            {...(workSteps.length > 0
              ? {
                  work: {
                    summary,
                    open: openWork,
                    onToggle: () => setOpenWork((open) => !open),
                    running: streaming,
                    span: withPromptStart(turnSpan(entry.times ?? []), promptMs),
                    liveLine,
                    liveKey
                  }
                }
              : {})}
          >
            {time ? (
              <span className="flex-none whitespace-nowrap font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                {time}
              </span>
            ) : null}
          </AgentTurnHeader>
          <div className="flex min-w-0 flex-col gap-[10px]">
            {workSteps.length > 0 && openWork ? (
              <WorkStepList steps={workSteps} sessionId={sessionId} live={streaming} />
            ) : null}
            {prose.map((text, i) => (
              <div key={i} className={`${AGENT_PROSE} whitespace-pre-wrap`} data-agent-prose="">
                <MessageText text={text} platform="webchat" />
              </div>
            ))}
            {children}
          </div>
        </div>
      </div>
    )
  }
  const name = entry.name ?? (entry.live ? you : person)
  return (
    <div data-thread-message="person" className="flex min-w-0 items-start justify-end gap-2">
      <div className="flex min-w-0 max-w-[calc(100%-50px)] flex-col items-end">
        <span className="mb-1 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)">
          {name}
          {time ? (
            <span className="ml-[6px] font-mono text-[10.5px] font-normal text-(--text-tertiary)">{time}</span>
          ) : null}
        </span>
        {said ? <div className={`${SELF_BUBBLE} min-w-0 whitespace-pre-wrap break-words`}>{said}</div> : null}
        {children}
      </div>
      {entry.avatarUrl ? (
        <img
          src={entry.avatarUrl}
          alt=""
          aria-hidden
          data-thread-avatar=""
          className="mt-[2px] h-[22px] w-[22px] flex-none rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="mt-[2px] flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--brand-soft) font-sans text-[9px] font-semibold leading-none text-(--brand-soft-text)"
        >
          {initials(name)}
        </span>
      )}
    </div>
  )
}

/** A question's typed answer and what was last sent, kept by request so expanding, shrinking or reading a file keeps them. */
const questionAnswers = new Map<string, { draft: string; sent: string | null }>()

function useQuestionAnswer(
  requestId: string
): [{ draft: string; sent: string | null }, (next: { draft: string; sent: string | null }) => void] {
  const [answer, setAnswer] = useState(() => questionAnswers.get(requestId) ?? { draft: '', sent: null })
  const update = (next: { draft: string; sent: string | null }) => {
    questionAnswers.set(requestId, next)
    setAnswer(next)
  }
  return [answer, update]
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
  const [{ draft, sent }, setAnswer] = useQuestionAnswer(question.requestId)
  const setDraft = (value: string) => setAnswer({ draft: value, sent })
  const setSent = (value: string) => setAnswer({ draft, sent: value })
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
  hint,
  readOnly,
  sendLabel,
  onSend,
  setDraft,
  onFocus,
  runtime,
  dock
}: {
  sessionId: string
  canReply: boolean
  checking: boolean
  placeholder: string
  /** Who a reply reaches, under the box. */
  hint: string
  readOnly: string
  sendLabel: string
  onSend: () => void
  setDraft: (text: string) => void
  onFocus?: () => void
  /** The task's runtime picker, beside the send button. */
  runtime?: ReactNode
  /** What the task runs in the background, docked over the box. */
  dock: ReactNode
}) {
  const draft = usePgDraft(sessionId)
  const hasText = usePgDraftHasText(sessionId)
  if (!canReply && !checking)
    return (
      <div className="flex-none border-t border-(--border-subtle) px-4 py-3 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {dock}
        {readOnly}
      </div>
    )
  return (
    <div className="flex-none border-t border-(--border-subtle) px-3 pt-[10px] pb-3">
      {dock}
      <div className="flex flex-col rounded-[10px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--brand) focus-within:[box-shadow:0_0_0_3px_var(--brand-ring)]">
        <textarea
          aria-label={placeholder}
          placeholder={placeholder}
          rows={2}
          value={draft}
          disabled={!canReply}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
          className="max-h-[160px] min-h-[44px] min-w-0 resize-none border-0 bg-transparent px-3 pt-[10px] pb-[2px] font-sans text-[13.5px] font-normal leading-[1.55] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
        />
        <div className="flex items-center gap-2 pt-[5px] pr-[7px] pb-[6px] pl-[10px]">
          <span
            data-task-thread-hint=""
            className="min-w-0 flex-1 truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
          >
            {hint}
          </span>
          {runtime}
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
    </div>
  )
}

/** Places the task's approvals at the thread's agent turns when the reader may answer them; otherwise draws the thread alone. */
function ApprovalsScope({
  taskSessionId,
  agentId,
  scope,
  entries,
  children
}: {
  taskSessionId: string
  agentId: string
  scope: { listSessionId: string; enabled: boolean; conversationPermissions: boolean } | undefined
  entries: readonly ThreadEntry[]
  children: ReactNode
}) {
  if (!scope) return <>{children}</>
  // A turn followed by a person's message answered an earlier exchange, so a waiting request is the latest one's.
  const turns: ApprovalTurnAnchor[] = entries.flatMap((entry, i) =>
    entry.who === 'agent' && !entry.question
      ? [
          {
            key: entry.key,
            ...(entry.agentId ? { agentId: entry.agentId } : {}),
            startMs: approvalTurnStart(entry.times ?? []),
            closed: entries.slice(i + 1).some((later) => later.who === 'person')
          }
        ]
      : []
  )
  return (
    <TranscriptApprovalsProvider
      agentId={agentId}
      sessionId={taskSessionId}
      listSessionId={scope.listSessionId}
      enabled={scope.enabled}
      conversationPermissions={scope.conversationPermissions}
      turns={turns}
    >
      {children}
    </TranscriptApprovalsProvider>
  )
}
