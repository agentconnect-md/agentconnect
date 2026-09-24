'use client'

import { useEffect, useState, type DragEvent } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  DECISION_PROVIDER_PROFILES,
  DECISION_CHAIN_MAX_STEPS,
  decisionModelSelectionIssues,
  modelSelectionTargets,
  type AgentModelSelection,
  type DecisionModelStep,
  type DecisionModelTarget,
  type DecisionCondition,
  type DecisionQuestion,
  type DecisionRuntimeTarget
} from '@agentconnect.md/protocol/decision'
import { fetchAgentDecisions } from '@/lib/api'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { useOrgs } from '@/lib/org-context'
import { RuntimeModelSelect, type RuntimeModelSource } from '@/components/console/RuntimeModelSelect'
import { RuntimeSelectionSample } from './RuntimeSelectionSample'
import { DecisionPicker } from './DecisionPicker'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { reachableSteps } from '@/lib/decisions/chain'
import { NextDecision, NextDecisionChip, useDecisionChainPath } from './DecisionChainControls'

type Rule = AgentModelSelection['rules'][number]

// The rule table's desktop columns per question type, as the design lays them out.
const CHOICE_COLS = 'desktop:grid-cols-[34px_minmax(0,1fr)_92px_12px_minmax(0,1.35fr)_28px]'
const SCORE_COLS = 'desktop:grid-cols-[70px_70px_12px_minmax(0,1fr)_28px]'
const BOOLEAN_COLS = 'desktop:grid-cols-[80px_12px_minmax(0,1fr)_28px]'
const HEAD =
  'hidden items-center gap-2 rounded-t-lg border-b border-(--border-subtle) bg-(--surface-app) px-3 py-[7px] font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary) desktop:grid'
const ROW = 'grid grid-cols-1 items-center gap-2 border-b border-(--border-subtle) px-3 py-2'
const ROW_ACTION =
  'flex h-6 w-6 items-center justify-center rounded-[5px] text-(--text-tertiary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:pointer-events-none disabled:opacity-35'
const NUMBER_INPUT = 'inp mn h-[30px] min-h-0 w-full px-[6px] py-0 text-center text-[12px] font-medium'

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

/** A Boolean answer's model: its own rule, split out of a rule that names both answers, or a new one. */
function setBooleanTarget(rules: AgentModelSelection['rules'], answer: boolean, target: DecisionModelTarget) {
  const index = rules.findIndex((rule) => rule.when.type === 'boolean' && rule.when.values.includes(answer))
  const own: Rule = { ...target, when: { type: 'boolean', values: [answer] } }
  if (index < 0) return [...rules, own]
  const rule = rules[index]!
  if (rule.when.type === 'boolean' && rule.when.values.length === 1)
    return rules.map((entry, at) => (at === index ? { when: entry.when, ...target } : entry))
  const rest: Rule = { ...rule, when: { type: 'boolean', values: [!answer] } }
  return [...rules.slice(0, index), own, rest, ...rules.slice(index + 1)]
}

/** A Boolean answer back on the fallback: dropped from its rule, and the rule too once it names nothing. */
function clearBooleanTarget(rules: AgentModelSelection['rules'], answer: boolean) {
  return rules.flatMap((rule): Rule[] => {
    if (rule.when.type !== 'boolean' || !rule.when.values.includes(answer)) return [rule]
    const values = rule.when.values.filter((value) => value !== answer)
    return values.length ? [{ ...rule, when: { type: 'boolean', values } }] : []
  })
}

// Replacing a branch also removes the steps that no remaining branch can reach.
function pruneSteps(selection: AgentModelSelection): AgentModelSelection {
  const steps = reachableSteps<DecisionModelStep>(selection, selection.steps ?? [], (step) =>
    step.rules.flatMap((rule) => ('nextStepId' in rule ? [rule.nextStepId] : []))
  )
  return { decisionId: selection.decisionId, rules: selection.rules, ...(steps.length ? { steps } : {}) }
}

