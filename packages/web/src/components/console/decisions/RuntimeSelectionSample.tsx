'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  selectDecisionTarget,
  matchDecisionCondition,
  type AgentModelSelection,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionRuntimeTarget
} from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { AgentMark } from '@/components/marks'
import { intervalText } from './DecisionConditionFields'
import type { RuntimeModelSource } from '../RuntimeModelSelect'
import { runtimeLabel } from '@/lib/data'

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
  fallback,
  source,
  valid
}: {
  question: DecisionQuestion
  selection: AgentModelSelection
  fallback: DecisionRuntimeTarget
  source?: RuntimeModelSource
  valid: boolean
}) {
  const t = useTranslations('Agents.dialog.modelSelection.sample')
  const [sample, setSample] = useState<0 | 1 | 2 | 3 | 4>(0)
  const answer = sampleAnswer(question, sample)
  const selected = valid && answer ? selectDecisionTarget(question, selection, answer) : undefined
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
  const result = !answer
    ? t('unavailable')
    : answer.type === 'choice'
      ? Object.entries(answer.probabilities)
          .map(([key, probability]) => `${key} ${Math.round(probability * 100)}%`)
          .join(' · ')
      : answer.type === 'boolean'
        ? t('booleanResult', { value: String(answer.value), probability: Math.round(answer.probability * 100) })
        : String(answer.value)
  const model =
    source?.runtimeModels
      .find((profile) => profile.runtime === target.runtime)
      ?.modelCatalog?.models.find((model) => model.id === target.model)?.name ?? target.model
  return (
    <details className="rounded-lg border border-(--border-subtle)">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-[13px] font-semibold">
        <span className="flex items-center gap-2">
          <Icon name="chevron-down" size={14} />
          {t('title')}
        </span>
        <span className="rounded-full bg-(--status-info-soft) px-2 py-1 text-[11px] text-(--status-info)">
          {t('badge')}
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="m-0 text-[12px] text-(--text-tertiary)">{t('help')}</p>
        {([0, 1, 2, 3, 4] as const).map((index) => (
          <button
            key={index}
            type="button"
            aria-pressed={sample === index}
            onClick={() => setSample(index)}
            className={`flex items-center gap-3 rounded-md border px-3 py-2 text-left text-[12px] ${sample === index ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle) hover:bg-(--surface-hover)'}`}
          >
            <span className="w-12 flex-none font-mono text-[10px] text-(--text-tertiary)">
              {index === 4 ? 'ERROR' : index === 1 || index === 3 ? 'PR/MR' : 'CHAT'}
            </span>
            {t(`text${index}`)}
          </button>
        ))}
        <dl className="m-0 grid grid-cols-1 gap-3 text-[12px] desktop:grid-cols-[140px_minmax(0,1fr)]">
          <dt className="font-mono uppercase text-(--text-tertiary)">{t('evaluatedText')}</dt>
          <dd className="m-0 text-(--text-secondary)">
            {t(sample === 1 || sample === 3 ? 'description' : 'opening')} · {t(`text${sample}`)}
          </dd>
          <dt className="font-mono uppercase text-(--text-tertiary)">{t('result')}</dt>
          <dd className="m-0 font-mono">{result}</dd>
        </dl>
        <div
          className={`rounded-md border p-3 text-[12px] ${selected ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle)'}`}
        >
          <strong className="mr-4">1 · {t('rules')}</strong>
          {!valid
            ? t('invalid')
            : winner
              ? t('matched', {
                  index: winner.index + 1,
                  condition,
                  runtime: runtimeLabel(target.runtime),
                  model: target.model
                })
              : t('noMatch')}
        </div>
        <div
          className={`rounded-md border p-3 text-[12px] ${!selected ? 'border-(--brand) bg-(--brand-soft)' : 'border-(--border-subtle)'}`}
        >
          <strong className="mr-4">2 · {t('fallback')}</strong>
          {selected ? t('notNeeded') : t('fallbackUsed')}
        </div>
        <div className="flex items-center gap-2 border-t border-(--border-subtle) pt-3 text-[13px]">
          <span className="text-(--text-tertiary)">{t('startsOn')}</span>
          <span className="inline-flex h-5 w-5">
            <AgentMark model={target.runtime} />
          </span>
          <strong>{model}</strong>
          <span className="font-mono text-[11px] text-(--text-tertiary)">{runtimeLabel(target.runtime)}</span>
        </div>
      </div>
    </details>
  )
}
