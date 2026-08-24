'use client'

// The two shapes the agent detail view's Tools & Skills tab is built from: one
// attached row, and the card header's "Add" menu (AgentConnect Console v2 design,
// agent page → Tools & Skills). Both cards list only what the agent HAS attached
// and offer everything else behind the menu, so the tab reads as a roster rather
// than a switchboard over the whole org registry.
//
// Kept here — not in ToolTile.tsx — because these are LIST rows: the registry
// pages still render the tile grid, and the two shapes should stay independently
// tweakable.

import type { ReactNode } from 'react'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { Button, Icon } from '@/components/ui'

/** One attached MCP server / skill: mark, name + meta line, origin badge, remove. */
export function AttachedRow({
  mark,
  name,
  meta,
  badge,
  actions,
  onRemove,
  removeTitle,
  dimmed,
  children
}: {
  mark: ReactNode
  name: string
  /** The muted second line — transport · kind, or a skill source's repo. */
  meta: ReactNode
  /** Where it comes from (registry / daemon-local / managed), right of the meta. */
  badge?: ReactNode
  /** Extra controls left of the remove button (the skills card's expand chevron). */
  actions?: ReactNode
  onRemove?: () => void
  removeTitle?: string
  /** A saved name this agent can no longer attach — shown only so it can be removed. */
  dimmed?: boolean
  /** Full-bleed panel below the row (the skills card's per-skill list). */
  children?: ReactNode
}) {
  return (
    <div className={`border-b border-(--border-subtle) last:border-b-0 ${dimmed ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-[11px] px-4 py-3">
        {mark}
        <div className="min-w-0 flex-1">
          <div className="mono truncate text-[12.5px] text-(--text-primary)">{name}</div>
          <div className="mono truncate text-[11px] text-(--text-tertiary)">{meta}</div>
        </div>
        {badge}
        {actions}
        {onRemove && (
          <button type="button" className="iconbtn flex-none" title={removeTitle} onClick={onRemove}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

/** The card footer's info strip — what serves these, and what removing one means. */
export function AttachedNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-(--border-subtle) px-4 py-[13px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
      <Icon name="info" size={14} className="flex-none" />
      <span>{children}</span>
    </div>
  )
}

/** One already-known thing the agent can attach, offered under a menu heading. */
export interface AttachOption {
  key: string
  name: string
  /** Right-aligned hint — the kind of server, the repo a source installs from. */
  meta?: string
  onPick: () => void
}

/** A heading plus the options under it; `emptyLabel` shows when nothing is left. */
export interface AttachGroup {
  heading: string
  icon: string
  options: AttachOption[]
  emptyLabel: string
}

/** A "create one now" item below the separator — opens the registry's own dialog. */
export interface AttachAction {
  key: string
  label: string
  icon: string
  onPick: () => void
}

/**
 * The card header's Add menu: "add existing" groups first, then the custom
 * quick-add actions. Groups with no options left say so rather than vanishing,
 * so the menu never looks broken when everything is already attached.
 */
export function AttachMenu({
  ariaLabel,
  groups,
  actions,
  disabled
}: {
  ariaLabel: string
  groups: AttachGroup[]
  actions: AttachAction[]
  disabled?: boolean
}) {
  const rows = groups.reduce((n, g) => n + Math.max(1, Math.min(g.options.length, 6)), 0)
  return (
    <AnchoredFlyout
      ariaLabel={ariaLabel}
      width={330}
      estimatedHeight={36 * (rows + actions.length) + 24 * groups.length}
      trigger={({ open, menuId, toggle }) => (
        <Button
          variant="secondary"
          size="xs"
          disabled={disabled}
          onClick={toggle}
          ariaExpanded={open}
          ariaHasPopup="menu"
          ariaControls={open ? menuId : undefined}
        >
          <Icon name="plus" size={14} />
          Add
          <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
        </Button>
      )}
    >
      {({ close }) => (
        <>
          {groups.map((group) => (
            <div key={group.heading}>
              <div className="fhdr">{group.heading}</div>
              {group.options.length === 0 ? (
                <div className="px-[10px] py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {group.emptyLabel}
                </div>
              ) : (
                group.options.map((option) => (
                  <button
                    key={option.key}
                    role="menuitem"
                    className="dmi"
                    onClick={() => {
                      close()
                      option.onPick()
                    }}
                  >
                    <Icon name={group.icon} size={15} />
                    <span className="mono min-w-0 flex-1 truncate text-left text-[12.5px]">{option.name}</span>
                    {option.meta && (
                      <span className="mono flex-none text-[11px] text-(--text-tertiary)">{option.meta}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          ))}
          {actions.length > 0 && <div className="dmsep" />}
          {actions.map((action) => (
            <button
              key={action.key}
              role="menuitem"
              className="dmi"
              onClick={() => {
                close()
                action.onPick()
              }}
            >
              <Icon name={action.icon} size={15} />
              <span className="flex-1 text-left">{action.label}</span>
            </button>
          ))}
        </>
      )}
    </AnchoredFlyout>
  )
}

/** The empty state both cards show when the agent has nothing attached yet. */
export function AttachedEmpty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-[26px] text-center">
      <div className="font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">{title}</div>
      <div className="mx-auto mt-[3px] mb-[13px] max-w-[430px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
        {hint}
      </div>
      {action}
    </div>
  )
}
