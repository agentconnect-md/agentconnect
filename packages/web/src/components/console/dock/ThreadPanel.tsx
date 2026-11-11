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
import { buildTurns, turnTimeMs, type Turn } from '@/components/console/session-turns'
import { turnTimeLabel } from '@/lib/transcript-time'
import { BotTurnView, UserTurnView } from '@/components/console/TurnViews'
import type { TaskLink } from '@/components/console/task-link'
import { fetchSessionDetail, type SessionThreadSummaryDto } from '@/lib/api'
import {
  AttachmentCards,
  FileDropOverlay,
  INLINE_IMAGE_KEY,
  composerCards,
  stageComposerFiles,
  useFileDrop
} from '@/components/console/ComposerFiles'
import { clipboardFiles, prepareWebchatImage } from '@/lib/webchat-image'
import { RunningCommandsDock } from '@/components/console/RunningCommandsDock'
import { ContextWindowIndicator } from '@/components/console/ContextWindowIndicator'
import { agentToneColor } from '@/lib/agent-tone'
import {
  MOCK_MODE,
  platName,
  type Agent,
  type DaemonRow,
  type ElicitAnswerValue,
  type FillCardAnswer
} from '@/lib/data'
import { threadShapeOf } from '@/components/console/coordinator-threads'
import { TaskRuntimePicker } from '@/components/console/dock/TaskRuntimePicker'
import { sessionAttributionAgentAuthors, sessionAttributionAgentId } from '@/lib/session-trigger'
import type { SenderPeople } from '@/components/console/sender-people'
import { CONSOLE_SWR_CONFIG, readOnceRegistered } from '@/lib/console-swr'
import type { AgentIcon } from '@/lib/agent-icon'
import { useOrgs } from '@/lib/org-context'
import { SessionShareButton, SessionShareDialogFor } from '@/components/console/SessionShare'
import { messageLink, useLocateMessage } from '@/lib/message-link'
import { approvalNotice, raisedIn, WebchatMcpApprovalCard } from '@/components/console/WebchatMcpApprovalCard'

const HEADER_BTN =
  'flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) focus-visible:outline-none'

