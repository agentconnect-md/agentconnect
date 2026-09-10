import { Spinner } from '@/components/marks'
import type { DaemonLifecycleOp } from '@/lib/data'

// Lists show the action; detail views include the target version.
export function daemonLifecycleLabel(op: DaemonLifecycleOp): string {
  const action =
    op.phase === 'preparing'
      ? 'Preparing upgrade'
      : op.phase === 'restarting' || op.op === 'restart'
        ? 'Restarting'
        : 'Upgrading'
  return `${action}${op.targetVersion ? ` to ${op.targetVersion}` : ''}…`
}

export function DaemonLifecycleBadge({ op, size = 'sm' }: { op: DaemonLifecycleOp | null; size?: 'sm' | 'md' }) {
  if (op?.status !== 'pending') return null

  const fullLabel = daemonLifecycleLabel(op)
  const md = size === 'md'
  const label = md ? fullLabel : daemonLifecycleLabel({ ...op, targetVersion: null })

  return (
    <span
      title={fullLabel}
      className={`inline-flex max-w-full flex-none items-center rounded-full border border-(--brand) bg-(--surface-sunken) font-sans font-semibold leading-normal text-(--brand) ${
        md ? 'gap-[5px] py-[2px] pr-[9px] pl-[6px] text-[11px]' : 'gap-1 py-[1px] pr-[7px] pl-[5px] text-[10.5px]'
      }`}
    >
      <Spinner size={md ? 11 : 10} />
      {label}
    </span>
  )
}
