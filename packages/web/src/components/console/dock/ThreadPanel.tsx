'use client'

// One thread in the dock (webchat-threads.md §6.2): its record or its task's session, the holding task's header, and a composer that writes in the thread (§6.3).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import { usePgDraft, usePgDraftHasText, usePlayground } from '@/components/console/PlaygroundProvider'
import { taskStateKey, taskTone, useTaskStops } from '@/components/console/task-list'
import { StateIcon } from '@/components/console/StateIcon'
import { SendButton } from '@/components/console/SendButton'
import { taskStopKey } from '@/components/console/follow-up'
import { exchangePromptMs, toggleWorkPanel, workPanelOpen } from '@/components/console/session-work'
import { TranscriptApprovalsProvider, UnplacedApprovals } from '@/components/console/TurnApprovals'
import { approvalTurnStart, type ApprovalTurnAnchor } from '@/components/console/approval-placement'
import {
  threadMessages,
  threadRows,
  unsavedLive,
  useTaskRow,
  useTaskThread,
  useThreadRecord,
  withoutAttribution,
  type ThreadRecordRef
} from '@/components/console/task-thread'
import { buildTurns, type Turn } from '@/components/console/session-turns'
import { BotTurnView, UserTurnView } from '@/components/console/TurnViews'
import type { TaskLink } from '@/components/console/task-link'
import { fetchSessionDetail, type SessionThreadSummaryDto } from '@/lib/api'
import { ComposerFileChips, stageComposerFile } from '@/components/console/ComposerFiles'
import { prepareWebchatImage } from '@/lib/webchat-image'
import { RunningCommandsDock } from '@/components/console/RunningCommandsDock'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import { agentToneColor } from '@/lib/agent-tone'
import { MOCK_MODE, platName, type Agent, type DaemonRow, type ElicitAnswerValue } from '@/lib/data'
import { threadShapeOf } from '@/components/console/coordinator-threads'
import { TaskRuntimePicker } from '@/components/console/dock/TaskRuntimePicker'
import { sessionAttributionAgentAuthors, sessionAttributionAgentId } from '@/lib/session-trigger'
import { CONSOLE_SWR_CONFIG, readOnceRegistered } from '@/lib/console-swr'
import type { AgentIcon } from '@/lib/agent-icon'
import { useOrgs } from '@/lib/org-context'
import { approvalNotice, raisedIn, WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'

const HEADER_BTN =
  'flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) focus-visible:outline-none'

const EMPTY: readonly never[] = []
const NO_AGENTS: ReadonlyMap<string, Agent> = new Map()
// A thread's rows come from one session, so no row names another source.
const NO_SOURCE = { session: new WeakMap(), turn: new WeakMap(), platform: new WeakMap(), agent: new WeakMap() }

export function ThreadPanel({
  agentId,
  agentName,
  agentIcon,
  agentRuntime,
  agentById,
  platform = '',
  task,
  record,
  parentSessionId,
  approvals,
  onBack,
  taskApprovals,
  runtimeContext,
  personPicture,
  fileTransfer = false,
  writer,
  focusComposer = false,
  onSummary,
  threadUrl
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
  /** The task that holds the thread; without `record`, the panel reads the task's own session. */
  task?: TaskLink
  /** The thread's record, read through the conversation's session; its footer names the holding task when `task` does not. */
  record?: ThreadRecordRef
  /** The conversation whose task list carries this one's state; null reads the task alone. */
  parentSessionId: string | null
  /** The coordinator's webchat conversation, whose grant the task writes under: its writes wait for approval here. */
  approvals?: { orgId: string; conversationId: string }
  /** Back to the Tasks list, which is also what closing the quick look does. */
  onBack: () => void
  /** Who may answer this task's approvals and the conversation they are read through: the coordinator page's own rules. */
  taskApprovals?: { listSessionId: string; enabled: boolean; conversationPermissions: boolean }
  /** The agent's daemon takes uploaded files, so a reply may carry one besides an image. */
  fileTransfer?: boolean
  /** What the task's runtime picker reads: the agent, its daemon's catalogs, and whether this reader may change settings. */
  runtimeContext?: {
    owner: Agent | undefined
    owningDaemon: DaemonRow | undefined
    agentRuntime: string
    editable: boolean
  }
  /** A person's console photo by sender, as the session page draws it; undefined asks for this visit's own sends. */
  personPicture?: (sender: string | undefined) => string | undefined
  /** The reader's own coordinator conversation, whose socket a message in this record's thread goes out on; absent for another member, who writes through the holding task. */
  writer?: { sessionId: string; conversationId?: string }
  /** Focus the composer when it first shows, as Reply in thread asks. */
  focusComposer?: boolean
  /** Told each footer the record's reads return, so the timeline's footer keeps up with an open thread. */
  onSummary?: (summary: SessionThreadSummaryDto) => void
  /** The thread's page on its platform, which the header links. */
  threadUrl?: string
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const { orgPath } = useOrgs()
  const {
    getLiveSteps,
    getPgInput,
    getPgTurnThread,
    isPgBusy,
    markSessionTarget,
    pgSend,
    pgSendThread,
    pgNotice,
    setPgInput,
    reconcileLiveSteps,
    pgAnswerElicitation,
    pgAttach,
    pgCancel
  } = usePlayground()
  // A turn the reader sent in this thread on their conversation's socket.
  const writing =
    !!writer && !!record && isPgBusy(writer.sessionId) && getPgTurnThread(writer.sessionId) === record.rootId
  // The record is read first; its footer names the holding task when the caller did not.
  const thread = useThreadRecord(record ?? null, (sid) => writing || isPgBusy(sid))
  const summary = thread.summary
  // A daemon without thread reads leaves a task's thread to its session; anything else reads the record.
  const fromRecord = !!record && !(thread.unsupported && task)
  const unreadable = fromRecord && summary?.readable === false
  const holderId = task?.sessionId ?? (unreadable ? null : (summary?.task?.sessionId ?? null))
  const id = holderId ?? ''
  // The owner writes in any thread of their conversation, held or not, and routing takes it to the task or the coordinator.
  const ownThread =
    writer && record && fromRecord && !unreadable && !thread.missing ? { ...writer, rootId: record.rootId } : null
  // A webchat task takes the thread a message is written in; a platform's task its own, mirrored into the platform thread.
  const shape = threadShapeOf(platform)
  const inThread = !!record && fromRecord && shape?.continuesInThread === true
  const mirrored = fromRecord && !!shape && !shape.continuesInThread
  const row = useTaskRow(agentId, holderId, parentSessionId)
  const { stopOf, stop } = useTaskStops(agentId, parentSessionId ?? id, () => {})
  const stopState = row ? stopOf(row) : undefined
  const stoppable = !!row && row.state === 'open' && taskStopKey(row) !== null && stopState !== 'stopped'
  const listRef = useRef<HTMLDivElement | null>(null)
  const busy = ownThread ? writing : holderId !== null && isPgBusy(id)
  const session = useTaskThread(fromRecord ? null : holderId, row, { busy })
  const recordPage = useMemo(() => (thread.messages ? { messages: thread.messages } : undefined), [thread.messages])
  const page = fromRecord ? recordPage : session.page
  const error = fromRecord ? thread.error : session.error
  const reload = fromRecord ? thread.reload : session.reload
  // The server decides who may continue a task, by its parent's audience; absent or false keeps it read-only.
  const { data: detail, mutate: reloadDetail } = useSWR(
    holderId ? ['session-detail', holderId] : null,
    ([, sid]) => readOnceRegistered(() => fetchSessionDetail(sid)),
    CONSOLE_SWR_CONFIG
  )
  const canReply = detail?.canContinue === true
  const messages = threadMessages(page)
  const agents = agentById ?? NO_AGENTS
  // The session page's own reading of a bot post: its sender is an agent, or its trusted attribution names one.
  const authors = useMemo(
    () => sessionAttributionAgentAuthors(platform, messages, agents),
    [agents, platform, messages]
  )
  // The owner's turns in this thread stream on their conversation's socket; another member's on the task's.
  const live = ownThread
    ? getLiveSteps(ownThread.sessionId).filter((step) => step.thread === ownThread.rootId)
    : holderId
      ? getLiveSteps(id)
      : EMPTY
  // Already this thread's own, so no step is left out as another thread's.
  const liveShown = unsavedLive(live, messages, agentId).map(({ thread: _thread, ...step }) => step)
  // The session page's turns: this visit's sends are the reader's own, and a person's name falls back as the page's does.
  const built = buildTurns({
    session: {
      id: holderId ?? record?.sessionId ?? '',
      agentId,
      agentName,
      model: '',
      platform,
      user: '@you',
      time: '',
      steps: []
    },
    rows: threadRows(messages, live),
    liveSteps: liveShown,
    source: NO_SOURCE,
    threadsView: false,
    threadShape: undefined,
    agentById: agents,
    asCron: (sender) => (sender.startsWith('cron:') ? { id: sender.slice('cron:'.length), name: null } : null),
    participantAgent: (sender, text, trustedAgentBot) => {
      const peer = agents.has(sender)
        ? sender
        : (sessionAttributionAgentId(platform, { text, trustedAgentBot }, agents) ?? authors.get(sender))
      return peer ? agents.get(peer) : undefined
    },
    isSelf: (sender) => sender === '@you',
    senderLabel: (_sender, fallback) => fallback ?? t('person'),
    ownsDecisionSeq: () => false,
    viewer: { picture: personPicture?.(undefined) ?? null },
    pictureOf: (sender) => personPicture?.(sender),
    sourceLabel: platName(platform)
  }).turns
  // Another agent's post reads as that agent, so its "sent by" line goes.
  const turns: Turn[] = built.map((turn) =>
    turn.kind === 'bot' && turn.agentId && turn.agentId !== agentId
      ? { ...turn, steps: turn.steps.map((step) => ({ ...step, text: withoutAttribution(step.text) })) }
      : turn
  )
  const [workOverride, setWorkOverride] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  // A read that lands after the turn ends retires the live copy of what it now carries.
  const ownSessionId = ownThread?.sessionId
  const ownRootId = ownThread?.rootId
  useEffect(() => {
    if (!page || busy) return
    if (ownSessionId && ownRootId) reconcileLiveSteps(ownSessionId, page.messages, agentId, undefined, ownRootId)
    else if (holderId) reconcileLiveSteps(holderId, page.messages, agentId)
  }, [agentId, busy, holderId, ownRootId, ownSessionId, page, reconcileLiveSteps])

  // The timeline's footer follows what this panel reads.
  const onSummaryRef = useRef(onSummary)
  onSummaryRef.current = onSummary
  useEffect(() => {
    if (summary) onSummaryRef.current?.(summary)
  }, [summary])

  // A turn's end is when its answer lands on the record.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void reload()
      // The turn's usage report lands with it, so the context ring re-reads the task's detail.
      void reloadDetail()
    }
    wasBusy.current = busy
  }, [busy, reload, reloadDetail])

  const last = turns[turns.length - 1]
  const tail = `${turns.length}:${last?.kind === 'bot' ? `${last.steps.length}:${last.steps.at(-1)?.text.length ?? 0}` : (last?.text.length ?? 0)}`
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [tail])

  // The composer's draft: the owner's is this thread's own, another member's the holding task's.
  const draftId = ownThread ? `${ownThread.sessionId}#${ownThread.rootId}` : id
  const send = (): void => {
    if (ownThread) {
      if (pgSendThread(ownThread.sessionId, agentId, getPgInput(draftId), ownThread.rootId, ownThread.conversationId))
        setPgInput(draftId, '')
      return
    }
    if (!canReply || !holderId) return
    markSessionTarget(holderId)
    // Read from the record, the message is written in this thread of the task, which may hold several.
    if (record && inThread) {
      if (pgSendThread(holderId, agentId, getPgInput(holderId), record.rootId)) setPgInput(holderId, '')
      return
    }
    pgSend(holderId, agentId)
  }

  const title = row?.title ?? task?.title ?? summary?.task?.title ?? t('thread')
  const tone = row ? taskTone(row, null) : null
  const pageHref = holderId ? orgPath(`/sessions/${encodeURIComponent(holderId)}`) : null
  // A question in the thread is the task's, answered on its session.
  const answerElicitation = holderId
    ? (turnAgent: string | undefined, requestId: string | undefined, value: ElicitAnswerValue): void => {
        if (!requestId) return
        markSessionTarget(holderId)
        pgAnswerElicitation(holderId, turnAgent ?? agentId, requestId, value)
      }
    : undefined
  // A turn a person's message follows answered an earlier exchange.
  const lastExchangeAt = turns.reduce((at, turn, i) => (turn.kind === 'user' && !turn.steer ? i : at), -1)
  // Until the agent's reply streams in, which then says it is working in its header, as the session page does.
  const lastLive = liveShown[liveShown.length - 1]
  const replying =
    last?.kind === 'bot' && !!lastLive && lastLive.kind !== 'msg' && (!last.agentId || last.agentId === agentId)
  return (
    <div
      {...(holderId ? { 'data-task-thread': holderId } : {})}
      {...(record ? { 'data-thread-panel': record.rootId } : {})}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-[43px] min-w-0 flex-none items-center gap-[6px] border-b border-(--border-subtle) pr-2 pl-[10px]">
        <button
          type="button"
          data-task-thread-back=""
          className={HEADER_BTN}
          title={t('backTitle')}
          aria-label={t('backTitle')}
          onClick={onBack}
        >
          <Icon name="chevron-left" size={15} />
        </button>
        {row && tone ? <StateIcon state={tone} label={tl(taskStateKey(row))} /> : null}
        <h3
          title={title}
          className="m-0 min-w-0 flex-1 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)"
        >
          {title}
        </h3>
        {stoppable && !canReply ? (
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
        {threadUrl ? (
          <a
            href={threadUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-thread-platform-link=""
            className={HEADER_BTN}
            title={t('openOnPlatform', { platform: platName(platform) })}
            aria-label={t('openOnPlatform', { platform: platName(platform) })}
          >
            <Icon name="external-link" size={14} />
          </a>
        ) : null}
        {/* Expanding a task is opening its own page; a real link, so a modified click opens it in a new tab. */}
        {pageHref ? (
          <Link
            href={pageHref}
            data-task-thread-expand=""
            className={HEADER_BTN}
            title={t('openPage', { title })}
            aria-label={t('openPage', { title })}
          >
            <Icon name="maximize-2" size={14} />
          </Link>
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
        {fromRecord && thread.hasEarlier ? (
          <button
            type="button"
            data-thread-earlier=""
            disabled={thread.loadingEarlier}
            onClick={() => void thread.loadEarlier().catch(() => {})}
            className="w-fit cursor-pointer border-0 bg-transparent p-0 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:underline"
          >
            {t('showEarlier')}
          </button>
        ) : !fromRecord && session.page?.nextCursor && pageHref ? (
          <Link
            href={pageHref}
            className="w-fit font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:underline"
          >
            {t('earlier')}
          </Link>
        ) : null}
        {unreadable ? (
          <span
            data-thread-unreadable=""
            className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
          >
            {t('unreadable')}
          </span>
        ) : null}
        {fromRecord && thread.missing ? (
          <span role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('missing')}
          </span>
        ) : !page && error ? (
          <span role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            {t('loadFailed')}
          </span>
        ) : null}
        {!page && !error ? (
          <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('loading')}
          </span>
        ) : null}
        <ApprovalsScope
          taskSessionId={id}
          agentId={agentId}
          scope={holderId ? taskApprovals : undefined}
          turns={turns}
          lastExchangeAt={lastExchangeAt}
        >
          {turns.map((turn, i) => (
            // The session page's turn: its time line, then the person's bubble or the agent's block.
            <div
              key={turn.key}
              data-thread-message={turn.kind === 'user' ? 'person' : 'agent'}
              {...(turn.kind === 'bot' && turn.agentId && turn.agentId !== agentId
                ? { 'data-thread-agent': turn.agentId }
                : {})}
              className="flex min-w-0 flex-col gap-[5px]"
            >
              {turn.time ? (
                <div className="mono text-center text-[11px] leading-normal text-(--text-tertiary)">{turn.time}</div>
              ) : null}
              {turn.kind === 'user' ? (
                <UserTurnView turn={turn} />
              ) : (
                <BotTurnView
                  turn={turn}
                  agentById={agents}
                  owner={agents.get(agentId)}
                  ownerRuntime={agentRuntime ?? ''}
                  sessionId={holderId ?? record?.sessionId}
                  streaming={busy && i === turns.length - 1}
                  workOpen={workPanelOpen(workOverride.get(turn.key))}
                  onToggleWork={() =>
                    setWorkOverride((prev) => toggleWorkPanel(prev, turn.key, workPanelOpen(prev.get(turn.key))))
                  }
                  promptMs={exchangePromptMs(turns, i)}
                  answerElicitation={answerElicitation}
                />
              )}
            </div>
          ))}
          <UnplacedApprovals />
        </ApprovalsScope>
        {busy && !replying ? (
          <div
            className="flex items-center gap-[9px]"
            style={{ '--agent-accent': agentToneColor(agentId || agentName) } as CSSProperties}
          >
            <span className="av h-6 w-6 flex-none rounded-md">
              <AgentIconView icon={agentIcon ?? null} runtime={agentRuntime ?? ''} size={24} />
            </span>
            <span role="status" className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('working', { agent: agentName })}
            </span>
          </div>
        ) : null}
      </div>
      {approvals && holderId ? (
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
      {/* The owner writes in any thread; another member only in a held one, which continues its task. */}
      {ownThread || holderId ? (
        <ThreadComposer
          sessionId={draftId}
          canReply={ownThread ? true : canReply}
          checking={ownThread ? false : detail === undefined}
          placeholder={ownThread || mirrored ? t('threadPlaceholder') : t('replyPlaceholder')}
          // Who answers a message in a thread; a task's reply box has its attach button there instead.
          {...(ownThread
            ? { hint: holderId ? t('threadHintTask') : t('threadHintCoordinator') }
            : mirrored
              ? { hint: t('threadHintMirrored', { platform: platName(platform) }) }
              : {})}
          // A thread send carries text alone, so only a reply onto the task's own session offers attachments.
          {...(MOCK_MODE || ownThread || (record && fromRecord) ? {} : { attach: { agentId, transfer: fileTransfer } })}
          sendLabel={t('send')}
          onSend={send}
          autoFocus={focusComposer}
          // Stop shows as soon as a turn runs here, before the task list catches up; the console's stop route is used once the list says it runs.
          {...(stoppable && row
            ? { onStop: () => void stop(row), stopping: stopState === 'busy' }
            : busy && !ownThread
              ? { onStop: () => pgCancel(id, agentId) }
              : {})}
          stopLabel={tl('stop')}
          setDraft={(text) => setPgInput(draftId, text)}
          // Writing here opens the task's own session, which is what reports the settings its picker offers.
          onFocus={() => {
            if (ownThread || !canReply) return
            markSessionTarget(id)
            pgAttach(id, agentId, '')
          }}
          runtime={
            runtimeContext && holderId ? (
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
          context={
            holderId ? (
              <ContextWindowIndicator used={detail?.usage?.contextUsed} size={detail?.usage?.contextSize} />
            ) : null
          }
          dock={
            MOCK_MODE || !holderId ? null : <RunningCommandsDock agentId={agentId} sessionId={id} turnActive={busy} />
          }
        />
      ) : null}
    </div>
  )
}

function ThreadComposer({
  sessionId,
  canReply,
  checking,
  placeholder,
  sendLabel,
  onSend,
  onStop,
  stopping = false,
  stopLabel,
  setDraft,
  onFocus,
  autoFocus = false,
  hint,
  runtime,
  context,
  attach,
  dock
}: {
  /** Whose draft the box edits. */
  sessionId: string
  canReply: boolean
  checking: boolean
  placeholder: string
  sendLabel: string
  onSend: () => void
  /** Stops the task's current turn; offered only while it runs. */
  onStop?: () => void
  stopping?: boolean
  stopLabel: string
  setDraft: (text: string) => void
  onFocus?: () => void
  /** Take the caret once the box can be written in. */
  autoFocus?: boolean
  /** Who a message reaches, where no attach button takes its place. */
  hint?: string
  /** The task's runtime picker, beside the attach button. */
  runtime?: ReactNode
  /** The task's context-window ring, beside send as on the conversation's composer. */
  context?: ReactNode
  /** Images and files go with a reply, staged as the conversation's composer stages them. */
  attach?: { agentId: string; transfer: boolean }
  /** What the task runs in the background, docked over the box. */
  dock: ReactNode
}) {
  const t = useTranslations('Sessions.detail')
  const draft = usePgDraft(sessionId)
  const hasText = usePgDraftHasText(sessionId)
  const { getPgImage, setPgImage, getPgFiles, setPgFiles } = usePlayground()
  const inputRef = useRef<HTMLInputElement>(null)
  const [preparing, setPreparing] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const image = getPgImage(sessionId)
  const files = getPgFiles(sessionId)
  const hasAttachment = !!image || files.length > 0
  const uploading = files.some((file) => file.status === 'uploading')
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  // After the dock's own reveal, which focuses an overlay panel as it opens.
  useEffect(() => {
    if (!autoFocus || !canReply) return
    const timer = window.setTimeout(() => boxRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [autoFocus, canReply])
  // No reply box where this reader may not continue the task; its background commands still show.
  if (!canReply && !checking) return dock ? <div className="flex-none px-3 pb-3 empty:hidden">{dock}</div> : null
  // An image goes inline, as the conversation's composer sends it; any other file is uploaded and referenced.
  const pick = async (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = ''
    if (!attach || !file) return
    setAttachError(null)
    if (!file.type.startsWith('image/')) {
      stageComposerFile(
        {
          sessionId,
          agentId: attach.agentId,
          transfer: attach.transfer,
          getPgFiles,
          setPgFiles,
          onError: setAttachError
        },
        file
      )
      return
    }
    setPreparing(true)
    try {
      setPgImage(sessionId, await prepareWebchatImage(file))
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : t('attachFailed'))
    } finally {
      setPreparing(false)
    }
  }
  const canSend = canReply && (hasText || hasAttachment) && !uploading && !preparing
  return (
    // On desktop the bottom inset is the conversation composer's (`.content`'s 26px + its footer's 4px), so the two boxes line up.
    <div className="flex-none px-3 pt-[10px] pb-3 desktop:pb-[30px]">
      {dock}
      <div className="flex flex-col rounded-[11px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--border-strong) focus-within:shadow-(--focus-shadow)">
        {attach ? (
          <ComposerFileChips
            files={files}
            onRemove={(key) => setPgFiles(sessionId, (staged) => staged.filter((file) => file.key !== key))}
          />
        ) : null}
        {attach && image ? (
          <div className="relative mx-[15px] mt-3 w-fit">
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={image.name}
              title={image.name}
              className="h-20 w-20 rounded-[9px] border border-(--border-subtle) bg-(--surface-sunken) object-cover"
            />
            <button
              type="button"
              className="iconbtn absolute -top-2 -right-2 h-6 w-6 rounded-full shadow-(--shadow-xs)"
              title={t('removeImage')}
              aria-label={t('removeImage')}
              onClick={() => setPgImage(sessionId)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}
        <textarea
          ref={boxRef}
          data-thread-composer=""
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
              if (canSend) onSend()
            }
          }}
          className="max-h-[160px] min-h-[56px] min-w-0 resize-none border-0 bg-transparent px-[15px] pt-[13px] pb-[2px] font-sans text-[14px] font-normal leading-[1.55] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
        />
        {attachError ? (
          <div
            role="alert"
            className="px-[15px] pb-1 font-sans text-[12px] font-normal leading-normal text-(--status-error)"
          >
            {attachError}
          </div>
        ) : null}
        {/* The conversation composer's toolbar: attach and the runtime on the left, stop or send at the right. */}
        <div className="flex items-center gap-2 border-t border-(--border-subtle) py-[7px] pr-[9px] pl-[10px]">
          {attach ? (
            <>
              <input ref={inputRef} type="file" hidden onChange={(e) => void pick(e.target.files?.[0])} />
              <button
                type="button"
                data-task-thread-attach=""
                className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
                aria-label={t('attachFile')}
                title={t('attachFile')}
                disabled={!canReply || preparing}
                onClick={() => inputRef.current?.click()}
              >
                <Icon name="paperclip" size={16} />
              </button>
            </>
          ) : hint ? (
            <span
              data-task-thread-hint=""
              className="min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
            >
              {hint}
            </span>
          ) : null}
          {runtime}
          <span className="flex-1" />
          {context}
          {/* As the conversation's composer: stop while the task runs and nothing is drafted, send otherwise. */}
          {onStop && !hasText && !hasAttachment ? (
            <SendButton stop label={stopLabel} disabled={stopping} onClick={onStop} />
          ) : (
            <SendButton label={sendLabel} disabled={!canSend} onClick={onSend} />
          )}
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
  turns,
  lastExchangeAt,
  children
}: {
  taskSessionId: string
  agentId: string
  scope: { listSessionId: string; enabled: boolean; conversationPermissions: boolean } | undefined
  turns: readonly Turn[]
  /** The latest person's message: a turn before it answered an earlier exchange. */
  lastExchangeAt: number
  children: ReactNode
}) {
  if (!scope) return <>{children}</>
  const anchors: ApprovalTurnAnchor[] = turns.flatMap((turn, i) =>
    turn.kind === 'bot'
      ? [
          {
            key: turn.key,
            ...(turn.agentId ? { agentId: turn.agentId } : {}),
            startMs: approvalTurnStart(turn.steps.map((step) => step.timeMs)),
            closed: i < lastExchangeAt
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
      turns={anchors}
    >
      {children}
    </TranscriptApprovalsProvider>
  )
}
