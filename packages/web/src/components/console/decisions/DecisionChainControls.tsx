'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction
} from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { DecisionChip } from './DecisionChip'
import { DecisionHoverRows } from './DecisionPicker'

export { reachableSteps } from '@/lib/decisions/chain'

type ChainHost = {
  back: MutableRefObject<((keep: boolean) => void) | null>
  setDepth: Dispatch<SetStateAction<number>>
}
const ChainHostContext = createContext<ChainHost | null>(null)
export const DecisionChainHost = ChainHostContext.Provider

// A modal's side of a cascade: Save, Cancel and Escape leave an open lower level before they act on the modal.
export function useDecisionChainHost() {
  const back = useRef<((keep: boolean) => void) | null>(null)
  const [depth, setDepth] = useState(0)
  const leave = useCallback((keep: boolean) => {
    if (!back.current) return false
    back.current(keep)
    return true
  }, [])
  return { host: { back, setDepth }, depth, leave }
}

// A cascade's open path; each level remembers the value on entry so Cancel can restore it.
export function useDecisionChainPath<T>(value: T, restore: (value: T) => void) {
  const [levels, setLevels] = useState<Array<{ id: string; entry: T }>>([])
  const host = useContext(ChainHostContext)
  const back = (keep: boolean) => {
    const last = levels.at(-1)
    if (!last) return
    if (!keep) restore(last.entry)
    setLevels(levels.slice(0, -1))
  }
  useEffect(() => {
    if (!host) return
    host.back.current = levels.length ? back : null
    host.setDepth(levels.length)
  })
  useEffect(
    () => () => {
      if (!host) return
      host.back.current = null
      host.setDepth(0)
    },
    [host]
  )
  return {
    path: levels.map((level) => level.id),
    enter: (id: string) => setLevels([...levels, { id, entry: value }]),
    to: (depth: number) => setLevels(levels.slice(0, depth))
  }
}

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
  ariaLabel,
  onSelect
}: {
  decisions: DecisionDefinition[]
  disabled?: boolean
  ariaLabel?: string
  onSelect: (decision: DecisionDefinition) => void
}) {
  const t = useTranslations('Decisions.chain')
  return (
    <AnchoredFlyout
      ariaLabel={t('next')}
      align="end"
      width={260}
      estimatedHeight={Math.min(320, decisions.length * 36 + 12)}
      triggerClassName="flex flex-none"
      trigger={({ open, menuId, toggle }) => (
        <DecisionChip
          name={null}
          label={ariaLabel ?? t('next')}
          title={t('next')}
          disabled={disabled || !decisions.length}
          openProps={{ 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? menuId : undefined }}
          onOpen={toggle}
        />
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

// A chosen next Decision: its chip opens the lower level, and × removes the continuation.
export function NextDecisionChip({
  decision,
  name,
  label,
  removeLabel,
  disabled,
  onOpen,
  onRemove
}: {
  decision?: DecisionDefinition
  name: string
  label?: string
  removeLabel?: string
  disabled?: boolean
  onOpen: () => void
  onRemove?: () => void
}) {
  const t = useTranslations('Decisions.chain')
  return (
    <DecisionChip
      fill
      name={name}
      label={label}
      onOpen={onOpen}
      hover={decision && <DecisionHoverRows decision={decision} />}
      remove={onRemove && !disabled ? { label: removeLabel ?? t('remove'), onClick: onRemove } : undefined}
    />
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
  const next = chain.decisions.find((d) => d.id === step?.decisionId)
  return (
    <span className="flex min-w-0 items-center gap-1">
      {nextStepId ? (
        <NextDecisionChip
          decision={next}
          name={next?.name ?? t('missing')}
          disabled={disabled}
          onOpen={() => chain.open(nextStepId)}
          onRemove={() => onChange(null)}
        />
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
