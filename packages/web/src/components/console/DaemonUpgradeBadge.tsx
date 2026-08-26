// The daemon "update available" hint (design: the amber `arrow-up-circle` pill beside
// a daemon's version). It reports that the running version trails the latest in the
// deployment's release channel. When `onClick` is supplied (the caller may command an
// upgrade — online + can-edit), the pill becomes a button that opens the upgrade dialog;
// otherwise it is display-only. Two sizes match the design: the compact chip naming the
// target version on the daemon list card, and the "Update to <latest>" chip in the detail
// header. Renders nothing unless an upgrade is actually available.
import { Icon } from '@/components/ui'

export function DaemonUpgradeBadge({
  show,
  latest,
  size = 'sm',
  onClick
}: {
  show: boolean
  /** The channel's latest version — non-null whenever `show` is true. */
  latest: string | null
  size?: 'sm' | 'md'
  /** When set, the pill is a button that opens the upgrade dialog (stops card navigation). */
  onClick?: () => void
}) {
  if (!show || !latest) return null
  const md = size === 'md'
  const cls = `inline-flex flex-none items-center rounded-full border border-(--amber-500) bg-(--status-paused-soft) font-sans font-semibold leading-normal text-(--amber-500) ${
    md ? 'gap-[5px] py-[2px] pr-[9px] pl-[7px] text-[11px]' : 'gap-1 py-[1px] pr-[7px] pl-[5px] text-[10.5px]'
  }`
  // The compact chip names the version it would move to — a list of "Outdated" pills says
  // which daemons are behind but never what they are behind by.
  const label = md ? `Update to ${latest}` : latest
  const icon = <Icon name="arrow-up-circle" size={md ? 12 : 11} />
  if (onClick) {
    return (
      <button
        type="button"
        title={`Upgrade to ${latest}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={`${cls} cursor-pointer transition-opacity hover:opacity-80`}
      >
        {icon}
        {label}
      </button>
    )
  }
  return (
    <span title={`Latest: ${latest}`} className={cls}>
      {icon}
      {label}
    </span>
  )
}
