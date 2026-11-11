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
  /** Holds the current choice, marked apart from the row being browsed; the text names it for assistive tech. */
  current?: string
}

/** A second titled group in the provider column, such as the coordinator's filter models. */
export interface ProviderColumnSection {
  title: string
  /** Explains the group on hover of the info mark beside its title. */
  hint?: string
  providers: readonly ProviderColumnItem[]
}

function ProviderButton({ item, active, onPick }: { item: ProviderColumnItem; active: boolean; onPick(): void }) {
  return (
    <button type="button" aria-pressed={active} className={`fopt min-h-8 ${active ? 'on' : ''}`} onClick={onPick}>
      <MarkSlot>{item.mark}</MarkSlot>
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {item.current && (
        <span className="flex flex-none" title={item.current} aria-label={item.current}>
          <Icon name="check" size={12} color="var(--brand)" />
        </span>
      )}
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
  )
}

// The provider · model menu body: providers on the left, the caller's model options on the right.
export function ProviderModelMenu({
  title,
  providers,
  section,
  active,
  onPick,
  search,
  header,
  children
}: {
  title: string
  /** Shown above the provider column's title, for what the whole menu edits. */
  header?: ReactNode
  providers: readonly ProviderColumnItem[]
  /** A second group below the providers; its ids share `active` and `onPick` with them. */
  section?: ProviderColumnSection
  /** The highlighted provider; null while a search spans every provider. */
  active: string | null
  onPick(id: string): void
  search?: { value: string; placeholder: string; onChange(value: string): void }
  children: ReactNode
}) {
  return (
    <div className="flex">
      {/* Only the provider list scrolls: the header stays on top and a section stays in view below it. */}
      <div className="flex max-h-[320px] w-[168px] flex-none flex-col border-r border-(--border-subtle) bg-(--surface-app) p-1">
        <div className="flex-none">
          {header}
          <div className="fhdr">{title}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="provider-list">
          {providers.map((item) => (
            <ProviderButton key={item.id} item={item} active={active === item.id} onPick={() => onPick(item.id)} />
          ))}
        </div>
        {section && section.providers.length > 0 && (
          <div className="mt-1 flex-none border-t border-(--border-subtle) pt-1" data-testid="provider-section">
            <div className="fhdr flex items-center gap-1">
              {section.title}
              {section.hint && (
                <span className="flex" title={section.hint} aria-label={section.hint}>
                  <Icon name="info" size={12} />
                </span>
              )}
            </div>
            {section.providers.map((item) => (
              <ProviderButton key={item.id} item={item} active={active === item.id} onPick={() => onPick(item.id)} />
            ))}
          </div>
        )}
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
