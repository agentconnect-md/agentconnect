'use client'

import { Fragment, useId, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'

/** One choice: the stored value, the word the button and the list print, and what it does. */
export interface ChannelSettingsOption<T extends string = string> {
  value: T
  label: string
  hint: ReactNode
}

/** One radio group of the popover: its heading, its choices, and the save a pick runs. */
export interface ChannelSettingsGroup {
  id: string
  label: string
  options: readonly ChannelSettingsOption[]
  value: string
  /** Whether the closed button reads this group's choice, given every group's; absent ⇒ always. */
  summarize?: (chosen: Readonly<Record<string, string>>) => boolean
  /** Saves a pick; the popover shows the pick until this settles, and a rejection's message after it. */
  onPick: (value: string) => void | Promise<void>
  /** Something else owns this choice: its options stay listed but inert, and the footer says why. */
  locked?: { label: string; hint: ReactNode }
}

const WIDTH = 248

/** A conversation row's settings behind one button that reads them; a pick saves at once and leaves the popover open. */
export function ChannelSettingsPopover({
  groups,
  name,
  disabled = false
}: {
  groups: readonly ChannelSettingsGroup[]
  /** The row's name, for assistive tech. */
  name: string
  /** Demo rows (no live integration) render the control inert. */
  disabled?: boolean
}) {
  const t = useTranslations('Integrations.channelList.settings')
  const id = useId()
  const [pending, setPending] = useState<Readonly<Record<string, string>>>({})
  // The option under the pointer or focus, whose description the footer shows instead of the chosen one's.
  const [peek, setPeek] = useState<{ group: string; value: string } | null>(null)
  // A refused save is told inside the popover, where the pick was made; anything drawn beside the rows would move them under it.
  const [error, setError] = useState<string | null>(null)
  const current = (g: ChannelSettingsGroup) => pending[g.id] ?? g.value
  const chosen = Object.fromEntries(groups.map((g) => [g.id, current(g)]))
  const summary = groups
    .filter((g) => !g.locked && (g.summarize?.(chosen) ?? true))
    .map((g) => g.options.find((o) => o.value === current(g))?.label ?? current(g))
  const pick = (g: ChannelSettingsGroup, value: string) => {
    if (disabled || g.locked || g.id in pending || value === current(g)) return
    setError(null)
    setPending((p) => ({ ...p, [g.id]: value }))
    void new Promise<void>((resolve) => resolve(g.onPick(value)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending((p) => Object.fromEntries(Object.entries(p).filter(([group]) => group !== g.id))))
  }
  const optionCount = groups.reduce((n, g) => n + g.options.length, 0)
  return (
    <AnchoredFlyout
      ariaLabel={t('menuLabel', { name })}
      width={WIDTH}
      matchTriggerWidth
      gap={6}
      estimatedHeight={60 + optionCount * 40 + groups.length * 60}
      triggerClassName="flex min-w-0 max-desktop:flex-1"
      trigger={({ open, menuId, toggle }) => (
        <button
          type="button"
          disabled={disabled}
          aria-label={t('ariaLabel', { name, value: summary.join(', ') })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          title={groups.map((g) => g.label).join(' · ')}
          onClick={() => {
            setError(null)
            toggle()
          }}
          className={`flex min-h-11 w-full items-center gap-2 whitespace-nowrap rounded-md border px-3 text-left font-sans text-[13px] font-medium leading-normal text-(--text-primary) transition-colors focus-visible:border-(--border-focus) focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none desktop:inline-flex desktop:h-7 desktop:min-h-0 desktop:w-auto desktop:gap-[6px] desktop:rounded-sm desktop:pl-[10px] desktop:pr-[7px] desktop:text-[11.5px] ${
            disabled
              ? 'cursor-default border-(--border-default) bg-(--surface-card) opacity-60'
              : open
                ? 'cursor-pointer border-(--border-strong) bg-(--surface-active)'
                : 'cursor-pointer border-(--border-default) bg-(--surface-card) hover:border-(--border-strong) hover:bg-(--surface-hover)'
          }`}
        >
          {summary.map((label, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <span aria-hidden="true" className="text-(--text-disabled)">
                  ·
                </span>
              )}
              <span>{label}</span>
            </Fragment>
          ))}
          <Icon
            name="chevron-down"
            size={14}
            strokeWidth={2.1}
            className={`ml-auto flex-none desktop:h-3 desktop:w-3 ${
              open ? 'rotate-180 text-(--text-secondary)' : 'text-(--text-tertiary)'
            }`}
          />
        </button>
      )}
    >
      {() => (
        <>
          {groups.map((g, index) => (
            <Fragment key={g.id}>
              {index > 0 && (
                <div role="separator" className="mx-3 my-[6px] h-px bg-(--border-subtle) desktop:mx-[10px]" />
              )}
              <div
                id={`${id}-${g.id}`}
                className={`px-3 pb-[6px] font-sans text-[10px] font-semibold uppercase leading-normal tracking-[0.06em] text-(--text-tertiary) desktop:px-[10px] desktop:pb-[5px] ${
                  index === 0 ? 'pt-[9px] desktop:pt-2' : 'pt-[7px] desktop:pt-[6px]'
                }`}
              >
                {g.label}
              </div>
              <div role="group" aria-labelledby={`${id}-${g.id}`}>
                {g.options.map((o) => {
                  const on = !g.locked && o.value === current(g)
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      aria-disabled={g.locked ? true : undefined}
                      aria-describedby={`${id}-${g.id}-${o.value}`}
                      onClick={() => pick(g, o.value)}
                      onMouseEnter={() => setPeek({ group: g.id, value: o.value })}
                      onMouseLeave={() => setPeek(null)}
                      onFocus={() => setPeek({ group: g.id, value: o.value })}
                      onBlur={() => setPeek(null)}
                      className={`${on ? 'fopt on' : 'fopt'} ${g.locked ? 'cursor-default font-normal text-(--text-tertiary) hover:bg-transparent' : ''} min-h-12 px-3 py-[11px] text-[13.5px] tracking-[-0.006em] focus-visible:shadow-[0_0_0_3px_var(--brand-ring)] focus-visible:outline-none desktop:min-h-8 desktop:px-[10px] desktop:py-[7px] desktop:text-[12.5px]`}
                    >
                      <span className="inline-flex w-4 flex-none desktop:w-[15px]">
                        {on && (
                          <Icon
                            name="check"
                            size={15}
                            strokeWidth={2.6}
                            color="var(--brand)"
                            className="desktop:h-[14px] desktop:w-[14px]"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    </button>
                  )
                })}
              </div>
            </Fragment>
          ))}
          <div className="mt-[5px] flex flex-col gap-[6px] border-t border-(--border-subtle) px-3 py-[10px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary) desktop:gap-[5px] desktop:px-[10px] desktop:py-[9px] desktop:text-[11.5px]">
            {error && (
              <div role="alert" className="flex items-start gap-[6px] text-(--status-error)">
                <Icon name="triangle-alert" size={13} className="mt-[2px] flex-none" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}
            {groups.map((g) => {
              if (g.locked)
                return (
                  <span key={g.id} className="text-pretty">
                    {t.rich('optionHint', {
                      label: g.locked.label,
                      b: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>,
                      hint: () => g.locked!.hint
                    })}
                  </span>
                )
              const shown = peek?.group === g.id ? peek.value : current(g)
              return (
                // Every description shares one cell, so the footer keeps its tallest height and never jumps on hover.
                <div key={g.id} aria-hidden="true" className="grid">
                  {g.options.map((o) => (
                    <span
                      key={o.value}
                      id={`${id}-${g.id}-${o.value}`}
                      className={`col-start-1 row-start-1 text-pretty ${o.value === shown ? '' : 'invisible'}`}
                    >
                      {t.rich('optionHint', {
                        label: o.label,
                        b: (chunks) => <span className="font-medium text-(--text-secondary)">{chunks}</span>,
                        hint: () => o.hint
                      })}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}
    </AnchoredFlyout>
  )
}
