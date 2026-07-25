'use client'

import { useId, useRef, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'

type ComposerMenuChoice = { value: string; label: string }

export function ComposerMenu({
  title,
  value,
  options,
  open,
  align = 'right',
  onOpenChange,
  onChange
}: {
  title: string
  value: string
  options: ComposerMenuChoice[]
  open: boolean
  align?: 'left' | 'right'
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const headingId = useId()
  const selected = options.find((choice) => choice.value === value) ?? options[0]

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
    <div className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-6 items-center gap-1 rounded-sm px-1 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover)"
        aria-label={`${title}: ${selected?.label ?? value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          onOpenChange(true)
        }}
      >
        <span>{selected?.label ?? value}</span>
        <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => onOpenChange(false)} />
          <div
            id={menuId}
            role="menu"
            aria-labelledby={headingId}
            className={`absolute bottom-[calc(100%+8px)] z-50 min-w-[148px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg) ${
              align === 'left' ? 'left-0' : 'right-0'
            }`}
            onKeyDown={moveFocus}
          >
            <div
              id={headingId}
              className="px-2 pt-[5px] pb-1 font-sans text-[10.5px] font-semibold leading-normal text-(--text-tertiary)"
            >
              {title}
            </div>
            {options.map((choice) => {
              const selectedChoice = choice.value === selected?.value
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedChoice}
                  autoFocus={selectedChoice}
                  className={`fopt min-h-8 gap-2 rounded-md px-2 py-[5px] text-[12px] ${
                    selectedChoice ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)' : ''
                  }`}
                  onClick={() => pick(choice.value)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{choice.label}</span>
                  {selectedChoice && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
