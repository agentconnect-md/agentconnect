'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { ApiError, confirmGoogleChatRecovery, fetchOrgs, verifyGoogleChatRecovery } from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import { decodeGoogleChatClaimState, googleChatConversationUrl, isGoogleChatRedirect } from '@/lib/googlechat-claim'

interface Recovery {
  orgId: string
  organization: string
  claim: string
  ticket: string
}

async function verify(): Promise<Recovery | null> {
  const query = new URLSearchParams(window.location.search)
  const returnTo = window.location.pathname + window.location.search
  window.history.replaceState({}, '', '/googlechat/recover')
  const saved: unknown = JSON.parse(sessionStorage.getItem('ac.googleChatRecovery') ?? 'null')
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('orgId' in saved) ||
    !('claim' in saved) ||
    !('state' in saved) ||
    typeof saved.orgId !== 'string' ||
    typeof saved.claim !== 'string' ||
    typeof saved.state !== 'string' ||
    !decodeGoogleChatClaimState(saved.claim) ||
    query.get('state') !== saved.state ||
    !query.get('code')
  )
    throw new Error('invalid recovery')
  if (isAuthConfigured() && !(await getUser())) {
    if (!writeFlowState('returnTo', returnTo)) throw new Error('storage unavailable')
    await login('google')
    return null
  }
  const org = (await fetchOrgs()).find((row) => row.id === saved.orgId && row.role !== 'viewer')
  if (!org) throw new Error('organization unavailable')
  const { ticket } = await verifyGoogleChatRecovery(saved.orgId, saved.state, query.get('code')!)
  sessionStorage.removeItem('ac.googleChatRecovery')
  return { orgId: org.id, organization: org.name || org.slug, claim: saved.claim, ticket }
}

export default function GoogleChatRecovery() {
  const t = useTranslations('Auth.googleChatClaim')
  const verification = useRef<Promise<Recovery | null> | null>(null)
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    let cancelled = false
    verification.current ??= verify()
    void verification.current.then(
      (result) => {
        if (!cancelled) setRecovery(result)
      },
      (err) => {
        if (!cancelled)
          setError(
            t(
              err instanceof ApiError && err.code === 'GOOGLE_CHAT_RECOVERY_NOT_ADMIN'
                ? 'recovery.notAdmin'
                : 'recovery.failed'
            )
          )
      }
    )
    return () => {
      cancelled = true
    }
  }, [t])

  async function confirm() {
    if (!recovery) return
    setBusy(true)
    setError(null)
    try {
      const result = await confirmGoogleChatRecovery(recovery.orgId, recovery.ticket)
      if (result.redirect) {
        if (!isGoogleChatRedirect(result.redirect)) throw new Error('unexpected redirect')
        window.location.assign(result.redirect)
      } else setDone(true)
    } catch (err) {
      setError(
        t(
          err instanceof ApiError && err.code === 'GOOGLE_CHAT_RECOVERY_NOT_ADMIN'
            ? 'recovery.notAdmin'
            : 'recovery.failed'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const claim = recovery ? decodeGoogleChatClaimState(recovery.claim) : null
  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[430px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg)">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
          {t(done ? 'doneTitle' : 'recovery.title')}
        </h1>
        {done && claim ? (
          <>
            <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('doneBody')}</p>
            <a className="dsbtn dsbtn-primary" href={googleChatConversationUrl(claim)}>
              {t('backToChat')}
            </a>
          </>
        ) : recovery ? (
          <>
            <p className="text-[13px] leading-[1.55] text-(--text-secondary)">
              {t('recovery.confirm', { organization: recovery.organization })}
            </p>
            <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('recovery.effect')}</p>
            <Button onClick={() => void confirm()} disabled={busy}>
              {t(busy ? 'connecting' : 'recovery.recover')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => window.location.assign(`/googlechat/claim?state=${encodeURIComponent(recovery.claim)}`)}
            >
              {t('recovery.cancel')}
            </Button>
          </>
        ) : !error ? (
          <div className="flex justify-center">
            <Spinner size={32} />
          </div>
        ) : null}
        {error && (
          <>
            <p role="alert" className="text-[13px] leading-[1.55] text-(--status-error)">
              {error}
            </p>
            <a className="text-[13px] text-(--brand)" href="mailto:contact@agentconnect.md">
              {t('recovery.support')}
            </a>
          </>
        )}
      </div>
    </div>
  )
}
