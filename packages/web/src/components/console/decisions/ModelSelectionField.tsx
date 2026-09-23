'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  decisionModelSelectionIssues,
  type AgentModelSelection,
  type DecisionCondition,
  type DecisionQuestion,
  type DecisionRuntimeTarget
} from '@agentconnect.md/protocol/decision'
import { fetchAgentDecisions } from '@/lib/api'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { useOrgs } from '@/lib/org-context'
import { RuntimeModelSelect, type RuntimeModelSource } from '@/components/console/RuntimeModelSelect'
import { DecisionConditionFields } from './DecisionConditionFields'
import { RuntimeSelectionSample } from './RuntimeSelectionSample'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

function nextCondition(question: DecisionQuestion, rules: AgentModelSelection['rules']): DecisionCondition {
  if (question.type === 'score') return { type: 'score', min: 0, max: question.criteria.length - 1 }
  if (question.type === 'boolean') {
    const used = rules.flatMap((rule) => (rule.when.type === 'boolean' ? rule.when.values : []))
    return { type: 'boolean', values: [[true, false].find((value) => !used.includes(value)) ?? true] }
  }
  const used = rules.flatMap((rule) => (rule.when.type === 'choice' ? Object.keys(rule.when.thresholds) : []))
  const key = Object.keys(question.criteria).find((key) => !used.includes(key)) ?? Object.keys(question.criteria)[0]!
  return { type: 'choice', thresholds: { [key]: 0.5 } }
}

