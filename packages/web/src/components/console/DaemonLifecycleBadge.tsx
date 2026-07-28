import { Spinner } from '@/components/marks'
import type { DaemonLifecycleOp } from '@/lib/data'

// Pending daemon lifecycle state. The list uses a compact action label so the
// running version remains readable; detail views keep the full target version.
export function daemonLifecycleLabel(op: DaemonLifecycleOp): string {
  const action = op.op === 'upgrade' ? 'Upgrading' : 'Restarting'
  return `${action}${op.targetVersion ? ` to ${op.targetVersion}` : ''}…`
}

export function DaemonLifecycleBadge({ op, size = 'sm' }: { op: DaemonLifecycleOp | null; size?: 'sm' | 'md' }) {
  if (op?.status !== 'pending') return null

  const fullLabel = daemonLifecycleLabel(op)
  const md = size === 'md'
  const label = md ? fullLabel : `${op.op === 'upgrade' ? 'Upgrading' : 'Restarting'}…`

  return (
    <span
      title={fullLabel}
      className={`inline-flex flex-none items-center rounded-full border border-(--brand) bg-(--surface-sunken) font-sans font-semibold leading-normal text-(--brand) ${
        md ? 'gap-[5px] py-[2px] pr-[9px] pl-[6px] text-[11px]' : 'gap-1 py-[1px] pr-[7px] pl-[5px] text-[10.5px]'
      }`}
    >
      <Spinner size={md ? 11 : 10} />
      {label}
    </span>
  )
}
