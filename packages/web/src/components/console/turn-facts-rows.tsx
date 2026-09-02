import type { ReactNode } from 'react'

/** The label · value grid every turn-facts formatter renders into: one row per fact, values wrap. */
export function FactRows({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-[2px] font-sans text-[12px] font-normal leading-[1.6]">
      {children}
    </div>
  )
}

/** One fact. A row with nothing to say renders nothing, so a formatter never prints a dash. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  if (children === undefined || children === null || children === '' || children === false) return null
  return (
    <>
      <span className="text-(--text-tertiary)">{label}</span>
      <span className="min-w-0 break-words text-(--text-primary)">{children}</span>
    </>
  )
}
