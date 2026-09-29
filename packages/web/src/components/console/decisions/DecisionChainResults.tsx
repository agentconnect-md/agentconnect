'use client'

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DecisionChainTrace } from '@agentconnect.md/protocol/decision'

export function DecisionChainResults({
  chain,
  names = [],
  selected,
  onSelect
}: {
  chain?: DecisionChainTrace
  names?: Array<{ id: string; name: string }>
  /** The step whose Model result is shown; rows are buttons only when `onSelect` is given. */
  selected?: number
  onSelect?: (index: number) => void
}) {
  const t = useTranslations('Decisions')
  if (!chain?.length) return null
  return (
    <ol
      aria-label={t('chain.path')}
      className={`m-0 flex list-none flex-col rounded-md border border-(--border-subtle) ${onSelect ? 'gap-[2px] p-[5px]' : 'gap-2 p-3'}`}
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
        const content = (
          <>
            <span className="text-(--text-tertiary)">{index + 1}</span>
            <Icon name="split" size={13} className="flex-none text-(--text-tertiary)" />
            <span className="min-w-0 flex-1 truncate">
              {names.find((d) => d.id === step.decisionId)?.name ?? `Decision ${index + 1}`}
            </span>
            <span className="font-mono text-(--text-secondary)">{value}</span>
          </>
        )
        return (
          <li key={step.stepId} className="flex min-w-0 items-center gap-2 text-[12px]">
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selected === index}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm px-[7px] py-[5px] text-left ${selected === index ? 'bg-(--surface-active) font-medium' : 'hover:bg-(--surface-hover)'}`}
                onClick={() => onSelect(index)}
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        )
      })}
    </ol>
  )
}
