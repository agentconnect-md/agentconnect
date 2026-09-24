'use client'

import { Icon } from '@/components/ui'

// The one Decision chip every By decision row carries: `split | +` until bound, then `split name ✎ | ×`.
export function DecisionChip({
  name,
  label,
  title,
  onOpen,
  disabled = false,
  warning,
  remove,
  openProps,
  fill = false
}: {
  /** The bound Decision's name; null renders the empty pair. */
  name: string | null
  /** The open control's accessible name; a bound chip defaults to its name. */
  label?: string
  title?: string
  onOpen(): void
  disabled?: boolean
  /** A held routing: the chip turns amber and this icon replaces the split. */
  warning?: 'lock' | 'triangle-alert'
  /** The × segment of a bound chip; omit where the viewer cannot stop it. */
  remove?: { label: string; title?: string; onClick(): void; busy?: boolean; failed?: boolean }
  /** `data-*` locators for the open control. */
  openProps?: Record<`data-${string}`, string>
  /** Stretch a bound chip across its row, as in a menu. */
  fill?: boolean
}) {
  if (name === null) {
    return (
      <button
        type="button"
        aria-label={label}
        title={title}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onOpen}
        {...openProps}
        className="group inline-flex h-[26px] flex-none cursor-pointer items-stretch overflow-hidden rounded-sm border border-(--border-default) bg-(--surface-card) p-0 text-(--text-tertiary) transition-colors enabled:hover:border-(--brand) enabled:hover:bg-(--brand-soft) enabled:hover:text-(--brand) disabled:cursor-default disabled:opacity-60"
      >
        <span className="flex w-[26px] items-center justify-center">
          <Icon name="split" size={13} />
        </span>
        <span className="flex w-5 items-center justify-center border-l border-(--border-subtle) transition-colors group-enabled:group-hover:border-(--brand-ring)">
          <Icon name="plus" size={11} />
        </span>
      </button>
    )
  }
  return (
    <span
      className={`inline-flex h-[26px] max-w-full items-stretch overflow-hidden rounded-sm border ${fill ? 'w-full' : 'flex-none'} ${
        warning ? 'border-(--amber-500) bg-(--surface-card)' : 'border-(--brand) bg-(--brand-soft)'
      } ${remove?.busy ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        aria-label={label ?? name}
        title={title}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onOpen}
        {...openProps}
        className={`inline-flex min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[7px] disabled:cursor-default ${fill ? 'flex-1' : ''}`}
      >
        {warning ? (
          <Icon name={warning} size={13} className="flex-none text-(--amber-500)" />
        ) : (
          <Icon name="split" size={13} className="flex-none text-(--brand)" />
        )}
        <span
          className={`mono min-w-0 truncate text-left text-[11px] font-medium text-(--text-primary) ${fill ? 'flex-1' : 'max-w-[200px]'}`}
        >
          {name}
        </span>
        <Icon name="pencil" size={11} className="flex-none text-(--text-tertiary)" />
      </button>
      {remove && (
        <button
          type="button"
          aria-label={remove.label}
          title={remove.title ?? remove.label}
          disabled={disabled || remove.busy}
          onClick={remove.onClick}
          className={`flex w-[22px] flex-none cursor-pointer items-center justify-center border-0 border-l bg-transparent transition-colors hover:text-(--text-primary) disabled:cursor-wait ${
            warning ? 'border-(--border-subtle)' : 'border-(--brand-ring)'
          } ${remove.failed ? 'text-(--status-error)' : 'text-(--text-tertiary)'}`}
        >
          <Icon name={remove.failed ? 'triangle-alert' : 'x'} size={11} />
        </button>
      )}
    </span>
  )
}
