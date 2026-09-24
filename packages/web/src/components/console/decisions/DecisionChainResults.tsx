'use client'

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DecisionChainTrace } from '@agentconnect.md/protocol/decision'

export function DecisionChainResults({
  chain,
  names = []
}: {
  chain?: DecisionChainTrace
  names?: Array<{ id: string; name: string }>
}) {
  const t = useTranslations('Decisions')
  if (!chain?.length) return null
  return (
    <ol
      aria-label={t('chain.path')}
      className="m-0 flex list-none flex-col gap-2 rounded-md border border-(--border-subtle) p-3"
    >
      {chain.map((step, index) => {
        const result = step.evaluation
        const answer = result.status === 'answered' ? result.answer : null
        const value =
          answer?.type === 'boolean'
            ? t(answer.value ? 'condition.yes' : 'condition.no')
            : answer
              ? String(answer.value)
              : result.status === 'unavailable'
                ? t(`try.failures.${result.reason}`)
                : ''
        return (
          <li key={step.stepId} className="flex min-w-0 items-center gap-2 text-[12px]">
            <span className="text-(--text-tertiary)">{index + 1}</span>
            <Icon name="split" size={13} className="flex-none text-(--text-tertiary)" />
            <span className="min-w-0 flex-1 truncate">
              {names.find((d) => d.id === step.decisionId)?.name ?? `Decision ${index + 1}`}
            </span>
            <span className="font-mono text-(--text-secondary)">{value}</span>
          </li>
        )
      })}
    </ol>
  )
}
