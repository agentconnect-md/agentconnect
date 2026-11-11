'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { ApiError, confirmMsTeamsRecovery, fetchOrgs, verifyMsTeamsRecovery } from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

interface Recovery {
  orgId: string
  organization: string
  agentHref: string
  ticket: string
}

async function verify(): Promise<Recovery | null> {
  const query = new URLSearchParams(window.location.search)
  const returnTo = window.location.pathname + window.location.search
  window.history.replaceState({}, '', '/msteams/connect')
  const saved: unknown = JSON.parse(sessionStorage.getItem('ac.msTeamsRecovery') ?? 'null')
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('orgId' in saved) ||
    !('agentId' in saved) ||
    !('state' in saved) ||
    typeof saved.orgId !== 'string' ||
    typeof saved.agentId !== 'string' ||
    typeof saved.state !== 'string' ||
    query.get('state') !== saved.state ||
    !query.get('code') ||
    query.has('error')
  )
    throw new Error('invalid recovery')
  if (isAuthConfigured() && !(await getUser())) {
    if (!writeFlowState('returnTo', returnTo)) throw new Error('storage unavailable')
    await login()
    return null
  }
  const org = (await fetchOrgs()).find((row) => row.id === saved.orgId && row.role !== 'viewer')
  if (!org) throw new Error('organization unavailable')
  const { ticket } = await verifyMsTeamsRecovery(saved.orgId, saved.state, query.get('code')!)
  sessionStorage.removeItem('ac.msTeamsRecovery')
  return {
    orgId: org.id,
    organization: org.name || org.slug,
    agentHref: `/${org.slug}/agents/${encodeURIComponent(saved.agentId)}`,
    ticket
  }
}

export default function MsTeamsRecovery() {
  const t = useTranslations('Auth.msTeamsConnect')
  const verification = useRef<Promise<Recovery | null> | null>(null)
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const failed = (err: unknown) =>
    setError(
      t(err instanceof ApiError && err.code === 'MSTEAMS_RECOVERY_NOT_ADMIN' ? 'recovery.notAdmin' : 'recovery.failed')
    )
  useEffect(() => {
    let cancelled = false
    verification.current ??= verify()
    void verification.current.then(
      (result) => {
        if (!cancelled) setRecovery(result)
      },
      (err) => {
        if (!cancelled) failed(err)
      }
    )
    return () => {
      cancelled = true
    }
    // One code exchange per landing, including React StrictMode's effect replay.
  }, [])

  async function confirm() {
    if (!recovery) return
    setBusy(true)
    setError(null)
    try {
      await confirmMsTeamsRecovery(recovery.orgId, recovery.ticket)
      setDone(true)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[430px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg)">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
          {t(done ? 'recovery.done' : 'recovery.title')}
        </h1>
        {done ? (
          <>
            <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('recovery.doneBody')}</p>
            <a className="dsbtn dsbtn-primary" href={recovery?.agentHref ?? '/'}>
              {t('backToAgent')}
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
            <Button variant="secondary" disabled={busy} onClick={() => window.location.assign(recovery.agentHref)}>
              {t(error ? 'backToAgent' : 'recovery.cancel')}
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
            {!recovery && (
              <a className="dsbtn dsbtn-secondary" href="/">
                {t('goToAgentConnect')}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  )
}
