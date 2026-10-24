// No 'use client' here: rendered only inside ModalProvider's tree and the Settings view, both client trees.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { saveBlob } from '@/lib/shared-file'
import { useOrgs } from '@/lib/org-context'
import { msTeamsApi } from './api'
import { MSTEAMS_APP_PACKAGE_FILENAME, msTeamsErrorMessage } from './setup'

/** Downloads the integration's Teams app package and saves it; a refusal shows under the button. */
export function AppPackageButton({
  integrationId,
  className,
  onDownloaded
}: {
  integrationId: string
  className: string
  onDownloaded?: () => void
}) {
  const t = useTranslations('Platforms.msteams')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const download = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      saveBlob(await msTeamsApi.appPackage(integrationId), MSTEAMS_APP_PACKAGE_FILENAME)
      onDownloaded?.()
    } catch (e) {
      setError(msTeamsErrorMessage(e, translate))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 desktop:flex-1">
      <button type="button" className={className} disabled={busy} onClick={() => void download()}>
        <Icon name={busy ? 'loader' : 'download'} size={14} className={busy ? 'animate-spin' : undefined} />
        {busy ? t('appPackage.downloading') : t('appPackage.download')}
      </button>
      {error && (
        <p role="alert" className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {error}
        </p>
      )}
    </div>
  )
}

/** An integration's package in Teams: the download, and, once the agent or the app changed, that Teams holds an older one; a connected tenant updates by signing in again (§5.1). */
export function AppPackageActions({
  integrationId,
  agentId,
  connected,
  canWrite
}: {
  integrationId: string
  agentId: string
  connected: boolean
  canWrite: boolean
}) {
  const t = useTranslations('Platforms.msteams')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  const { activeOrg } = useOrgs()
  const [current, setCurrent] = useState<boolean | null>(null)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const [checked, setChecked] = useState(0)

  useEffect(() => {
    let cancelled = false
    msTeamsApi
      .appPackageStatus(integrationId)
      .then((status) => !cancelled && setCurrent(status.current))
      // Unknown stays silent: the download still works.
      .catch(() => !cancelled && setCurrent(null))
    return () => {
      cancelled = true
    }
  }, [integrationId, checked])

  // Leaves for Microsoft's sign-in; the connect page publishes and upgrades the teams.
  const update = async () => {
    if (lock.current || !activeOrg) return
    lock.current = true
    setUpdating(true)
    setError(null)
    try {
      const { authorizeUrl } = await msTeamsApi.connect(activeOrg.id, agentId)
      window.location.assign(authorizeUrl)
    } catch (e) {
      setError(msTeamsErrorMessage(e, translate))
      setUpdating(false)
      lock.current = false
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {current === false && (
        <p className="m-0 flex items-center gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
          <Icon name="refresh-cw" size={13} color="var(--status-paused)" />
          {t('appPackage.outdated')}
        </p>
      )}
      <div className="flex flex-col gap-2 desktop:flex-row">
        {current === false && connected && canWrite && (
          <button
            type="button"
            className="dsbtn sm dsbtn-primary flex-none"
            disabled={updating}
            onClick={() => void update()}
          >
            {updating ? t('appPackage.updating') : t('appPackage.update')}
          </button>
        )}
        <AppPackageButton
          integrationId={integrationId}
          className="dsbtn sm dsbtn-secondary"
          onDownloaded={() => setChecked((n) => n + 1)}
        />
      </div>
      {error && (
        <p role="alert" className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {error}
        </p>
      )}
    </div>
  )
}
