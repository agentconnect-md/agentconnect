'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import { fetchAgentModelEvaluations } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { answerText } from '@/lib/decisions/evaluations'
import { ModelSelectionEvaluationsDrawer, type ModelEvaluationsTarget } from './ModelSelectionEvaluations'

// Read the session's frozen choice independently of its agent's current Decision binding.
export function SessionModelSelectionResult({
  target,
  sessionId,
  pending = false
}: {
  target: ModelEvaluationsTarget
  sessionId?: string
  pending?: boolean
}) {
  const { activeOrg } = useOrgs()
  const t = useTranslations('Sessions.decisionResult')
  const decisions = useTranslations('Decisions')
  const outcomes = useTranslations('Agents.dialog.modelSelection.evaluations')
  const [open, setOpen] = useState(false)
  const enabled = target.live && !!activeOrg?.id && !!sessionId && !sessionId.startsWith('pg_')
  const { data } = useSWR(
    enabled ? ['session-model-evaluation', activeOrg!.id, target.agentId, sessionId, pending] : null,
    async () => {
      const page = await fetchAgentModelEvaluations(target.agentId, { sessionId, limit: 1 }, activeOrg!.id)
      return page.items.find((item) => item.sessionId === sessionId) ?? null
    },
    { shouldRetryOnError: false, refreshInterval: (latest) => (pending && !latest ? 2000 : 0) }
  )
  if (!enabled || !data) return null
  const answer = answerText(data.answer, { yes: decisions('condition.yes'), no: decisions('condition.no') })
  return (
    <div className="flex justify-center py-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('open')}
        className="flex min-w-0 max-w-full cursor-pointer items-center gap-[7px] rounded-full border border-(--border-subtle) bg-(--surface-card) px-[11px] py-1 text-left hover:bg-(--surface-hover)"
      >
        <Icon name="git-branch" size={12} className="flex-none text-(--text-tertiary)" />
        <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          {t('modelSelection')} · {target.agentName} · {outcomes(`outcome.${data.outcome}`)}
          {answer && <span className="mono text-[11px] text-(--text-tertiary)"> · {answer}</span>}
        </span>
        <Icon name="chevron-right" size={12} className="flex-none text-(--text-tertiary)" />
      </button>
      {open && (
        <ModelSelectionEvaluationsDrawer
          target={target}
          sessionId={sessionId}
          initialSeq={data.seq}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
