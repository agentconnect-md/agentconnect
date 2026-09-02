'use client'

// Per-conversation default dispatch for a SHARED bot — who takes its unmatched messages.
// Picking one PATCHes the conversation's explicit owner (`setChannelAgent`). Shared by the
// org Bots roster and the agent page's Linear rows, so the two cannot drift apart.
// The menu is an <AnchoredFlyout>: the agent page wraps each integration card in
// `overflow-hidden`, which cut an in-row menu after its first option, and the flyout also
// flips above the trigger near the bottom of the viewport instead of running off it.

import { useState } from 'react'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
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

/** The default-dispatch control's own glyph — FIXED, so the control has one shape wherever it
 *  appears, the way the trigger's bell does. "Leads to" is already this console's word for a
 *  hand-off. Shared with the agent page's own per-conversation picker. */
export const DISPATCH_ICON = 'corner-down-right'

const MENU_WIDTH = 240
const MENU_HEADER_HEIGHT = 34
const MENU_ROW_HEIGHT = 34

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
  const [saving, setSaving] = useState(false)
  const active = options.find((o) => o.id === activeId) ?? options[0]
  const pick = (id: string) => {
    if (disabled || saving || id === active?.id) return
    setSaving(true)
    onPick(id).finally(() => setSaving(false))
  }
  return (
    <span className="justify-self-end" onClick={(e) => e.stopPropagation()}>
      <AnchoredFlyout
        ariaLabel="Default dispatch"
        align="end"
        width={MENU_WIDTH}
        estimatedHeight={MENU_HEADER_HEIGHT + options.length * MENU_ROW_HEIGHT}
        trigger={({ open, menuId, toggle }) => (
          <button
            type="button"
            onClick={() => !disabled && toggle()}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            title={`Default dispatch — ${active?.name ?? 'none'}`}
            className={`flex items-center gap-2 rounded-[7px] border-0 bg-transparent px-[5px] py-1 hover:bg-(--surface-hover) ${
              disabled ? 'cursor-default' : 'cursor-pointer'
            } ${saving ? 'opacity-60' : ''}`}
          >
            {/* A FIXED glyph, the way the trigger's bell is: the trigger used the active
                agent's avatar, so the control changed shape per agent and read as whatever
                that mark suggested. The avatars stay in the menu, where they identify rows. */}
            <Icon name={DISPATCH_ICON} size={13} color="var(--text-tertiary)" className="flex-none" />
            <span className="mono max-w-[180px] truncate text-[12.5px] text-(--text-primary)">
              {active?.name ?? '—'}
            </span>
            <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
          </button>
        )}
      >
        {({ close }) => (
          <>
            <div className="px-[9px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
              Default dispatch
            </div>
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close(true)
                  pick(o.id)
                }}
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
          </>
        )}
      </AnchoredFlyout>
    </span>
  )
}
