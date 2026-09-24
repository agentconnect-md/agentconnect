'use client'

import { useEffect, useState, type ReactNode } from 'react'
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

const ROW_ACTION =
  'flex h-7 w-7 items-center justify-center rounded-md text-(--text-tertiary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35'
const RULE_NUMBER =
  'flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md bg-(--surface-active) font-mono text-[11px] font-semibold leading-normal text-(--text-secondary)'

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

/** One rule or the fallback as a card: a numbered head with its actions, then its fields side by side. */
function RuleCard({
  number,
  title,
  actions,
  invalid = false,
  children
}: {
  number: ReactNode
  title: ReactNode
  actions?: ReactNode
  invalid?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`rounded-lg border bg-(--surface-card) ${invalid ? 'border-(--red-500)' : 'border-(--border-subtle)'}`}
    >
      <div className="flex items-center gap-2 rounded-t-lg border-b border-(--border-subtle) bg-(--surface-app) py-2 pl-3 pr-[10px]">
        {number}
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
          {title}
        </span>
        {actions}
      </div>
      <div className="grid grid-cols-1 gap-[13px] p-3 desktop:grid-cols-2">{children}</div>
    </div>
  )
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
  const fallbackCard = (
    <RuleCard number={<span className={`${RULE_NUMBER} bg-(--surface-sunken)`}>—</span>} title={t('fallbackTitle')}>
      <p className="m-0 self-center font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">{t('fallback')}</p>
      <div className="fld">
        <span className="fldlbl">{t('use')}</span>
        {fallbackPicker(true)}
      </div>
    </RuleCard>
  )
  // Each question type has its own "When": one answer and its minimum, a Yes/No pick, or a score interval.
  const whenField = (rule: AgentModelSelection['rules'][number], index: number) => {
    if (!decision) return null
    if (
      rule.when.type === 'choice' &&
      decision.question.type === 'choice' &&
      Object.keys(rule.when.thresholds).length === 1
    ) {
      const [answer, probability] = Object.entries(rule.when.thresholds)[0]!
      return (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <AnswerSelect
              ariaLabel={t('answer', { index: index + 1 })}
              value={answer}
              answers={decision.question.criteria}
              onChange={(next) =>
                replaceRule(index, { ...rule, when: { type: 'choice', thresholds: { [next]: probability } } })
              }
            />
          </div>
          <span className="flex-none font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('min')}</span>
          <input
            className="inp mn h-[30px] min-h-0 w-[58px] flex-none px-[6px] py-0 text-center text-[12px] font-medium"
            type="number"
            min={0}
            max={100}
            step={1}
            aria-label={t('probability', { index: index + 1 })}
            value={Math.round(probability * 100)}
            onChange={(event) =>
              replaceRule(index, {
                ...rule,
                when: { type: 'choice', thresholds: { [answer]: Number(event.target.value) / 100 } }
              })
            }
          />
          <span className="flex-none font-mono text-[11.5px] leading-normal text-(--text-tertiary)">%</span>
        </div>
      )
    }
    return (
      <DecisionConditionFields
        question={decision.question}
        value={rule.when}
        issues={[]}
        onChange={(when) => replaceRule(index, { ...rule, when })}
      />
    )
  }
  const helpText = decision ? t(decision.question.type === 'choice' ? 'choiceHelp' : 'intervalHelp') : ''
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
              <Icon name="split" size={13} />
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
          <div className="fld">
            <span className="fldlbl">{t('decision')}</span>
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
                  <a
                    className="lnk gap-[6px] text-[11.5px] font-medium"
                    href={orgPath(`/decisions/${decision.id}`)}
                    target="_blank"
                    rel="noreferrer"
                    title={t('openDecision', { name: decision.name })}
                  >
                    <Icon name="pencil" size={12} />
                    {t('viewAndEdit')}
                  </a>
                  <span className="mono text-[11px] text-(--text-tertiary)">
                    {t(`types.${decision.question.type}`)} · {decision.providerId} · {decision.model}
                  </span>
                </>
              )}
            </div>
          </div>
          {value && !decision && (
            <p className="m-0 text-[12px] text-(--text-secondary)">{loading ? t('loading') : t('retained')}</p>
          )}
          {!decision && fallbackCard}
          {value && decision && (
            <>
              <div className="fld">
                <span className="flex items-center justify-between gap-2">
                  <span className="fldlbl">{t('rules')}</span>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-7 gap-1 px-2"
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
                </span>
                <div className="flex flex-col gap-[10px]">
                  {value.rules.map((rule, index) => (
                    <RuleCard
                      key={index}
                      number={<span className={RULE_NUMBER}>{index + 1}</span>}
                      title={t('rule', { index: index + 1 })}
                      invalid={issues.some(
                        (issue) => issue.path[0] === 'rules' && String(issue.path[1]) === String(index)
                      )}
                      actions={
                        <span className="flex flex-none items-center gap-[2px]">
                          {([-1, 1] as const).map((step) => (
                            <button
                              key={step}
                              type="button"
                              className={ROW_ACTION}
                              disabled={index + step < 0 || index + step >= value.rules.length}
                              aria-label={t(step < 0 ? 'moveUp' : 'moveDown', { index: index + 1 })}
                              onClick={() => move(index, step)}
                            >
                              <Icon name={step < 0 ? 'arrow-up' : 'arrow-down'} size={14} />
                            </button>
                          ))}
                          <button
                            type="button"
                            className={ROW_ACTION}
                            aria-label={t('removeRule', { index: index + 1 })}
                            onClick={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })}
                          >
                            <Icon name="x" size={14} />
                          </button>
                        </span>
                      }
                    >
                      <div className="fld min-w-0">
                        <span className="fldlbl">{t(`when.${decision.question.type}`)}</span>
                        {whenField(rule, index)}
                      </div>
                      <div className="fld min-w-0">
                        <span className="fldlbl">{t('use')}</span>
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
                      </div>
                    </RuleCard>
                  ))}
                  {fallbackCard}
                </div>
                <span className="flex items-start gap-[7px] font-sans text-[11.5px] leading-[1.5] text-(--text-tertiary)">
                  <Icon name="info" size={12} className="mt-[2px] flex-none" />
                  {helpText}
                </span>
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
