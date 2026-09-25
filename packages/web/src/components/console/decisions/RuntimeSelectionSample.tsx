'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  selectDecisionTarget,
  matchDecisionCondition,
  type AgentModelSelection,
  type DecisionAnswer,
  type DecisionDefinition,
  type DecisionModelStep,
  type DecisionQuestion,
  type DecisionRuntimeTarget
} from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { AgentMark, MarkSlot } from '@/components/marks'
import { intervalText } from './DecisionConditionFields'
import type { RuntimeModelSource } from '../RuntimeModelSelect'
import { runtimeLabel } from '@/lib/data'

const SECTION_LABEL =
  'font-mono text-[10.5px] font-semibold uppercase leading-normal tracking-[0.06em] text-(--text-tertiary)'

// Illustrative answers exercise the current rules without making provider requests.
export function sampleAnswer(question: DecisionQuestion, sample: number): DecisionAnswer | undefined {
  if (sample === 4) return undefined
  if (question.type === 'boolean')
    return { type: 'boolean', value: sample !== 2, probability: sample === 2 ? 0.2 : 0.8 }
  if (question.type === 'score') {
    const value = (question.criteria.length - 1) * [0.8, 0.5, 0.1, 0][sample]!
    const probabilities = question.criteria.map((_, index) => Math.max(0, 1 - Math.abs(index - value)))
    return {
      type: 'score',
      confidence: Math.max(...probabilities),
      probabilities,
      value
    }
  }
  const keys = Object.keys(question.criteria)
  const winner = keys[sample % keys.length]!
  return {
    type: 'choice',
    confidence: 0.78,
    value: winner,
    probabilities: Object.fromEntries(
      keys.map((key) => [key, keys.length === 1 ? 1 : key === winner ? 0.78 : 0.22 / (keys.length - 1)])
    )
  }
}

