'use client'

import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

/** One choice: the stored value, the word the closed control shows, and the hover copy for what it does. */
export interface TriggerOption<T extends string> {
  value: T
  label: string
  hint: string
}

/**
 * The bell + dropdown that says when an agent runs here — one control for every trigger surface
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
  disabled = false,
  busy = false,
  className = ''
}: {
  options: readonly TriggerOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the control for assistive tech — "Trigger for #deploys". */
  ariaLabel: string
  /** What the glyph means on this surface, in this platform's nouns. */
  hint: string
  /** Demo rows (no live integration) render the control inert. */
  disabled?: boolean
  /** A write is in flight: the control holds its reading and stops taking picks. */
  busy?: boolean
  /** Host layout only — the channel rows stretch the control at ≤768px. */
  className?: string
}) {
  const current = options.find((o) => o.value === value)
  const inert = disabled || busy
  return (
    <span className={`inline-flex items-center gap-[7px] ${className}`}>
      <span title={hint} className="flex-none leading-none">
        <Icon name="bell" size={14} color="var(--text-tertiary)" />
      </span>
      <AnchoredFlyout
        ariaLabel={ariaLabel}
        align="start"
        width={220}
        estimatedHeight={10 + options.length * 34}
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
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={o.value === value}
                title={o.hint}
                className="fopt"
                // Every pick reaches the host, the displayed one included: a code-host row whose stored
                // rule the menu cannot express normalizes by re-picking what it already shows. True
                // no-ops are suppressed by the hosts, which know which of their picks are no-ops.
                onClick={() => {
                  close(true)
                  onChange(o.value)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Icon name="check" size={14} color="var(--brand)" className="flex-none" />}
              </button>
            ))}
          </>
        )}
      </AnchoredFlyout>
    </span>
  )
}
