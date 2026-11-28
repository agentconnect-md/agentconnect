'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { LoadingState, OrgIconView } from '@/components/marks'
import { Button } from '@/components/ui'
import { currentUser, loginWithSso } from '@/lib/auth'
import type { OrgDto } from '@/lib/api'
import { clearSsoTest } from '@/lib/organization-sso'
import { writeFlowState } from '@/lib/flow-state'
import { orgColor, useOrgs } from '@/lib/org-context'
import { MOCK_MODE } from '@/lib/data'

export function OrgGate({ children, orgless }: { children: ReactNode; orgless?: boolean }) {
  const { activeOrg, orgs, loading, error, refreshOrgs } = useOrgs()
  const t = useTranslations('Common')
  if (activeOrg?.ssoSignIn) return <OrgSsoSignIn org={activeOrg} connection={activeOrg.ssoSignIn} />
  if (MOCK_MODE || activeOrg) return children
  // An account page has nothing to wait for once the caller is known to belong to no organization.
  if (orgless && !loading && !error && orgs.length === 0) return children
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

// The organization accepts this browser session only once it signs in through its SSO connection (organization-sso.md §4.5).
function OrgSsoSignIn({ org, connection }: { org: OrgDto; connection: { connectorId: string } }) {
  const t = useTranslations('Common.organizationSso')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const orgName = org.name ?? org.slug

  const signIn = async () => {
    setPending(true)
    setFailed(null)
    try {
      // The sign-in lands on the callback, which returns here.
      writeFlowState('returnTo', window.location.pathname + window.location.search)
      clearSsoTest()
      await loginWithSso(connection.connectorId, currentUser()?.email ?? undefined)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
      <OrgIconView
        icon={org.icon}
        iconUrl={org.iconUrl}
        label={orgName}
        fallbackColor={orgColor(org.id)}
        size={40}
        className="rounded-md text-[18px]"
      />
      <h1 className="font-sans text-[18px] leading-normal font-semibold text-(--text-primary)">
        {t('title', { org: orgName })}
      </h1>
      <Button disabled={pending} onClick={() => void signIn()}>
        {t('signIn')}
      </Button>
      {failed && (
        <p role="alert" className="text-[13px] text-(--status-error)">
          {failed}
        </p>
      )}
    </div>
  )
}