export function ModelSelectionField({
  agentId,
  value: configuration,
  onChange: onConfigurationChange,
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
  const [decisionMode, setDecisionMode] = useState(!!configuration)
  const { path: stepPath, enter, to } = useDecisionChainPath(configuration, onConfigurationChange)
  const stepIndex = configuration?.steps?.findIndex((step) => step.id === stepPath.at(-1)) ?? -1
  const value: DecisionModelStep | null = stepIndex >= 0 ? configuration!.steps![stepIndex]! : configuration
  const onChange = (next: DecisionModelStep | null, steps = configuration?.steps) => {
    if (!next) {
      to(0)
      onConfigurationChange(null)
      return
    }
    const updated: AgentModelSelection =
      stepIndex < 0
        ? { ...next, steps }
        : { ...configuration!, steps: steps?.map((step, index) => (index === stepIndex ? { ...step, ...next } : step)) }
    onConfigurationChange(pruneSteps(updated))
  }
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const active = !!value || decisionMode
  const decision = decisions.find((decision) => decision.id === value?.decisionId)
  const { data: retained } = useSWR(
    agentId && orgId && value && !decision && api?.mode === 'live' ? ['agent-model-decision', orgId, agentId] : null,
    ([, org, id]) => fetchAgentDecisions(id, org, 'model_selection')
  )
  const rootDecision = decisions.find((entry) => entry.id === configuration?.decisionId)
  const issues =
    configuration && rootDecision
      ? decisionModelSelectionIssues(
          rootDecision.question,
          configuration,
          new Map(decisions.map((entry) => [entry.id, entry.question]))
        )
      : []
  const missingModel =
    configuration &&
    modelSelectionTargets(configuration).some(
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
  const replaceRule = (index: number, rule: Rule, steps = configuration?.steps) => {
    if (value) onChange({ ...value, rules: value.rules.map((entry, i) => (i === index ? rule : entry)) }, steps)
  }
  const removeRule = (index: number) => {
    if (value) onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })
  }
  const moveRule = (from: number, to: number) => {
    if (!value || from === to || to < 0 || to >= value.rules.length) return
    const rules = [...value.rules]
    const [rule] = rules.splice(from, 1)
    rules.splice(to, 0, rule!)
    onChange({ ...value, rules })
  }
  const invalidRow = (index: number) =>
    issues.some((issue) => {
      const path =
        stepIndex >= 0 && issue.path[0] === 'steps' && issue.path[1] === stepIndex
          ? issue.path.slice(2)
          : stepIndex < 0
            ? issue.path
            : []
      return path[0] === 'rules' && String(path[1]) === String(index)
    })
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
  const rulePicker = (
    rule: Rule,
    ariaLabel: string,
    onPick: (target: DecisionModelTarget, steps?: AgentModelSelection['steps']) => void
  ) => {
    const next = 'nextStepId' in rule ? configuration?.steps?.find((step) => step.id === rule.nextStepId) : undefined
    const nextName =
      decisions.find((entry) => entry.id === next?.decisionId)?.name ??
      retained?.find((entry) => entry.id === next?.decisionId)?.name ??
      t('nextDecision')
    return (
      <div className="flex min-w-0 items-center gap-1">
        {'runtime' in rule ? (
          <div className="min-w-0 flex-1">
            <RuntimeModelSelect
              dense
              runSettings
              value={{
                effort: fallback.effort,
                permissionMode: fallback.permissionMode,
                fastMode: fallback.fastMode,
                ...rule
              }}
              ariaLabel={ariaLabel}
              source={source}
              runtimes={runtimes}
              runInSandbox={runInSandbox}
              onChange={(target) => onPick(target)}
            />
          </div>
        ) : (
          <NextDecisionChip
            decision={decisions.find((entry) => entry.id === next?.decisionId)}
            name={nextName}
            label={t('editNext', { name: nextName })}
            removeLabel={t('useModel')}
            onOpen={() => enter(rule.nextStepId)}
            onRemove={() => onPick(fallback)}
          />
        )}
        {'runtime' in rule && (
          <NextDecision
            decisions={decisions}
            ariaLabel={`${ariaLabel}: ${t('nextDecision')}`}
            disabled={(configuration?.steps?.length ?? 0) >= DECISION_CHAIN_MAX_STEPS - 1}
            onSelect={(entry) => {
              const id = crypto.randomUUID()
              onPick({ nextStepId: id }, [
                ...(configuration?.steps ?? []),
                { id, decisionId: entry.id, rules: [{ when: nextCondition(entry.question, []), ...fallback }] }
              ])
              enter(id)
            }}
          />
        )}
      </div>
    )
  }
  const fallbackPanel = (
    <div className="grid grid-cols-1 items-center gap-3 rounded-b-lg bg-(--surface-sunken) px-3 py-[10px] desktop:grid-cols-[minmax(0,1fr)_minmax(0,250px)]">
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
          {t('fallbackTitle')}
        </span>
        <span className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('fallback')}</span>
      </span>
      {fallbackPicker(true)}
    </div>
  )
  const addButton = decision && value && (
    <span className="flex justify-end">
      <Button
        variant="secondary"
        size="xs"
        className="h-[22px] gap-1 px-[7px] font-sans text-[11.5px] normal-case tracking-normal"
        ariaLabel={t('addRule')}
        disabled={value.rules.length >= 32}
        onClick={() =>
          onChange({
            ...value,
            rules: [...value.rules, { when: nextCondition(decision.question, value.rules), ...fallback }]
          })
        }
      >
        <Icon name="plus" size={12} />
        {t('add')}
      </Button>
    </span>
  )
  // The header, and its Add, is desktop-only; narrow screens add from below the rules.
  const mobileAdd = decision && value && (
    <button
      type="button"
      className="lnk m-3 gap-[6px] text-[12.5px] font-medium desktop:hidden"
      aria-label={t('addRule')}
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
    </button>
  )
  const removeButton = (index: number) => (
    <span className="flex justify-end">
      <button
        type="button"
        className={ROW_ACTION}
        aria-label={t('removeRule', { index: index + 1 })}
        onClick={() => removeRule(index)}
      >
        <Icon name="x" size={13} />
      </button>
    </span>
  )
  const hint = (text: string) => (
    <span title={text} aria-label={text} className="inline-flex cursor-help">
      <Icon name="info" size={11} />
    </span>
  )
  const arrow = <Icon name="arrow-right" size={13} className="hidden flex-none text-(--text-tertiary) desktop:block" />

  const choiceTable = (question: Extract<DecisionQuestion, { type: 'choice' }>, selection: DecisionModelStep) => (
    <>
      <div className={`${HEAD} ${CHOICE_COLS}`}>
        <span>#</span>
        <span>{t('answerColumn')}</span>
        <span className="flex items-center gap-1">
          {t('probabilityColumn')}
          {hint(t('choiceHelp'))}
        </span>
        <span />
        <span>{t('providerModel')}</span>
        {addButton}
      </div>
      {selection.rules.map((rule, index) => {
        const [answer, probability] =
          rule.when.type === 'choice' ? (Object.entries(rule.when.thresholds)[0] ?? ['', 0.5]) : ['', 0.5]
        const setWhen = (key: string, threshold: number) =>
          replaceRule(index, { ...rule, when: { type: 'choice', thresholds: { [key]: threshold } } })
        return (
          <div
            key={index}
            data-testid="model-rule"
            className={`${ROW} ${CHOICE_COLS} ${invalidRow(index) ? 'bg-(--status-error-soft)' : ''} ${dragging === index ? 'opacity-50' : ''} ${dropAt === index && dragging !== index ? 'shadow-[inset_0_2px_0_var(--brand)]' : ''}`}
            onDragOver={(event: DragEvent) => {
              if (dragging === null) return
              event.preventDefault()
              setDropAt(index)
            }}
            onDrop={(event: DragEvent) => {
              event.preventDefault()
              if (dragging !== null) moveRule(dragging, index)
              setDragging(null)
              setDropAt(null)
            }}
          >
            <button
              type="button"
              draggable
              aria-label={t('reorder', { index: index + 1 })}
              title={t('reorder', { index: index + 1 })}
              className="-ml-1 inline-flex h-[26px] w-fit cursor-grab items-center gap-px rounded-[5px] px-[2px] text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-secondary)"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                setDragging(index)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                event.preventDefault()
                moveRule(index, index + (event.key === 'ArrowUp' ? -1 : 1))
              }}
            >
              <Icon name="grip-vertical" size={13} />
              <span className="font-mono text-[11px] font-semibold leading-normal">{index + 1}</span>
            </button>
            <AnswerSelect
              ariaLabel={t('answer', { index: index + 1 })}
              value={answer}
              answers={question.criteria}
              onChange={(next) => setWhen(next, probability)}
            />
            <span className="flex items-center gap-1">
              <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">≥</span>
              <input
                className={`${NUMBER_INPUT} w-[54px]!`}
                type="number"
                min={0}
                max={100}
                step={1}
                aria-label={t('probability', { index: index + 1 })}
                value={Math.round(probability * 100)}
                onChange={(event) => setWhen(answer, Number(event.target.value) / 100)}
              />
              <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">%</span>
            </span>
            {arrow}
            {rulePicker(rule, t('ruleModel', { index: index + 1 }), (target, steps) =>
              replaceRule(index, { when: rule.when, ...target }, steps)
            )}
            {removeButton(index)}
          </div>
        )
      })}
      {mobileAdd}
    </>
  )

  const scoreTable = (selection: DecisionModelStep) => (
    <>
      <div className={`${HEAD} ${SCORE_COLS}`}>
        <span className="flex items-center gap-1">
          {t('fromColumn')}
          {hint(t('intervalHelp'))}
        </span>
        <span>{t('toColumn')}</span>
        <span />
        <span>{t('providerModel')}</span>
        {addButton}
      </div>
      {selection.rules.map((rule, index) => {
        const when = rule.when.type === 'score' ? rule.when : { type: 'score' as const, min: 0, max: 0 }
        const bound = (raw: string, current: number) => {
          const parsed = Number(raw)
          return raw === '' || !Number.isFinite(parsed) ? current : parsed
        }
        return (
          <div
            key={index}
            data-testid="model-rule"
            className={`${ROW} ${SCORE_COLS} ${invalidRow(index) ? 'bg-(--status-error-soft)' : ''}`}
          >
            <input
              className={NUMBER_INPUT}
              type="number"
              step={0.5}
              aria-label={t('intervalStart', { index: index + 1 })}
              value={when.min}
              onChange={(event) =>
                replaceRule(index, { ...rule, when: { ...when, min: bound(event.target.value, when.min) } })
              }
            />
            <input
              className={NUMBER_INPUT}
              type="number"
              step={0.5}
              aria-label={t('intervalEnd', { index: index + 1 })}
              value={when.max}
              onChange={(event) =>
                replaceRule(index, { ...rule, when: { ...when, max: bound(event.target.value, when.max) } })
              }
            />
            {arrow}
            {rulePicker(rule, t('ruleModel', { index: index + 1 }), (target, steps) =>
              replaceRule(index, { when: rule.when, ...target }, steps)
            )}
            {removeButton(index)}
          </div>
        )
      })}
      {mobileAdd}
    </>
  )

  // Yes and No are always listed; an answer without its own rule shows the fallback until one is picked.
  const booleanTable = (selection: DecisionModelStep) => (
    <>
      <div className={`${HEAD} ${BOOLEAN_COLS}`}>
        <span>{t('answerColumn')}</span>
        <span />
        <span>{t('providerModel')}</span>
        <span />
      </div>
      {([true, false] as const).map((answer) => {
        const index = selection.rules.findIndex(
          (rule) => rule.when.type === 'boolean' && rule.when.values.includes(answer)
        )
        const rule: Rule = selection.rules[index] ?? { ...fallback, when: { type: 'boolean', values: [answer] } }
        const label = answer ? t('yes') : t('no')
        return (
          <div
            key={String(answer)}
            data-testid="model-rule"
            className={`${ROW} ${BOOLEAN_COLS} ${index >= 0 && invalidRow(index) ? 'bg-(--status-error-soft)' : ''}`}
          >
            <span className="font-mono text-[12.5px] font-medium leading-normal text-(--text-primary)">{label}</span>
            {arrow}
            <div className="min-w-0 desktop:max-w-[300px]">
              {rulePicker(rule, t('answerModel', { answer: label }), (target, steps) =>
                onChange({ ...selection, rules: setBooleanTarget(selection.rules, answer, target) }, steps)
              )}
            </div>
            <span className="flex justify-end">
              {index >= 0 && (
                <button
                  type="button"
                  className={ROW_ACTION}
                  // The last rule stays: a binding needs one, and Fixed is how to drop it.
                  disabled={clearBooleanTarget(selection.rules, answer).length === 0}
                  aria-label={t('useFallback', { answer: label })}
                  title={t('useFallback', { answer: label })}
                  onClick={() => onChange({ ...selection, rules: clearBooleanTarget(selection.rules, answer) })}
                >
                  <Icon name="x" size={13} />
                </button>
              )}
            </span>
          </div>
        )
      })}
    </>
  )

  const evaluator = decision && (
    <span className="inline-flex h-6 min-w-0 items-center gap-[6px] rounded-[5px] border border-(--border-subtle) bg-(--surface-sunken) px-2 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)">
      <Icon name="lock" size={11} className="flex-none text-(--text-tertiary)" />
      {t('evaluator')}
      <span className="truncate font-mono text-(--text-primary)">
        {DECISION_PROVIDER_PROFILES.find((profile) => profile.id === decision.providerId)?.name ?? decision.providerId}{' '}
        · {decision.model}
      </span>
    </span>
  )

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[15px] font-semibold">{t('title')}</h3>
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
          <div className="w-[340px] max-w-full">{fallbackPicker(false)}</div>
        </div>
      ) : (
        <>
          {stepIndex >= 0 && (
            <nav aria-label={t('decisionPath')} className="flex flex-wrap items-center gap-1 text-[12px]">
              <button type="button" className="lnk" onClick={() => to(0)}>
                {rootDecision?.name ?? t('firstDecision')}
              </button>
              {stepPath.map((id, index) => {
                const step = configuration?.steps?.find((entry) => entry.id === id)
                const name = decisions.find((entry) => entry.id === step?.decisionId)?.name ?? t('nextDecision')
                return (
                  <span key={`${id}:${index}`} className="inline-flex items-center gap-1">
                    <Icon name="chevron-right" size={12} />
                    <button
                      type="button"
                      className="lnk"
                      aria-current={index === stepPath.length - 1 ? 'page' : undefined}
                      onClick={() => to(index + 1)}
                    >
                      {name}
                    </button>
                  </span>
                )
              })}
            </nav>
          )}
          <div className="flex flex-wrap items-center gap-[10px]">
            <DecisionPicker
              decisions={decisions}
              value={value?.decisionId}
              placeholder={retained?.find((item) => item.id === value?.decisionId)?.name ?? t('chooseDecision')}
              loading={loading}
              triggerClassName="block w-[260px] min-w-0 max-w-full"
              onSelect={(entry) => selectDecision(entry.id)}
              create={{ href: orgPath('/decisions/new'), newTab: true }}
            />
            {evaluator}
            {decision && (
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
            )}
          </div>
          {value && !decision && (
            <p className="m-0 text-[12px] text-(--text-secondary)">{loading ? t('loading') : t('retained')}</p>
          )}
          <div className="rounded-lg border border-(--border-default) bg-(--surface-card)">
            {value && decision?.question.type === 'choice' && choiceTable(decision.question, value)}
            {value && decision?.question.type === 'score' && scoreTable(value)}
            {value && decision?.question.type === 'boolean' && booleanTable(value)}
            {fallbackPanel}
          </div>
          {configuration && rootDecision && (
            <RuntimeSelectionSample
              question={rootDecision.question}
              selection={configuration}
              decisions={decisions}
              fallback={fallback}
              source={source}
              valid={valid}
            />
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
          className={`inp mn h-[30px] min-h-0 w-full cursor-pointer gap-2 px-[9px] py-0 text-left text-[12px] font-medium hover:border-(--border-strong) ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          title={answers[value]}
          onClick={toggle}
        >
          <span className="min-w-0 flex-1 truncate">{value}</span>
          <Icon
            name="chevron-down"
            size={14}
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
