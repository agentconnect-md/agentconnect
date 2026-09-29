'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { modelUsageRules, type AgentModelSelection, type DecisionQuestion } from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { useHoverCard } from '@/components/ui/HoverCard'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import { DecisionRulesHover, decisionRow, useRuleLines } from './DecisionRulesHover'
import { ModelSelectionEvaluationsDrawer, type ModelEvaluationsTarget } from './ModelSelectionEvaluations'

export interface DecisionModelSummary {
  /** The Decision's name, or a generic label where the viewer cannot see it. */
  name: string
  /** The agent's model selection; the card lists its first step's rules. */
  selection: AgentModelSelection
  /** The first step's question, when the viewer can see its Decision. */
  question?: DecisionQuestion
  /** The agent's own runtime and model, used when no rule matches. */
  fallback: { runtime: string; model: string }
  /** The Decision's page, when the viewer can see it. */
  decisionHref?: string
  /** Whose model selections the card's Recent evaluations link opens. */
  evaluations?: ModelEvaluationsTarget
}

// The hover card for a runtime picked by Decision: the Decision, each rule, the fallback, then Recent evaluations.
export function DecisionModelHover({
  name,
  selection,
  question,
  fallback,
  decisionHref,
  onEvaluations
}: Omit<DecisionModelSummary, 'evaluations'> & { onEvaluations?: () => void }) {
  const t = useTranslations('Agents.dialog.runtimeModel')
  const decisions = useOptionalDecisionsPrototype()?.decisions
  const lines = useRuleLines()(modelUsageRules(selection, selection.decisionId, fallback), question, {
    decision: (id) => decisions?.find((entry) => entry.id === id)?.name
  })
  return (
    <DecisionRulesHover
      rows={[[t('model'), t('byDecision')], decisionRow(t('decision'), name, decisionHref)]}
      rules={lines.rules}
      fallback={lines.fallback?.then ? lines.fallback : undefined}
      onEvaluations={onEvaluations}
    />
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
