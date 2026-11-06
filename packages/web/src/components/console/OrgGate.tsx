'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { LoadingState } from '@/components/marks'
import { Button } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { MOCK_MODE } from '@/lib/data'

export function OrgGate({ children }: { children: ReactNode }) {
  const { activeOrg, loading, error, refreshOrgs } = useOrgs()
  const t = useTranslations('Common')
  if (MOCK_MODE || activeOrg) return children
  if (error) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
        <p role="alert" className="text-[14px] text-(--text-secondary)">
          {t('organizationLoadError')}
        </p>
        <Button disabled={loading} onClick={() => void refreshOrgs()}>
          {t(loading ? 'actions.loading' : 'actions.retry')}
        </Button>
      </div>
    )
  }
  return <LoadingState fill />
}
