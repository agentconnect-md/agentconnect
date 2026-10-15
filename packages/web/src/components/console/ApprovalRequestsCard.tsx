'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  ApiError,
  decideAgentPermissionRequest,
  decideAssistantConversationProposal,
  decideSessionPermissionRequest,
  fetchAgentPermissionRequests,
  fetchAssistantConversationProposals,
  fetchSessionPermissionRequests,
  type AgentPermissionOptionDto,
  type AgentPermissionRequestDto,
  type AssistantConversationProposalDto
} from '@/lib/api'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useOptionalNotifications } from '@/lib/notifications'
import { approvalSourceKey } from '@/lib/approval-notifications'
import { Button, Icon } from '@/components/ui'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'

/** How a decision on a conversation's proposal ended here: its outcome, or why it was no longer waiting. */
interface SettledProposal {
  proposal: AssistantConversationProposalDto
  text: string
  tone: string
}

export function ApprovalRequestsCard({
  agentId,
  sessionId,
  pendingOnly = false,
  bare = false,
  className = '',
  permissions = true,
  conversationPermissions = false,
  proposals = false
}: {
  agentId: string
  sessionId?: string
  /** Composer strip mode: only unanswered requests, hidden entirely when none. */
  pendingOnly?: boolean
  /** Rows only, no card chrome / header / collapse — for embedding in a popover. */
  bare?: boolean
  className?: string
  /** The agent's permission requests, which only its editors may answer. */
  permissions?: boolean
  /** Read and decide them through the conversation instead, as its owner may where people in chat approve; needs `sessionId`. */
  conversationPermissions?: boolean
  /** Also this webchat conversation's proposals (assistant-mode.md §5.10), for whoever may continue it and editors; needs `sessionId`. */
  proposals?: boolean
}) {
  const t = useTranslations('Agents.detail.integrations')
  const ta = useTranslations('Agents.detail.activity')
  const { activeOrg, orgPath } = useOrgs()
  const notifications = useOptionalNotifications()
  const conversation = conversationPermissions ? sessionId : undefined
  const requestsKey =
    MOCK_MODE || !permissions
      ? null
      : conversation
        ? consoleKeys.sessionPermissionRequests(activeOrg?.id, conversation)
        : consoleKeys.agentPermissionRequests(activeOrg?.id, agentId)
  const {
    data: allRequests,
    error,
    isLoading,
    mutate
  } = useSWR<AgentPermissionRequestDto[]>(
    requestsKey,
    ([, , resource, id]) =>
      resource === 'session-permission-requests'
        ? fetchSessionPermissionRequests(id as string)
        : fetchAgentPermissionRequests(id as string),
    { refreshInterval: 3_000 }
  )
  // SWR stops polling an errored key: a refusal ends it, the console's retry resumes it after a failed read.
  const proposalsKey =
    MOCK_MODE || !proposals || !sessionId
      ? null
      : consoleKeys.assistantConversationProposals(activeOrg?.id, agentId, sessionId)
  const {
    data: proposalPage,
    isLoading: proposalsLoading,
    mutate: mutateProposals
  } = useSWR(
    proposalsKey,
    ([, , , id, conversation]) => fetchAssistantConversationProposals(id as string, conversation as string),
    { refreshInterval: 3_000 }
  )
  const [settledProposals, setSettledProposals] = useState<Record<string, SettledProposal>>({})
  // Decisions sent without an answer: still waiting they say so, gone they may have started.
  const [unconfirmed, setUnconfirmed] = useState<Record<string, AssistantConversationProposalDto>>({})
  const [busy, setBusy] = useState<string | null>(null)
  // Collapse follows what is listed, and a toggle overrides it only until the listed ids change: a count can repeat with new rows.
  const [collapseOverride, setCollapseOverride] = useState<{ key: string; collapsed: boolean } | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  // A conversation also answers what its background work asks (assistant-mode.md §5.6).
  const fromSubsession = (request: AgentPermissionRequestDto) =>
    sessionId !== undefined && request.parentSessionId === sessionId && request.sessionId !== sessionId
  const sessionRequests = sessionId
    ? allRequests?.filter((request) => request.sessionId === sessionId || fromSubsession(request))
    : allRequests
  const pendingRequests = sessionRequests?.filter((request) => request.status === 'pending') ?? []
  const listedProposals = proposalPage?.proposals ?? []
  const pendingProposals = listedProposals.filter((proposal) => !settledProposals[proposal.id])
  const listedIds = new Set(listedProposals.map((proposal) => proposal.id))
  // A proposal decided here keeps its row and what happened until dismissed; one sent unanswered and gone may have started.
  const settledRows: SettledProposal[] = [
    ...Object.values(settledProposals),
    ...Object.values(unconfirmed)
      .filter((proposal) => proposalPage !== undefined && !listedIds.has(proposal.id) && !settledProposals[proposal.id])
      .map((proposal) => ({
        proposal,
        text: ta('drafts.proposal.outcome.unconfirmedHere'),
        tone: 'text-(--status-paused)'
      }))
  ]
  const pendingCount = pendingRequests.length + pendingProposals.length
  const pendingKey = [...pendingRequests.map((request) => request.id), ...pendingProposals.map((p) => p.id)]
    .sort()
    .join('\n')
  // The composer strip shows what still needs an answer; answered history lives behind the header's Requests popover.
  const requests = pendingOnly ? sessionRequests && pendingRequests : sessionRequests

  if (pendingOnly && pendingCount === 0 && settledRows.length === 0) return null

  const decide = async (request: AgentPermissionRequestDto, decision: 'allow' | 'deny', optionId?: string) => {
    if (busy || request.status !== 'pending') return
    setBusy(`${request.id}:${optionId ?? decision}`)
    setDecisionError(null)
    try {
      if (conversation) await decideSessionPermissionRequest(conversation, request.id, decision, optionId)
      else await decideAgentPermissionRequest(agentId, request.id, decision, optionId)
      // A decision made here needs no bell item to say so (slack-approval-dm.md §7).
      if (request.sessionId) notifications?.markSourceRead(approvalSourceKey(request.sessionId))
      void mutate(
        (rows) =>
          rows?.map((row) =>
            row.id === request.id
              ? {
                  ...row,
                  status: decision === 'allow' ? ('allowed' as const) : ('denied' as const),
                  resolvedAt: new Date().toISOString()
                }
              : row
          ),
        { revalidate: false }
      )
    } catch {
      setDecisionError(t('requestUpdateError'))
      void mutate()
    } finally {
      setBusy(null)
    }
  }

  const settleProposal = (proposal: AssistantConversationProposalDto, text: string, tone: string) =>
    setSettledProposals((prev) => ({ ...prev, [proposal.id]: { proposal, text, tone } }))
  const dismissProposal = (id: string) => {
    setSettledProposals(({ [id]: _settled, ...rest }) => rest)
    setUnconfirmed(({ [id]: _sent, ...rest }) => rest)
  }
  // Activity's decision, bound to this conversation: the first answer from any surface wins. Returns a notice for a row still waiting.
  const decideProposal = async (
    proposal: AssistantConversationProposalDto,
    decision: 'approve' | 'deny'
  ): Promise<string | null> => {
    if (!sessionId) return null
    try {
      const { status, failure } = await decideAssistantConversationProposal(agentId, sessionId, proposal.id, decision)
      if (status === 'denied') settleProposal(proposal, ta('drafts.proposal.outcome.denied'), 'text-(--text-secondary)')
      else if (status === 'failed')
        settleProposal(
          proposal,
          ta('drafts.proposal.outcome.failed', { reason: failure ?? ta('drafts.outcome.unknownReason') }),
          'text-(--status-error)'
        )
      else settleProposal(proposal, ta('drafts.proposal.outcome.executingHere'), 'text-(--status-info)')
      void mutateProposals()
      return null
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined
      // The agent runs as much background work as it may: the proposal keeps waiting, and says why.
      if (code === 'SUBSESSION_LIMIT') return (err as ApiError).message
      if (code === 'DECISION_UNCONFIRMED') {
        setUnconfirmed((prev) => ({ ...prev, [proposal.id]: proposal }))
        void mutateProposals()
        return ta('drafts.outcome.unconfirmedWaiting')
      }
      const refused =
        code === 'DRAFT_EXPIRED'
          ? ta('drafts.proposal.outcome.expired')
          : code === 'DRAFT_ALREADY_DECIDED'
            ? ta('drafts.outcome.decided')
            : err instanceof ApiError && err.status === 404
              ? ta('drafts.outcome.gone')
              : null
      if (!refused) return ta('drafts.decideFailed')
      settleProposal(proposal, refused, 'text-(--text-secondary)')
      void mutateProposals()
      return null
    }
  }

  const collapseKey = [pendingKey, ...settledRows.map((row) => row.proposal.id)].join('\n')
  const collapsed =
    collapseOverride?.key === collapseKey ? collapseOverride.collapsed : pendingCount === 0 && settledRows.length === 0
  const permissionRows = requests?.length ?? 0
  const rowCount = permissionRows + pendingProposals.length + settledRows.length
  const loading = allRequests === undefined && proposalPage === undefined && (isLoading || proposalsLoading)

  const body = (
    <>
      {loading ? (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">{t('loadingRequests')}</div>
      ) : error && allRequests === undefined && rowCount === 0 ? (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">{t('unavailable')}</div>
      ) : rowCount ? (
        // Capped so a pile of requests can never push the composer off-screen.
        <div className="max-h-[34vh] overflow-y-auto">
          {requests?.map((request, index) => {
            const allowBusy = busy === `${request.id}:allow`
            const denyBusy = busy === `${request.id}:deny`
            return (
              <div
                key={request.id}
                className={`flex flex-col gap-2 px-3 py-2 desktop:flex-row desktop:items-center ${
                  index > 0 ? 'border-t border-(--border-subtle)' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                      {request.requesterName ?? request.requesterId ?? t('unknownUser')}
                    </span>
                    <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {formatApprovalTime(request.createdAt)}
                    </span>
                    {request.kind === 'join' ? (
                      <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('joinRequest')}</span>
                    ) : null}
                    {fromSubsession(request) && request.sessionId ? (
                      <Link
                        className="lnk font-sans text-[11px] font-medium leading-normal"
                        href={orgPath(`/sessions/${encodeURIComponent(request.sessionId)}`)}
                      >
                        {t('fromSubsession')}
                      </Link>
                    ) : null}
                    {request.status !== 'pending' && (
                      <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                        {request.status}
                        {request.resolvedByName ? ` · ${request.resolvedByName}` : ''}
                      </span>
                    )}
                  </div>
                  {/* A join confirmation is a question to a person, not a command, so it reads in the body face. */}
                  <div
                    className={`mt-[2px] line-clamp-2 break-words text-[11.5px] leading-[1.45] text-(--text-secondary) ${
                      request.kind === 'join' ? 'font-sans' : 'font-mono'
                    }`}
                    title={request.command}
                  >
                    {request.command}
                  </div>
                </div>
                {request.status === 'pending' && request.options?.length ? (
                  // One control per option the runtime offered, in its order, as the chat card does (#1969).
                  <div className="flex flex-wrap items-center gap-2 desktop:max-w-[60%] desktop:justify-end">
                    {request.options.map((option) => {
                      const decision = optionDecision(option)
                      return (
                        <Button
                          key={option.optionId}
                          variant={decision === 'allow' ? 'primary' : 'secondary'}
                          size="xs"
                          disabled={busy !== null}
                          onClick={() => void decide(request, decision, option.optionId)}
                        >
                          {busy === `${request.id}:${option.optionId}`
                            ? t(decision === 'allow' ? 'allowing' : 'denying')
                            : option.name}
                        </Button>
                      )
                    })}
                  </div>
                ) : request.status === 'pending' ? (
                  <div className="flex flex-none items-center gap-2">
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void decide(request, 'deny')}
                    >
                      {denyBusy ? t('denying') : t('deny')}
                    </Button>
                    <Button size="xs" disabled={busy !== null} onClick={() => void decide(request, 'allow')}>
                      {allowBusy ? t('allowing') : t('allow')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {pendingProposals.map((proposal, index) => (
            <ProposalRow
              key={proposal.id}
              proposal={proposal}
              first={permissionRows === 0 && index === 0}
              notice={unconfirmed[proposal.id] ? ta('drafts.outcome.unconfirmedWaiting') : null}
              onDecide={decideProposal}
            />
          ))}
          {settledRows.map((row, index) => (
            <SettledProposalRow
              key={row.proposal.id}
              settled={row}
              first={permissionRows === 0 && pendingProposals.length === 0 && index === 0}
              onDismiss={dismissProposal}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 py-3 font-sans text-[12px] text-(--text-tertiary)">{t('noRequests')}</div>
      )}
      {decisionError && (
        <div className="border-t border-(--border-subtle) px-3 py-2 font-sans text-[11.5px] text-(--red-600)">
          {decisionError}
        </div>
      )}
    </>
  )

  if (bare) return <div className={className}>{body}</div>

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Collapsed, the card is one header row whose pending count stays visible. */}
      <div
        className={`flex items-center justify-between px-3 py-[6px] ${collapsed ? '' : 'border-b border-(--border-subtle)'}`}
      >
        <button
          type="button"
          onClick={() => setCollapseOverride({ key: collapseKey, collapsed: !collapsed })}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 text-left"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} color="var(--text-tertiary)" />
          <span className="font-sans text-[12.5px] font-semibold leading-normal">
            {pendingOnly ? t('pendingRequests') : t('approvalRequests')}
          </span>
        </button>
        {pendingCount > 0 && (
          <span className="badge bg-(--amber-50) text-(--amber-600)">{t('pendingCount', { count: pendingCount })}</span>
        )}
      </div>
      {collapsed ? null : body}
    </div>
  )
}

/** A patrol's proposal waiting in this conversation: the sentence first, its reason and task folded, Activity's confirm before deciding. */
function ProposalRow({
  proposal,
  first,
  notice,
  onDecide
}: {
  proposal: AssistantConversationProposalDto
  first: boolean
  /** Why the last decision left it waiting. */
  notice: string | null
  onDecide: (proposal: AssistantConversationProposalDto, decision: 'approve' | 'deny') => Promise<string | null>
}) {
  const t = useTranslations('Agents.detail.activity')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<'approve' | 'deny' | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowNotice, setRowNotice] = useState<string | null>(null)
  const shown = rowNotice ?? notice

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true)
    setRowNotice(null)
    try {
      setRowNotice(await onDecide(proposal, decision))
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <div
      className={`px-3 py-2 ${first ? '' : 'border-t border-(--border-subtle)'}`}
      data-conversation-proposal={proposal.id}
    >
      <div className="flex flex-col gap-1 desktop:flex-row desktop:items-center desktop:gap-2">
        <span className="badge w-fit flex-none bg-(--status-info-soft) text-(--status-info)">
          {t('drafts.proposal.badge')}
        </span>
        <span className="min-w-0 break-words font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) desktop:flex-1">
          {proposal.sentence}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-[2px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:flex-row desktop:gap-3">
        {proposal.itemTitle ? <span>{t('drafts.proposal.item', { title: proposal.itemTitle })}</span> : null}
        <span>
          {t('drafts.expires', {
            time: format.dateTime(new Date(proposal.expiresAt), { dateStyle: 'medium', timeStyle: 'short' })
          })}
        </span>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mt-1 flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {t('drafts.proposal.details')}
      </button>
      {open ? (
        <div className="mt-1">
          {proposal.why ? (
            <div className="break-words font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
              {t('drafts.proposal.why', { why: proposal.why })}
            </div>
          ) : null}
          <div className="mt-1 max-h-[160px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-2 py-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-primary)">
            {proposal.task}
          </div>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmStrip
          prompt={confirming === 'deny' ? t('drafts.proposal.denyConfirm') : t('drafts.proposal.approveConfirmHere')}
          confirm={confirming === 'deny' ? t('drafts.proposal.deny') : t('drafts.approve')}
          keep={t('drafts.cancel')}
          busy={busy}
          tone={confirming === 'deny' ? 'danger' : 'primary'}
          onConfirm={() => void decide(confirming)}
          onKeep={() => setConfirming(null)}
        />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="xs" onClick={() => setConfirming('approve')}>
            {t('drafts.approve')}
          </Button>
          <Button variant="secondary" size="xs" onClick={() => setConfirming('deny')}>
            {t('drafts.proposal.deny')}
          </Button>
        </div>
      )}
      {shown ? (
        <div role="alert" className="mt-1 font-sans text-[11.5px] text-(--status-paused)">
          {shown}
        </div>
      ) : null}
    </div>
  )
}

/** A proposal decided here, or one no longer waiting: what happened, until dismissed. */
function SettledProposalRow({
  settled,
  first,
  onDismiss
}: {
  settled: SettledProposal
  first: boolean
  onDismiss: (id: string) => void
}) {
  const t = useTranslations('Agents.detail.activity')
  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 ${first ? '' : 'border-t border-(--border-subtle)'}`}
      data-conversation-proposal={settled.proposal.id}
    >
      <div className="min-w-0 flex-1">
        <div className="break-words font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
          {settled.proposal.sentence}
        </div>
        <div role="status" className={`mt-[2px] font-sans text-[11.5px] font-medium leading-normal ${settled.tone}`}>
          {settled.text}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(settled.proposal.id)}
        aria-label={t('drafts.proposal.dismiss')}
        title={t('drafts.proposal.dismiss')}
        className="flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

function optionDecision(option: AgentPermissionOptionDto): 'allow' | 'deny' {
  return option.kind === 'allow_once' || option.kind === 'allow_always' ? 'allow' : 'deny'
}

function formatApprovalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}
