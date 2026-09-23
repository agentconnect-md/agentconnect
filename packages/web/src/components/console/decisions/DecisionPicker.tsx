'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { HoverCardRows, useHoverCard } from '@/components/ui/HoverCard'

export interface DecisionPickerEntry {
  id: string
  name: string
  question: Pick<DecisionQuestion, 'type'>
  providerId: string
  model: string
}

// The saved-Decision chooser shared by every surface that binds one (a channel gate, an agent's runtime).
export function DecisionPicker<T extends DecisionPickerEntry>({
  decisions,
  value,
  placeholder,
  onSelect,
  loading = false,
  disabled = false,
  create,
  triggerClassName = 'block w-[280px] min-w-0 max-w-full'
}: {
  decisions: readonly T[]
  /** The bound Decision's id; its name comes from `decisions`, else `placeholder`. */
  value?: string | null
  /** The trigger's text when `value` is not in `decisions`: a prompt, or a retained Decision's name. */
  placeholder?: string
  onSelect(entry: T): void
  loading?: boolean
  disabled?: boolean
  /** Offer "Add decision" under the list. */
  create?: { href: string; newTab?: boolean; onClick?(): void }
  triggerClassName?: string
}) {
  const t = useTranslations('Decisions')
  const hover = useHoverCard()
  const selected = decisions.find((entry) => entry.id === value)
  const meta = (entry: T) => `${t(`types.${entry.question.type}`)} · ${entry.model}`
  return (
    <AnchoredFlyout
      ariaLabel={t('binding.decision')}
      width={280}
      matchTriggerWidth
      estimatedHeight={10 + Math.max(1, decisions.length) * 44 + (create ? 44 : 0)}
      align="start"
      triggerClassName={triggerClassName}
      trigger={({ open, menuId, toggle }) => (
        <>
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            {...(selected ? hover.triggerProps : {})}
            onClick={() => {
              hover.hide()
              toggle()
            }}
            className={`inp h-8 min-h-0 w-full cursor-pointer gap-[7px] px-[10px] py-0 text-left text-[12.5px] font-medium hover:border-(--border-strong) disabled:cursor-default disabled:opacity-60 ${open ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)' : ''}`}
          >
            <Icon name="git-branch" size={13} className="flex-none text-(--text-tertiary)" />
            <span className="min-w-0 flex-1 truncate">
              {selected?.name ?? placeholder ?? t('binding.selectDecision')}
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className={`flex-none text-(--text-tertiary) transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
          {selected &&
            !open &&
            hover.card(
              <HoverCardRows
                rows={[
                  [t('binding.decision'), selected.name],
                  [t('questionType'), t(`types.${selected.question.type}`)],
                  [t('provider'), selected.providerId],
                  [t('model'), selected.model]
                ]}
              />
            )}
        </>
      )}
    >
      {({ close }) => (
        <>
          {loading ? (
            <div className="px-[9px] py-[7px] font-sans text-[12px] leading-normal text-(--text-tertiary)">
              {t('loading')}
            </div>
          ) : decisions.length === 0 ? (
            <div className="px-[9px] py-[7px] font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">
              {t('binding.noDecisions')}
            </div>
          ) : (
            decisions.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitemradio"
                aria-checked={entry.id === value}
                title={entry.name}
                className={`fopt min-h-[38px] flex-col items-start justify-center gap-px py-1 ${entry.id === value ? 'on' : ''}`}
                onClick={() => {
                  close(true)
                  onSelect(entry)
                }}
              >
                <span className="max-w-full truncate">{entry.name}</span>
                <span className="max-w-full truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                  {meta(entry)}
                </span>
              </button>
            ))
          )}
          {create && (
            <>
              <div className="my-1 h-px bg-(--border-subtle)" />
              <Link
                href={create.href}
                target={create.newTab ? '_blank' : undefined}
                rel={create.newTab ? 'noreferrer' : undefined}
                className="fopt no-underline"
                onClick={() => {
                  create.onClick?.()
                  close()
                }}
              >
                <Icon name="plus" size={15} color="var(--text-tertiary)" />
                {t('createDecision')}
              </Link>
            </>
          )}
        </>
      )}
    </AnchoredFlyout>
  )
}
