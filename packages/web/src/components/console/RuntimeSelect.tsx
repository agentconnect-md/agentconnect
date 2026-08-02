import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { AgentMark } from '@/components/marks'
import { Icon } from '@/components/ui'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { runtimeLabel } from '@/lib/data'

/** Why an option is offered but not choosable. Today the daemon reports exactly one
 *  such case: a curated runtime whose last probe came back "authentication required"
 *  — installed on the host, but logged out, so the daemon keeps it unlaunchable. */
const UNAVAILABLE_HINT = 'Not signed in on this daemon — sign in to the runtime on the daemon host'

export function RuntimeSelect({
  value,
  options,
  unavailable,
  unavailableHint = UNAVAILABLE_HINT,
  onChange,
  ariaLabel = 'Runtime'
}: {
  value: string
  options: readonly string[]
  /** Ids the daemon reports but cannot currently run — shown dimmed and unpickable.
   *  The CURRENT value is never disabled, so a form always has a way back to itself. */
  unavailable?: readonly string[]
  unavailableHint?: string
  onChange: (value: string) => void
  ariaLabel?: string
}) {
  const registry = useAcpRegistry()
  const rows = options.map((id) => ({
    id,
    label: runtimeLabel(id, acpRuntime(registry, id)?.name),
    disabled: id !== value && !!unavailable?.includes(id)
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

  // Keyboard travel lands only on choosable rows: step from `from` in `delta` steps
  // until one is enabled, wrapping. Returns `from` when every row is disabled, which
  // can't happen while a value is set (its own row is always enabled).
  const nextEnabled = (from: number, delta: number) => {
    for (let i = 1; i <= rows.length; i++) {
      const index = (from + delta * i + rows.length * i) % rows.length
      if (!rows[index]?.disabled) return index
    }
    return from
  }
  const firstEnabled = (from: number) => (rows[from]?.disabled ? nextEnabled(from, 1) : from)

  const openFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(event.key === 'ArrowDown' ? firstEnabled(selectedIndex) : nextEnabled(0, -1))
      setOpen(true)
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => nextEnabled(current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? firstEnabled(0) : nextEnabled(0, -1))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = rows[activeIndex]
      if (active && !active.disabled) pick(active.id)
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
          setActiveIndex(firstEnabled(selectedIndex))
          setOpen((current) => !current)
        }}
        onKeyDown={openFromKeyboard}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {value ? (
            <>
              <span className="imark h-5 w-5 flex-none rounded-[5px]">
                <AgentMark model={selected?.id ?? value} />
              </span>
              <span className="truncate">{selected?.label ?? value}</span>
            </>
          ) : (
            // Deferred exec config (an unplaced preset agent): nothing chosen yet —
            // never show the first option as if it were selected.
            <span className="truncate text-(--text-tertiary)">Select runtime</span>
          )}
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
                  // aria-disabled, not the `disabled` attribute: a disabled button
                  // emits no pointer events, so the tooltip layer would never get to
                  // show WHY the row can't be picked.
                  aria-disabled={row.disabled || undefined}
                  title={row.disabled ? unavailableHint : undefined}
                  className={`fopt min-h-10 gap-3 rounded-md px-2 py-[6px] text-[13px] ${
                    row.disabled
                      ? 'cursor-not-allowed opacity-45 hover:bg-transparent'
                      : isSelected
                        ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                        : isActive
                          ? 'bg-(--surface-hover)'
                          : ''
                  }`}
                  onMouseEnter={() => !row.disabled && setActiveIndex(index)}
                  onClick={() => !row.disabled && pick(row.id)}
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
