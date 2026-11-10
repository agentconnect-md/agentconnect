'use client'

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

export interface FieldSelectOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  /** A short tag after the label, such as the kind of an entry. */
  tag?: string
  /** A hover hint on the option, spelling out what choosing it means. */
  title?: string
}

const OptionTag = ({ tag }: { tag: string }) => (
  <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">{tag}</span>
)

/** A form-field dropdown with the `.inp` trigger of `DaemonSelect`/`RuntimeSelect`, portaled so a modal body never clips it; `inline` draws the trigger as a dotted-underline word inside a sentence. */
export function FieldSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  inline = false
}: {
  value: T
  options: readonly FieldSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
  inline?: boolean
}) {
  const current = options.find((o) => o.value === value)
  const triggerClass = inline
    ? `inline-flex items-center gap-[3px] rounded-xs border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal underline decoration-dotted decoration-(--text-tertiary) underline-offset-[3px] outline-none focus-visible:shadow-(--focus-shadow) ${
        disabled
          ? 'cursor-default text-(--text-tertiary)'
          : 'cursor-pointer text-(--text-secondary) hover:text-(--text-primary)'
      }`
    : ''
  return (
    <AnchoredFlyout
      ariaLabel={ariaLabel}
      align="start"
      width={200}
      matchTriggerWidth={!inline}
      estimatedHeight={12 + options.length * 34}
      triggerClassName={inline ? 'inline-flex' : 'flex w-full'}
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
          className={
            inline
              ? triggerClass
              : `inp relative w-full text-left outline-none transition-[background-color,border-color,box-shadow] ${
                  open
                    ? 'cursor-pointer border-(--border-strong) shadow-(--focus-shadow)'
                    : disabled
                      ? 'cursor-default opacity-60'
                      : 'cursor-pointer hover:border-(--border-strong) hover:bg-(--surface-hover)'
                }`
          }
        >
          {inline && current?.icon}
          {inline ? (
            <span>{current?.label ?? value}</span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {current?.icon}
              <span className="min-w-0 truncate">{current?.label ?? value}</span>
              {current?.tag && <OptionTag tag={current.tag} />}
            </span>
          )}
          <Icon
            name="chevron-down"
            size={inline ? 12 : 15}
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
          title={o.title}
          className={`fopt focus-visible:bg-(--surface-hover) focus-visible:outline-none ${o.value === value ? 'on' : ''}`}
          onClick={() => onPick(o.value)}
        >
          {o.icon}
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
          {o.tag && <OptionTag tag={o.tag} />}
          <span className="flex w-4 flex-none items-center justify-center">
            {o.value === value && <Icon name="check" size={15} color="var(--brand)" />}
          </span>
        </button>
      ))}
    </div>
  )
}
