'use client'

import type { ReactNode } from 'react'
import { MarkSlot } from '@/components/marks'
import { Icon } from '@/components/ui'

export interface ProviderColumnItem {
  id: string
  label: string
  mark: ReactNode
  count?: number
  /** Shown as a warning icon whose tooltip is this text. */
  warning?: string
}

// The provider · model menu body: providers on the left, the caller's model options on the right.
export function ProviderModelMenu({
  title,
  providers,
  active,
  onPick,
  search,
  children
}: {
  title: string
  providers: readonly ProviderColumnItem[]
  /** The highlighted provider; null while a search spans every provider. */
  active: string | null
  onPick(id: string): void
  search?: { value: string; placeholder: string; onChange(value: string): void }
  children: ReactNode
}) {
  return (
    <div className="flex">
      <div className="max-h-[320px] w-[168px] flex-none overflow-y-auto border-r border-(--border-subtle) bg-(--surface-app) p-1">
        <div className="fhdr">{title}</div>
        {providers.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={active === item.id}
            className={`fopt min-h-8 ${active === item.id ? 'on' : ''}`}
            onClick={() => onPick(item.id)}
          >
            <MarkSlot>{item.mark}</MarkSlot>
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            {item.warning && (
              <span className="flex flex-none" title={item.warning}>
                <Icon name="triangle-alert" size={12} color="var(--status-paused)" />
              </span>
            )}
            {item.count !== undefined && (
              <span className="flex-none font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                {item.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-[6px]">
        {search && (
          <input
            autoFocus
            className="fsearch"
            aria-label={search.placeholder}
            placeholder={search.placeholder}
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
          />
        )}
        <div className="max-h-[264px] overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

export function ModelOption({
  label,
  selected,
  onClick,
  description,
  ariaLabel
}: {
  label: string
  selected: boolean
  onClick(): void
  description?: string
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      title={description}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className={`fopt min-h-[30px] ${selected ? 'on' : ''}`}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  )
}
