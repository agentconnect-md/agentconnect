import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { DaemonRow } from '@/lib/data'
import { changeDaemonApproval, creatorLabel } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { Button, Icon } from '@/components/ui'

export default function DaemonApprovalModal({
  daemon,
  revoke = false,
  onClose
}: {
  daemon: DaemonRow
  revoke?: boolean
  onClose: () => void
}) {
  const t = useTranslations('Daemons.approval')
  const { refresh } = useConsoleData()
  const { me } = useProfile()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (busy || !daemon.canManageApproval || !daemon.approval) return
    setBusy(true)
    setError(null)
    try {
      await changeDaemonApproval(daemon, revoke ? 'revoked' : 'approved')
      refresh()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      refresh()
    }
  }
  return (
    <>
      <div className="modalhead">
        <Icon name="shield" size={20} />
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {t(revoke ? 'revokeTitle' : 'approveTitle', { name: daemon.name })}
        </span>
        <button className="iconbtn" aria-label={t('cancel')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="mb-4 text-[13px] text-(--text-secondary)">
          {t(revoke ? 'revokeDescription' : 'approveDescription')}
        </p>
        {!revoke && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 rounded-lg border border-(--border-subtle) bg-(--surface-sunken) p-4 text-[13px]">
            <dt className="text-(--text-tertiary)">{t('createdBy')}</dt>
            <dd>
              {creatorLabel(daemon.createdBy, me)} · {daemon.createdAt}
            </dd>
            <dt className="text-(--text-tertiary)">{t('host')}</dt>
            <dd className="break-all font-mono">{daemon.host || '—'}</dd>
            <dt className="text-(--text-tertiary)">{t('status')}</dt>
            <dd>{t(daemon.status === 'online' ? 'online' : 'offline')}</dd>
          </dl>
        )}
        {!revoke && daemon.status !== 'online' && (
          <p className="mt-3 text-[13px] text-(--text-secondary)">{t('connectFirst')}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-(--status-error)">
            {error}
          </p>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          disabled={busy || !daemon.canManageApproval || (!revoke && daemon.status !== 'online')}
          onClick={() => void submit()}
        >
          {t(busy ? 'saving' : revoke ? 'revoke' : 'approve')}
        </Button>
      </div>
    </>
  )
}
