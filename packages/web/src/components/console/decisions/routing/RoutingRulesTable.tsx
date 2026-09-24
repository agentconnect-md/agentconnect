'use client'

// A routing Decision's rules as the design lays them out: one row per Choice or Boolean answer and where it goes, else numbered rules, then Otherwise.

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import {
  displayOrder,
  newRule,
  ruleIssues,
  type RoutingDraftRule,
  type RoutingIssue
} from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import type { DecisionCondition, DecisionQuestion } from '@agentconnect.md/protocol/decision'
import { RoutingContinuation } from '../DecisionChainControls'
import { IntervalSlider } from '../DecisionConditionFields'
import { AgentMark16, FieldIssue, Note, RuleRow, issueText } from './RoutingFields'
import { SelfAgentTag, useSelfAgentId } from '@/components/console/SelfAgentTag'

// The design's compact table: a 34px header, 8px rows, and 30px controls.
const HEAD =
  'hidden min-h-[34px] items-center gap-[10px] rounded-t-lg border-b border-(--border-subtle) bg-(--surface-app) px-3 font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary) desktop:grid'
const ROW = 'grid grid-cols-1 items-center gap-2 border-b border-(--border-subtle) px-3 py-2 desktop:gap-[10px]'
const PICKER = 'inp h-[30px] min-h-0 w-full justify-between gap-2 px-[9px] py-0 text-left'
const NUMBER_INPUT = 'inp mn h-[30px] min-h-0 w-full px-[6px] py-0 text-center text-[12px]'
const SCORE_COLS = 'desktop:grid-cols-[20px_60px_60px_minmax(60px,1fr)_14px_minmax(0,1.3fr)_24px]'

/** One answer a Choice or Boolean question can give, and the single-answer condition its row saves. */
interface Answer {
  key: string
  label: string
  description: string
  when: DecisionCondition
}

function answersOf(question: DecisionQuestion, words: { yes: string; no: string }): Answer[] | null {
  if (question.type === 'choice')
    return Object.entries(question.criteria).map(([key, description]) => ({
      key,
      label: key,
      description,
      when: { type: 'choice', thresholds: { [key]: 0.5 } }
    }))
  if (question.type === 'boolean')
    return ([true, false] as const).map((value) => ({
      key: String(value),
      label: value ? words.yes : words.no,
      description: value ? question.criteria.true : question.criteria.false,
      when: { type: 'boolean', values: [value] }
    }))
  return null
}

/** The one answer a rule's condition names, or null when it names several or none. */
function answerKey(when: DecisionCondition | null): string | null {
  if (when?.type === 'choice') {
    const keys = Object.keys(when.thresholds)
    return keys.length === 1 ? keys[0]! : null
  }
  if (when?.type === 'boolean') return when.values.length === 1 ? String(when.values[0]) : null
  return null
}

/** Whether a rule's condition still reads against a question: same type, and a Choice naming only answers it has. */
export function fitsQuestion(when: DecisionCondition | null, question: DecisionQuestion): boolean {
  if (!when || when.type !== question.type) return false
  if (when.type === 'choice' && question.type === 'choice')
    return Object.keys(when.thresholds).every((key) => Object.hasOwn(question.criteria, key))
  if (when.type === 'score' && question.type === 'score') return when.max <= question.criteria.length - 1
  return true
}

type Target =
  | { type: 'agent'; agentId: string }
  | { type: 'skip' }
  | { type: 'otherwise' }
  | { type: 'decision'; nextStepId: string }