const EMPTY: readonly never[] = []
const NO_AGENTS: ReadonlyMap<string, Agent> = new Map()
// A thread's rows come from one session, so no row names another source.
/** The panel follows no bottom, so a jump has nothing to let go of. */
const noRelease = () => {}
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
  people,
  fileTransfer = false,
  writer,
  focusComposer = false,
  onSummary,
  fromMain = EMPTY,
  onShowInConversation,
  threadUrl,
  attachments = true
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
  /** Who each sender is to the reader, as the session page reads them; absent knows only this visit's own sends. */
  people?: SenderPeople
  /** Whether the daemon continuing this conversation accepts thread attachments. */
  attachments?: boolean
  /** The socket a message in this record's thread goes out on: the owner's coordinator conversation, or a continued platform coordinator (`continues` its session); absent for another member, who writes through the holding task. */
  writer?: { sessionId: string; conversationId?: string; continues?: string }
  /** Focus the composer when it first shows, as Reply in thread asks. */
  focusComposer?: boolean
  /** Told each footer the record's reads return, so the timeline's footer keeps up with an open thread. */
  onSummary?: (summary: SessionThreadSummaryDto) => void
  /** The coordinator's turns in this thread from the main timeline: its tool calls on the root, drawn above the replies. */
  fromMain?: readonly Turn[]
  /** Scrolls the conversation's main timeline to a message by its transcript seq, as a redirected message's label does. */
  onShowInConversation?: (seq: number) => void
  /** The thread's page on its platform, which the header links. */
  threadUrl?: string
}) {
  const t = useTranslations('Common.taskThread')
  const tl = useTranslations('Common.taskList')
  const { orgPath } = useOrgs()
  const {
    getLiveSteps,
    getPgInput,
    getPgFiles,
    getPgImage,
    setPgFiles,
    setPgImage,
    getPgTurnThread,
    isPgBusy,
    markSessionTarget,
    pgSend,
    pgSendThread,
    pgNotice,
    setPgInput,
    reconcileLiveSteps,
    pgAnswerElicitation,
    pgAnswerFill,
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
  // A webchat task takes the thread a message is written in; a platform's task its own, mirrored into the platform thread.
  const shape = threadShapeOf(platform)
  const inThread = !!record && fromRecord && shape?.continuesInThread === true
  const mirrored = fromRecord && !!shape && !shape.continuesInThread
  // The writer writes in any thread, and routing takes it to the task or the coordinator; a platform's held thread continues its task instead.
  const ownThread =
    writer && record && fromRecord && !unreadable && !thread.missing && !(mirrored && holderId)
      ? { ...writer, rootId: record.rootId }
      : null
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
    isSelf: (sender) => sender === '@you' || people?.isSelf(sender) === true,
    senderLabel: (sender, fallback) => people?.label(sender, fallback ?? t('person')) ?? fallback ?? t('person'),
    ownsDecisionSeq: () => false,
    viewer: people?.viewer ?? {},
    pictureOf: (sender) => people?.pictureOf(sender),
    sourceLabel: platName(platform)
  }).turns
  // Another agent's post reads as that agent, so its "sent by" line goes.
  const turns: Turn[] = built.map((turn) =>
    turn.kind === 'bot' && turn.agentId && turn.agentId !== agentId
      ? { ...turn, steps: turn.steps.map((step) => ({ ...step, text: withoutAttribution(step.text) })) }
      : turn
  )
  const [workOverride, setWorkOverride] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // The webchat conversation the task's questions wait in: the one its coordinator's conversation and its tasks share.
  const taskConversation = detail?.channel ?? undefined
  // The root leads the thread; the coordinator's work on it from the main timeline sits under it, ahead of the replies.
  const earlierUnread = fromRecord ? thread.hasEarlier : Boolean(session.page?.nextCursor)
  const threadRoot = turns[0]?.kind === 'user' && !earlierUnread ? turns.slice(0, 1) : []
  const threadReplies = turns.slice(threadRoot.length)
  // A message's link: the holding task's own page, else this thread's address on the conversation, each with the message's anchor.
  const [messageShare, setMessageShare] = useState<string | null>(null)
  const shareSessionId = holderId ?? record?.sessionId
  // A link to a message of this thread lands on it, reading the thread's earlier messages back to it.
  useLocateMessage(
    'thread',
    noRelease,
    fromRecord ? { has: thread.hasEarlier, loading: thread.loadingEarlier, load: thread.loadEarlier } : undefined
  )
  const shareMessage = (turn: Turn): (() => void) | undefined => {
    const seq = turn.rowSeq
    if (seq === undefined || !shareSessionId) return undefined
    const base = holderId
      ? orgPath(`/sessions/${encodeURIComponent(holderId)}`)
      : `${window.location.pathname}?${new URLSearchParams({ thread: record!.rootId })}`
    return () => setMessageShare(messageLink(base, seq))
  }
  const renderTurn = (turn: Turn, i: number, list: readonly Turn[], sid: string | undefined) => (
    // The session page's turn: its time line, then the person's bubble or the agent's block.
    <div
      key={turn.key}
      data-thread-message={turn.kind === 'user' ? 'person' : 'agent'}
      {...(turn.kind === 'bot' && turn.agentId && turn.agentId !== agentId
        ? { 'data-thread-agent': turn.agentId }
        : {})}
      {...(turn.rowSeq !== undefined ? { 'data-msg-seq': turn.rowSeq } : {})}
      className="-mx-2 flex min-w-0 flex-col gap-[5px] rounded-lg px-2 transition-colors data-[message-located]:bg-(--amber-50)"
    >
      {turn.time ? (
        <div className="mono text-center text-[11px] leading-normal text-(--text-tertiary)">
          {turnTimeLabel(turn.time, turnTimeMs(turn))}
        </div>
      ) : null}
      {turn.kind === 'user' && turn.handedTo ? (
        // A message the coordinator redirected here from the conversation, marked across the panel as Slack marks one sent to two places.
        <div data-thread-redirected="" className="-mx-4 flex flex-col gap-[5px] bg-(--amber-50) px-4 py-[8px]">
          {/* Opens the message where it was said, on the conversation's main timeline. */}
          <button
            type="button"
            data-thread-redirected-from=""
            disabled={!onShowInConversation || turn.rowSeq === undefined}
            onClick={() => turn.rowSeq !== undefined && onShowInConversation?.(turn.rowSeq)}
            className="flex w-fit cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) enabled:hover:underline disabled:cursor-default"
          >
            <Icon name="corner-up-right" size={12} color="var(--amber-500)" className="flex-none" />
            {t('redirectedFromCoordinator')}
          </button>
          <UserTurnView turn={turn} onShare={shareMessage(turn)} />
        </div>
      ) : turn.kind === 'user' ? (
        <UserTurnView turn={turn} onShare={shareMessage(turn)} />
      ) : (
        <BotTurnView
          turn={turn}
          agentById={agents}
          owner={agents.get(agentId)}
          ownerRuntime={agentRuntime ?? ''}
          sessionId={sid}
          streaming={busy && list === turns && i === turns.length - 1}
          workOpen={workPanelOpen(workOverride.get(turn.key))}
          onToggleWork={() =>
            setWorkOverride((prev) => toggleWorkPanel(prev, turn.key, workPanelOpen(prev.get(turn.key))))
          }
          promptMs={exchangePromptMs(list, i)}
          answerElicitation={answerElicitation}
          answerFill={answerFill}
          onShare={shareMessage(turn)}
        />
      )}
    </div>
  )

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
    const staged = getPgFiles(draftId)
    if (staged.some((file) => file.status !== 'ready')) return
    const image = getPgImage(draftId)
    const files = staged.flatMap((file) => (file.attachment ? [file.attachment] : []))
    const clear = () => {
      setPgInput(draftId, '')
      setPgImage(draftId)
      setPgFiles(draftId, () => [])
    }
    if (ownThread) {
      // A continued coordinator's socket mints for its session, and its page draws the thread the message goes in.
      if (ownThread.continues) markSessionTarget(ownThread.sessionId, ownThread.continues, true)
      if (
        pgSendThread(
          ownThread.sessionId,
          agentId,
          getPgInput(draftId),
          ownThread.rootId,
          ownThread.conversationId,
          image,
          files
        )
      )
        clear()
      return
    }
    if (!canReply || !holderId) return
    markSessionTarget(holderId)
    // Read from the record, the message is written in this thread of the task, which may hold several.
    if (record && inThread) {
      if (pgSendThread(holderId, agentId, getPgInput(holderId), record.rootId, undefined, image, files)) clear()
      return
    }
    pgSend(holderId, agentId)
  }

  const title = row?.title ?? task?.title ?? summary?.task?.title ?? t('thread')
  const tone = row ? taskTone(row, null) : null
  const pageHref = holderId ? orgPath(`/sessions/${encodeURIComponent(holderId)}`) : null
  // A question in the thread is the task's, answered on the conversation's own socket, as its page does: a continuation socket the composer targets has a conversation of its own, where no question waits.
  const answerElicitation = holderId
    ? (turnAgent: string | undefined, requestId: string | undefined, value: ElicitAnswerValue): void => {
        if (!requestId) return
        pgAnswerElicitation(parentSessionId ?? holderId, turnAgent ?? agentId, requestId, value, taskConversation)
      }
    : undefined
  // A Fill card in the thread is the task's, answered like its questions: on the conversation's own socket and channel.
  const answerFill = holderId
    ? (turnAgent: string | undefined, requestId: string, answer: FillCardAnswer) =>
        pgAnswerFill(parentSessionId ?? holderId, turnAgent ?? agentId, requestId, answer, taskConversation)
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
      {shareSessionId ? (
        <SessionShareDialogFor
          key={shareSessionId}
          open={messageShare !== null}
          sessionId={shareSessionId}
          fallbackTitle={title}
          link={messageShare ?? undefined}
          onClose={() => setMessageShare(null)}
        />
      ) : null}
      {/* Takes the tab strip's place, so on desktop it is the session header's 52px and its divider continues that line. */}
      <div className="flex h-[43px] min-w-0 flex-none items-center gap-[6px] border-b border-(--border-subtle) pr-2 pl-[10px] desktop:h-[52px]">
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
        {holderId ? (
          <SessionShareButton
            sessionId={holderId}
            title={title}
            className={HEADER_BTN}
            iconSize={14}
            data-task-thread-share=""
          />
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
            {...(summary?.task?.starting ? { 'data-thread-starting': '' } : { 'data-thread-unreadable': '' })}
            className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)"
          >
            {summary?.task?.starting ? t('starting') : t('unreadable')}
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
          {/* The root, then the coordinator's work on it from the main timeline, a divider, and the thread's replies below. */}
          {threadRoot.map((turn, i) => renderTurn(turn, i, turns, holderId ?? record?.sessionId))}
          {fromMain.map((turn, i) => renderTurn(turn, i, fromMain, record?.sessionId))}
          {(threadRoot.length > 0 || fromMain.length > 0) && threadReplies.length > 0 ? (
            <div
              data-thread-replies-divider=""
              role="separator"
              className="flex items-center gap-3 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) before:h-px before:flex-1 before:bg-(--border-subtle) after:h-px after:flex-1 after:bg-(--border-subtle)"
            >
              {t('repliesDivider')}
            </div>
          ) : null}
          {threadReplies.map((turn, i) =>
            renderTurn(turn, i + threadRoot.length, turns, holderId ?? record?.sessionId)
          )}
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
          {...(attachments ? { attach: { agentId, transfer: mirrored ? false : fileTransfer } } : {})}
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
  const uploading = files.some((file) => file.status !== 'ready')
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  // After the dock's own reveal, which focuses an overlay panel as it opens.
  useEffect(() => {
    if (!autoFocus || !canReply) return
    const timer = window.setTimeout(() => boxRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [autoFocus, canReply])
  // Uploaded originals and their previews travel together; older conversations keep inline image input.
  const pick = async (selected: File[]) => {
    if (inputRef.current) inputRef.current.value = ''
    if (!attach || !selected.length || preparing) return
    setAttachError(null)
    if (attach.transfer) {
      if (image) {
        setAttachError('Remove the inline image before adding uploaded files.')
        return
      }
      stageComposerFiles(
        {
          sessionId,
          agentId: attach.agentId,
          transfer: attach.transfer,
          getPgFiles,
          setPgFiles,
          onError: setAttachError
        },
        selected
      )
      return
    }
    const file = selected[0]!
    if (selected.length !== 1 || !file.type.startsWith('image/')) {
      setAttachError(
        'This conversation accepts one image attachment. Documents and multiple attachments aren’t supported here.'
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
  const fileDrop = useFileDrop((selected) => void pick(selected))
  // No reply box where this reader may not continue the task; its background commands still show.
  if (!canReply && !checking) return dock ? <div className="flex-none px-3 pb-3 empty:hidden">{dock}</div> : null
  const canSend = canReply && (hasText || hasAttachment) && !uploading && !preparing
  const dropEnabled = !!attach && canReply
  return (
    // On desktop the bottom inset is the conversation composer's (`.content`'s 26px + its footer's 4px), so the two boxes line up.
    <div
      {...(dropEnabled ? fileDrop.handlers : {})}
      className="relative flex-none px-3 pt-[10px] pb-3 desktop:pb-[30px]"
    >
      {dropEnabled && fileDrop.over ? <FileDropOverlay /> : null}
      {dock}
      <div className="flex flex-col rounded-[11px] border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xs) transition-[border-color,box-shadow] focus-within:border-(--border-strong) focus-within:shadow-(--focus-shadow)">
        {attach ? (
          <AttachmentCards
            className="px-[15px] pt-3"
            cards={composerCards(files, image)}
            onRemove={(key) =>
              key === INLINE_IMAGE_KEY
                ? setPgImage(sessionId)
                : setPgFiles(sessionId, (staged) => staged.filter((file) => file.key !== key))
            }
          />
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
          onPaste={(event) => {
            const selected = clipboardFiles(event.clipboardData)
            if (!attach || !selected.length) return
            event.preventDefault()
            void pick(selected)
          }}
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
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => void pick(Array.from(e.target.files ?? []))}
              />
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
