'use client'

import { useState } from 'react'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

/** One choice: the stored value, the word the closed control shows, and the hover copy for what it does. */
export interface TriggerOption<T extends string> {
  value: T
  label: string
  hint: string
  /** Listed but not pickable here; its hint says why. */
  disabled?: boolean
  /** Footer copy for the hovered or current choice; the footer shows only when options carry it. */
  description?: string
}

/**
 * The ⚡ + dropdown that says when an agent runs here — one control for every trigger surface
 * (conversations, watched repositories, watched projects), because they are one decision worded
 * per platform. It states the current choice and keeps the rest behind a menu, so a row that also
 * carries event pills doesn't read as one long bar of segments.
 *
 * The menu is an {@link AnchoredFlyout}: every host card clips its rows, so a menu drawn in flow
 * would be cut off on the last one.
 */
export function TriggerSelect<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  hint,
  heading,
  disabled = false,
  busy = false,
  className = ''
}: {
  options: readonly TriggerOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the control for assistive tech — "Trigger for #deploys". */
  ariaLabel: string
  /** What ⚡ means on this surface, in this platform's nouns. */
  hint: string
  /** Caps heading above the choices, such as "Run on". */
  heading?: string
  /** Demo rows (no live integration) render the control inert. */
  disabled?: boolean
  /** A write is in flight: the control holds its reading and stops taking picks. */
  busy?: boolean
  /** Host layout only — the channel rows stretch the control at ≤768px. */
  className?: string
}) {
  const current = options.find((o) => o.value === value)
  const inert = disabled || busy
  const [hovered, setHovered] = useState<T | null>(null)
  const explained = options.find((o) => o.value === (hovered ?? value)) ?? current
  const explains = options.some((o) => o.description)
  return (
    <span className={`inline-flex items-center gap-[7px] ${className}`}>
      <span title={hint} className="flex-none leading-none">
        <Icon name="zap" size={14} color="var(--text-tertiary)" />
      </span>
      <AnchoredFlyout
        ariaLabel={ariaLabel}
        align="start"
        width={explains ? 240 : 220}
        estimatedHeight={10 + options.length * 34 + (heading ? 26 : 0) + (explains ? 60 : 0)}
        triggerClassName="flex min-w-0 flex-1"
        trigger={({ open, menuId, toggle }) => (
          <button
            type="button"
            disabled={inert}
            aria-label={ariaLabel}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            title={current?.hint ?? hint}
            onClick={toggle}
            className={
              inert
                ? 'selbtn h-[30px] w-full cursor-default opacity-60'
                : open
                  ? 'selbtn on h-[30px] w-full'
                  : 'selbtn h-[30px] w-full'
            }
          >
            <span className="lbl">{current?.label ?? value}</span>
          </button>
        )}
      >
        {({ close }) => (
          <>
            {heading && (
              <div className="px-[10px] pb-[5px] pt-[6px] font-sans text-[10.5px] font-semibold uppercase leading-normal tracking-[0.08em] text-(--text-tertiary)">
                {heading}
              </div>
            )}
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                aria-disabled={o.disabled ? true : undefined}
                // The footer already explains a described choice, so a tooltip would repeat it.
                title={o.description ? undefined : o.hint}
                onMouseEnter={() => setHovered(o.value)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(o.value)}
                onBlur={() => setHovered(null)}
                className={o.disabled ? 'fopt cursor-not-allowed text-(--text-tertiary) opacity-60' : 'fopt'}
                // Every pick reaches the host, the displayed one included: a code-host row whose stored
                // rule the menu cannot express normalizes by re-picking what it already shows. True
                // no-ops are suppressed by the hosts, which know which of their picks are no-ops.
                onClick={() => {
                  if (o.disabled) return
                  close(true)
                  onChange(o.value)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
              </button>
            ))}
            {explains && explained?.description && (
              <div className="mx-[-4px] mt-[5px] border-t border-(--border-subtle) px-[14px] py-[9px] text-left font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
                <span className="font-medium text-(--text-secondary)">{explained.label}</span> — {explained.description}
              </div>
            )}
          </>
        )}
      </AnchoredFlyout>
    </span>
  )
}
