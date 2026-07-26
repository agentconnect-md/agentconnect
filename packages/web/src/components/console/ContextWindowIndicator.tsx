import { useId } from 'react'
import { fmtCountCompact } from '@/lib/api'

export function ContextWindowIndicator({ used, size }: { used?: number; size?: number }) {
  const tooltipId = useId()
  const percentage =
    used != null && size != null && size > 0 ? Math.min(100, Math.max(0, Math.round((used / size) * 100))) : null
  const usedText = used != null ? fmtCountCompact(used) : null
  const sizeText = size != null ? fmtCountCompact(size) : null

  return (
    <span className="group relative inline-flex flex-none">
      <button
        type="button"
        aria-label="Context window"
        aria-describedby={tooltipId}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.blur()
          }
        }}
      >
        <span
          aria-hidden="true"
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
          style={{
            background:
              percentage == null
                ? 'var(--border-default)'
                : `conic-gradient(var(--text-secondary) ${percentage}%, var(--border-default) 0)`
          }}
        >
          <span className="h-3 w-3 rounded-full bg-(--surface-card)" />
        </span>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none invisible absolute right-0 bottom-full z-30 mb-2 min-w-[174px] max-w-[calc(100vw-40px)] translate-y-1 rounded-[7px] border border-(--border-default) bg-(--surface-card) px-[10px] py-2 text-center opacity-0 shadow-(--shadow-lg) transition-[opacity,transform,visibility] group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 desktop:right-auto desktop:left-1/2 desktop:-translate-x-1/2"
      >
        <span className="block font-sans text-[10.5px] font-medium leading-normal text-(--text-tertiary)">
          Context window:
        </span>
        <span className="mt-[3px] block font-sans text-[12px] font-medium leading-normal text-(--text-primary)">
          {percentage == null ? 'Usage unavailable' : `${percentage}% used (${100 - percentage}% left)`}
        </span>
        {usedText && (
          <span className="mt-[3px] block font-sans text-[12px] font-medium leading-normal text-(--text-primary)">
            {sizeText ? `${usedText} / ${sizeText} tokens used` : `${usedText} tokens used`}
          </span>
        )}
      </span>
    </span>
  )
}
