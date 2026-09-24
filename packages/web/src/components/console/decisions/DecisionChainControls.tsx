'use client'

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { DecisionChip } from './DecisionChip'
import { DecisionHoverRows } from './DecisionPicker'

export { reachableSteps } from '@/lib/decisions/chain'

// A cascade's open path; each level remembers the value on entry so Cancel can restore it.
export function useDecisionChainPath<T>(value: T, restore: (value: T) => void) {
  const [levels, setLevels] = useState<Array<{ id: string; entry: T }>>([])
  const back = (keep: boolean) => {
    const last = levels.at(-1)
    if (!last) return
    if (!keep) restore(last.entry)
    setLevels(levels.slice(0, -1))
  }
  return {
    path: levels.map((level) => level.id),
    enter: (id: string) => setLevels([...levels, { id, entry: value }]),
    to: (depth: number) => setLevels(levels.slice(0, depth)),
    back
  }
}

// Each deeper sheet sits a little lower and narrower, so the levels behind it stay visible.
const SHEET_STACK = [
  'max-w-[720px] desktop:translate-y-3 max-desktop:max-h-[86vh]',
  'max-w-[688px] desktop:translate-y-6 max-desktop:max-h-[80vh]',
  'max-w-[656px] desktop:translate-y-9 max-desktop:max-h-[74vh]'
]

// A later Decision of a chain, stacked over its parent with its own Save and Cancel.
export function DecisionChainSheet({
  depth,
  top,
  parent,
  condition,
  title,
  canWrite,
  onParent,
  onSave,
  onCancel,
  children
}: {
  /** 1 for the first Decision after the root. */
  depth: number
  /** Only the top sheet takes focus and answers Escape; everything beneath it is inert. */
  top: boolean
  /** The Decision this one follows, and the rule that leads here. */
  parent: string
  condition?: string
  title: string
  canWrite: boolean
  /** Return to the parent keeping edits, as the path link does. */
  onParent: () => void
  onSave: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const t = useTranslations('Decisions')
  const scrim = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  // Whatever held focus when this sheet opened, read before the editor beneath goes inert.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  // Layout-phase, so a closing menu's queued focus lands on an inert trigger instead of the covered editor.
  useLayoutEffect(() => {
    if (!top) return
    const covered = [...document.body.children].filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node !== scrim.current && !node.inert
    )
    for (const node of covered) node.inert = true
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      for (const node of covered) node.inert = false
    }
  }, [top])
  // Declared after the inert effect, so on close the opener is focusable again before it takes focus back.
  useLayoutEffect(() => () => void (opener?.isConnected && opener.focus()), [opener])
  useEffect(() => {
    if (!top) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [top, onCancel])
  return createPortal(
    <div ref={scrim} className="scrim bg-[rgba(17,22,29,0.28)]" onClick={onCancel}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`modal ${SHEET_STACK[Math.min(depth, SHEET_STACK.length) - 1]}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalhead">
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <nav
              aria-label={t('chain.path')}
              className="flex min-w-0 items-center gap-[5px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
            >
              <Icon name="corner-up-left" size={12} className="flex-none" />
              <button type="button" className="lnk min-w-0 truncate" onClick={onParent}>
                {parent}
              </button>
              {condition && <span className="mono min-w-0 truncate">· {condition}</span>}
            </nav>
            <span className="flex min-w-0 items-center gap-[7px] font-sans text-[16px] font-semibold leading-normal">
              <Icon name="split" size={15} className="flex-none text-(--brand)" />
              <span className="truncate">{title}</span>
            </span>
          </span>
          <button type="button" className="iconbtn" aria-label={t('cancel')} onClick={onCancel}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          {children}
          <div className="flex flex-wrap items-center gap-[9px]">
            {canWrite && (
              <Button variant="primary" size="sm" className="max-desktop:flex-1" onClick={onSave}>
                {t('save')}
              </Button>
            )}
            <Button variant="secondary" size="sm" className="max-desktop:flex-1" onClick={onCancel}>
              {canWrite ? t('cancel') : t('binding.close')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
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
