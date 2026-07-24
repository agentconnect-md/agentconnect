import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { AgentMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { runtimeLabel } from '@/lib/data'

export function RuntimeSelect({
  value,
  options,
  onChange,
  ariaLabel = 'Runtime'
}: {
  value: string
  options: readonly string[]
  onChange: (value: string) => void
  ariaLabel?: string
}) {
  const registry = useAcpRegistry()
  const rows = options.map((id) => ({
    id,
    label: runtimeLabel(id, acpRuntime(registry, id)?.name)
  }))
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === value)
  )
  const selected = rows[selectedIndex]
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => listRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const closeAndFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const pick = (id: string) => {
    onChange(id)
    closeAndFocus()
  }

  const openFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(event.key === 'ArrowDown' ? selectedIndex : rows.length - 1)
      setOpen(true)
    }
  }

  const moveActive = (delta: number) => {
    setActiveIndex((current) => (current + delta + rows.length) % rows.length)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : rows.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = rows[activeIndex]
      if (active) pick(active.id)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocus()
      return
    }
    if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`inp relative w-full cursor-pointer text-left outline-none transition-[background-color,border-color,box-shadow] ${
          open
            ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)'
            : 'hover:border-(--border-strong) hover:bg-(--surface-hover) focus-visible:border-(--border-focus) focus-visible:ring-[3px] focus-visible:ring-(--brand-ring)'
        }`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setActiveIndex(selectedIndex)
          setOpen((current) => !current)
        }}
        onKeyDown={openFromKeyboard}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="imark h-5 w-5 flex-none rounded-[5px]">
            <AgentMark model={selected?.id ?? value} />
          </span>
          <span className="truncate">{selected?.label ?? value}</span>
        </span>
        <Icon
          name="chevron-down"
          size={15}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && rows.length > 0 && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
            // Size to the widest option (never truncate a runtime name), with the
            // trigger width as the floor — the Runtime field is a 1/3 column now,
            // too narrow to clip "Claude Code" against.
            className="fmenu left-0 z-40 w-max min-w-full rounded-lg p-2 shadow-(--shadow-xl) outline-none"
            onKeyDown={onListKeyDown}
          >
            {rows.map((row, index) => {
              const isSelected = row.id === value
              const isActive = index === activeIndex
              return (
                <button
                  key={row.id}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  className={`fopt min-h-10 gap-3 rounded-md px-2 py-[6px] text-[13px] ${
                    isSelected
                      ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                      : isActive
                        ? 'bg-(--surface-hover)'
                        : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(row.id)}
                >
                  <span className="imark h-7 w-7 flex-none rounded-md">
                    <AgentMark model={row.id} />
                  </span>
                  <span className="flex-1 whitespace-nowrap">{row.label}</span>
                  {isSelected && <Icon name="check" size={16} color="var(--brand)" className="flex-none" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
