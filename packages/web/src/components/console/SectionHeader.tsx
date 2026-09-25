import type { ReactNode } from 'react'

/** The label + count that separates a page's lists, with an optional action on the right. */
export function SectionHeader({
  id,
  label,
  count,
  action,
  first = false
}: {
  id?: string
  label: string
  /** Omitted while the count is unknown (loading or failed). */
  count?: number
  action?: ReactNode
  /** Nothing renders above it — drop the separating margin so it does not float. */
  first?: boolean
}) {
  return (
    <div className={`${first ? '' : 'mt-6 '}mb-[9px] flex min-h-[26px] items-center gap-[9px]`}>
      <span id={id} className="font-sans text-[13px] font-semibold leading-normal">
        {label}
      </span>
      {count !== undefined && <span className="mono text-[11.5px] text-(--text-tertiary)">{count}</span>}
      {action && (
        <>
          <div className="flex-1" />
          {action}
        </>
      )}
    </div>
  )
}
