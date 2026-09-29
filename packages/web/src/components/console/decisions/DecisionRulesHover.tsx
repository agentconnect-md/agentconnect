'use client'

// The hover card every placed Decision shares: header rows, each rule as `when → then`, the fallback, Recent evaluations.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { DecisionQuestion, DecisionUsageRules, DecisionUsageTarget } from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { HoverCardRows } from '@/components/ui/HoverCard'
import { conditionSummary } from './DecisionConditionFields'

export interface RuleLine {
  when: string
  then: string
}

export interface RuleLines {
  rules: RuleLine[]
  fallback?: { label: string; then: string }
}

const HOVER_RULE = 'grid grid-cols-[16px_auto_12px_minmax(0,1fr)] items-center gap-[6px]'
const HOVER_NUM =
  'flex h-4 w-4 items-center justify-center rounded-xs font-mono text-[9.5px] font-semibold leading-normal text-(--text-secondary)'

/** The card's Decision row, linked when the viewer can open the Decision. */
export function decisionRow(label: string, name: string, href?: string | null): readonly [string, ReactNode] {
  return [
    label,
    href ? (
      <Link
        href={href}
        className="underline decoration-(--border-strong) underline-offset-[3px] hover:text-(--brand-soft-text) hover:decoration-current"
      >
        {name}
      </Link>
    ) : (
      name
    )
  ]
}

export function DecisionRulesHover({
  rows,
  rules,
  fallback,
  onEvaluations
}: Partial<RuleLines> & {
  rows?: readonly (readonly [string, ReactNode])[]
  onEvaluations?: () => void
}) {
  const t = useTranslations('Decisions')
  const ruled = !!rules?.length || !!fallback
  return (
    <>
      {!!rows?.length && <HoverCardRows rows={rows} />}
      {ruled && (
        <span className={`flex flex-col gap-1 ${rows?.length ? 'mt-2 border-t border-(--border-subtle) pt-2' : ''}`}>
          {rules?.map((rule, index) => (
            <span key={index} className={HOVER_RULE}>
              <span className={`${HOVER_NUM} bg-(--surface-active)`}>{index + 1}</span>
              <span className="whitespace-nowrap font-mono text-[11px] leading-normal text-(--text-primary)">
                {rule.when}
              </span>
              <Icon name="arrow-right" size={11} className="text-(--text-tertiary)" />
              <span className="truncate font-mono text-[11px] leading-normal text-(--text-secondary)">{rule.then}</span>
            </span>
          ))}
          {fallback && (
            <span className={HOVER_RULE}>
              <span className={`${HOVER_NUM} bg-(--surface-sunken)`}>—</span>
              <span className="font-sans text-[11px] leading-normal text-(--text-tertiary)">{fallback.label}</span>
              <Icon name="arrow-right" size={11} className="text-(--text-tertiary)" />
              <span className="truncate font-mono text-[11px] leading-normal text-(--text-secondary)">
                {fallback.then}
              </span>
            </span>
          )}
        </span>
      )}
      {onEvaluations && (
        <button
          type="button"
          onClick={onEvaluations}
          className={`flex w-full cursor-pointer items-center gap-[6px] border-0 bg-transparent px-0 pb-0 text-left font-sans text-[11.5px] font-medium leading-normal text-(--brand-soft-text) hover:underline ${
            rows?.length || ruled ? 'mt-2 border-t border-(--border-subtle) pt-2' : 'pt-0'
          }`}
        >
          <Icon name="rotate-ccw-clock" size={12} className="flex-none" />
          <span className="flex-1">{t('routing.recentEvaluations')}</span>
          <Icon name="arrow-right" size={12} className="flex-none" />
        </button>
      )}
    </>
  )
}

/** Words a place's rules: conditions by the Decision's question, targets by the names the viewer can see. */
export function useRuleLines() {
  const t = useTranslations('Decisions')
  const modelT = useTranslations('Agents.dialog.runtimeModel')
  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  return (
    step: Partial<DecisionUsageRules> | null | undefined,
    question: DecisionQuestion | undefined,
    names: { agent?: (id: string) => string | undefined; decision?: (id: string) => string | undefined } = {}
  ): RuleLines => {
    const target = (then: DecisionUsageTarget) => {
      switch (then.type) {
        case 'trigger':
          return t('chain.trigger')
        case 'skip':
          return t('chain.skip')
        case 'default_agent':
          return t('routing.otherwise.default')
        case 'agent':
          return names.agent?.(then.agentId) ?? t('routing.action.hiddenAgent')
        case 'model':
          return then.model || then.runtime
        case 'decision':
          return names.decision?.(then.decisionId) ?? t('chain.missing')
      }
    }
    const otherwise = step?.otherwise
    return {
      rules: (step?.rules ?? []).map((rule) => ({
        when: conditionSummary(question, rule.when, words),
        then: target(rule.then)
      })),
      ...(otherwise
        ? {
            fallback: {
              label: otherwise.type === 'model' ? modelT('fallback') : t('routing.otherwise.label'),
              then: target(otherwise)
            }
          }
        : {})
    }
  }
}
