'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import type { AgentPermissionRequestDto } from '@/lib/api'
import { Button, Icon } from '@/components/ui'
import { optionDecision, usePermissionDecision, usePermissionRequests } from '@/components/console/ApprovalRequestsCard'
import {
  approvalAnswerPlace,
  approvalCommandText,
  isTranscriptApproval,
  placeTranscriptApprovals,
  type ApprovalTurnAnchor
} from '@/components/console/approval-placement'

type Decide = ReturnType<typeof usePermissionDecision>

interface TranscriptApprovalsValue extends Decide {
  byTurn: Map<string, AgentPermissionRequestDto[]>
  /** Waiting requests of this session no turn can hold yet; drawn at the end so none is lost. */
  unplaced: AgentPermissionRequestDto[]
}

const TranscriptApprovalsContext = createContext<TranscriptApprovalsValue | null>(null)

/** Reads the conversation's permission requests once for its transcript, on the strip's own poll, and places each at the turn that asked it. */
export function TranscriptApprovalsProvider({
  agentId,
  sessionId,
  listSessionId,
  enabled,
  conversationPermissions,
  turns,
  children
}: {
  agentId: string
  /** The session whose requests are placed here. */
  sessionId: string
  /** The conversation the requests are read through when that is another one (a task's coordinator); defaults to `sessionId`. */
  listSessionId?: string
  /** The viewer may read and answer the conversation's requests: the strip's own permission rules. */
  enabled: boolean
  conversationPermissions: boolean
  turns: readonly ApprovalTurnAnchor[]
  children: ReactNode
}) {
  const { data, mutate, conversation } = usePermissionRequests({
    agentId,
    sessionId: listSessionId ?? sessionId,
    permissions: enabled,
    conversationPermissions
  })
  const decision = usePermissionDecision(agentId, conversation, mutate)
  const byTurn = enabled && data ? placeTranscriptApprovals(turns, data, sessionId) : null
  const placed = new Set([...(byTurn?.values() ?? [])].flat().map((request) => request.id))
  const unplaced =
    data?.filter(
      (request) => isTranscriptApproval(request, sessionId) && request.status === 'pending' && !placed.has(request.id)
    ) ?? []
  const value = byTurn ? { byTurn, unplaced, ...decision } : null
  return <TranscriptApprovalsContext.Provider value={value}>{children}</TranscriptApprovalsContext.Provider>
}

/** Waiting requests no turn on screen holds yet, answered at the end of the stream rather than lost. */
export function UnplacedApprovals() {
  const ctx = useContext(TranscriptApprovalsContext)
  if (!ctx || ctx.unplaced.length === 0) return null
  return (
    <div data-unplaced-approvals="" className="flex min-w-0 flex-col gap-2">
      {ctx.unplaced.map((request) => (
        <PendingApproval
          key={request.id}
          request={request}
          busy={ctx.busy}
          error={ctx.decisionError?.requestId === request.id ? ctx.decisionError.message : null}
          onDecide={(decision, optionId) => void ctx.decide(request, decision, optionId)}
        />
      ))}
    </div>
  )
}

/** The tool-call approvals one agent turn asked: a waiting one as a card to answer, a settled one as a quiet line. */
export function TurnApprovals({ turnKey, asked }: { turnKey: string; asked?: ReadonlySet<string> }) {
  const ctx = useContext(TranscriptApprovalsContext)
  // A waiting request the turn already draws as its own confirmation card is answered there.
  const requests = ctx?.byTurn
    .get(turnKey)
    ?.filter((request) => request.status !== 'pending' || !asked?.has(request.id))
  if (!ctx || !requests?.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {requests.map((request) =>
        request.status === 'pending' ? (
          <PendingApproval
            key={request.id}
            request={request}
            busy={ctx.busy}
            error={ctx.decisionError?.requestId === request.id ? ctx.decisionError.message : null}
            onDecide={(decision, optionId) => void ctx.decide(request, decision, optionId)}
          />
        ) : (
          <SettledApproval key={request.id} request={request} />
        )
      )}
    </div>
  )
}

