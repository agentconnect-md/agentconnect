'use client'

// "Trigger when": one control set per question type, so no two surfaces describe a condition differently.

import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { Icon } from '@/components/ui'
import type { DecisionCondition, DecisionQuestion, DecisionValidationIssue } from '@agentconnect.md/protocol/decision'

/** The pill toggle every condition control uses — an enabled answer, a picked value, a level. */
export function Chip({
  on,
  onClick,
  disabled,
  title,
  children
}: {
  on: boolean
  onClick?: () => void
  disabled?: boolean
  title?: string
  children: ReactNode
}) {
  const base =
    'inline-flex items-center gap-[5px] rounded-full border px-[9px] py-1 font-mono text-[11.5px] leading-normal'
  const tone = on
    ? 'border-(--brand) bg-(--brand-soft) font-semibold text-(--brand-soft-text)'
    : 'border-(--border-default) bg-transparent font-medium text-(--text-secondary)'
  if (!onClick) return <span className={`${base} ${tone}`}>{children}</span>
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      className={`${base} ${tone} ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
    >
      {on && <Icon name="check" size={12} />}
      {children}
    </button>
  )
}

/** The interval as the design prints it: half-open, except that the rubric maximum is included. */
export function intervalText(condition: Extract<DecisionCondition, { type: 'score' }>, levels: number): string {
  const maximum = levels - 1
  return `${condition.min} ≤ score ${condition.max >= maximum ? '≤ ' : '< '}${condition.max}`
}

export function DecisionConditionFields({
  question,
  value,
  onChange,
  issues
}: {
  question: DecisionQuestion
  value: DecisionCondition
  onChange: (next: DecisionCondition) => void
  /** The condition's own validation issues; the editor renders the first one beneath the controls. */
  issues: DecisionValidationIssue[]
}) {
  const t = useTranslations('Decisions.condition')
  const invalid = issues.length > 0

  if (question.type === 'choice' && value.type === 'choice') {
    const thresholds = value.thresholds
    return (
      <div className="flex flex-col gap-[7px]">
        {Object.entries(question.criteria).map(([key, description]) => {
          const enabled = Object.hasOwn(thresholds, key)
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <Chip
                on={enabled}
                title={description}
                onClick={() => {
                  const next = { ...thresholds }
                  if (enabled) delete next[key]
                  else next[key] = 0.3
                  onChange({ type: 'choice', thresholds: next })
                }}
              >
                {key}
              </Chip>
              {enabled && (
                <>
                  <span className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('min')}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round((thresholds[key] ?? 0.3) * 100)}
                    aria-label={t('minimumProbability', { answer: key })}
                    onChange={(event) => {
                      const percent = event.target.value === '' ? 0 : Number(event.target.value)
                      const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
                      onChange({ type: 'choice', thresholds: { ...thresholds, [key]: bounded / 100 } })
                    }}
                    className="inp mn h-7 w-[66px] min-h-0 text-center"
                  />
                  <span className="font-mono text-[11.5px] leading-normal text-(--text-tertiary)">%</span>
                </>
              )}
            </div>
          )
        })}
        {/* A key the question no longer has stays visible, so a repair can remove it instead of being stuck invalid. */}
        {Object.keys(thresholds)
          .filter((key) => !Object.hasOwn(question.criteria, key))
          .map((key) => (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <Chip
                on
                title={t('removedChoice')}
                onClick={() => {
                  const next = { ...thresholds }
                  delete next[key]
                  onChange({ type: 'choice', thresholds: next })
                }}
              >
                <s>{key}</s>
              </Chip>
              <span className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
                {t('removedChoice')}
              </span>
            </div>
          ))}
        <span className="font-sans text-[11px] leading-[1.5] text-(--text-tertiary)">{t('choiceHelp')}</span>
        {invalid && <ConditionIssue issue={issues[0]!} />}
      </div>
    )
  }

  if (question.type === 'boolean' && value.type === 'boolean') {
    return (
      <div className="flex flex-col gap-[7px]">
        <div className="flex flex-wrap gap-[6px]">
          {([true, false] as const).map((answer) => {
            const on = value.values.includes(answer)
            return (
              <Chip
                key={String(answer)}
                on={on}
                onClick={() =>
                  onChange({
                    type: 'boolean',
                    values: on ? value.values.filter((entry) => entry !== answer) : [...value.values, answer].sort()
                  })
                }
              >
                {answer ? t('yes') : t('no')}
              </Chip>
            )
          })}
        </div>
        {invalid && <ConditionIssue issue={issues[0]!} />}
      </div>
    )
  }

  if (question.type === 'score' && value.type === 'score') {
    const levels = question.criteria.length
    const maximum = levels - 1
    const fromPercent = `${(value.min / maximum) * 100}%`
    const spanPercent = `${((value.max - value.min) / maximum) * 100}%`
    const bound = (raw: string, fallback: number) => {
      const parsed = Number(raw)
      return raw === '' || !Number.isFinite(parsed) ? fallback : parsed
    }
    return (
      <div className="flex flex-col gap-[7px]">
        <div className="flex flex-wrap items-center gap-[9px]">
          <label className="flex items-center gap-2 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
            {t('from')}
            <input
              type="number"
              step={0.1}
              value={value.min}
              aria-label={t('intervalStart')}
              onChange={(event) =>
                onChange({ type: 'score', min: bound(event.target.value, value.min), max: value.max })
              }
              className="inp mn h-7 w-[66px] min-h-0 text-center"
            />
          </label>
          <label className="flex items-center gap-2 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
            {t('to')}
            <input
              type="number"
              step={0.1}
              value={value.max}
              aria-label={t('intervalEnd')}
              onChange={(event) =>
                onChange({ type: 'score', min: value.min, max: bound(event.target.value, value.max) })
              }
              className="inp mn h-7 w-[66px] min-h-0 text-center"
            />
          </label>
          <div className="relative h-[26px] min-w-[150px] flex-1">
            <div className="absolute inset-x-0 top-[11px] h-1 rounded-[3px] bg-(--gray-200)" />
            <div
              className="absolute top-[11px] h-1 rounded-[3px] bg-(--brand)"
              style={{ left: fromPercent, width: spanPercent }}
            />
            <input
              type="range"
              min={0}
              max={maximum}
              step={0.1}
              value={value.min}
              aria-label={t('intervalStart')}
              onChange={(event) =>
                onChange({ type: 'score', min: Math.min(Number(event.target.value), value.max - 0.1), max: value.max })
              }
              className="pointer-events-none absolute inset-0 h-[26px] w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-(--surface-card) [&::-moz-range-thumb]:bg-(--brand) [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-(--surface-card) [&::-webkit-slider-thumb]:bg-(--brand)"
            />
            <input
              type="range"
              min={0}
              max={maximum}
              step={0.1}
              value={value.max}
              aria-label={t('intervalEnd')}
              onChange={(event) =>
                onChange({ type: 'score', min: value.min, max: Math.max(Number(event.target.value), value.min + 0.1) })
              }
              className="pointer-events-none absolute inset-0 h-[26px] w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-(--surface-card) [&::-moz-range-thumb]:bg-(--brand) [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-(--surface-card) [&::-webkit-slider-thumb]:bg-(--brand)"
            />
          </div>
          <span className="flex-none font-mono text-[11.5px] leading-normal text-(--text-secondary)">
            {intervalText(value, levels)}
          </span>
        </div>
        {invalid && <ConditionIssue issue={issues[0]!} />}
      </div>
    )
  }

  return null
}

function ConditionIssue({ issue }: { issue: DecisionValidationIssue }) {
  return (
    <div className="flex items-start gap-[7px] font-sans text-[11.5px] leading-[1.5] text-(--red-600)">
      <Icon name="triangle-alert" size={12} className="mt-[2px] flex-none" />
      <span>{issue.message}</span>
    </div>
  )
}