export function RuntimeSelectionSample({
  question,
  selection,
  decisions = [],
  fallback,
  source,
  valid
}: {
  question: DecisionQuestion
  selection: AgentModelSelection
  decisions?: readonly Pick<DecisionDefinition, 'id' | 'name' | 'question'>[]
  fallback: DecisionRuntimeTarget
  source?: RuntimeModelSource
  valid: boolean
}) {
  const t = useTranslations('Agents.dialog.modelSelection.sample')
  const [sample, setSample] = useState<0 | 1 | 2 | 3 | 4>(0)
  const answer = sampleAnswer(question, sample)
  let selected: DecisionRuntimeTarget | undefined
  const evaluatedSteps: Array<{ name: string; matched: boolean }> = []
  if (valid && answer) {
    let step: DecisionModelStep = selection
    let currentQuestion = question
    const visited = new Set<string>()
    while (true) {
      const result = sampleAnswer(currentQuestion, sample)
      const target = result ? selectDecisionTarget(currentQuestion, step, result) : undefined
      if (!target) break
      if ('runtime' in target) {
        selected = target
        break
      }
      if (visited.has(target.nextStepId)) break
      visited.add(target.nextStepId)
      const next = selection.steps?.find((entry) => entry.id === target.nextStepId)
      const definition = decisions.find((entry) => entry.id === next?.decisionId)
      if (!next || !definition) break
      const nextAnswer = sampleAnswer(definition.question, sample)
      evaluatedSteps.push({
        name: definition.name,
        matched: !!nextAnswer && !!selectDecisionTarget(definition.question, next, nextAnswer)
      })
      step = next
      currentQuestion = definition.question
    }
  }
  const target = selected ?? fallback
  const matches =
    valid && answer
      ? selection.rules
          .map((rule, index) => {
            const match = matchDecisionCondition(question, rule.when, answer)
            const probability =
              answer.type === 'choice' && match.matched
                ? Math.max(...match.matchedKeys.map((key) => answer.probabilities[key]!))
                : 1
            return { index, match, probability }
          })
          .filter((entry) => entry.match.matched)
          .sort((a, b) => b.probability - a.probability)
      : []
  const winner = matches[0]
  const winningRule = winner ? selection.rules[winner.index] : undefined
  const winningCondition = winner ? selection.rules[winner.index]!.when : undefined
  const condition =
    winningCondition?.type === 'choice' && answer?.type === 'choice'
      ? winner!.match.matchedKeys
          .map(
            (key) =>
              `${key} ${Math.round(answer.probabilities[key]! * 100)}% ≥ ${Math.round(winningCondition.thresholds[key]! * 100)}%`
          )
          .join(' · ')
      : winningCondition?.type === 'score' && question.type === 'score'
        ? intervalText(winningCondition, question.criteria.length)
        : winningCondition?.type === 'boolean'
          ? winningCondition.values.join(', ')
          : ''
  const model =
    source?.runtimeModels
      .find((profile) => profile.runtime === target.runtime)
      ?.modelCatalog?.models.find((model) => model.id === target.model)?.name ?? target.model
  const steps = [
    {
      title: t('rules'),
      active: !!winner,
      detail: !valid
        ? t('invalid')
        : winner
          ? winningRule && 'nextStepId' in winningRule
            ? t('branchMatched', {
                index: winner.index + 1,
                condition,
                decision:
                  decisions.find(
                    (d) => d.id === selection.steps?.find((step) => step.id === winningRule.nextStepId)?.decisionId
                  )?.name ?? 'Decision'
              })
            : t('matched', { index: winner.index + 1, condition, runtime: runtimeLabel(target.runtime), model })
          : t('noMatch')
    },
    ...evaluatedSteps.map((step) => ({
      title: step.name,
      active: step.matched,
      detail: step.matched ? t('continued') : t('noMatch')
    })),
    { title: t('fallback'), active: !selected, detail: selected ? t('notNeeded') : t('fallbackUsed') }
  ]
  return (
    <details className="group rounded-md border border-(--border-subtle)">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-[10px] px-4 py-[9px] [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-sans text-[13px] font-semibold leading-normal">
          <Icon
            name="chevron-down"
            size={13}
            className="flex-none -rotate-90 text-(--text-tertiary) transition-transform group-open:rotate-0"
          />
          {t('title')}
        </span>
        <span
          title={t('help')}
          className="inline-flex items-center gap-[5px] rounded-full bg-(--status-info-soft) px-2 py-[2px] font-sans text-[11px] font-semibold leading-normal text-(--status-info)"
        >
          <Icon name="flask-conical" size={11} />
          {t('badge')}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-(--border-subtle) px-4 py-[14px]">
        <div className="flex flex-col gap-1">
          {([0, 1, 2, 3, 4] as const).map((index) => (
            <button
              key={index}
              type="button"
              aria-pressed={sample === index}
              onClick={() => setSample(index)}
              className={`grid grid-cols-[44px_minmax(0,1fr)] items-center gap-2 rounded-sm border px-[9px] py-[7px] text-left transition-colors ${sample === index ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle) hover:border-(--border-strong)'}`}
            >
              <span className="font-mono text-[10.5px] font-medium uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
                {index === 4 ? 'ERROR' : index === 1 || index === 3 ? 'PR/MR' : 'CHAT'}
              </span>
              <span className="truncate font-sans text-[12px] leading-normal text-(--text-primary)">
                {t(`text${index}`)}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-[6px]">
          <span className={SECTION_LABEL}>
            {t('evaluatedText')} · {t(sample === 1 || sample === 3 ? 'trigger' : 'opening')}
          </span>
          <div className="rounded-sm border border-(--border-subtle) bg-(--surface-sunken) px-[10px] py-2 font-sans text-[12.5px] leading-[1.5] text-(--text-secondary)">
            {t(`text${sample}`)}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <span className={SECTION_LABEL}>{t('result')}</span>
          {!answer ? (
            <div className="flex items-center gap-2 rounded-sm bg-(--status-paused-soft) px-[10px] py-2 font-sans text-[12px] font-medium leading-normal">
              <Icon name="triangle-alert" size={13} color="var(--amber-500)" />
              {t('unavailable')}
            </div>
          ) : answer.type === 'choice' ? (
            <div className="flex flex-col gap-[6px]">
              {Object.entries(answer.probabilities).map(([key, probability]) => (
                <div key={key} className="grid grid-cols-[140px_minmax(0,1fr)_36px] items-center gap-2">
                  <span className="truncate font-mono text-[11.5px] font-medium leading-normal text-(--text-secondary)">
                    {key}
                  </span>
                  <span className="h-[6px] overflow-hidden rounded-[3px] bg-(--surface-sunken)">
                    <span
                      className={`block h-full rounded-[3px] ${key === answer.value ? 'bg-(--brand)' : 'bg-(--gray-300)'}`}
                      style={{ width: `${Math.round(probability * 100)}%` }}
                    />
                  </span>
                  <span className="text-right font-mono text-[11.5px] font-medium leading-normal">
                    {Math.round(probability * 100)}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="font-mono text-[13px] font-semibold leading-normal">
              {answer.type === 'boolean'
                ? t('booleanResult', { value: String(answer.value), probability: Math.round(answer.probability * 100) })
                : String(answer.value)}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-[6px]">
          {steps.map((step, index) => (
            <div
              key={index}
              aria-current={step.active ? 'step' : undefined}
              className={`grid grid-cols-[20px_minmax(0,1fr)] items-center gap-[9px] rounded-sm border px-[10px] py-[7px] ${step.active ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle)'}`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold leading-normal ${step.active ? 'bg-(--brand) text-white' : 'bg-(--surface-sunken) text-(--text-tertiary)'}`}
              >
                {index + 1}
              </span>
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span
                  className={`whitespace-nowrap font-sans text-[12.5px] leading-normal ${step.active ? 'font-semibold text-(--text-primary)' : 'font-medium text-(--text-secondary)'}`}
                >
                  {step.title}
                </span>
                <span
                  title={step.detail}
                  className="truncate font-mono text-[11.5px] leading-normal text-(--text-tertiary)"
                >
                  {step.detail}
                </span>
              </span>
            </div>
          ))}
          <div className="mt-[6px] flex items-center gap-2 border-t border-(--border-subtle) pt-[10px]">
            <span className="font-sans text-[12px] leading-normal text-(--text-tertiary)">{t('startsOn')}</span>
            <MarkSlot>
              <AgentMark model={target.runtime} fillPct={100} />
            </MarkSlot>
            <span className="font-sans text-[15px] font-semibold leading-normal tracking-[-0.01em]">{model}</span>
            <span className="font-mono text-[11px] leading-normal text-(--text-tertiary)">
              {runtimeLabel(target.runtime)}
            </span>
          </div>
        </div>
      </div>
    </details>
  )
}
