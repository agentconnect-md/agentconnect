'use client'

// Per-conversation default dispatch for a SHARED bot — who takes its unmatched messages.
// Picking one PATCHes the conversation's explicit owner (`setChannelAgent`). Shared by the
// org Bots roster and the agent page's Linear rows, so the two cannot drift apart.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/ui'
import { AgentIconView } from '@/components/marks'
import type { AgentIcon } from '@/lib/agent-icon'

/** One candidate owner — an agent the bot is installed on. */
export interface DefaultDispatchOption {
  id: string
  name: string
  model: string
  runtime: string
  icon?: AgentIcon | null
}

export function DefaultDispatchPicker({
  options,
  activeId,
  disabled,
  onPick
}: {
  options: DefaultDispatchOption[]
  activeId: string | null
  disabled: boolean
  onPick: (agentId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Where the menu goes, measured when it opens: it is portaled to <body> and fixed-positioned,
  // so an `overflow-hidden` card around the picker (the agent page's integration cards) cannot
  // clip it. Right-anchored, because the picker sits in its row's right-most column.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const toggle = () => {
    if (disabled) return
    if (open) return setOpen(false)
    const rect = button.current?.getBoundingClientRect()
    setAnchor(rect ? { top: rect.bottom + 5, right: Math.max(0, window.innerWidth - rect.right) } : null)
    setOpen(true)
  }
  // The menu is measured once; a scroll or resize would strand it, so either just closes it.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])
  const active = options.find((o) => o.id === activeId) ?? options[0]
  const pick = (id: string) => {
    setOpen(false)
    if (disabled || saving || id === active?.id) return
    setSaving(true)
    onPick(id).finally(() => setSaving(false))
  }
  return (
    <span className="relative justify-self-end" onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        onClick={toggle}
        title="Default dispatch — the agent this conversation's unmatched messages go to"
        className={`flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[5px] py-1 hover:bg-(--surface-hover) ${
          disabled ? 'cursor-default' : 'cursor-pointer'
        } ${saving ? 'opacity-60' : ''}`}
      >
        <span className="av h-5 w-5 rounded-[5px]">
          <AgentIconView icon={active?.icon} runtime={active?.runtime ?? active?.model ?? ''} size={20} />
        </span>
        <span className="mono text-[12.5px] text-(--text-primary)">{active?.name ?? '—'}</span>
        <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
      </button>
      {open &&
        createPortal(
          <>
            <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div
              className="fixed z-40 min-w-[230px] rounded-[10px] border border-(--border-default) bg-(--surface-card) p-1 shadow-(--shadow-lg)"
              style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-[9px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                Default dispatch
              </div>
              {options.map((o) => (
                <button
                  key={o.id}
                  onClick={() => pick(o.id)}
                  className="flex w-full cursor-pointer items-center gap-[9px] rounded-[6px] border-0 bg-transparent px-[9px] py-[6px] text-left hover:bg-(--surface-hover)"
                >
                  <span className="av h-[22px] w-[22px] flex-none rounded-[6px]">
                    <AgentIconView icon={o.icon} runtime={o.runtime} size={22} />
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-(--text-primary)">{o.name}</span>
                  <Icon
                    name="check"
                    size={13}
                    color={o.id === active?.id ? 'var(--brand)' : 'transparent'}
                    className="flex-none"
                  />
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </span>
  )
}
