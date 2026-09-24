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
import { DecisionPicker } from './DecisionPicker'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

// The rule table's desktop columns: number, answer, probability, arrow, provider and model, actions.
const RULE_GRID =
  'grid grid-cols-1 items-center gap-2 desktop:grid-cols-[24px_minmax(0,1.1fr)_100px_14px_minmax(0,1fr)_76px] desktop:gap-[10px]'
const ROW_ACTION =
  'flex h-6 w-6 items-center justify-center rounded-[5px] text-(--text-tertiary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35'

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
  runInSandbox
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
  // Fixed and By decision share one control: the fallback's run settings are the agent's own.
  const fallbackPicker = (dense: boolean) => (
    <RuntimeModelSelect
      dense={dense}
      runSettings
      allowRuntimeOnly={!active}
      value={fallback}
      onChange={onFallbackChange}
      source={source}
      runtimes={runtimes}
      runInSandbox={runInSandbox}
    />
  )
  const fallbackPanel = (
    <div className="grid grid-cols-1 items-center gap-3 bg-(--surface-sunken) px-3 py-[10px] desktop:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
          {t('fallbackTitle')}
        </span>
        <span className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('fallback')}</span>
      </div>
      {fallbackPicker(true)}
    </div>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[14px] font-semibold">{t('title')}</h3>
        {api && (
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
          <div className="w-[280px] max-w-full">{fallbackPicker(false)}</div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[10px]">
            <DecisionPicker
              decisions={decisions}
              value={value?.decisionId}
              placeholder={retained?.find((item) => item.id === value?.decisionId)?.name ?? t('chooseDecision')}
              loading={loading}
              onSelect={(entry) => selectDecision(entry.id)}
              create={{ href: orgPath('/decisions/new'), newTab: true }}
            />
            {decision && (
              <>
                <span className="inline-flex h-6 min-w-0 items-center gap-[6px] rounded-[5px] border border-(--border-subtle) bg-(--surface-sunken) px-2 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)">
                  <Icon name="lock" size={11} className="flex-none text-(--text-tertiary)" />
                  {t('evaluator')}
                  <span className="truncate font-mono text-(--text-primary)">
                    {decision.providerId} · {decision.model}
                  </span>
                </span>
                <a
                  className={ROW_ACTION}
                  href={orgPath(`/decisions/${decision.id}`)}
                  target="_blank"
                  rel="noreferrer"
                  title={t('openDecision', { name: decision.name })}
                  aria-label={t('openDecision', { name: decision.name })}
                >
                  <Icon name="arrow-up-right" size={13} />
                </a>
              </>
            )}
          </div>
          {value && !decision && (
            <p className="m-0 text-[12px] text-(--text-secondary)">{loading ? t('loading') : t('retained')}</p>
          )}
          {!decision && (
            <div className="overflow-hidden rounded-md border border-(--border-default)">{fallbackPanel}</div>
          )}
          {value && decision && (
            <>
              <div className="overflow-hidden rounded-md border border-(--border-default)">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-(--border-subtle) bg-(--surface-app) px-3 py-[5px] font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.06em] text-(--text-tertiary) desktop:grid-cols-[24px_minmax(0,1.1fr)_100px_14px_minmax(0,1fr)_76px] desktop:gap-[10px]">
                  <span className="hidden desktop:inline">#</span>
                  <span className="flex items-center gap-1">
                    {t(decision.question.type === 'choice' ? 'answerColumn' : 'condition')}
                    {decision.question.type !== 'choice' && (
                      <button
                        type="button"
                        className="inline-flex"
                        title={t('intervalHelp')}
                        aria-label={t('intervalHelp')}
                      >
                        <Icon name="info" size={12} />
                      </button>
                    )}
                  </span>
                  <span className="hidden items-center gap-1 desktop:flex">
                    {decision.question.type === 'choice' && (
                      <>
                        {t('probabilityColumn')}
                        <button
                          type="button"
                          className="inline-flex"
                          title={t('choiceHelp')}
                          aria-label={t('choiceHelp')}
                        >
                          <Icon name="info" size={12} />
                        </button>
                      </>
                    )}
                  </span>
                  <span className="hidden desktop:inline" />
                  <span className="hidden desktop:inline">{t('providerModel')}</span>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-6 gap-1 justify-self-end px-2 font-sans normal-case tracking-normal"
                    ariaLabel={t('addRule')}
                    disabled={value.rules.length >= 32}
                    onClick={() =>
                      onChange({
                        ...value,
                        rules: [...value.rules, { when: nextCondition(decision.question, value.rules), ...fallback }]
                      })
                    }
                  >
                    <Icon name="plus" size={14} />
                    {t('add')}
                  </Button>
                </div>
                {value.rules.map((rule, index) => (
                  <div key={index} className={`${RULE_GRID} border-b border-(--border-subtle) px-3 py-2`}>
                    <span className="font-mono text-[11px] font-semibold leading-normal text-(--text-tertiary)">
                      {index + 1}
                    </span>
                    {rule.when.type === 'choice' &&
                    decision.question.type === 'choice' &&
                    Object.keys(rule.when.thresholds).length === 1 ? (
                      <>
                        <AnswerSelect
                          ariaLabel={t('answer', { index: index + 1 })}
                          value={Object.keys(rule.when.thresholds)[0]!}
                          answers={decision.question.criteria}
                          onChange={(answer) =>
                            replaceRule(index, {
                              ...rule,
                              when: {
                                type: 'choice',
                                thresholds: {
                                  [answer]: Object.values(
                                    (rule.when as Extract<DecisionCondition, { type: 'choice' }>).thresholds
                                  )[0]!
                                }
                              }
                            })
                          }
                        />
                        <div className="flex items-center gap-[5px]">
                          <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">≥</span>
                          <input
                            className="inp mn h-[30px] min-h-0 w-[58px] px-[6px] py-0 text-center text-[12px] font-medium"
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
                          <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">%</span>
                        </div>
                      </>
                    ) : (
                      <div className="min-w-0 desktop:col-span-2">
                        <DecisionConditionFields
                          question={decision.question}
                          value={rule.when}
                          issues={[]}
                          onChange={(when) => replaceRule(index, { ...rule, when })}
                        />
                      </div>
                    )}
                    <Icon name="arrow-right" size={13} className="hidden text-(--text-tertiary) desktop:block" />
                    <RuntimeModelSelect
                      dense
                      runSettings
                      value={{
                        effort: fallback.effort,
                        permissionMode: fallback.permissionMode,
                        fastMode: fallback.fastMode,
                        ...rule
                      }}
                      ariaLabel={t('ruleModel', { index: index + 1 })}
                      source={source}
                      runtimes={runtimes}
                      runInSandbox={runInSandbox}
                      onChange={(target) => replaceRule(index, { ...rule, ...target })}
                    />
                    <div className="flex justify-end gap-[2px]">
                      {([-1, 1] as const).map((step) => (
                        <button
                          key={step}
                          type="button"
                          className={ROW_ACTION}
                          disabled={index + step < 0 || index + step >= value.rules.length}
                          aria-label={t(step < 0 ? 'moveUp' : 'moveDown', { index: index + 1 })}
                          onClick={() => move(index, step)}
                        >
                          <Icon name={step < 0 ? 'arrow-up' : 'arrow-down'} size={13} />
                        </button>
                      ))}
                      <button
                        type="button"
                        className={ROW_ACTION}
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

function AnswerSelect({
  value,
  answers,
  onChange,
  ariaLabel
}: {
  value: string
  answers: Record<string, string>
  onChange(value: string): void
  ariaLabel: string
}) {
  return (
    <AnchoredFlyout
      ariaLabel={ariaLabel}
      width={280}
      matchTriggerWidth
      align="start"
      triggerClassName="block min-w-0"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className={`inp mn min-h-[30px] w-full cursor-pointer gap-2 px-[9px] py-1 text-left text-[12px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
        >
          <span className="min-w-0 flex-1 break-all">{value}</span>
          <Icon
            name="chevron-down"
            size={13}
            className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) =>
        Object.entries(answers).map(([answer, description]) => (
          <button
            key={answer}
            type="button"
            role="menuitemradio"
            aria-checked={answer === value}
            title={description}
            className={`fopt min-h-[30px] gap-2 py-1 text-[12px] ${answer === value ? 'on' : ''}`}
            onClick={() => {
              onChange(answer)
              close(true)
            }}
          >
            <span className="min-w-0 flex-1 font-mono break-all">{answer}</span>
            {answer === value && <Icon name="check" size={14} className="flex-none text-(--brand)" />}
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}