export function ModelSelectionField({
  agentId,
  value,
  onChange,
  onValidityChange,
  fallback,
  onFallbackChange,
  source,
  runtimes,
  runInSandbox,
  enabled = true,
  fastMode,
  onFastModeChange
}: {
  agentId?: string
  value: AgentModelSelection | null
  onChange(value: AgentModelSelection | null): void
  onValidityChange(valid: boolean): void
  fallback: DecisionRuntimeTarget
  onFallbackChange(value: DecisionRuntimeTarget): void
  source?: RuntimeModelSource
  runtimes: readonly string[]
  runInSandbox?: boolean
  enabled?: boolean
  fastMode?: boolean
  onFastModeChange?(value: boolean): void
}) {
  const t = useTranslations('Agents.dialog.modelSelection')
  const { orgPath } = useOrgs()
  const { api, orgId, decisions = [], loading, error } = useOptionalDecisionsPrototype() ?? {}
  const [decisionMode, setDecisionMode] = useState(!!value)
  const active = !!value || decisionMode
  const decision = decisions.find((decision) => decision.id === value?.decisionId)
  const { data: retained } = useSWR(
    agentId && orgId && value && !decision && api?.mode === 'live' ? ['agent-model-decision', orgId, agentId] : null,
    ([, org, id]) => fetchAgentDecisions(id, org, 'model_selection')
  )
  const issues = value && decision ? decisionModelSelectionIssues(decision.question, value) : []
  const missingModel = value?.rules.some(
    (rule) =>
      !runtimes.includes(rule.runtime) ||
      !source?.runtimeModels.find((profile) => profile.runtime === rule.runtime)?.models.includes(rule.model)
  )
  const fallbackAvailable = source?.runtimeModels
    .find((profile) => profile.runtime === fallback.runtime)
    ?.models.includes(fallback.model)
  const valid = !active || (!!value && !!fallbackAvailable && !missingModel && issues.length === 0)
  useEffect(() => onValidityChange(valid), [valid, onValidityChange])
  const selectDecision = (id: string) => {
    const next = decisions.find((item) => item.id === id)
    if (next && next.id !== value?.decisionId)
      onChange({ decisionId: next.id, rules: [{ when: nextCondition(next.question, []), ...fallback }] })
  }
  const replaceRule = (index: number, rule: AgentModelSelection['rules'][number]) => {
    if (value) onChange({ ...value, rules: value.rules.map((entry, i) => (i === index ? rule : entry)) })
  }
  const move = (index: number, step: number) => {
    if (!value) return
    const rules = [...value.rules]
    ;[rules[index], rules[index + step]] = [rules[index + step]!, rules[index]!]
    onChange({ ...value, rules })
  }
  const fixedPicker = (
    <RuntimeModelSelect
      allowRuntimeOnly={!active}
      value={fallback}
      onChange={onFallbackChange}
      source={source}
      runtimes={runtimes}
      runInSandbox={runInSandbox}
      fastMode={fastMode}
      onFastModeChange={onFastModeChange}
    />
  )
  const fallbackPanel = (
    <div className="grid items-center gap-3 rounded-b-lg bg-(--surface-sunken) p-3 desktop:grid-cols-2">
      <div>
        <strong className="text-[13px]">{t('fallbackTitle')}</strong>
        <p className="mt-1 mb-0 text-[12px] text-(--text-tertiary)">{t('fallback')}</p>
      </div>
      {fixedPicker}
    </div>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[14px] font-semibold">{t('title')}</h3>
        {enabled && api && (
          <div className="pillbar" role="group" aria-label={t('title')}>
            <button
              type="button"
              className={!active ? 'pill on' : 'pill'}
              aria-pressed={!active}
              onClick={() => {
                setDecisionMode(false)
                onChange(null)
              }}
            >
              {t('fixed')}
            </button>
            <button
              type="button"
              className={active ? 'pill on' : 'pill'}
              aria-pressed={active}
              onClick={() => {
                setDecisionMode(true)
                if (!value && decisions[0]) selectDecision(decisions[0].id)
              }}
            >
              {t('byDecision')}
            </button>
          </div>
        )}
      </div>
      {!active ? (
        <div className="fld">
          <span className="fldlbl">{t('providerModel')}</span>
          {fixedPicker}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <AnchoredFlyout
              role="dialog"
              ariaLabel={t('savedDecisions')}
              width={340}
              matchTriggerWidth
              estimatedHeight={320}
              align="start"
              triggerClassName="min-w-0 flex-1"
              trigger={({ open, menuId, toggle }) => (
                <button
                  type="button"
                  className="inp flex w-full items-center gap-2 text-left"
                  aria-label={t('savedDecisions')}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  aria-controls={open ? menuId : undefined}
                  onClick={toggle}
                >
                  <Icon name="git-branch" size={16} />
                  <span className="flex-1 truncate">
                    {decision?.name ??
                      retained?.find((item) => item.id === value?.decisionId)?.name ??
                      t('chooseDecision')}
                  </span>
                  <Icon name="chevron-down" size={14} />
                </button>
              )}
            >
              {({ close }) => (
                <div className="max-h-80 overflow-y-auto">
                  <div className="p-2 font-mono text-[11px] uppercase tracking-wider text-(--text-tertiary)">
                    {t('savedDecisions')}
                  </div>
                  {decisions.map((item) => (
                    <div key={item.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className={`flex min-w-0 flex-1 flex-col rounded-md px-2 py-[7px] text-left ${value?.decisionId === item.id ? 'bg-(--brand-soft)' : 'hover:bg-(--surface-hover)'}`}
                        onClick={() => {
                          selectDecision(item.id)
                          close(true)
                        }}
                      >
                        <span className="text-[13px] font-semibold">{item.name}</span>
                        <span className="font-mono text-[11px] text-(--text-tertiary)">
                          {t(item.question.type)} · {item.providerId}
                        </span>
                      </button>
                      <a
                        className="iconbtn"
                        href={orgPath(`/decisions/${item.id}`)}
                        target="_blank"
                        rel="noreferrer"
                        title={t('openDecision', { name: item.name })}
                      >
                        <Icon name="arrow-up-right" size={16} />
                      </a>
                    </div>
                  ))}
                  {!decisions.length && (
                    <div className="p-2 text-[12px] text-(--text-tertiary)">
                      {loading ? t('loading') : t('emptyDecisions')}
                    </div>
                  )}
                </div>
              )}
            </AnchoredFlyout>
            {decision && (
              <span className="inline-flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 text-[12px] text-(--text-secondary)">
                <Icon name="lock" size={13} />
                {t('evaluator')}
                <span className="font-mono text-(--text-primary)">
                  {decision.providerId} · {decision.model}
                </span>
              </span>
            )}
          </div>
          {value && !decision && (
            <p className="m-0 text-[12px] text-(--text-secondary)">{loading ? t('loading') : t('retained')}</p>
          )}
          {!decision && fallbackPanel}
          {value && decision && (
            <>
              <div className="flex items-center justify-between">
                <strong className="text-[13px]">{t('rules')}</strong>
                <Button
                  variant="secondary"
                  disabled={value.rules.length >= 32}
                  onClick={() =>
                    onChange({
                      ...value,
                      rules: [...value.rules, { when: nextCondition(decision.question, value.rules), ...fallback }]
                    })
                  }
                >
                  <Icon name="plus" size={14} />
                  {t('addRule')}
                </Button>
              </div>
              <p className="m-0 text-[12px] text-(--text-tertiary)">
                {t(decision.question.type === 'choice' ? 'choiceHelp' : 'intervalHelp')}
              </p>
              <div className="rounded-lg border border-(--border-subtle)">
                <div className="hidden grid-cols-[24px_minmax(0,1fr)_minmax(0,1.1fr)_78px] gap-2 rounded-t-lg border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-(--text-tertiary) desktop:grid">
                  <span>#</span>
                  <span>{t('condition')}</span>
                  <span>{t('providerModel')}</span>
                  <span />
                </div>
                {value.rules.map((rule, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-1 items-center gap-2 border-b border-(--border-subtle) p-3 desktop:grid-cols-[24px_minmax(0,1fr)_minmax(0,1.1fr)_78px]"
                  >
                    <span className="font-mono text-[12px] text-(--text-tertiary)">{index + 1}</span>
                    {rule.when.type === 'choice' &&
                    decision.question.type === 'choice' &&
                    Object.keys(rule.when.thresholds).length === 1 ? (
                      <div className="flex min-w-0 items-center gap-2">
                        <select
                          className="inp min-w-0 flex-1 font-mono"
                          aria-label={t('answer', { index: index + 1 })}
                          value={Object.keys(rule.when.thresholds)[0]}
                          onChange={(event) =>
                            replaceRule(index, {
                              ...rule,
                              when: {
                                type: 'choice',
                                thresholds: {
                                  [event.target.value]: Object.values(
                                    (rule.when as Extract<DecisionCondition, { type: 'choice' }>).thresholds
                                  )[0]!
                                }
                              }
                            })
                          }
                        >
                          {Object.keys(decision.question.criteria).map((key) => (
                            <option key={key}>{key}</option>
                          ))}
                        </select>
                        <span className="text-(--text-tertiary)">≥</span>
                        <input
                          className="inp w-16"
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          aria-label={t('probability', { index: index + 1 })}
                          value={Math.round(Object.values(rule.when.thresholds)[0]! * 100)}
                          onChange={(event) =>
                            replaceRule(index, {
                              ...rule,
                              when: {
                                type: 'choice',
                                thresholds: {
                                  [Object.keys(
                                    (rule.when as Extract<DecisionCondition, { type: 'choice' }>).thresholds
                                  )[0]!]: Number(event.target.value) / 100
                                }
                              }
                            })
                          }
                        />
                        <span className="text-[12px] text-(--text-tertiary)">%</span>
                      </div>
                    ) : (
                      <DecisionConditionFields
                        question={decision.question}
                        value={rule.when}
                        issues={[]}
                        onChange={(when) => replaceRule(index, { ...rule, when })}
                      />
                    )}
                    <RuntimeModelSelect
                      value={rule}
                      ariaLabel={t('ruleModel', { index: index + 1 })}
                      source={source}
                      runtimes={runtimes}
                      runInSandbox={runInSandbox}
                      onChange={(target) => replaceRule(index, { ...rule, ...target })}
                    />
                    <div className="flex justify-end gap-1">
                      {([-1, 1] as const).map((step) => (
                        <button
                          key={step}
                          type="button"
                          className="iconbtn h-6 w-6"
                          disabled={index + step < 0 || index + step >= value.rules.length}
                          aria-label={t(step < 0 ? 'moveUp' : 'moveDown', { index: index + 1 })}
                          onClick={() => move(index, step)}
                        >
                          <Icon name={step < 0 ? 'arrow-up' : 'arrow-down'} size={13} />
                        </button>
                      ))}
                      <button
                        type="button"
                        className="iconbtn h-6 w-6"
                        aria-label={t('removeRule', { index: index + 1 })}
                        onClick={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                {fallbackPanel}
              </div>
              <RuntimeSelectionSample
                question={decision.question}
                selection={value}
                fallback={fallback}
                source={source}
                valid={valid}
              />
            </>
          )}
          {issues.length > 0 && (
            <div role="alert" className="text-[12px] text-(--status-error)">
              {t('invalidRules')}
            </div>
          )}
          {(missingModel || !fallbackAvailable) && (
            <div role="alert" className="text-[12px] text-(--status-error)">
              {t('missingModel')}
            </div>
          )}
          <p className="m-0 text-[12px] text-(--text-tertiary)">{t('help')}</p>
        </>
      )}
      {error && (
        <div role="alert" className="text-[12px] text-(--status-error)">
          {t('loadError')}
        </div>
      )}
    </div>
  )
}
