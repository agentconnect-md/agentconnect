'use client'

// Recent evaluations of an agent's coordinator filter (auto-session-mode.md §4.7), opened from its Configuration card.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { DecisionEvaluationsDrawer } from '@/components/console/decisions/DecisionEvaluationsDrawer'
import { coordinatorFilterEvaluations } from '@/lib/decisions/evaluation-source'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'

export function CoordinatorFilterEvaluationsLink({ agentId, agentName }: { agentId: string; agentName: string }) {
  const t = useTranslations('Agents.detail')
  const words = useTranslations('Decisions')
  const prototype = useOptionalDecisionsPrototype()
  const [open, setOpen] = useState(false)
  const name = words('evaluations.coordinatorFilter.name')
  const triggerWhen = words('evaluations.coordinatorFilter.triggerWhen')
  const source = useMemo(
    () =>
      prototype ? coordinatorFilterEvaluations(prototype.api, prototype.orgId, agentId, { name, triggerWhen }) : null,
    [prototype, agentId, name, triggerWhen]
  )
  if (!source) return null
  return (
    <>
      <button type="button" className="lnk text-[11.5px] font-medium" onClick={() => setOpen(true)}>
        {t('basics.filterEvaluations')}
      </button>
      {open && <DecisionEvaluationsDrawer source={source} agentName={agentName} onClose={() => setOpen(false)} />}
    </>
  )
}
