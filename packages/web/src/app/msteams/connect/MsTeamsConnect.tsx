'use client'

// Microsoft returns an administrator here after consent (teams-integration.md §8.3): connect the tenant, then install the app into teams.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import {
  ApiError,
  checkMsTeamsAgentBotRequest,
  continueMsTeamsConnect,
  createMsTeamsAgentBot,
  fetchOrgs,
  finishMsTeamsConnect,
  installMsTeamsTeams,
  startMsTeamsConnect,
  startMsTeamsRecovery,
  type MsTeamsAgentBotRequestDto,
  type MsTeamsConnectResultDto
} from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

type Phase = 'loading' | 'failed' | 'creating' | 'teams' | 'installing' | 'requested' | 'done'

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

// The agent a signed state names, for a connect that has to start again.
function msTeamsConnectAgentId(state: string): string | null {
  try {
    const parsed = JSON.parse(atob(state.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))) as { agentId?: unknown }
    return typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : null
  } catch {
    return null
  }
}

// Whether a state is the silent sign-in's, which Microsoft answers with an error when the account is not of that tenant.
function msTeamsConnectIsSilent(state: string): boolean {
  try {
    const parsed = JSON.parse(atob(state.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))) as { pin?: unknown }
    return typeof parsed.pin === 'string'
  } catch {
    return false
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
  MSTEAMS_AGENT_NAME_TAKEN: 'nameTaken',
  MSTEAMS_AGENT_BOTS_UNAVAILABLE: 'agentBotsUnavailable',
  MSTEAMS_TENANT_NOT_CONNECTED: 'notConnected',
  MSTEAMS_AGENT_ALREADY_CONNECTED: 'alreadyConnected',
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
  // A further agent's own bot has no team step: it joins a team when someone mentions it there (teams-integration.md §8.6.5).
  const [ownBot, setOwnBot] = useState(false)
  // A request from a person who may not publish waits for a Teams administrator's approval (§8.6.6).
  const [request, setRequest] = useState<MsTeamsAgentBotRequestDto | null>(null)
  const [checking, setChecking] = useState(false)
  const [recovery, setRecovery] = useState<{ tenantId: string; agentId: string } | null>(null)
  const [recovering, setRecovering] = useState(false)
  const landing = useRef<URLSearchParams | null>(null)
  const exchange = useRef<Promise<MsTeamsConnectResultDto | null> | null>(null)

  const fail = (e: unknown) => {
    const detail = e instanceof ApiError && e.code === 'MSTEAMS_TENANT_TAKEN' ? e.details?.recovery : null
    if (
      detail &&
      typeof detail === 'object' &&
      'tenantId' in detail &&
      'agentId' in detail &&
      typeof detail.tenantId === 'string' &&
      typeof detail.agentId === 'string'
    )
      setRecovery({ tenantId: detail.tenantId, agentId: detail.agentId })
    const key = e instanceof ApiError && e.code ? ERROR_KEYS[e.code] : undefined
    setError(t(`errors.${(key ?? 'generic') as 'generic'}`))
    setPhase('failed')
  }

  useEffect(() => {
    landing.current ??= new URLSearchParams(window.location.search)
    const params = landing.current
    window.history.replaceState(null, '', window.location.pathname)
    const code = params.get('code')
    const state = params.get('state')
    const org = msTeamsConnectOrgId(state)
    // The tenant-wide consent returns the state and no code: the sign-in follows at once.
    const consented = params.get('admin_consent')?.toLowerCase() === 'true' && !params.get('error') && !code
    // The silent sign-in found no account of the organization's tenant: this is a tenant to connect, through its consent.
    const silentAgent =
      params.get('error') && state && org && msTeamsConnectIsSilent(state) ? msTeamsConnectAgentId(state) : null
    if (silentAgent && org) {
      void startMsTeamsConnect(org, silentAgent, undefined, true)
        .then((again) => window.location.assign(again.authorizeUrl))
        .catch(fail)
      return
    }
    // Microsoft sends an error instead of a code when the person declined or lacks the admin role.
    if (params.get('error') || (!code && !consented) || !state || !org) {
      setError(t(params.get('error') === 'access_denied' ? 'errors.declined' : 'errors.expired'))
      setPhase('failed')
      return
    }
    let cancelled = false
    setOrgId(org)
    exchange.current ??= (async () => {
      if (isAuthConfigured() && !(await getUser())) {
        writeFlowState('returnTo', `${window.location.pathname}?${params}`)
        await login()
        return null
      }
      if (!code) {
        window.location.assign((await continueMsTeamsConnect(org, state)).authorizeUrl)
        return null
      }
      return finishMsTeamsConnect(org, code, state)
    })()
    void (async () => {
      try {
        const connected = await exchange.current
        if (cancelled || !connected) return
        // The person signed in at another tenant than the organization's: one silent sign-in there settles which they meant.
        if (connected.authorizeUrl) {
          window.location.assign(connected.authorizeUrl)
          return
        }
        setResult(connected)
        const slug = (await fetchOrgs().catch(() => [])).find((o) => o.id === org)?.slug
        if (slug) setAgentHref(`/${slug}/agents/${connected.agentId}`)
        // A Teams Store install already has the app: connecting the tenant was the whole step.
        if (connected.store) {
          setPhase('done')
          return
        }
        // A sign-in that resumed a waiting request has nothing more to choose.
        if (connected.request) {
          setRequest(connected.request)
          setPhase('requested')
          return
        }
        if (connected.agentBot) {
          setOwnBot(true)
          // A sign-in that finished a waiting request carries no ticket: there is nothing left to make.
          if (!connected.ticket) {
            setPhase('done')
            return
          }
          // Making the bot takes up to a minute; the page waits for it and has nothing to choose.
          setPhase('creating')
          const made = await createMsTeamsAgentBot(org, connected.ticket)
          if (cancelled) return
          setResult(made)
          // A person who may not publish gets a request that waits for an administrator instead.
          if (made.request) {
            setRequest(made.request)
            setPhase('requested')
          } else setPhase('done')
          return
        }
        // An update preselects nothing: the teams that had the app already run the new package.
        const update = connected.teams.some((team) => team.app !== 'none')
        setChosen(new Set(update ? [] : connected.teams.slice(0, 1).map((team) => team.id)))
        setPhase('teams')
      } catch (e) {
        if (cancelled) return
        // The sign-in skipped the consent page, but this tenant has not recorded it: start again through it.
        const agentId = msTeamsConnectAgentId(state)
        if (e instanceof ApiError && e.code === 'MSTEAMS_CONSENT_NEEDED' && agentId) {
          try {
            window.location.assign((await startMsTeamsConnect(org, agentId, undefined, true)).authorizeUrl)
            return
          } catch (again) {
            fail(again)
            return
          }
        }
        fail(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // Runs once per landing.
  }, [])

  async function recover() {
    if (!recovery) return
    setRecovering(true)
    try {
      const attempt = await startMsTeamsRecovery(orgId, recovery.tenantId, recovery.agentId)
      sessionStorage.setItem(
        'ac.msTeamsRecovery',
        JSON.stringify({ orgId, agentId: recovery.agentId, state: attempt.state })
      )
      window.location.assign(attempt.authorizeUrl)
    } catch {
      setError(t('recovery.failed'))
      setRecovering(false)
    }
  }

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

  async function check() {
    if (!request) return
    setChecking(true)
    try {
      const checked = await checkMsTeamsAgentBotRequest(orgId, request.id)
      if (checked.integrationId) setPhase('done')
      else if (checked.request) setRequest(checked.request)
      // The request is gone: a background check finished it, or someone cancelled it. The agent's page shows which.
      else window.location.assign(agentHref)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) window.location.assign(agentHref)
      else fail(e)
    } finally {
      setChecking(false)
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
            {recovery && (
              <>
                <Button disabled={recovering} onClick={() => void recover()}>
                  {t('recovery.verify')}
                </Button>
                <a className="text-[13px] text-(--brand)" href="mailto:contact@agentconnect.md">
                  {t('recovery.support')}
                </a>
              </>
            )}
            <Button variant="secondary" disabled={recovering} onClick={() => window.location.assign(agentHref)}>
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
                {t(result?.store ? 'storeDoneBody' : ownBot ? 'agentBotDoneBody' : 'doneBody')}
              </p>
            </div>
            <a href={agentHref} className="dsbtn dsbtn-primary">
              {t('backToAgent')}
            </a>
          </div>
        ) : phase === 'requested' && request ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--surface-active)">
              <Icon name="clock" size={22} color="var(--text-secondary)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('request.title')}</h1>
              <p role="status" className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {t(`request.${request.status}`)}
              </p>
            </div>
            <a
              href={request.adminCenterUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="dsbtn dsbtn-secondary no-underline"
            >
              {t('request.openAdmin')}
              <Icon name="external-link" size={14} />
            </a>
            <div className="flex gap-[10px]">
              <Button disabled={checking} onClick={() => void check()}>
                {t(checking ? 'request.checking' : 'request.check')}
              </Button>
              <Button variant="ghost" disabled={checking} onClick={() => window.location.assign(agentHref)}>
                {t('backToAgent')}
              </Button>
            </div>
          </div>
        ) : phase === 'creating' ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center text-[14px] text-(--text-secondary)">
            <Spinner size={40} />
            <p role="status">{t('creatingBot')}</p>
            <p className="text-[13px] leading-[1.55]">{t('agentBotDescription')}</p>
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
