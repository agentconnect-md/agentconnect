'use client'

// Microsoft returns an administrator here after consent (teams-integration.md §8.3): connect the tenant, then install the app into teams.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { ApiError, fetchOrgs, finishMsTeamsConnect, installMsTeamsTeams, type MsTeamsConnectResultDto } from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

type Phase = 'loading' | 'failed' | 'teams' | 'installing' | 'done'

/** The organization a signed state names; the Control Plane re-checks the signature, this only routes the request. */
export function msTeamsConnectOrgId(state: string | null): string | null {
  const payload = state?.split('.')[0]
  if (!payload) return null
  try {
    const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { orgId?: unknown }
    return typeof parsed.orgId === 'string' && parsed.orgId ? parsed.orgId : null
  } catch {
    return null
  }
}

// The Control Plane's refusal codes, each mapped to the sentence that names its fix.
const ERROR_KEYS: Record<string, string> = {
  MSTEAMS_CONNECT_STATE_INVALID: 'expired',
  MSTEAMS_CONNECT_DENIED: 'denied',
  MSTEAMS_CONNECT_PERSONAL_ACCOUNT: 'personalAccount',
  MSTEAMS_CONNECT_NOT_ADMIN: 'notAdmin',
  MSTEAMS_TENANT_TAKEN: 'taken',
  MSTEAMS_TENANT_IN_USE: 'inUse',
  MSTEAMS_CONNECT_NO_AGENT: 'noAgent',
  MSTEAMS_RELAY_ORIGIN_MISSING: 'unavailable',
  MSTEAMS_CONNECT_UNAVAILABLE: 'unavailable',
  MSTEAMS_TENANT_MISMATCH: 'tenantMismatch'
}

export default function MsTeamsConnect() {
  const t = useTranslations('Auth.msTeamsConnect')
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [orgId, setOrgId] = useState('')
  const [result, setResult] = useState<MsTeamsConnectResultDto | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [agentHref, setAgentHref] = useState('/')

  const fail = (e: unknown) => {
    const key = e instanceof ApiError && e.code ? ERROR_KEYS[e.code] : undefined
    setError(t(`errors.${(key ?? 'generic') as 'generic'}`))
    setPhase('failed')
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const org = msTeamsConnectOrgId(state)
    // Microsoft sends an error instead of a code when the person declined or lacks the admin role.
    if (params.get('error') || !code || !state || !org) {
      setError(t(params.get('error') === 'access_denied' ? 'errors.declined' : 'errors.expired'))
      setPhase('failed')
      return
    }
    let cancelled = false
    void (async () => {
      if (isAuthConfigured() && !(await getUser())) {
        writeFlowState('returnTo', window.location.pathname + window.location.search)
        await login()
        return
      }
      try {
        // The code is single-use, so the address bar drops it before anything can replay it.
        window.history.replaceState(null, '', window.location.pathname)
        const connected = await finishMsTeamsConnect(org, code, state)
        if (cancelled) return
        setOrgId(org)
        setResult(connected)
        const slug = (await fetchOrgs().catch(() => [])).find((o) => o.id === org)?.slug
        if (slug) setAgentHref(`/${slug}/agents/${connected.agentId}`)
        // A Teams Store install already has the app: connecting the tenant was the whole step.
        if (connected.store) {
          setPhase('done')
          return
        }
        // An update preselects nothing: the teams that had the app already run the new package.
        const update = connected.teams.some((team) => team.app !== 'none')
        setChosen(new Set(update ? [] : connected.teams.slice(0, 1).map((team) => team.id)))
        setPhase('teams')
      } catch (e) {
        if (!cancelled) fail(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // Runs once per landing.
  }, [])

  async function install() {
    if (!result?.ticket || chosen.size === 0) return
    setPhase('installing')
    setError(null)
    try {
      await installMsTeamsTeams(orgId, result.ticket, [...chosen])
      setPhase('done')
    } catch (e) {
      fail(e)
    }
  }

  const updatedCount = result?.teams.filter((team) => team.app === 'updated').length ?? 0
  const failedCount = result?.teams.filter((team) => team.app === 'failed').length ?? 0

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[430px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg)">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        {phase === 'failed' ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-error-soft)">
              <Icon name="link-2-off" size={22} color="var(--status-error)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('failedTitle')}</h1>
              <p role="alert" className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {error}
              </p>
            </div>
            <Button variant="secondary" onClick={() => window.location.assign(agentHref)}>
              {t('goToAgentConnect')}
            </Button>
          </div>
        ) : phase === 'done' ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-online-soft)">
              <Icon name="check" size={22} color="var(--status-online)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('doneTitle')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {t(result?.store ? 'storeDoneBody' : 'doneBody')}
              </p>
            </div>
            <a href={agentHref} className="dsbtn dsbtn-primary">
              {t('backToAgent')}
            </a>
          </div>
        ) : phase === 'loading' || !result ? (
          <div className="flex flex-col items-center gap-4 py-6 text-[14px] text-(--text-secondary)">
            <Spinner size={40} />
            {t('connecting')}
          </div>
        ) : (
          <>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('title')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{t('description')}</p>
              {updatedCount > 0 && (
                <p role="status" className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                  {t('updated', { count: updatedCount })}
                </p>
              )}
              {failedCount > 0 && (
                <p role="alert" className="mt-2 text-[13px] leading-[1.55] text-(--status-error)">
                  {t('updateFailed', { count: failedCount })}
                </p>
              )}
            </div>
            {result.teams.length > 0 ? (
              <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto">
                {result.teams.map((team) => (
                  <label
                    key={team.id}
                    className="flex cursor-pointer items-center gap-[10px] text-[14px] text-(--text-primary)"
                  >
                    <input
                      type="checkbox"
                      checked={team.app === 'updated' || chosen.has(team.id)}
                      disabled={team.app !== 'none' || phase === 'installing'}
                      onChange={() => toggle(team.id)}
                    />
                    {team.name}
                    {team.app !== 'none' && (
                      <span className="text-[12px] text-(--text-tertiary)">
                        {t(team.app === 'updated' ? 'teamUpdated' : 'teamNotUpdated')}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('noTeams')}</p>
            )}
            <p className="text-[12px] leading-[1.5] text-(--text-tertiary)">{t('personal')}</p>
            <div className="flex gap-[10px]">
              {updatedCount + failedCount > 0 && chosen.size === 0 ? (
                <Button onClick={() => setPhase('done')}>{t('finish')}</Button>
              ) : (
                <>
                  <Button onClick={() => void install()} disabled={phase === 'installing' || chosen.size === 0}>
                    {phase === 'installing' ? t('installing') : t('install')}
                  </Button>
                  <Button variant="ghost" onClick={() => setPhase('done')} disabled={phase === 'installing'}>
                    {t('skip')}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
