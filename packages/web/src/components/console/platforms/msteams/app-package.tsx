// No 'use client' here: rendered only inside ModalProvider's tree and the Settings view, both client trees.

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { saveBlob } from '@/lib/shared-file'
import { msTeamsApi } from './api'
import { MSTEAMS_APP_PACKAGE_FILENAME, msTeamsErrorMessage } from './setup'

/** Downloads the integration's Teams app package and saves it; a refusal shows under the button. */
export function AppPackageButton({ integrationId, className }: { integrationId: string; className: string }) {
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
