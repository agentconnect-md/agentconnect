import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { AgentIconView } from '@/components/marks'
import { Icon } from '@/components/ui'
import { agentLabel, type Agent } from '@/lib/data'

export function AgentPicker({
  agents,
  value,
  onPick,
  disabled
}: {
  agents: Agent[]
  value: string | null
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const t = useTranslations('Integrations.dialog')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selectedIndex = Math.max(
    0,
    agents.findIndex((a) => a.id === value)
  )
  const selected = agents.find((agent) => agent.id === value)

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
    if (id !== value) onPick(id)
    closeAndFocus()
  }
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + agents.length) % agents.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = agents[activeIndex]
      if (active) pick(active.id)
      return
    }
    if (event.key === 'Escape') {
      // The dialog closes on Escape too — this one belongs to the open menu.
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
        disabled={disabled || agents.length === 0}
        className={`inp relative w-full cursor-pointer text-left outline-none transition-[background-color,border-color,box-shadow] ${
          open
            ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)'
            : 'hover:border-(--border-strong) hover:bg-(--surface-hover) focus-visible:border-(--border-focus) focus-visible:ring-[3px] focus-visible:ring-(--brand-ring)'
        }`}
        aria-label={t('agent')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setActiveIndex(selectedIndex)
          setOpen((v) => !v)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setActiveIndex(selectedIndex)
          setOpen(true)
        }}
      >
        <span className="inline-flex min-w-0 items-center gap-[9px]">
          <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
            <AgentIconView icon={selected?.icon} runtime={selected?.runtime ?? ''} size={22} />
          </span>
          <span className="mono truncate text-[12.5px]">{selected ? agentLabel(selected) : t('chooseAgent')}</span>
        </span>
        <Icon
          name="chevron-down"
          size={15}
          color="var(--text-tertiary)"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <>
          <div className="fscrim" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label={t('agent')}
            aria-activedescendant={`${listboxId}-option-${activeIndex}`}
            className="fmenu left-0 z-40 max-h-[260px] w-full overflow-y-auto rounded-lg p-2 shadow-(--shadow-xl) outline-none"
            onKeyDown={onListKeyDown}
          >
            {agents.map((a, index) => {
              const isSelected = a.id === value
              return (
                <button
                  key={a.id}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  className={`fopt min-h-10 gap-[9px] rounded-md px-2 py-[6px] ${
                    isSelected
                      ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                      : index === activeIndex
                        ? 'bg-(--surface-hover)'
                        : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(a.id)}
                >
                  <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                    <AgentIconView icon={a.icon} runtime={a.runtime} size={22} />
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-left text-[12.5px]">{agentLabel(a)}</span>
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
