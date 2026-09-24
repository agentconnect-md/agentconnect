'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'

export { reachableSteps } from '@/lib/decisions/chain'

export function DecisionChainNav({
  path,
  onBack
}: {
  path: Array<{ id: string; name: string }>
  onBack: (index: number) => void
}) {
  const t = useTranslations('Decisions.chain')
  return (
    <nav aria-label={t('path')} className="flex flex-wrap items-center gap-1 text-[12px] text-(--text-secondary)">
      {path.map((step, index) => (
        <span key={step.id} className="inline-flex min-w-0 items-center gap-1">
          {index > 0 && <Icon name="chevron-right" size={12} />}
          <button
            type="button"
            className="lnk max-w-[180px] truncate"
            onClick={() => onBack(index)}
            aria-current={index === path.length - 1 ? 'step' : undefined}
          >
            {step.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

export function NextDecision({
  decisions,
  disabled,
  onSelect
}: {
  decisions: DecisionDefinition[]
  disabled?: boolean
  onSelect: (decision: DecisionDefinition) => void
}) {
  const t = useTranslations('Decisions.chain')
  return (
    <AnchoredFlyout
      ariaLabel={t('next')}
      align="end"
      width={260}
      estimatedHeight={Math.min(320, decisions.length * 36 + 12)}
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          className="iconbtn h-[30px] w-[30px] flex-none"
          title={t('next')}
          aria-label={t('next')}
          disabled={disabled || !decisions.length}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
        >
          <Icon name="git-branch" size={14} />
        </button>
      )}
    >
      {({ close }) =>
        decisions.map((decision) => (
          <button
            type="button"
            role="menuitem"
            key={decision.id}
            className="fopt"
            onClick={() => {
              close(true)
              onSelect(decision)
            }}
          >
            <Icon name="split" size={13} />
            <span className="min-w-0 truncate">{decision.name}</span>
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}

export const RoutingChainContext = createContext<{
  decisions: DecisionDefinition[]
  steps: Array<{ id: string; decisionId: string }>
  canAdd: boolean
  add(decision: DecisionDefinition): string
  open(id: string): void
} | null>(null)

export function RoutingContinuation({
  nextStepId,
  disabled,
  onChange,
  children
}: {
  nextStepId?: string
  disabled: boolean
  onChange: (id: string | null) => void
  children: ReactNode
}) {
  const chain = useContext(RoutingChainContext)
  const t = useTranslations('Decisions.chain')
  if (!chain) return children
  const step = chain.steps.find((entry) => entry.id === nextStepId)
  return (
    <span className="flex min-w-0 items-center gap-1">
      {nextStepId ? (
        <>
          <button
            type="button"
            className="inp h-[30px] min-h-0 min-w-0 flex-1 gap-2 text-[12px]"
            disabled={disabled}
            onClick={() => chain.open(nextStepId)}
          >
            <Icon name="split" size={13} />
            <span className="truncate">
              {chain.decisions.find((d) => d.id === step?.decisionId)?.name ?? t('missing')}
            </span>
            <Icon name="chevron-right" size={12} />
          </button>
          <button
            type="button"
            className="iconbtn h-7 w-7 flex-none"
            disabled={disabled}
            aria-label={t('remove')}
            title={t('remove')}
            onClick={() => onChange(null)}
          >
            <Icon name="x" size={12} />
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">{children}</span>
          <NextDecision
            decisions={chain.decisions}
            disabled={disabled || !chain.canAdd}
            onSelect={(decision) => onChange(chain.add(decision))}
          />
        </>
      )}
    </span>
  )
}
