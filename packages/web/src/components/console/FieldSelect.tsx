'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

export interface FieldSelectOption<T extends string> {
  value: T
  label: string
}

/** A form-field dropdown with the `.inp` trigger of `DaemonSelect`/`RuntimeSelect`, portaled so a modal body never clips it. */
export function FieldSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false
}: {
  value: T
  options: readonly FieldSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const current = options.find((o) => o.value === value)
  return (
    <AnchoredFlyout
      ariaLabel={ariaLabel}
      align="start"
      width={200}
      matchTriggerWidth
      estimatedHeight={12 + options.length * 34}
      triggerClassName="flex w-full"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
          onKeyDown={(event) => {
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
              event.preventDefault()
              toggle()
            }
          }}
          className={`inp relative w-full text-left outline-none transition-[background-color,border-color,box-shadow] ${
            open
              ? 'cursor-pointer border-(--border-focus) ring-[3px] ring-(--brand-ring)'
              : disabled
                ? 'cursor-default opacity-60'
                : 'cursor-pointer hover:border-(--border-strong) hover:bg-(--surface-hover) focus-visible:border-(--border-focus) focus-visible:ring-[3px] focus-visible:ring-(--brand-ring)'
          }`}
        >
          <span className="min-w-0 truncate">{current?.label ?? value}</span>
          <Icon
            name="chevron-down"
            size={15}
            color="var(--text-tertiary)"
            className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    >
      {({ close }) => (
        <FieldSelectMenu
          options={options}
          value={value}
          onPick={(next) => {
            close(true)
            onChange(next)
          }}
          onDismiss={() => close(true)}
        />
      )}
    </AnchoredFlyout>
  )
}

/** The open menu: focuses the current option, then arrows/Home/End move focus and Enter/Space pick natively. */
function FieldSelectMenu<T extends string>({
  options,
  value,
  onPick,
  onDismiss
}: {
  options: readonly FieldSelectOption<T>[]
  value: T
  onPick: (value: T) => void
  onDismiss: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const items = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const all = items()
      ;(all.find((b) => b.getAttribute('aria-checked') === 'true') ?? all[0])?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % all.length
        : event.key === 'ArrowUp'
          ? (at - 1 + all.length) % all.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : null
    if (next !== null) {
      event.preventDefault()
      all[next]?.focus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      onDismiss()
    }
  }

  return (
    <div ref={listRef} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="menuitemradio"
          aria-checked={o.value === value}
          tabIndex={-1}
          className={`fopt focus-visible:bg-(--surface-hover) focus-visible:outline-none ${o.value === value ? 'on' : ''}`}
          onClick={() => onPick(o.value)}
        >
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
          <span className="flex w-4 flex-none items-center justify-center">
            {o.value === value && <Icon name="check" size={15} color="var(--brand)" />}
          </span>
        </button>
      ))}
    </div>
  )
}
