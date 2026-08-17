import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'

/** What a placement option NAMES (daemon-groups.md §2): the install-wide pool, one of the org's
 *  own groups, or a single machine. The first two are member sets and behave alike — the server
 *  picks the member — so they share an icon language and differ only in badge. */
export type PlacementOptionKind = 'pool' | 'group' | 'daemon'

export interface DaemonSelectOption {
  value: string
  label: string
  detail: string
  kind?: PlacementOptionKind
  disabled?: boolean
}

/** A set target is drawn as a target, never as the member that happens to answer for it. */
const isSet = (option: Pick<DaemonSelectOption, 'kind'>): boolean => option.kind === 'pool' || option.kind === 'group'
const iconFor = (option: DaemonSelectOption): string =>
  option.kind === 'pool' ? 'cloud' : option.kind === 'group' ? 'layers' : option.value ? 'server' : 'server-off'
// Cloud is a product and carries its name as a badge; a group carries its own name already, and the
// design's group row has no badge — the layers mark is what says "a set, not a machine".
const badgeFor = (option: DaemonSelectOption): string | null => (option.kind === 'pool' ? 'Cloud' : null)

function enabledIndex(options: readonly DaemonSelectOption[], start: number, delta: 1 | -1): number {
  if (!options.length) return -1
  for (let step = 0; step < options.length; step += 1) {
    const index = (start + delta * step + options.length) % options.length
    if (!options[index]!.disabled) return index
  }
  return -1
}

export function DaemonSelect({
  value,
  options,
  onChange,
  ariaLabel = 'Runs on',
  placeholder = 'No daemons connected'
}: {
  value: string
  options: readonly DaemonSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  placeholder?: string
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

  const initialActiveIndex = () =>
    selected && !selected.disabled ? selectedIndex : enabledIndex(options, Math.max(selectedIndex, 0), 1)

  const closeAndFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const pick = (option: DaemonSelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    closeAndFocus()
  }

  const moveActive = (delta: 1 | -1) => {
    setActiveIndex((current) => {
      const start =
        current < 0 ? (delta === 1 ? 0 : options.length - 1) : (current + delta + options.length) % options.length
      return enabledIndex(options, start, delta)
    })
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const start = event.key === 'ArrowDown' ? 0 : options.length - 1
    setActiveIndex(enabledIndex(options, start, event.key === 'ArrowDown' ? 1 : -1))
    setOpen(true)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const start = event.key === 'Home' ? 0 : options.length - 1
      setActiveIndex(enabledIndex(options, start, event.key === 'Home' ? 1 : -1))
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
        disabled={options.length === 0}
        onClick={() => {
          setActiveIndex(initialActiveIndex())
          setOpen((current) => !current)
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`inline-flex min-w-0 items-center gap-2 ${selected ? '' : 'text-(--text-tertiary)'}`}>
          {selected && (
            <span
              className={`flex h-6 w-6 flex-none items-center justify-center rounded-md ${
                isSet(selected) ? 'bg-(--brand-soft)' : 'bg-(--surface-sunken)'
              }`}
            >
              <Icon
                name={iconFor(selected)}
                size={14}
                color={isSet(selected) ? 'var(--brand)' : 'var(--text-tertiary)'}
              />
            </span>
          )}
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected && badgeFor(selected) && (
            <span className="flex-none rounded-full bg-(--brand-soft) px-[7px] py-[2px] font-sans text-[10.5px] font-semibold leading-normal text-(--brand-soft-text)">
              {badgeFor(selected)}
            </span>
          )}
        </span>
        <Icon
          name="chevron-down"
          size={15}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && options.length > 0 && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
            className="fmenu right-0 left-0 z-40 max-h-[360px] min-w-0 rounded-lg p-2 shadow-(--shadow-xl) outline-none"
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value
              const isActive = index === activeIndex
              return (
                <button
                  key={`${option.kind ?? 'daemon'}:${option.value}`}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  data-pool={option.kind === 'pool' || undefined}
                  data-group={option.kind === 'group' || undefined}
                  className={`fopt min-h-[58px] gap-[10px] rounded-md px-2 py-[7px] text-[13px] ${
                    option.disabled
                      ? 'cursor-not-allowed text-(--text-disabled) opacity-65'
                      : isSelected
                        ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                        : isActive
                          ? 'bg-(--surface-hover)'
                          : ''
                  }`}
                  onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => pick(option)}
                >
                  <span className="flex w-4 flex-none items-center justify-center">
                    {isSelected && <Icon name="check" size={16} color="var(--brand)" />}
                  </span>
                  <span
                    className={`flex h-8 w-8 flex-none items-center justify-center rounded-md ${
                      isSet(option) ? 'bg-(--brand-soft)' : 'bg-(--surface-sunken)'
                    }`}
                  >
                    <Icon
                      name={iconFor(option)}
                      size={16}
                      color={isSet(option) ? 'var(--brand)' : 'var(--text-tertiary)'}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-sans text-[13px] font-semibold leading-normal">
                      <span className="truncate">{option.label}</span>
                      {badgeFor(option) && (
                        <span className="flex-none rounded-full bg-(--brand-soft) px-[7px] py-[2px] font-sans text-[10.5px] font-semibold leading-normal text-(--brand-soft-text)">
                          {badgeFor(option)}
                        </span>
                      )}
                    </span>
                    <span className="mt-[3px] block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {option.detail}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
