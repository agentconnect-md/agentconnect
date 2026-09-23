'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  decisionModelSelectionIssues,
  type AgentModelSelection,
  type DecisionCondition,
  type DecisionQuestion
} from '@agentconnect.md/protocol/decision'
import { fetchAgentDecisions } from '@/lib/api'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { ModelSelect } from '@/components/console/ModelSelect'
import { DecisionConditionFields } from './DecisionConditionFields'
import { Button, Icon } from '@/components/ui'

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
  models,
  fallbackModel,
  supported
}: {
  agentId?: string
  value: AgentModelSelection | null
  onChange(value: AgentModelSelection | null): void
  onValidityChange(valid: boolean): void
  models: Array<{ value: string; name?: string; description?: string; unavailable?: boolean }>
  fallbackModel: string
  supported: boolean
}) {
  const t = useTranslations('Agents.dialog.modelSelection')
  const { api, orgId, decisions, loading, error } = useDecisionsPrototype()
  const decision = decisions.find((decision) => decision.id === value?.decisionId)
  const { data: retained } = useSWR(
    agentId && orgId && value && !decision && api.mode === 'live' ? ['agent-model-decision', orgId, agentId] : null,
    ([, org, id]) => fetchAgentDecisions(id, org, 'model_selection')
  )
  const issues = value && decision ? decisionModelSelectionIssues(decision.question, value) : []
  const missingModel = value?.rules.some(
    (rule) => !models.some((model) => model.value === rule.model && !model.unavailable)
  )
  const valid = !value || (supported && !!fallbackModel && !missingModel && issues.length === 0)
  useEffect(() => onValidityChange(valid), [valid, onValidityChange])
  const replaceRule = (index: number, rule: AgentModelSelection['rules'][number]) => {
    if (value) onChange({ ...value, rules: value.rules.map((entry, i) => (i === index ? rule : entry)) })
  }
  return (
    <div className="mt-[14px] flex flex-col gap-3">
      <label className="fld">
        <span className="fldlbl">{t('title')}</span>
        <select
          className="inp"
          value={value?.decisionId ?? ''}
          onChange={(event) => {
            const next = decisions.find((item) => item.id === event.target.value)
            onChange(
              next
                ? {
                    decisionId: next.id,
                    rules: [{ when: nextCondition(next.question, []), model: fallbackModel }]
                  }
                : null
            )
          }}
        >
          <option value="">{t('fixed')}</option>
          {value && !decision && (
            <option value={value.decisionId}>
              {retained?.find((item) => item.id === value.decisionId)?.name ?? t('unavailableDecision')}
            </option>
          )}
          {decisions.map((item) => (
            <option key={item.id} value={item.id} disabled={!supported || loading || !!error}>
              {t('byDecision', { name: item.name })}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div role="alert" className="text-[12px] text-(--status-error)">
          {t('loadError')}
        </div>
      )}
      {!supported && <p className="m-0 text-[12px] text-(--text-secondary)">{t('unsupported')}</p>}
      {value && (
        <>
          <p className="m-0 text-[12px] text-(--text-secondary)">{t('help')}</p>
          {!decision ? (
            <p className="m-0 text-[12px] text-(--text-secondary)">{loading ? t('loading') : t('retained')}</p>
          ) : (
            <>
              {value.rules.map((rule, index) => (
                <div key={index} className="rounded-md border border-(--border-subtle) p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold">{t('rule', { index: index + 1 })}</span>
                    <button
                      type="button"
                      className="iconbtn"
                      aria-label={t('removeRule', { index: index + 1 })}
                      onClick={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <DecisionConditionFields
                    question={decision.question}
                    value={rule.when}
                    issues={[]}
                    onChange={(when) => replaceRule(index, { ...rule, when })}
                  />
                  <div className="mt-3">
                    <ModelSelect
                      value={rule.model}
                      ariaLabel={t('ruleModel', { index: index + 1 })}
                      options={
                        models.some((model) => model.value === rule.model)
                          ? models
                          : [...models, { value: rule.model, unavailable: true }]
                      }
                      onChange={(model) => replaceRule(index, { ...rule, model })}
                    />
                  </div>
                </div>
              ))}
              <Button
                variant="ghost"
                disabled={value.rules.length >= 32}
                onClick={() =>
                  onChange({
                    ...value,
                    rules: [
                      ...value.rules,
                      { when: nextCondition(decision.question, value.rules), model: fallbackModel }
                    ]
                  })
                }
              >
                {t('addRule')}
              </Button>
            </>
          )}
          {issues.length > 0 && (
            <div role="alert" className="text-[12px] text-(--status-error)">
              {t('invalidRules')}
            </div>
          )}
          {missingModel && (
            <div role="alert" className="text-[12px] text-(--status-error)">
              {t('missingModel')}
            </div>
          )}
          <p className="m-0 text-[12px] text-(--text-secondary)">{t('fallback')}</p>
        </>
      )}
    </div>
  )
}
