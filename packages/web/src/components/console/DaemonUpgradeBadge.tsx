// The amber pill beside a daemon's version, shown only when its release channel has a newer one.
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
  /** `sm` names the target version (the list card); `md` says "Update to <latest>" (the detail header). */
  size?: 'sm' | 'md'
  /** When set, the pill is a button that opens the upgrade dialog (stops card navigation). */
  onClick?: () => void
}) {
  if (!show || !latest) return null
  const md = size === 'md'
  const cls = `inline-flex flex-none items-center rounded-full border border-(--amber-500) bg-(--status-paused-soft) font-sans font-semibold leading-normal text-(--amber-500) ${
    md ? 'gap-[5px] py-[2px] pr-[9px] pl-[7px] text-[11px]' : 'gap-1 py-[1px] pr-[7px] pl-[5px] text-[10.5px]'
  }`
  // The compact chip names the target version: "Outdated" says which daemons are behind, never what by.
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