/** Where an answer's messages go: an agent, nowhere, or on to Otherwise when no rule covers the answer. */
function TargetPicker({
  agents,
  value,
  label,
  disabled,
  allowOtherwise,
  placeholder,
  onChange
}: {
  agents: RosterAgent[]
  value: Target
  label: string
  disabled: boolean
  allowOtherwise: boolean
  /** What an unset target reads when Otherwise is not an option. */
  placeholder?: string
  onChange: (target: Target) => void
}) {
  const t = useTranslations('Decisions.routing.modal')
  const selfAgentId = useSelfAgentId()
  const selected = value.type === 'agent' ? agents.find((agent) => agent.id === value.agentId) : undefined
  const text =
    value.type === 'agent'
      ? (selected?.name ?? t('hiddenAgent'))
      : value.type === 'skip'
        ? t('doNotTrigger')
        : (placeholder ?? t('useOtherwise'))
  const option = (key: string, on: boolean, content: ReactNode, pick: Target, close: (focus?: boolean) => void) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className={on ? 'fopt on' : 'fopt'}
      onClick={() => {
        close(true)
        onChange(pick)
      }}
    >
      {content}
    </button>
  )
  return (
    <RoutingContinuation
      nextStepId={value.type === 'decision' ? value.nextStepId : undefined}
      disabled={disabled}
      onChange={(id) => onChange(id ? { type: 'decision', nextStepId: id } : { type: 'skip' })}
    >
      <AnchoredFlyout
        ariaLabel={label}
        align="start"
        width={260}
        matchTriggerWidth
        estimatedHeight={20 + (agents.length + 2) * 36}
        triggerClassName="block min-w-0"
        trigger={({ open, menuId, toggle }) => (
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={toggle}
            className={`${PICKER} ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          >
            <span
              className={`flex min-w-0 items-center gap-[7px] font-mono text-[12px] leading-normal ${value.type === 'agent' ? 'text-(--text-primary)' : 'text-(--text-secondary)'}`}
            >
              {selected && <AgentMark16 agent={selected} />}
              <span className="truncate">{text}</span>
            </span>
            <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
          </button>
        )}
      >
        {({ close }) => (
          <>
            {agents.map((agent) =>
              option(
                agent.id,
                value.type === 'agent' && value.agentId === agent.id,
                <>
                  <AgentMark16 agent={agent} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{agent.name}</span>
                  {agent.id === selfAgentId && <SelfAgentTag />}
                  <span
                    aria-hidden="true"
                    className={`h-[7px] w-[7px] flex-none rounded-full ${agent.available ? 'bg-(--status-online)' : 'bg-(--gray-300)'}`}
                  />
                </>,
                { type: 'agent', agentId: agent.id },
                close
              )
            )}
            <div className="my-1 h-px bg-(--border-subtle)" />
            {option('skip', value.type === 'skip', t('doNotTrigger'), { type: 'skip' }, close)}
            {allowOtherwise &&
              option('otherwise', value.type === 'otherwise', t('useOtherwise'), { type: 'otherwise' }, close)}
          </>
        )}
      </AnchoredFlyout>
    </RoutingContinuation>
  )
}

export function RoutingRulesTable({
  question,
  rules,
  otherwise,
  agents,
  issues,
  disabled,
  canWrite,
  otherwiseLabels,
  onRules,
  onOtherwise,
  onRefresh
}: {
  question: DecisionQuestion
  rules: RoutingDraftRule[]
  otherwise: 'default_agent' | 'skip'
  /** The agents a rule can route to. */
  agents: RosterAgent[]
  issues: RoutingIssue[]
  disabled: boolean
  canWrite: boolean
  /** How this surface names Otherwise's non-skip choice (a channel's default agent, a repository's every agent). */
  otherwiseLabels?: { default: string }
  onRules: (patch: (rules: RoutingDraftRule[]) => RoutingDraftRule[]) => void
  onOtherwise: (otherwise: 'default_agent' | 'skip') => void
  onRefresh: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tm = useTranslations('Decisions.routing.modal')
  const tDecisions = useTranslations('Decisions')
  const words = { yes: tDecisions('condition.yes'), no: tDecisions('condition.no') }
  const answers = answersOf(question, words)
  const keyed = rules.map((rule) => answerKey(rule.when))
  // Every rule naming one distinct answer reads as the answer table; anything else keeps the rule list.
  const tabular =
    answers !== null &&
    keyed.every((key) => key !== null && answers.some((answer) => answer.key === key)) &&
    new Set(keyed).size === keyed.length
  const setTarget = (answer: Answer, target: Target) =>
    onRules((rules) => {
      const index = rules.findIndex((rule) => answerKey(rule.when) === answer.key)
      if (target.type === 'otherwise') return rules.filter((_, at) => at !== index)
      const action: RoutingDraftRule['action'] = target
      if (index >= 0) return rules.map((rule, at) => (at === index ? { ...rule, action } : rule))
      return [...rules, { ...newRule(question, rules), when: structuredClone(answer.when), action }]
    })

  const order = displayOrder(question, rules)
  const choice = question.type === 'choice'
  const tableCols = choice
    ? 'desktop:grid-cols-[minmax(0,1.3fr)_96px_14px_minmax(0,1fr)]'
    : 'desktop:grid-cols-[minmax(0,1.3fr)_14px_minmax(0,1fr)]'
  const addRule = canWrite && (
    <button
      type="button"
      className="inline-flex h-[22px] flex-none items-center gap-1 rounded-[5px] border border-(--border-default) bg-(--surface-card) px-[7px] font-sans text-[11.5px] font-medium normal-case leading-normal tracking-normal text-(--text-secondary) hover:border-(--border-strong) hover:text-(--text-primary)"
      aria-label={t('rules.add')}
      disabled={disabled}
      onClick={() => onRules((all) => [...all, newRule(question, all)])}
    >
      <Icon name="plus" size={12} />
      {tm('add')}
    </button>
  )
  return (
    <div className="rounded-lg border border-(--border-default) bg-(--surface-card)">
      {question.type === 'score' ? (
        <>
          <div className={`${HEAD} ${SCORE_COLS}`}>
            <span>#</span>
            <span>{tm('from')}</span>
            <span>{tm('to')}</span>
            <span className="flex items-center gap-[5px]">
              {tm('range')}
              <span title={t('rules.scoreHint')} aria-label={t('rules.scoreHint')} className="inline-flex cursor-help">
                <Icon name="info" size={13} />
              </span>
            </span>
            <span />
            <span className="col-span-2 flex min-w-0 items-center justify-between gap-2">
              {tm('triggers')}
              {addRule}
            </span>
          </div>
          {rules.length === 0 && (
            <div className="px-3 py-2">
              <Note icon="list">{t('rules.empty')}</Note>
            </div>
          )}
          {order.map((index, position) => {
            const rule = rules[index]!
            return (
              <ScoreRuleRow
                key={rule.id}
                number={position + 1}
                rule={rule}
                levels={question.criteria.length}
                issues={ruleIssues(issues, index)}
                agents={agents}
                disabled={disabled}
                onChange={(next) => onRules((rules) => rules.map((entry) => (entry.id === next.id ? next : entry)))}
                onRemove={() => onRules((all) => all.filter((entry) => entry.id !== rule.id))}
                onRefresh={onRefresh}
              />
            )
          })}
          {canWrite && (
            <button
              type="button"
              className="lnk m-3 gap-[6px] text-[12.5px] font-medium desktop:hidden"
              disabled={disabled}
              onClick={() => onRules((all) => [...all, newRule(question, all)])}
            >
              <Icon name="plus" size={14} />
              {t('rules.add')}
            </button>
          )}
        </>
      ) : tabular && answers ? (
        <>
          <div className={`${HEAD} ${tableCols}`}>
            <span>{tm('answer')}</span>
            {choice && <span>{tm('minProbability')}</span>}
            <span />
            <span className="flex items-center justify-between gap-2">
              {tm('triggers')}
              {choice && (
                <span title={t('rules.choiceHint')} aria-label={t('rules.choiceHint')} className="inline-flex">
                  <Icon name="info" size={13} />
                </span>
              )}
            </span>
          </div>
          {answers.map((answer) => {
            const index = rules.findIndex((rule) => answerKey(rule.when) === answer.key)
            const rule = index >= 0 ? rules[index]! : null
            const target: Target = !rule
              ? { type: 'otherwise' }
              : rule.action.type === 'decision'
                ? rule.action
                : rule.action.type === 'skip'
                  ? { type: 'skip' }
                  : rule.action.agentId
                    ? { type: 'agent', agentId: rule.action.agentId }
                    : { type: 'otherwise' }
            const rowIssues = index >= 0 ? ruleIssues(issues, index) : []
            const threshold = rule?.when?.type === 'choice' ? (rule.when.thresholds[answer.key] ?? 0.5) : null
            return (
              <div key={answer.key} data-testid="routing-answer" className={`${ROW} ${tableCols}`}>
                <span className="flex min-w-0 flex-col gap-[2px]" title={answer.description}>
                  <span className="mono truncate text-[12.5px] text-(--text-primary)">{answer.label}</span>
                  <span className="truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    {answer.description}
                  </span>
                </span>
                {choice && (
                  <span className="flex items-center gap-[5px]">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      disabled={disabled || threshold === null}
                      aria-label={tm('minFor', { answer: answer.label })}
                      value={threshold === null ? '' : Math.round(threshold * 100)}
                      placeholder="—"
                      onChange={(event) => {
                        const percent = Math.min(100, Math.round(Math.max(0, Number(event.target.value) || 0)))
                        // React skips rewriting a number input whose value is numerically equal, so "080" would stay.
                        event.target.value = String(percent)
                        onRules((rules) =>
                          rules.map((entry, at) =>
                            at === index
                              ? {
                                  ...entry,
                                  when: { type: 'choice', thresholds: { [answer.key]: percent / 100 } }
                                }
                              : entry
                          )
                        )
                      }}
                      className={`${NUMBER_INPUT} w-[56px]!`}
                    />
                    <span className="font-mono text-[11.5px] leading-normal text-(--text-tertiary)">%</span>
                  </span>
                )}
                <Icon name="arrow-right" size={13} className="hidden text-(--text-tertiary) desktop:block" />
                <span className="flex min-w-0 flex-col gap-1">
                  <TargetPicker
                    agents={agents}
                    value={target}
                    label={tm('targetFor', { answer: answer.label })}
                    disabled={disabled}
                    allowOtherwise
                    onChange={(next) => setTarget(answer, next)}
                  />
                  {rowIssues.map((issue, at) => (
                    <FieldIssue key={at}>{issueText(t, issue)}</FieldIssue>
                  ))}
                </span>
              </div>
            )
          })}
        </>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-2">
          {rules.length === 0 ? (
            <Note icon="list">{t('rules.empty')}</Note>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0 desktop:gap-0">
              {order.map((index, position) => {
                const rule = rules[index]!
                return (
                  <RuleRow
                    key={rule.id}
                    t={t}
                    number={position + 1}
                    rule={rule}
                    question={question}
                    issues={ruleIssues(issues, index)}
                    agents={agents}
                    disabled={disabled}
                    onChange={(next) => onRules((rules) => rules.map((entry) => (entry.id === next.id ? next : entry)))}
                    onRemove={() => onRules((all) => all.filter((entry) => entry.id !== rule.id))}
                    onRefresh={onRefresh}
                  />
                )
              })}
            </ol>
          )}
          {canWrite && (
            <button
              type="button"
              className="lnk self-start gap-[6px] pb-1 text-[12.5px] font-medium"
              disabled={disabled}
              onClick={() => onRules((all) => [...all, newRule(question, all)])}
            >
              <Icon name="plus" size={14} />
              {t('rules.add')}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 rounded-b-lg bg-(--surface-sunken) px-3 py-[9px]">
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
            {t('otherwise.label')}
          </span>
          <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {tm('otherwiseHint')}
          </span>
        </span>
        <div className="w-[220px] max-w-[50%] flex-none">
          <OtherwisePicker labels={otherwiseLabels} value={otherwise} disabled={disabled} onChange={onOtherwise} />
        </div>
      </div>
    </div>
  )
}

/** A score rule as one table row: its interval as numbers and a track, then the agent it triggers. */
function ScoreRuleRow({
  number,
  rule,
  levels,
  issues,
  agents,
  disabled,
  onChange,
  onRemove,
  onRefresh
}: {
  number: number
  rule: RoutingDraftRule
  levels: number
  issues: RoutingIssue[]
  agents: RosterAgent[]
  disabled: boolean
  onChange: (rule: RoutingDraftRule) => void
  onRemove: () => void
  onRefresh: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tm = useTranslations('Decisions.routing.modal')
  const when = rule.when?.type === 'score' ? rule.when : null
  const setWhen = (next: Extract<DecisionCondition, { type: 'score' }>) => onChange({ ...rule, when: next })
  const bound = (raw: string, current: number) => {
    const parsed = Number(raw)
    return raw === '' || !Number.isFinite(parsed) ? current : parsed
  }
  const target: Target =
    rule.action.type === 'decision'
      ? rule.action
      : rule.action.type === 'skip'
        ? { type: 'skip' }
        : rule.action.agentId
          ? { type: 'agent', agentId: rule.action.agentId }
          : { type: 'otherwise' }
  const agent = target.type === 'agent' ? agents.find((entry) => entry.id === target.agentId) : undefined
  const messages = issues.map((issue) => (issue.code ? issueText(t, issue) : (issue.message ?? ''))).filter(Boolean)
  return (
    <div
      data-testid="routing-rule"
      aria-label={t('rules.number', { number })}
      className={`border-b border-(--border-subtle) py-2 pl-3 pr-2 ${issues.length ? 'bg-(--status-error-soft)' : ''}`}
    >
      <div className={`grid grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_24px] items-center gap-2 ${SCORE_COLS}`}>
        <span className="font-mono text-[11px] font-semibold leading-normal text-(--text-tertiary)">{number}</span>
        {when ? (
          <>
            <input
              className={NUMBER_INPUT}
              type="number"
              step={0.1}
              disabled={disabled}
              aria-label={tm('fromFor', { number })}
              value={when.min}
              onChange={(event) => setWhen({ ...when, min: bound(event.target.value, when.min) })}
            />
            <input
              className={NUMBER_INPUT}
              type="number"
              step={0.1}
              disabled={disabled}
              aria-label={tm('toFor', { number })}
              value={when.max}
              onChange={(event) => setWhen({ ...when, max: bound(event.target.value, when.max) })}
            />
            <IntervalSlider
              value={when}
              maximum={levels - 1}
              onChange={setWhen}
              className="col-span-full desktop:col-span-1"
            />
          </>
        ) : (
          <span className="col-span-2 desktop:col-span-3">
            <FieldIssue>{t('decision.typeChanged')}</FieldIssue>
          </span>
        )}
        <Icon name="arrow-right" size={14} className="hidden text-(--text-tertiary) desktop:block" />
        <span className="col-span-3 min-w-0 desktop:col-span-1">
          <TargetPicker
            agents={agents}
            value={target}
            label={t('action.agent', { number })}
            disabled={disabled}
            allowOtherwise={false}
            placeholder={t('action.selectAgent')}
            onChange={(next) =>
              onChange({
                ...rule,
                action: next.type === 'otherwise' ? { type: 'skip' } : next
              })
            }
          />
        </span>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
          title={t('rules.remove', { number })}
          aria-label={t('rules.remove', { number })}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      {(messages.length > 0 || (agent && !agent.available)) && (
        <div className="mt-[6px] flex flex-col gap-1 desktop:ml-7">
          {messages.map((message, at) => (
            <FieldIssue key={at}>{message}</FieldIssue>
          ))}
          {agent && !agent.available && (
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
      )}
    </div>
  )
}

/** Otherwise: each conversation's default agent, or nothing. */
function OtherwisePicker({
  value,
  disabled,
  labels,
  onChange
}: {
  value: 'default_agent' | 'skip'
  disabled: boolean
  labels?: { default: string }
  onChange: (value: 'default_agent' | 'skip') => void
}) {
  const t = useTranslations('Decisions.routing')
  const tm = useTranslations('Decisions.routing.modal')
  const label = (entry: 'default_agent' | 'skip') =>
    entry === 'skip' ? tm('doNotTrigger') : (labels?.default ?? t('otherwise.default'))
  return (
    <AnchoredFlyout
      ariaLabel={t('otherwise.label')}
      align="start"
      width={240}
      matchTriggerWidth
      estimatedHeight={90}
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          aria-label={t('otherwise.label')}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
          className={`${PICKER} ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
        >
          <span className="truncate font-mono text-[12px] leading-normal">{label(value)}</span>
          <Icon name="chevron-down" size={14} color="var(--text-tertiary)" className="flex-none" />
        </button>
      )}
    >
      {({ close }) =>
        (['default_agent', 'skip'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="menuitemradio"
            aria-checked={entry === value}
            className={entry === value ? 'fopt on' : 'fopt'}
            onClick={() => {
              close(true)
              onChange(entry)
            }}
          >
            {label(entry)}
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}
