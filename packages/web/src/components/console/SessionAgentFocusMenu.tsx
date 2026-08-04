'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Icon } from '@/components/ui'

export interface SessionAgentFocusOption {
  agentId: string
  label: string
  href?: string
  avatar: ReactNode
}

export function SessionAgentFocusMenu({
  options,
  value,
  onChange
}: {
  options: SessionAgentFocusOption[]
  value: string
  onChange: (agentId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const headingId = useId()
  const selected = options.find((option) => option.agentId === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!selected) return null

  if (options.length === 1) {
    return selected.href ? (
      <Link className="lnk min-w-0 flex-[0_1_auto] text-[12.5px] text-(--text-secondary)" href={selected.href}>
        <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">{selected.avatar}</span>
        <span className="truncate">{selected.label}</span>
      </Link>
    ) : (
      <span className="lnk min-w-0 flex-[0_1_auto] cursor-default text-[12.5px] text-(--text-secondary)">
        <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">{selected.avatar}</span>
        <span className="truncate">{selected.label}</span>
      </span>
    )
  }

  const closeAndFocus = () => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const pick = (agentId: string) => {
    onChange(agentId)
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
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    if (items.length === 0) return
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement))
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div ref={wrapRef} className="relative flex min-w-0 flex-[0_1_auto]">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Focused agent: ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex h-[26px] min-w-0 cursor-pointer items-center gap-[7px] rounded-md border-0 bg-transparent px-1 font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <span className="av h-[18px] w-[18px] flex-none rounded-[5px]">{selected.avatar}</span>
        <span className="truncate">{selected.label}</span>
        <span className="flex-none text-(--text-tertiary)">+{options.length - 1}</span>
        <Icon name="chevron-down" size={13} color="var(--text-tertiary)" className="flex-none" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={headingId}
          className="absolute top-[calc(100%+7px)] left-0 z-50 w-[280px] max-w-[calc(100vw-32px)] rounded-[9px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
          onKeyDown={moveFocus}
        >
          <div
            id={headingId}
            className="px-2 pt-[5px] pb-1 font-sans text-[10.5px] font-semibold leading-normal tracking-[0.06em] text-(--text-tertiary) uppercase"
          >
            Focus
          </div>
          <div className="max-h-[300px] overflow-y-auto overflow-x-hidden">
            {options.map((option) => {
              const active = option.agentId === selected.agentId
              return (
                <div
                  key={option.agentId}
                  role="none"
                  className={`flex items-center rounded-md ${
                    active
                      ? 'bg-(--brand-soft) text-(--brand-soft-text)'
                      : 'text-(--text-primary) hover:bg-(--surface-hover)'
                  }`}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    autoFocus={active}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-[9px] border-0 bg-transparent px-2 py-[7px] text-left font-sans text-[13px] font-semibold leading-normal text-inherit"
                    onClick={() => pick(option.agentId)}
                  >
                    <span className="av h-6 w-6 flex-none rounded-sm">{option.avatar}</span>
                    <span className="truncate">{option.label}</span>
                  </button>
                  {option.href && (
                    <Link
                      href={option.href}
                      role="menuitem"
                      title={`Open ${option.label}`}
                      aria-label={`Open ${option.label}`}
                      className="iconbtn mr-[6px] flex h-7 w-7 flex-none items-center justify-center bg-(--surface-card) no-underline"
                      onClick={() => setOpen(false)}
                    >
                      <Icon name="arrow-up-right" size={14} />
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
