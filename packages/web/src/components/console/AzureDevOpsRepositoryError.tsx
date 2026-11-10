'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import type { AzureDevOpsRepositoryPicker } from '@/lib/use-azure-devops-repositories'

export function AzureDevOpsRepositoryError({ picker }: { picker: AzureDevOpsRepositoryPicker }) {
  const t = useTranslations('Integrations.dialog.workspaceFields')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error) desktop:col-span-2">
      {picker.verificationRequired ? t('azureVerifyDescription') : picker.error}
      {picker.verificationRequired && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void picker
              .verify()
              .then((opened) => {
                if (!opened) setError(t('azureVerifyPopupBlocked'))
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false))
          }}
        >
          {t('azureVerifyAccess')}
        </Button>
      )}
      {error && <span>{error}</span>}
      <button type="button" className="lnk" disabled={picker.reloading} onClick={picker.reload}>
        {t('connectedSync')}
      </button>
    </div>
  )
}
