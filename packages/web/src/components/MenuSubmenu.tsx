'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@/components/ui'

export interface MenuSubmenuOption<T extends string> {
  value: T
  label: string
}

/** A `.dmi` row that opens a single-choice list as a flyout beside its dropdown menu. */
export function MenuSubmenu<T extends string>({
  icon,
  label,
  options,
  value,
  disabled,
  onSelect,
  onPicked
}: {
  icon: string
  label: string
  options: readonly MenuSubmenuOption<T>[]
  value: T
  disabled?: boolean
  onSelect: (value: T) => void
  onPicked?: () => void
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const menuId = useId()

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const show = () => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  // A short grace period lets the pointer cut diagonally across a neighbouring row to reach the flyout.
  const hide = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="dmi"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={show}
      >
        <Icon name={icon} size={15} color="var(--text-tertiary)" />
        <span className="flex-1">{label}</span>
        <Icon name="chevron-right" size={15} color="var(--text-tertiary)" />
      </button>
      {open && (
        <div className="absolute -top-[5px] left-full z-50 pl-[9px]">
          <div
            id={menuId}
            role="menu"
            aria-label={label}
            className="w-[200px] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg)"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                disabled={disabled}
                className="dmi justify-between"
                onClick={() => {
                  onSelect(option.value)
                  setOpen(false)
                  onPicked?.()
                }}
              >
                {option.label}
                {option.value === value && <Icon name="check" size={15} color="var(--brand)" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
