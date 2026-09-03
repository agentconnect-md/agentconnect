import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'
import { modelLabel } from '@/lib/data'

export interface ModelSelectOption {
  /** The advertised model id — what the agent stores and the runtime answers to, so it is
   *  the row's label verbatim (runtime-model-catalog.md §7). */
  value: string
  /** The runtime's own display name, when it differs from the id. Right-aligned meta, never
   *  the label: "Opus (1M context)" tells you what `opus[1m]` is without replacing it. It is
   *  the part that gives way when the row is tight — a shrinkable name is what lets the menu
   *  narrow to its cap instead of forcing its own min-content width on the dialog. */
  name?: string
  /** The runtime's model blurb — the row's hover text. */
  description?: string
  /** Stored on the agent but no longer advertised: still selectable, marked in the row. */
  unavailable?: boolean
}

/** The model field's picker. Same listbox as the Runtime and Runs-on fields beside it —
 *  `.inp` trigger, scrim, `.fmenu`, `.fopt` rows, roving keyboard focus — because a native
 *  `<select>` renders the platform's own popup: OS chrome, a system-blue selected row, and no
 *  room for what the catalog knows about a model. No provider mark, unlike those two: every
 *  option here belongs to the SAME runtime, so the icon would repeat down the list. */
export function ModelSelect({
  value,
  options,
  onChange,
  ariaLabel = 'Model',
  placeholder = '—',
  disabledHint
}: {
  value: string
  options: readonly ModelSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  /** Shown when the runtime advertises no models at all. */
  placeholder?: string
  disabledHint?: string
}) {
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
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

  const pick = (option: ModelSelectOption) => {
    onChange(option.value)
    closeAndFocus()
  }

  const openFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setActiveIndex(event.key === 'ArrowDown' ? 0 : options.length - 1)
    setOpen(true)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => (current + delta + options.length) % options.length)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = options[activeIndex]
      if (active) pick(active)
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

  const empty = options.length === 0
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`inp relative w-full text-left outline-none transition-[background-color,border-color,box-shadow] ${
          empty
            ? 'cursor-not-allowed'
            : open
              ? 'cursor-pointer border-(--border-focus) ring-[3px] ring-(--brand-ring)'
              : 'cursor-pointer hover:border-(--border-strong) hover:bg-(--surface-hover) focus-visible:border-(--border-focus) focus-visible:ring-[3px] focus-visible:ring-(--brand-ring)'
        }`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={empty}
        title={empty ? disabledHint : selected?.description}
        onClick={() => {
          setActiveIndex(Math.max(selectedIndex, 0))
          setOpen((current) => !current)
        }}
        onKeyDown={openFromKeyboard}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {empty ? (
            <span className="truncate text-(--text-tertiary)">{placeholder}</span>
          ) : (
            <span className="truncate">{modelLabel(selected?.value ?? value)}</span>
          )}
        </span>
        <Icon
          name="chevron-down"
          size={15}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && !empty && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            // Anchored to the field's RIGHT edge (`.fmenu` itself sets `left: 0`, hence the
            // explicit `left-auto`). Model is the last field of its row, so a menu wider than
            // the trigger has to grow INWARD: left-anchored it pushed past the dialog, widening
            // the form's scroll area and putting a horizontal scrollbar under it. Width is the
            // widest row, floored at the trigger and capped so it cannot outgrow the viewport.
            className="fmenu right-0 left-auto z-40 w-max max-w-[min(420px,calc(100vw-32px))] min-w-full rounded-lg p-2 shadow-(--shadow-xl) outline-none"
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value
              const isActive = index === activeIndex
              return (
                <button
                  key={option.value}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  title={option.description}
                  className={`fopt min-h-10 gap-3 rounded-md px-2 py-[6px] text-[13px] ${
                    isSelected
                      ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                      : isActive
                        ? 'bg-(--surface-hover)'
                        : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(option)}
                >
                  <span className="min-w-0 flex-1 truncate">{modelLabel(option.value)}</span>
                  {option.unavailable ? (
                    <span className="flex-none font-sans text-[11px] font-medium leading-normal text-(--status-paused)">
                      unavailable
                    </span>
                  ) : (
                    option.name && (
                      <span
                        className={`min-w-0 truncate font-sans text-[11.5px] font-normal leading-normal ${
                          isSelected ? 'text-(--brand-soft-text) opacity-80' : 'text-(--text-tertiary)'
                        }`}
                      >
                        {option.name}
                      </span>
                    )
                  )}
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
