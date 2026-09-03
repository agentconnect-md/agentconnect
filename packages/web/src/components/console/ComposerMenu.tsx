'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@/components/ui'

// Default trigger look — the minimal inline chip used by the session composer.
// Callers (e.g. the Home composer's design-pill selectors) can replace it via
// `triggerClassName` and prepend an icon via `leading`.
const DEFAULT_TRIGGER =
  'inline-flex h-6 items-center gap-1 rounded-sm px-1 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover)'

type ComposerMenuChoice = {
  value: string
  label: string
  description?: string
  leading?: ReactNode
  /** Render the option dimmed (still selectable) — e.g. an offline agent. */
  dimmed?: boolean
}

export function ComposerMenu({
  title,
  value,
  options,
  open,
  align = 'right',
  placement = 'up',
  leading,
  trailing,
  footer,
  triggerClassName,
  iconOnly = false,
  tooltips = true,
  onOpenChange,
  onChange
}: {
  title: string
  value: string
  options: ComposerMenuChoice[]
  open: boolean
  align?: 'left' | 'right'
  /** Which way the menu opens. Default 'up' suits a bottom-docked composer; use
   *  'down' when the trigger sits near the top of its scroll container (Home). */
  placement?: 'up' | 'down'
  /** Optional node rendered before the label (e.g. an agent avatar / model mark). */
  leading?: ReactNode
  /** Optional node rendered after the label, before the chevron (e.g. a "fast" badge). */
  trailing?: ReactNode
  /** Optional row rendered below the options, behind a divider (e.g. the Fast-mode toggle). */
  footer?: ReactNode
  /** Overrides the default trigger look (e.g. the Home composer's design pills). */
  triggerClassName?: string
  /** Icon-only trigger (e.g. the Home composer's "+ add agents" chip): render only
   *  `leading` — no selected-value label, no chevron. */
  iconOnly?: boolean
  /** Hover-tooltip the trigger + options with the generic "<title>: <label>" text. Turn
   *  off for self-explanatory menus (model / effort / permission) where that reads as
   *  noise; a choice's own `description` is shown either way. */
  tooltips?: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const headingId = useId()
  const selected = options.find((choice) => choice.value === value) ?? options[0]
  // A choice's own description always shows: `tooltips` only governs the generic
  // "<title>: <label>" fallback, which is the part that reads as noise.
  const tooltipFor = (choice: ComposerMenuChoice | undefined) =>
    choice?.description ?? (tooltips ? (choice ? `${title}: ${choice.label}` : title) : undefined)

  const closeAndFocus = () => {
    onOpenChange(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const pick = (next: string) => {
    onChange(next)
    closeAndFocus()
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    if (options.length === 0) return
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  }

  return (
    // min-w-0 (not flex-none): in a nowrap composer row (mobile) the trigger
    // shrinks and truncates its label instead of wrapping the whole row. An
    // icon-only trigger has no label to truncate — it keeps its fixed box.
    <div className={`relative ${iconOnly ? 'flex-none' : 'min-w-0'}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName ?? DEFAULT_TRIGGER} min-w-0 max-w-full`}
        aria-label={`${title}: ${selected?.label ?? value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={tooltipFor(selected)}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          onOpenChange(true)
        }}
      >
        {leading}
        {!iconOnly && <span className="truncate">{selected?.label ?? value}</span>}
        {trailing}
        {!iconOnly && <Icon name="chevron-down" size={13} color="var(--text-tertiary)" className="flex-none" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => onOpenChange(false)} />
          <div
            id={menuId}
            role="menu"
            aria-labelledby={headingId}
            className={`absolute z-50 min-w-[148px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg) ${
              placement === 'down' ? 'top-[calc(100%+8px)]' : 'bottom-[calc(100%+8px)]'
            } ${align === 'left' ? 'left-0' : 'right-0'}`}
            onKeyDown={moveFocus}
          >
            <div
              id={headingId}
              className="px-2 pt-[5px] pb-1 font-sans text-[10.5px] font-semibold leading-normal text-(--text-tertiary)"
            >
              {title}
            </div>
            {/* Options scroll within a capped height so a long list (e.g. dozens of
                models) never runs off-screen; the heading above stays put. */}
            <div className="max-h-[300px] overflow-y-auto overflow-x-hidden">
              {options.map((choice) => {
                const selectedChoice = choice.value === selected?.value
                return (
                  <button
                    key={choice.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedChoice}
                    autoFocus={selectedChoice}
                    title={tooltipFor(choice)}
                    className={`fopt min-h-8 gap-2 rounded-md px-2 py-[5px] text-[12px] ${
                      selectedChoice ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)' : ''
                    } ${choice.dimmed ? 'opacity-55' : ''}`}
                    onClick={() => pick(choice.value)}
                  >
                    {choice.leading}
                    <span className="min-w-0 flex-1 truncate text-left">{choice.label}</span>
                    {selectedChoice && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
                  </button>
                )
              })}
            </div>
            {footer && <div className="mt-1 border-t border-(--border-subtle)">{footer}</div>}
          </div>
        </>
      )}
    </div>
  )
}
