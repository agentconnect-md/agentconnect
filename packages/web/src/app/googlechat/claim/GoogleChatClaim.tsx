'use client'

// The Google Chat claim page (google-chat-integration.md §10.5): Chat's private prompt links here to connect a Workspace.

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { ApiError, claimGoogleChatCustomer, fetchOrgs, type OrgDto } from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import {
  decodeGoogleChatClaimState,
  googleChatClaimErrorKey,
  googleChatConversationUrl,
  isGoogleChatRedirect,
  type GoogleChatClaimState
} from '@/lib/googlechat-claim'

type Phase = 'loading' | 'invalid' | 'ready' | 'returning' | 'done'

export default function GoogleChatClaim() {
  const t = useTranslations('Auth.googleChatClaim')
  const [phase, setPhase] = useState<Phase>('loading')
  const [raw, setRaw] = useState('')
  const [claim, setClaim] = useState<GoogleChatClaimState | null>(null)
  const [orgs, setOrgs] = useState<OrgDto[]>([])
  const [orgId, setOrgId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Only organizations the person can edit may take the app.
  const loadOrgs = useCallback(async () => {
    try {
      const editable = (await fetchOrgs()).filter((org) => org.role !== 'viewer')
      setOrgs(editable)
      setOrgId((current) => (editable.some((org) => org.id === current) ? current : (editable[0]?.id ?? '')))
      setError(null)
    } catch {
      setError(t('loadError'))
    }
  }, [t])

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('state')
    const decoded = decodeGoogleChatClaimState(value)
    if (!value || !decoded) {
      setPhase('invalid')
      return
    }
    setRaw(value)
    setClaim(decoded)
    let cancelled = false
    void (async () => {
      if (isAuthConfigured() && !(await getUser())) {
        // The claim is checked against the Google account, so sign in with Google and come back here.
        writeFlowState('returnTo', window.location.pathname + window.location.search)
        await login('google')
        return
      }
      await loadOrgs()
      if (!cancelled) setPhase('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [loadOrgs])

  async function connect() {
    if (!orgId) {
      setError(t('selectOrganization'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { redirect } = await claimGoogleChatCustomer(orgId, raw)
      // Without a completion URL Chat cannot resume the prompt, so the person goes back and writes again.
      if (redirect === undefined) {
        setPhase('done')
        // Best effort: a tab Chat opened closes itself; one the browser keeps open shows the way back.
        window.close()
        return
      }
      if (!isGoogleChatRedirect(redirect)) throw new Error('unexpected redirect')
      setPhase('returning')
      window.location.assign(redirect)
    } catch (e) {
      setError(t(`errors.${e instanceof ApiError ? googleChatClaimErrorKey(e.code, e.status) : 'generic'}`))
      setSubmitting(false)
    }
  }

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[430px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg)">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        {phase === 'invalid' ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-error-soft)">
              <Icon name="link-2-off" size={22} color="var(--status-error)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('unavailable')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{t('errors.invalidLink')}</p>
            </div>
            <Button variant="secondary" onClick={() => window.location.assign('/')}>
              {t('goToAgentConnect')}
            </Button>
          </div>
        ) : phase === 'done' && claim ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-online-soft)">
              <Icon name="check" size={22} color="var(--status-online)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('doneTitle')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{t('doneBody')}</p>
            </div>
            <a href={googleChatConversationUrl(claim)} className="dsbtn dsbtn-primary">
              {t('backToChat')}
            </a>
          </div>
        ) : phase === 'loading' || phase === 'returning' || !claim ? (
          <div className="flex flex-col items-center gap-4 py-6 text-[14px] text-(--text-secondary)">
            <Spinner size={40} />
            {phase === 'returning' ? t('returning') : t('preparing')}
          </div>
        ) : (
          <>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('title')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{t('description')}</p>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px] leading-normal">
              {claim.user ? (
                <>
                  <dt className="text-(--text-tertiary)">{t('account')}</dt>
                  <dd className="mono break-all text-(--text-primary)">{claim.user}</dd>
                </>
              ) : null}
              <dt className="text-(--text-tertiary)">{t('app')}</dt>
              <dd className="mono break-all text-(--text-primary)">{claim.app}</dd>
              <dt className="text-(--text-tertiary)">{t('conversation')}</dt>
              <dd className="break-all text-(--text-primary)">
                {claim.kind === 'dm' ? t('directMessage') : t('space', { name: claim.space })}
              </dd>
            </dl>

            {orgs.length > 0 ? (
              <label className="flex flex-col gap-[6px]">
                <span className="text-[12px] font-medium uppercase tracking-wide text-(--text-tertiary)">
                  {t('organization')}
                </span>
                <select
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  disabled={submitting}
                  className="rounded-md border border-(--border-default) bg-(--surface-card) px-[10px] py-2 text-[14px] text-(--text-primary)"
                >
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name || org.slug}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('noOrganizations')}</p>
                <div className="flex gap-[10px]">
                  <a href="/welcome?new=1" target="_blank" rel="noopener" className="dsbtn dsbtn-secondary">
                    {t('createOrganization')}
                  </a>
                  <Button variant="ghost" onClick={() => void loadOrgs()}>
                    {t('refresh')}
                  </Button>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-[13px] leading-[1.55] text-(--status-error)">
                {error}
              </p>
            )}

            <Button onClick={() => void connect()} disabled={submitting || !orgId}>
              {submitting ? t('connecting') : t('connect')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
