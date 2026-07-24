import { useId } from 'react'
import { Icon } from '@/components/ui'

export function CompactFieldLabel({
  label,
  detail,
  tooltipAlign = 'center'
}: {
  label: string
  detail: string
  tooltipAlign?: 'center' | 'right'
}) {
  const detailId = useId()

  return (
    <div className="group relative flex items-center gap-[6px]">
      <span className="fldlbl">{label}</span>
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={detailId}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-(--text-tertiary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)"
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
        id={detailId}
        role="tooltip"
        data-align={tooltipAlign}
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-[200px] max-w-[calc(100vw-40px)] -translate-x-1/2 translate-y-1 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] py-[7px] font-sans text-[12px] font-medium leading-[1.45] break-words whitespace-normal text-(--text-primary) opacity-0 shadow-(--shadow-lg) transition-[opacity,transform,visibility] data-[align=right]:right-0 data-[align=right]:left-auto data-[align=right]:translate-x-0 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        {detail}
      </span>
    </div>
  )
}
