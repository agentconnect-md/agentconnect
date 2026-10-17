'use client'

// An agent's Activity view (assistant-mode.md §1.7, §5.11, §5.12): what waits for the viewer, then its tasks and follow-ups, with finished ones behind one toggle.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  ApiError,
  decideAgentPermissionRequest,
  decideAssistantDraft,
  fetchAssistantDrafts,
  fetchAssistantSubsessions,
  memberDisplayName,
  type AgentPermissionOptionDto,
  type AssistantDraftDecision,
  type AssistantDraftDto,
  type AssistantDraftOutcomeDto,
  type AssistantPermissionRequestDto,
  type AssistantSubsessionDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { chatPlatformName, chatRoomSigil } from '@/lib/platform-labels'
import { consoleKeys } from '@/lib/swr-keys'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'
import { followUpOf, ProposedFollowUp } from '@/components/console/follow-up'
import {
  BackgroundTaskRow,
  DecisionButton,
  FinishedToggle,
  MetaLine,
  ParentPlace,
  PreviewLine,
  TaskGroup,
  TaskRow,
  taskFinished,
  useShortTime,
  useTaskStops
} from '@/components/console/task-list'

const REFRESH_MS = 30_000
/** How often "started 4m ago" redraws; arithmetic, no request. */
const TICK_MS = 30_000

type Translate = ReturnType<typeof useTranslations<'Agents.detail.activity'>>

/** How an answer to background work's permission request ended here; `gone` is one another surface answered first. */
type PermissionResult = 'allowed' | 'denied' | 'gone'

/** How a decision on a draft ended: its outcome, why the daemon refused it, sent without an answer, or a proposal left waiting at the background work limit. */
type DraftResult =
  | { outcome: AssistantDraftOutcomeDto }
  | { refused: 'expired' | 'decided' | 'gone' }
  | { unconfirmed: true }
  | { busy: string }

const DRAFT_REFUSALS: Record<string, 'expired' | 'decided'> = {
  DRAFT_EXPIRED: 'expired',
  DRAFT_ALREADY_DECIDED: 'decided'
}

/** Names a conversation from the agent's integrations; webchat and unknown rows fall back to the platform and id. */
function usePlaceLabel(
  agentId: string
): (place: { platform?: string; channel: string; integrationId?: string | null }) => string {
  const t = useTranslations('Agents.detail.activity')
  const { integrations } = useConsoleData()
  return ({ platform, channel, integrationId }) => {
    const own = integrations.filter((i) => (integrationId ? i.id === integrationId : i.platform === platform))
    const ranked = [...own.filter((i) => i.agentId === agentId), ...own.filter((i) => i.agentId !== agentId)]
    for (const integration of ranked) {
      const row = integration.channels.find((c) => c.channelId === channel)
      if (!row) continue
      if (row.kind === 'im') return t('dmWith', { name: row.name })
      return row.kind === 'mpim' ? row.name : `${chatRoomSigil(integration.platform)}${row.name}`
    }
    const known = platform ?? ranked[0]?.platform
    if (known === 'webchat') return t('webchat')
    return known ? `${chatPlatformName(known, known)} · ${channel}` : channel
  }
}

function errorText(t: Translate, error: unknown): string {
  return error instanceof ApiError && error.code === 'DAEMON_FEATURE_MISSING' ? t('upgradeDaemon') : t('unavailable')
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <div className="px-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">{children}</div>
  )
}

