import { useId } from 'react'
import { OUTPUT_MODE_OPTIONS } from '@/lib/output-mode'
import { Icon } from '@/components/ui'

/** Hover/focus comparison shared by every console surface that displays output mode. */
export function OutputModeHelp({ activeMode }: { activeMode?: string | null }) {
  const tooltipId = useId()

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
        aria-label="Compare output modes"
        aria-describedby={tooltipId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.blur()
          }
        }}
      >
        <Icon name="info" size={13} />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-0 z-30 mb-2 w-[320px] max-w-[calc(100vw-72px)] translate-y-1 rounded-md border border-(--border-default) bg-(--surface-card) p-3 opacity-0 shadow-(--shadow-lg) transition-[opacity,transform,visibility] group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        <span className="block font-sans text-[11px] font-semibold leading-normal tracking-[0.06em] text-(--text-tertiary) uppercase">
          What appears in the channel
        </span>
        <span className="mt-2 flex flex-col gap-1">
          {OUTPUT_MODE_OPTIONS.map((mode) => (
            <span
              key={mode.key}
              className={
                activeMode === mode.key
                  ? 'grid grid-cols-[62px_1fr] gap-3 rounded-sm bg-(--brand-soft) px-[9px] py-2'
                  : 'grid grid-cols-[62px_1fr] gap-3 rounded-sm px-[9px] py-2'
              }
            >
              <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                {mode.label}
              </span>
              <span className="font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-secondary)">
                {mode.description}
              </span>
            </span>
          ))}
        </span>
        <span className="mt-2 block border-t border-(--border-subtle) pt-2 font-sans text-[11px] font-normal leading-[1.4] text-(--text-tertiary)">
          All modes keep full activity in session history.
        </span>
      </span>
    </span>
  )
}
