'use client'

// The shared-bot routing rules' building blocks: save errors, field notes, the agent picker, and a rule row (decisions.md §9.2).

import { type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { AgentIconView } from '@/components/marks'
import { errorParts } from '@/lib/decisions/binding'
import type { RoutingDraftRule, RoutingIssue } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import type { DecisionQuestion, DecisionValidationIssue } from '@agentconnect.md/protocol/decision'
import { RoutingContinuation } from '../DecisionChainControls'
import { DecisionConditionFields } from '../DecisionConditionFields'

export type T = ReturnType<typeof useTranslations<'Decisions.routing'>>

/** Why a routing save failed, in the terms the footer renders. */
export type RoutingSaveError =
  | { kind: 'invalid'; issues: DecisionValidationIssue[] }
  | { kind: 'forbidden' }
  | { kind: 'decision_missing' }
  | { kind: 'unsupported' }
  | { kind: 'conflict'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string }

export function routingSaveError(cause: unknown): RoutingSaveError {
  const parts = errorParts(cause)
  if (!parts) return { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  const issues = Array.isArray(parts.body.issues) ? (parts.body.issues as DecisionValidationIssue[]) : []
  if (parts.status === 400)
    return issues.length ? { kind: 'invalid', issues } : { kind: 'refused', message: parts.message }
  if (parts.status === 403) return { kind: 'forbidden' }
  if (parts.status === 404 && parts.code === 'DECISION_NOT_FOUND') return { kind: 'decision_missing' }
  if (parts.status === 409 && parts.code === 'DECISION_UNSUPPORTED_CONSUMER') return { kind: 'unsupported' }
  if (parts.status === 409) return { kind: 'conflict', message: parts.message }
  return { kind: 'failed', message: parts.message }
}

export function saveErrorText(t: T, error: RoutingSaveError): string {
  if (error.kind === 'invalid') return t('saveError.invalid')
  if (error.kind === 'forbidden') return t('saveError.forbidden')
  if (error.kind === 'decision_missing') return t('saveError.decisionMissing')
  if (error.kind === 'unsupported') return t('saveError.unsupported')
  if (error.kind === 'conflict') return t('saveError.conflict', { message: error.message })
  if (error.kind === 'refused') return t('saveError.refused', { message: error.message })
  return t('saveError.failed', { message: error.message })
}

export function issueText(t: T, issue: RoutingIssue): string {
  if (issue.code === 'decision_required') return t('decision.required')
  if (issue.code === 'target_required') return t('action.targetRequired')
  if (issue.code === 'target_removed') return t('action.targetRemovedHint')
  if (issue.code === 'condition_required') return t('decision.typeChanged')
  if (issue.code === 'trigger_required') return t('removal.triggerRequired', { channel: String(issue.path[1] ?? '') })
  return issue.message ?? ''
}

export function FieldIssue({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--red-600)">
      <Icon name="triangle-alert" size={12} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

export function Note({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

/** An agent's mark at menu size; AgentIconView fills its box, so the box sets the size. */
export function AgentMark16({ agent }: { agent: Pick<RosterAgent, 'icon' | 'runtime'> }) {
  return (
    <span className="av h-4 w-4 flex-none rounded-[4px]">
      <AgentIconView icon={agent.icon} runtime={agent.runtime} size={16} />
    </span>
  )
}

/** A same-bot agent picker showing each agent's identity and availability. */
export function AgentPicker({
  agents,
  value,
  label,
  placeholder,
  hiddenLabel,
  disabled,
  onChange
}: {
  agents: RosterAgent[]
  value: string | null
  label: string
  placeholder: string
  hiddenLabel: string
  disabled: boolean
  onChange: (agentId: string) => void
}) {
  const selected = value ? agents.find((agent) => agent.id === value) : undefined
  return (
    <AnchoredFlyout
      ariaLabel={label}
      align="start"
      width={260}
      estimatedHeight={10 + Math.max(1, agents.length) * 36}
      triggerClassName="inline-flex min-w-[200px] max-desktop:w-full max-desktop:min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
          className={`inp min-h-8 w-full justify-between gap-2 text-left ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
        >
          <span className="flex min-w-0 items-center gap-2 font-sans text-[12.5px] font-normal leading-normal">
            {selected && <AgentMark16 agent={selected} />}
            <span className="truncate">{selected ? selected.name : value ? hiddenLabel : placeholder}</span>
          </span>
          <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
        </button>
      )}
    >
      {({ close }) =>
        agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            role="menuitemradio"
            aria-checked={agent.id === value}
            className={agent.id === value ? 'fopt on' : 'fopt'}
            onClick={() => {
              close(true)
              onChange(agent.id)
            }}
          >
            <AgentMark16 agent={agent} />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            <span
              className={`h-[7px] w-[7px] flex-none rounded-full ${agent.available ? 'bg-(--status-online)' : 'bg-(--gray-300)'}`}
              aria-hidden="true"
            />
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}

export function RuleRow({
  t,
  number,
  rule,
  question,
  issues,
  agents,
  disabled,
  onChange,
  onRemove,
  onRefresh
}: {
  t: T
  number: number
  rule: RoutingDraftRule
  question: DecisionQuestion | null
  issues: RoutingIssue[]
  agents: RosterAgent[]
  disabled: boolean
  onChange: (rule: RoutingDraftRule) => void
  onRemove: () => void
  onRefresh: () => void
}) {
  const whenIssues = issues
    .filter((issue) => issue.path[2] === 'when' && !issue.code)
    .map((issue) => ({ path: issue.path.slice(3), message: issue.message ?? '' }))
  const actionIssue = issues.find((issue) => issue.path[2] === 'action')
  const conditionMissing = issues.some((issue) => issue.code === 'condition_required')
  const targetId = rule.action.type === 'agent' ? rule.action.agentId : null
  const target = targetId ? agents.find((agent) => agent.id === targetId) : undefined
  const invalid = issues.length > 0
  return (
    <li
      data-testid="routing-rule"
      aria-label={t('rules.number', { number })}
      className={`grid grid-cols-1 gap-3 rounded-lg border bg-(--surface-card) p-3 desktop:grid-cols-[36px_minmax(0,1.3fr)_minmax(0,1fr)_32px] desktop:items-start desktop:rounded-none desktop:border-0 desktop:border-b desktop:border-(--border-subtle) desktop:bg-transparent desktop:px-0 desktop:py-2 ${
        invalid ? 'border-(--red-500)' : 'border-(--border-subtle)'
      }`}
    >
      <span className="flex items-center justify-between font-mono text-[12px] font-semibold leading-normal text-(--text-secondary) desktop:pt-1">
        {number}
        <button
          type="button"
          className="iconbtn h-7 w-7 desktop:hidden"
          title={t('rules.remove', { number })}
          aria-label={t('rules.remove', { number })}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="trash" size={13} />
        </button>
      </span>
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {t('rules.when')}
        </span>
        {question && rule.when && rule.when.type === question.type ? (
          <DecisionConditionFields
            question={question}
            value={rule.when}
            onChange={(when) => onChange({ ...rule, when })}
            issues={whenIssues}
          />
        ) : (
          <FieldIssue>{conditionMissing || rule.when ? t('decision.typeChanged') : t('decision.required')}</FieldIssue>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {t('rules.then')}
        </span>
        <RoutingContinuation
          nextStepId={rule.action.type === 'decision' ? rule.action.nextStepId : undefined}
          disabled={disabled}
          onChange={(id) => onChange({ ...rule, action: id ? { type: 'decision', nextStepId: id } : { type: 'skip' } })}
        >
          <select
            className="inp h-8 min-h-0"
            aria-label={t('action.label', { number })}
            value={rule.action.type}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...rule,
                action:
                  event.target.value === 'skip'
                    ? { type: 'skip' }
                    : { type: 'agent', agentId: rule.action.type === 'agent' ? rule.action.agentId : null }
              })
            }
          >
            <option value="agent">{t('action.route')}</option>
            <option value="skip">{t('action.skip')}</option>
          </select>
          {rule.action.type === 'agent' && (
            <AgentPicker
              agents={agents}
              value={rule.action.agentId}
              label={t('action.agent', { number })}
              placeholder={t('action.selectAgent')}
              hiddenLabel={t('action.targetRemoved')}
              disabled={disabled}
              onChange={(agentId) => onChange({ ...rule, action: { type: 'agent', agentId } })}
            />
          )}
        </RoutingContinuation>
        {actionIssue && <FieldIssue>{issueText(t, actionIssue)}</FieldIssue>}
        {target && !target.available && (
          <span className="flex flex-wrap items-center gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--amber-500)">
            <Icon name="wifi-off" size={12} />
            <b className="font-semibold">{t('action.targetUnavailable')}</b>
            <span className="text-(--text-tertiary)">{t('action.targetUnavailableHint')}</span>
            <button type="button" className="lnk" onClick={onRefresh}>
              {t('action.refresh')}
            </button>
          </span>
        )}
      </div>
      <span className="hidden justify-end desktop:flex">
        <button
          type="button"
          className="iconbtn h-7 w-7"
          title={t('rules.remove', { number })}
          aria-label={t('rules.remove', { number })}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="trash" size={13} />
        </button>
      </span>
    </li>
  )
}
