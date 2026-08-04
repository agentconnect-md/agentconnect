// No 'use client' here: imported only by client components (the daemon modals
// under ModalProvider), so it's already in the client bundle — and keeping the
// directive off avoids Next's "props must be serializable" check on onChange.

/**
 * The daemon's "Expire sessions" picker (Add/Edit daemon modals): how long the
 * daemon keeps FINISHED sessions in its local store before its retention sweep
 * deletes them (session row + per-session Git worktree). 'never' disables the
 * sweep. Rendered as the standard `.inp` field with an invisible overlaid
 * native <select> (same pattern as the lifecycle modal's version picker).
 */
import { Icon } from '@/components/ui'
import type { DaemonSessionRetention } from '@/lib/api'

export const SESSION_RETENTION_DEFAULT: DaemonSessionRetention = '7d'

const OPTIONS: { value: DaemonSessionRetention; label: string }[] = [
  { value: '7d', label: 'After 7 days' },
  { value: '30d', label: 'After 30 days' },
  { value: '90d', label: 'After 90 days' },
  { value: 'never', label: 'Never' }
]

export function SessionRetentionField({
  value,
  onChange,
  disabled
}: {
  value: DaemonSessionRetention
  onChange: (value: DaemonSessionRetention) => void
  disabled?: boolean
}) {
  const label = OPTIONS.find((o) => o.value === value)?.label ?? value
  return (
    <div className="fld mt-[14px]">
      <span className="fldlbl">Expire sessions</span>
      <div className={`inp relative ${disabled ? 'opacity-60' : ''}`}>
        <span className="truncate font-sans text-[13px] text-(--text-primary)">
          {label}
          {value === SESSION_RETENTION_DEFAULT && <span className="text-(--text-tertiary)"> · default</span>}
        </span>
        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="ml-auto" />
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as DaemonSessionRetention)}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
          aria-label="Expire sessions"
        >
          {OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.value === SESSION_RETENTION_DEFAULT ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </div>
      <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        Finished sessions older than this are deleted from the daemon, including their workspaces.
      </span>
    </div>
  )
}
