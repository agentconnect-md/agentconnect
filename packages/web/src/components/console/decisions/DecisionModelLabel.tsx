'use client'

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'

export interface DecisionModelSummary {
  /** The Decision's name, or a generic label where the viewer cannot see it. */
  name: string
  rules?: readonly { when: string; then: string }[]
  /** The model used when no rule matches. */
  fallback?: string
}

const HOVER_RULE = 'grid grid-cols-[16px_auto_12px_minmax(0,1fr)] items-center gap-[6px]'
const HOVER_NUM =
  'flex h-4 w-4 items-center justify-center rounded-xs font-mono text-[9.5px] font-semibold leading-normal text-(--text-secondary)'

// The hover card for a runtime picked by Decision: the Decision, then each rule and the fallback.
export function DecisionModelHover({ name, rules, fallback }: DecisionModelSummary) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  return (
    <>
      <HoverCardRows
        rows={[
          [t('model'), t('byDecision')],
          [t('decision'), name]
        ]}
      />
      {(!!rules?.length || !!fallback) && (
        <span className="mt-2 flex flex-col gap-1 border-t border-(--border-subtle) pt-2">
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
              <span className="font-sans text-[11px] leading-normal text-(--text-tertiary)">{t('fallback')}</span>
              <Icon name="arrow-right" size={11} className="text-(--text-tertiary)" />
              <span className="truncate font-mono text-[11px] leading-normal text-(--text-secondary)">{fallback}</span>
            </span>
          )}
        </span>
      )}
    </>
  )
}

// A read-only runtime picked by Decision: the split icon and the Decision's name, its rules on hover.
export function DecisionModelLabel({ size = 13, ...summary }: DecisionModelSummary & { size?: number }) {
  const hover = useHoverCard()
  return (
    <>
      <span {...hover.triggerProps} className="inline-flex min-w-0 items-center gap-[6px]">
        <Icon name="split" size={size} className="flex-none text-(--brand)" />
        <span className="truncate">{summary.name}</span>
      </span>
      {hover.card(<DecisionModelHover {...summary} />)}
    </>
  )
}