export function AssistantActivityPanel({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const t = useTranslations('Agents.detail.activity')
  const tl = useTranslations('Common.taskList')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const [showFinished, setShowFinished] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const subsessions = useSWR(
    consoleKeys.assistantSubsessions(orgId, agentId),
    ([, , , id]) => fetchAssistantSubsessions(id as string),
    { refreshInterval: REFRESH_MS, shouldRetryOnError: false }
  )
  const drafts = useSWR(
    canEdit ? consoleKeys.assistantDrafts(orgId, agentId) : null,
    ([, , , id]) => fetchAssistantDrafts(id as string),
    { refreshInterval: REFRESH_MS, shouldRetryOnError: false }
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const { mutate: rereadTasks } = subsessions
  const reread = useCallback(() => void rereadTasks(), [rereadTasks])
  const { stopOf, stop } = useTaskStops(agentId, agentId, reread)

  // A decided or unconfirmed draft keeps its row and what happened, even after a refresh stops listing it.
  const [decided, setDecided] = useState<Record<string, { draft: AssistantDraftDto; result: DraftResult }>>({})
  const pendingDrafts = drafts.data?.drafts ?? []
  const pendingIds = new Set(pendingDrafts.map((draft) => draft.id))
  const draftRows = [
    ...pendingDrafts,
    ...Object.values(decided)
      .map((entry) => entry.draft)
      .filter((draft) => !pendingIds.has(draft.id))
  ]
  // Background work's permission request answered here keeps its row and what happened, like a draft.
  const [answered, setAnswered] = useState<
    Record<string, { request: AssistantPermissionRequestDto; result: PermissionResult }>
  >({})
  const pendingPermissions = drafts.data?.permissionRequests ?? []
  const pendingPermissionIds = new Set(pendingPermissions.map((request) => request.requestId))
  const permissionRows = [
    ...pendingPermissions,
    ...Object.values(answered)
      .map((entry) => entry.request)
      .filter((request) => !pendingPermissionIds.has(request.requestId))
  ]

  const decidePermission = async (
    request: AssistantPermissionRequestDto,
    decision: 'allow' | 'deny',
    optionId?: string
  ) => {
    const settle = (result: PermissionResult) =>
      setAnswered((prev) => ({ ...prev, [request.requestId]: { request, result } }))
    try {
      await decideAgentPermissionRequest(agentId, request.requestId, decision, optionId)
      settle(decision === 'allow' ? 'allowed' : 'denied')
    } catch (err) {
      // Answered elsewhere first, or its background work ended: whichever surface answered first won.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        settle('gone')
        void drafts.mutate()
        return
      }
      throw err
    }
  }

  const decideDraft = async (draft: AssistantDraftDto, decision: AssistantDraftDecision) => {
    const settle = (result: DraftResult) => setDecided((prev) => ({ ...prev, [draft.id]: { draft, result } }))
    try {
      settle({ outcome: await decideAssistantDraft(agentId, draft.id, decision) })
    } catch (err) {
      const refused = err instanceof ApiError ? DRAFT_REFUSALS[err.code ?? ''] : undefined
      if (refused) return settle({ refused })
      // The agent runs as much background work as it may: the proposal keeps waiting, and says why.
      if (err instanceof ApiError && err.code === 'SUBSESSION_LIMIT') return settle({ busy: err.message })
      if (err instanceof ApiError && err.status === 404) return settle({ refused: 'gone' })
      if (err instanceof ApiError && err.code === 'DECISION_UNCONFIRMED') {
        // It may have posted without an answer: keep the row and its warning, and read the list again.
        settle({ unconfirmed: true })
        void drafts.mutate()
        return
      }
      throw err
    }
  }

  const pending = subsessions.data === undefined && subsessions.error === undefined
  const draftsPending = canEdit && drafts.data === undefined && drafts.error === undefined
  if (pending || draftsPending) {
    return (
      <div className="flex flex-col gap-4 p-4 desktop:p-0" data-assistant-activity>
        <Quiet>{t('loading')}</Quiet>
      </div>
    )
  }

  const errors = [
    subsessions.error && !subsessions.data ? errorText(t, subsessions.error) : null,
    canEdit && drafts.error && !drafts.data ? errorText(t, drafts.error) : null
  ].filter((text): text is string => text !== null)
  const rows = subsessions.data?.subsessions ?? []
  const finished = rows.filter(taskFinished).length
  const listed = [...rows.filter((row) => !taskFinished(row)), ...(showFinished ? rows.filter(taskFinished) : [])]
  const tasks = listed.filter((row) => followUpOf(row) === null)
  const followUps = listed.filter((row) => followUpOf(row) !== null)
  // Messages first, then proposals, then permission requests.
  const messages = draftRows.filter((draft) => draft.kind !== 'task')
  const proposals = draftRows.filter((draft) => draft.kind === 'task')
  const waiting = messages.length + proposals.length + permissionRows.length
  const nothing = waiting + tasks.length + followUps.length === 0 && errors.length === 0
  const truncated = drafts.data?.truncated === true || (showFinished && subsessions.data?.truncated === true)

  const drawTask = (row: AssistantSubsessionDto, i: number) => (
    <BackgroundTaskRow
      key={`${row.sessionId ?? 'hidden'}:${row.startedAt}:${i}`}
      row={row}
      now={now}
      stop={stopOf(row)}
      onStop={stop}
      withPlace
      dim={taskFinished(row)}
    />
  )
  const drawDraft = (draft: AssistantDraftDto) => (
    <DraftRow
      key={draft.id}
      agentId={agentId}
      draft={draft}
      result={decided[draft.id]?.result}
      pending={pendingIds.has(draft.id)}
      onDecide={decideDraft}
    />
  )

  return (
    <div className="flex flex-col gap-4 p-4 desktop:max-w-[880px] desktop:p-0" data-assistant-activity>
      {[...new Set(errors)].map((text) => (
        <Quiet key={text}>{text}</Quiet>
      ))}
      {waiting > 0 ? (
        <TaskGroup id="waiting" title={t('waiting')} count={waiting}>
          {messages.map(drawDraft)}
          {proposals.map(drawDraft)}
          {permissionRows.map((request) => (
            <PermissionRequestRow
              key={request.requestId}
              request={request}
              result={answered[request.requestId]?.result}
              onDecide={decidePermission}
            />
          ))}
        </TaskGroup>
      ) : null}
      {tasks.length > 0 ? (
        <TaskGroup id="tasks" title={tl('groups.tasks')} count={tasks.length}>
          {tasks.map(drawTask)}
        </TaskGroup>
      ) : null}
      {followUps.length > 0 ? (
        <TaskGroup id="follow-ups" title={tl('groups.followUps')} count={followUps.length}>
          {followUps.map(drawTask)}
        </TaskGroup>
      ) : null}
      {nothing ? <Quiet>{t('empty')}</Quiet> : null}
      {truncated ? <Quiet>{t('more')}</Quiet> : null}
      {finished > 0 ? (
        <FinishedToggle count={finished} open={showFinished} onToggle={() => setShowFinished((v) => !v)} />
      ) : null}
    </div>
  )
}

/** Background work waiting for permission (assistant-mode.md §5.6): which one, what it asks to run, and the same answers its card offers. */
function PermissionRequestRow({
  request,
  result,
  onDecide
}: {
  request: AssistantPermissionRequestDto
  result: PermissionResult | undefined
  onDecide: (request: AssistantPermissionRequestDto, decision: 'allow' | 'deny', optionId?: string) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const tl = useTranslations('Common.taskList')
  const shortTime = useShortTime()
  const { orgPath } = useOrgs()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { subsession, parent } = request
  const offered: { decision: 'allow' | 'deny'; label: string; optionId?: string }[] = request.options?.length
    ? request.options.map((option: AgentPermissionOptionDto) => ({
        decision: option.kind === 'allow_once' || option.kind === 'allow_always' ? 'allow' : 'deny',
        label: option.name,
        optionId: option.optionId
      }))
    : [
        { decision: 'allow', label: t('permissions.allow') },
        { decision: 'deny', label: t('permissions.deny') }
      ]
  // Denials first, so the primary answer sits at the right edge.
  const choices = [...offered.filter((c) => c.decision === 'deny'), ...offered.filter((c) => c.decision === 'allow')]

  const decide = async (choice: (typeof choices)[number]) => {
    setBusy(true)
    setFailure(false)
    try {
      await onDecide(request, choice.decision, choice.optionId)
    } catch {
      setFailure(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <TaskRow
      tone="waiting"
      attrs={{ 'data-assistant-permission': request.requestId }}
      title={
        subsession ? (
          <Link
            className="min-w-0 break-words text-inherit no-underline hover:underline"
            href={orgPath(`/sessions/${encodeURIComponent(subsession.sessionId)}`)}
          >
            {subsession.title ?? tl('untitled')}
          </Link>
        ) : (
          <span className="min-w-0 break-words font-normal text-(--text-tertiary)">{tl('hidden')}</span>
        )
      }
      meta={
        <MetaLine
          platform={parent?.platform}
          parts={[
            parent ? <ParentPlace parent={parent} /> : null,
            t('permissions.badge'),
            tl('expires', { time: shortTime(request.expiresAt) })
          ]}
        />
      }
      preview={<PreviewLine text={request.tool} mono expanded={expanded} onToggle={() => setExpanded((v) => !v)} />}
      actions={
        result ? null : (
          <div className="flex flex-wrap justify-end gap-2" data-assistant-permission-actions>
            {choices.map((choice) => (
              <DecisionButton
                key={choice.optionId ?? choice.decision}
                label={choice.label}
                primary={choice.decision === 'allow'}
                disabled={busy}
                onClick={() => void decide(choice)}
              />
            ))}
          </div>
        )
      }
      after={
        <>
          {result ? (
            <div
              role="status"
              className={`mt-1 font-sans text-[12.5px] font-medium leading-normal ${
                result === 'allowed' ? 'text-(--status-online-text)' : 'text-(--text-secondary)'
              }`}
            >
              {t(`permissions.outcome.${result}`)}
            </div>
          ) : null}
          {failure && !result ? (
            <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
              {t('permissions.decideFailed')}
            </div>
          ) : null}
        </>
      }
    />
  )
}

function DraftRow({
  agentId,
  draft,
  result,
  pending,
  onDecide
}: {
  agentId: string
  draft: AssistantDraftDto
  result: DraftResult | undefined
  /** The latest read still lists it as waiting for approval. */
  pending: boolean
  onDecide: (draft: AssistantDraftDto, decision: AssistantDraftDecision) => Promise<void>
}) {
  const t = useTranslations('Agents.detail.activity')
  const tl = useTranslations('Common.taskList')
  const tf = useTranslations('Common.followUp')
  const shortTime = useShortTime()
  const { members } = useConsoleData()
  const placeLabel = usePlaceLabel(agentId)
  const [confirming, setConfirming] = useState<AssistantDraftDecision | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const target = draft.target.name
    ? draft.target.dm
      ? t('dmWith', { name: draft.target.name })
      : `${chatRoomSigil(draft.target.platform)}${draft.target.name}`
    : placeLabel(draft.target)
  // A proposal runs its task in the item's conversation once approved.
  const proposal = draft.kind === 'task' ? draft.proposal : undefined
  const approver = draft.approver
  const member = approver?.consoleUserId ? members.find((m) => m.userId === approver.consoleUserId) : undefined
  const approves = draft.inConversation
    ? t('drafts.inConversationApproves')
    : !approver
      ? t('drafts.noApprover')
      : t('drafts.approves', {
          name:
            approver.kind === 'conversation'
              ? placeLabel(approver)
              : (approver.name ?? (member ? memberDisplayName(member) : (approver.userId ?? t('drafts.someone'))))
        })
  // An unconfirmed decision may be tried again only while the draft is still listed as waiting; a proposal left waiting may be approved again.
  const canDecide = !result || ('unconfirmed' in result && pending) || 'busy' in result
  const expires = tl('expires', { time: shortTime(draft.expiresAt) })

  const decide = async (decision: AssistantDraftDecision) => {
    setBusy(true)
    setFailure(null)
    try {
      await onDecide(draft, decision)
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.code === 'DAEMON_FEATURE_MISSING'
          ? t('drafts.upgradeDaemon')
          : t('drafts.decideFailed')
      )
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  // The collapsed line: a message's text, a proposal's reason, else what it would take or run.
  const previewText = proposal
    ? proposal.why || (proposal.followUp ? tf('doneWhen', { text: proposal.followUp.doneWhen }) : draft.text)
    : draft.text
  const details = proposal ? (
    <>
      {proposal.itemTitle ? (
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('drafts.proposal.item', { title: proposal.itemTitle })}
        </span>
      ) : null}
      {proposal.followUp ? (
        <ProposedFollowUp followUp={proposal.followUp} compact />
      ) : proposal.why ? (
        <div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
          {draft.text}
        </div>
      ) : null}
    </>
  ) : null

  return (
    <TaskRow
      tone="waiting"
      attrs={{ 'data-assistant-draft': draft.id }}
      title={
        proposal ? (
          <span className="min-w-0 break-words">{proposal.sentence}</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-[2px]">
            <span className="min-w-0 break-words">
              {t('drafts.to', { target })}
              {draft.target.thread ? (
                <span className="font-normal text-(--text-tertiary)"> · {t('drafts.inThread')}</span>
              ) : null}
            </span>
            {draft.target.external ? (
              <span className="flex-none rounded-xs border border-(--border-default) px-[5px] font-sans text-[11px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('drafts.external')}
              </span>
            ) : null}
          </span>
        )
      }
      meta={
        <MetaLine
          platform={draft.target.platform}
          parts={
            proposal
              ? [target, proposal.followUp ? t('drafts.proposal.kindFollowUp') : t('drafts.proposal.kindTask'), expires]
              : // The title already names where it goes, so the place is the mark alone.
                [t('drafts.kind'), approves, expires]
          }
        />
      }
      preview={
        <PreviewLine text={previewText} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
          {details}
        </PreviewLine>
      }
      actions={
        canDecide && !confirming ? (
          <div className="flex gap-2" data-assistant-draft-actions>
            <DecisionButton
              label={proposal ? t('drafts.proposal.deny') : t('drafts.discard')}
              primary={false}
              onClick={() => setConfirming('discard')}
            />
            <DecisionButton label={t('drafts.approve')} primary onClick={() => setConfirming('approve')} />
          </div>
        ) : null
      }
      after={
        <>
          {result ? (
            <DraftOutcome
              result={result}
              pending={pending}
              proposalPlace={proposal ? target : undefined}
              followUpForm={proposal?.followUp !== undefined}
            />
          ) : null}
          {canDecide && confirming ? (
            <ConfirmStrip
              prompt={
                proposal
                  ? confirming === 'discard'
                    ? t('drafts.proposal.denyConfirm')
                    : proposal.followUp
                      ? t('drafts.proposal.takeConfirm', { place: target })
                      : t('drafts.proposal.approveConfirm', { place: target })
                  : confirming === 'discard'
                    ? t('drafts.discardConfirm')
                    : t('drafts.approveConfirm', { target })
              }
              confirm={
                confirming !== 'discard'
                  ? t('drafts.approve')
                  : proposal
                    ? t('drafts.proposal.deny')
                    : t('drafts.discard')
              }
              keep={t('drafts.cancel')}
              busy={busy}
              tone={confirming === 'discard' ? 'danger' : 'primary'}
              onConfirm={() => void decide(confirming)}
              onKeep={() => setConfirming(null)}
            />
          ) : null}
          {failure && canDecide ? (
            <div role="alert" className="mt-1 font-sans text-[12px] text-(--status-error)">
              {failure}
            </div>
          ) : null}
        </>
      }
    />
  )
}

const OUTCOME_CLASS: Record<AssistantDraftOutcomeDto['status'], string> = {
  executing: 'text-(--status-info)',
  succeeded: 'text-(--status-online-text)',
  denied: 'text-(--text-secondary)',
  failed: 'text-(--status-error)',
  outcome_unknown: 'text-(--status-paused)'
}

/** What a decision did, in place of the draft's buttons; a proposal's names the conversation it runs in, and a follow-up form's links to the conversation of the follow-up it took. */
function DraftOutcome({
  result,
  pending,
  proposalPlace,
  followUpForm = false
}: {
  result: DraftResult
  pending: boolean
  proposalPlace?: string | undefined
  followUpForm?: boolean
}) {
  const t = useTranslations('Agents.detail.activity')
  const { orgPath } = useOrgs()
  let text: string
  let tone = 'text-(--text-secondary)'
  // The follow-up a follow-up form took has no page before its first check; its conversation lists it under Tasks.
  const taken = 'outcome' in result ? result.outcome.followUp?.conversation : undefined
  if ('busy' in result) {
    tone = 'text-(--status-paused)'
    text = result.busy
  } else if ('unconfirmed' in result) {
    tone = 'text-(--status-paused)'
    text = pending
      ? t('drafts.outcome.unconfirmedWaiting')
      : proposalPlace !== undefined
        ? t('drafts.proposal.outcome.unconfirmedGone', { place: proposalPlace })
        : t('drafts.outcome.unconfirmedGone')
  } else if ('refused' in result) {
    text =
      proposalPlace !== undefined && result.refused === 'expired'
        ? t('drafts.proposal.outcome.expired')
        : t(`drafts.outcome.${result.refused}`)
  } else if (proposalPlace !== undefined && followUpForm) {
    const { status, failure } = result.outcome
    tone = OUTCOME_CLASS[status]
    text =
      status === 'failed'
        ? t('drafts.proposal.outcome.notTaken', { reason: failure ?? t('drafts.outcome.unknownReason') })
        : status === 'denied'
          ? t('drafts.proposal.outcome.deniedFollowUp')
          : t('drafts.proposal.outcome.taken', { place: proposalPlace })
  } else if (proposalPlace !== undefined) {
    const { status, failure } = result.outcome
    tone = OUTCOME_CLASS[status]
    text =
      status === 'failed'
        ? t('drafts.proposal.outcome.failed', { reason: failure ?? t('drafts.outcome.unknownReason') })
        : t(`drafts.proposal.outcome.${status}`, { place: proposalPlace })
  } else {
    const { status, failure } = result.outcome
    tone = OUTCOME_CLASS[status]
    text =
      status === 'failed'
        ? t('drafts.outcome.failed', { reason: failure ?? t('drafts.outcome.unknownReason') })
        : // A post is never left running by its decision; read it as still settling.
          status === 'executing'
          ? t('drafts.outcome.unconfirmedWaiting')
          : t(`drafts.outcome.${status}`)
  }
  return (
    <div
      role="status"
      className={`mt-2 rounded-md bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-medium leading-normal ${tone}`}
      data-assistant-draft-outcome
    >
      {text}
      {taken ? (
        <>
          {' '}
          <Link className="lnk" href={orgPath(`/sessions/${encodeURIComponent(taken.sessionId)}`)}>
            {t('drafts.proposal.outcome.seeFollowUp')}
          </Link>
        </>
      ) : null}
    </div>
  )
}
