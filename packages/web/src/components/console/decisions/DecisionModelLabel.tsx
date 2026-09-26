'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'
import { ModelSelectionEvaluationsDrawer, type ModelEvaluationsTarget } from './ModelSelectionEvaluations'

export interface DecisionModelSummary {
  /** The Decision's name, or a generic label where the viewer cannot see it. */
  name: string
  rules?: readonly { when: string; then: string }[]
  /** The model used when no rule matches. */
  fallback?: string
  /** The Decision's page, when the viewer can see it. */
  decisionHref?: string
  /** Whose model selections the card's Recent evaluations link opens. */
  evaluations?: ModelEvaluationsTarget
}

const HOVER_RULE = 'grid grid-cols-[16px_auto_12px_minmax(0,1fr)] items-center gap-[6px]'
const HOVER_NUM =
  'flex h-4 w-4 items-center justify-center rounded-xs font-mono text-[9.5px] font-semibold leading-normal text-(--text-secondary)'

// The hover card for a runtime picked by Decision: the Decision, each rule, the fallback, then Recent evaluations.
export function DecisionModelHover({
  name,
  rules,
  fallback,
  decisionHref,
  onEvaluations
}: Omit<DecisionModelSummary, 'evaluations'> & { onEvaluations?: () => void }) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const evaluationsT = useTranslations('Agents.dialog.modelSelection.evaluations')
  return (
    <>
      <HoverCardRows
        rows={[
          [t('model'), t('byDecision')],
          [
            t('decision'),
            decisionHref ? (
              <Link
                href={decisionHref}
                className="underline decoration-(--border-strong) underline-offset-[3px] hover:text-(--brand-soft-text) hover:decoration-current"
              >
                {name}
              </Link>
            ) : (
              name
            )
          ]
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
      {onEvaluations && (
        <button
          type="button"
          onClick={onEvaluations}
          className="mt-2 flex w-full cursor-pointer items-center gap-[6px] border-0 border-t border-(--border-subtle) bg-transparent px-0 pb-0 pt-2 text-left font-sans text-[11.5px] font-medium leading-normal text-(--brand-soft-text) hover:underline"
        >
          <Icon name="history" size={12} className="flex-none" />
          <span className="flex-1">{evaluationsT('title')}</span>
          <Icon name="arrow-right" size={12} className="flex-none" />
        </button>
      )}
    </>
  )
}

/** Opens the Recent evaluations drawer from a By decision hover card, which unmounts as the pointer leaves. */
export function useModelEvaluationsLink(target: ModelEvaluationsTarget | undefined, hide: () => void) {
  const [open, setOpen] = useState(false)
  return {
    onEvaluations: target
      ? () => {
          hide()
          setOpen(true)
        }
      : undefined,
    drawer: target && open && <ModelSelectionEvaluationsDrawer target={target} onClose={() => setOpen(false)} />
  }
}

// A read-only runtime picked by Decision: the split icon and the Decision's name, its rules on hover.
export function DecisionModelLabel({ size = 13, evaluations, ...summary }: DecisionModelSummary & { size?: number }) {
  const hover = useHoverCard({ interactive: !!(evaluations || summary.decisionHref) })
  const link = useModelEvaluationsLink(evaluations, hover.hide)
  return (
    <>
      <span {...hover.triggerProps} className="inline-flex min-w-0 items-center gap-[6px]">
        <Icon name="split" size={size} className="flex-none text-(--brand)" />
        <span className="truncate">{summary.name}</span>
      </span>
      {hover.card(<DecisionModelHover {...summary} onEvaluations={link.onEvaluations} />)}
      {link.drawer}
    </>
  )
}