function PendingApproval({
  request,
  busy,
  error,
  onDecide
}: {
  request: AgentPermissionRequestDto
  busy: string | null
  error: string | null
  onDecide: (decision: 'allow' | 'deny', optionId?: string) => void
}) {
  const t = useTranslations('Sessions.detail')
  const ti = useTranslations('Agents.detail.integrations')
  return (
    <div
      data-turn-approval={request.id}
      className="flex min-w-0 flex-col gap-2 rounded-r-[10px] border-l-2 border-(--amber-500) bg-gradient-to-r from-(--status-paused-soft) to-transparent to-70% px-[14px] py-3"
    >
      <div className="flex min-w-0 items-start gap-2 font-sans text-[14px] font-normal leading-[1.5] text-(--text-secondary)">
        <Icon name="shield-alert" size={16} color="var(--amber-500)" className="mt-[2px] flex-none" />
        <span className="min-w-0 break-words">
          <span className="font-medium text-(--text-primary)">{t('approvalNeeded')}</span>{' '}
          <code className="break-all rounded-xs bg-(--surface-sunken) px-1 font-mono text-[12.5px]">
            {approvalCommandText(request.command)}
          </code>
        </span>
      </div>
      {/* One control per option the runtime offered, in its order, as the chat card does (#1969). */}
      <div className="flex flex-wrap items-center gap-2 pl-6">
        {request.options?.length ? (
          request.options.map((option) => {
            const decision = optionDecision(option)
            return (
              <Button
                key={option.optionId}
                variant={option.kind === 'allow_once' ? 'primary' : 'secondary'}
                size="sm"
                disabled={busy !== null}
                onClick={() => onDecide(decision, option.optionId)}
              >
                {busy === `${request.id}:${option.optionId}`
                  ? ti(decision === 'allow' ? 'allowing' : 'denying')
                  : option.name}
              </Button>
            )
          })
        ) : (
          <>
            <Button size="sm" disabled={busy !== null} onClick={() => onDecide('allow')}>
              {busy === `${request.id}:allow` ? ti('allowing') : ti('allow')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => onDecide('deny')}>
              {busy === `${request.id}:deny` ? ti('denying') : ti('deny')}
            </Button>
          </>
        )}
      </div>
      {error && (
        <div role="alert" className="pl-6 font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {error}
        </div>
      )}
    </div>
  )
}

function SettledApproval({ request }: { request: AgentPermissionRequestDto }) {
  const t = useTranslations('Sessions.detail')
  const format = useFormatter()
  const outcome =
    request.status === 'allowed'
      ? t('approvalAllowed')
      : request.status === 'denied'
        ? t('approvalDenied')
        : t('approvalExpired')
  // Who answered and where, as far as the record says; an expired request was answered by no one.
  const name = request.resolvedByName?.trim()
  const place = approvalAnswerPlace(request.resolvedBy)
  const answerer =
    request.status === 'expired'
      ? null
      : name
        ? place?.kind === 'here'
          ? t('approvalAnsweredByHere', { name })
          : place
            ? t('approvalAnsweredByIn', { name, platform: place.name })
            : t('approvalAnsweredBy', { name })
        : place?.kind === 'here'
          ? t('approvalAnsweredHere')
          : place
            ? t('approvalAnsweredIn', { platform: place.name })
            : null
  const resolved = request.resolvedAt ? new Date(request.resolvedAt) : null
  const time =
    resolved && !Number.isNaN(resolved.getTime())
      ? format.dateTime(resolved, { hour: 'numeric', minute: '2-digit' })
      : null
  return (
    <div
      data-turn-approval={request.id}
      className="flex min-w-0 items-start gap-2 border-l-2 border-(--border-default) py-1 pl-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)"
    >
      <Icon name="message-square-more" size={14} className="mt-[2px] flex-none" />
      <span className="min-w-0 break-words">
        <span className="font-medium text-(--text-secondary)">{t('approvalAsked')}</span>{' '}
        <span className="break-all font-mono text-[12px]">{approvalCommandText(request.command)}</span>
        {' · '}
        <span className="text-(--text-secondary)">{outcome}</span>
        {answerer ? ` · ${answerer}` : null}
        {time ? ` · ${time}` : null}
      </span>
    </div>
  )
}
