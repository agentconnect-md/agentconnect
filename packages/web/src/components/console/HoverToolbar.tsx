'use client'

// A message's hover menu, as Slack draws one: a small floating row of actions shown while its message is hovered or focused.

import type { ReactNode } from 'react'

/** One action in a hover menu. */
export const HOVER_TOOL_BUTTON =
  'flex h-6 w-6 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)'

/** The icon size of a hover menu's actions. */
export const HOVER_TOOL_ICON = 13

// Literal per group so Tailwind sees each variant: hover or keyboard focus shows it, never a clicked button's lingering focus, so one menu shows at a time.
const SHOW = {
  turn: 'desktop:group-hover/turn:flex desktop:group-has-[:focus-visible]/turn:flex',
  card: 'desktop:group-hover/card:flex desktop:group-has-[:focus-visible]/card:flex'
} as const

export function HoverToolbar({
  group,
  label,
  className,
  children,
  ...attrs
}: {
  /** The hovered element whose `group/<name>` reveals the menu. */
  group: keyof typeof SHOW
  label: string
  /** Where the menu floats, relative to its positioned container. */
  className: string
  children: ReactNode
} & Record<`data-${string}`, string>) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={`absolute z-[5] hidden items-center gap-px rounded-[7px] border border-(--border-default) bg-(--surface-card) p-px shadow-(--shadow-md) ${SHOW[group]} ${className}`}
      {...attrs}
    >
      {children}
    </div>
  )
}
