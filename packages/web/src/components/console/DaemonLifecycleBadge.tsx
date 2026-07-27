import { Spinner } from '@/components/marks'
import type { DaemonLifecycleOp } from '@/lib/data'

export function daemonLifecycleLabel(op: DaemonLifecycleOp): string {
  const action = op.op === 'upgrade' ? 'Upgrading' : 'Restarting'
  return `${action}${op.targetVersion ? ` to ${op.targetVersion}` : ''}…`
}

export function DaemonLifecycleBadge({ op }: { op: DaemonLifecycleOp | null }) {
  if (op?.status !== 'pending') return null

  const label = daemonLifecycleLabel(op)

  return (
    <span
      title={label}
      className="inline-flex flex-none items-center gap-[5px] rounded-full border border-(--brand) bg-(--surface-sunken) py-[2px] pr-[9px] pl-[6px] font-sans text-[11px] font-semibold leading-normal text-(--brand)"
    >
      <Spinner size={11} />
      {label}
    </span>
  )
}
