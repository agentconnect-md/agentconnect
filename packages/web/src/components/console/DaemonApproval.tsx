import { useTranslations } from 'next-intl'
import type { DaemonRow } from '@/lib/data'
import { creatorLabel } from '@/lib/api'
import { useProfile } from '@/lib/profile'
import { useConsoleData } from '@/lib/data-context'
import { Button } from '@/components/ui'
import { useModal } from './ModalProvider'

export function DaemonApprovalCount() {
  const t = useTranslations('Daemons.approval')
  const { daemons } = useConsoleData()
  const count = daemons.filter((d) => d.canManageApproval && d.approval?.status === 'pending').length
  if (!count) return null
  return (
    <span
      className="ml-auto rounded-full bg-(--brand) px-[6px] text-[11px] text-white"
      aria-label={t('count', { count })}
    >
      {count}
    </span>
  )
}

export function DaemonApprovalBadge({ daemon }: { daemon: DaemonRow }) {
  const t = useTranslations('Daemons.approval')
  if (!daemon.approval || daemon.approval.status === 'approved') return null
  return (
    <span
      className={`badge shrink-0 ${daemon.approval.status === 'revoked' ? 'bg-(--status-error-soft) text-(--status-error)' : 'bg-(--brand-soft) text-(--brand)'}`}
    >
      {t(daemon.approval.status)}
    </span>
  )
}

export function DaemonApprovalAction({ daemon, menu = false }: { daemon: DaemonRow; menu?: boolean }) {
  const t = useTranslations('Daemons.approval')
  const { openModal } = useModal()
  if (!daemon.canManageApproval || !daemon.approval) return null
  const revoke = daemon.approval.status === 'approved'
  if (revoke && !menu) return null
  const label = revoke ? 'revoke' : daemon.approval.status === 'revoked' ? 'approveAgain' : 'review'
  const open = () => openModal(revoke ? 'revokeDaemon' : 'approveDaemon', daemon)
  return menu ? (
    <button className="dmi" onClick={open}>
      {t(label)}
    </button>
  ) : (
    <span onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={open}>
        {t(label)}
      </Button>
    </span>
  )
}

export function DaemonApprovalNotice({ daemon }: { daemon: DaemonRow }) {
  const t = useTranslations('Daemons.approval')
  const { me } = useProfile()
  if (!daemon.approval || daemon.approval.status === 'approved') return null
  const revoked = daemon.approval.status === 'revoked'
  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-4 ${revoked ? 'border-(--status-error) bg-(--status-error-soft)' : 'border-(--border-subtle) bg-(--surface-card)'}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[14px] font-semibold leading-normal">
          {t(revoked ? 'revokedTitle' : daemon.canManageApproval ? 'waitingForYou' : 'waiting')}
        </div>
        <p className="mt-1 font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('waitingDescription')}
        </p>
        {revoked && daemon.approval.changedAt && (
          <p className="mt-1 text-[12px] text-(--text-tertiary)">
            {t('changedBy', {
              name: creatorLabel(daemon.approval.changedBy, me),
              date: new Date(daemon.approval.changedAt).toLocaleString()
            })}
          </p>
        )}
      </div>
      <DaemonApprovalAction daemon={daemon} />
    </div>
  )
}
