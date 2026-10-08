'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import {
  ApiError,
  connectSlackWorkspace,
  fetchAgents,
  fetchOrgs,
  fetchSlackWorkspaceInstall,
  type OrgDto
} from '@/lib/api'
import type { Agent } from '@/lib/data'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

export default function SlackConnect() {
  const t = useTranslations('Auth.slackConnect')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'done'>('loading')
  const [installation, setInstallation] = useState('')
  const [workspace, setWorkspace] = useState<{ workspaceName: string; slackUrl: string } | null>(null)
  const [orgs, setOrgs] = useState<OrgDto[]>([])
  const [orgId, setOrgId] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [identityRequired, setIdentityRequired] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const org = orgs.find((item) => item.id === orgId)

  useEffect(() => {
    let cancelled = false
    const id = new URLSearchParams(window.location.search).get('installation')
    setPhase('loading')
    setError(null)
    setIdentityRequired(false)
    void (async () => {
      try {
        if (!id || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error(t('invalidLink'))
        setInstallation(id)
        if (isAuthConfigured() && !(await getUser())) {
          if (cancelled) return
          if (!writeFlowState('returnTo', window.location.pathname + window.location.search))
            throw new Error(t('storageBlocked'))
          await login('slack')
          return
        }
        const [installed, allOrgs] = await Promise.all([fetchSlackWorkspaceInstall(id), fetchOrgs()])
        if (cancelled) return
        const editable = allOrgs.filter((item) => item.role !== 'viewer')
        setWorkspace(installed)
        setOrgs(editable)
        setOrgId((current) => (editable.some((item) => item.id === current) ? current : (editable[0]?.id ?? '')))
        setPhase('ready')
      } catch (e) {
        if (cancelled) return
        const identity = e instanceof ApiError && e.status === 403
        setIdentityRequired(identity)
        setError(identity ? t('identityRequired') : e instanceof Error ? e.message : t('loadError'))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh, t])

  useEffect(() => {
    if (phase !== 'ready' || !orgId) return
    let cancelled = false
    setAgents([])
    setAgentId('')
    setLoadingAgents(true)
    void fetchAgents(orgId)
      .then((all) => {
        if (cancelled) return
        const editable = all.filter((agent) => agent.canEdit)
        setAgents(editable)
        setAgentId(editable.find((agent) => agent.name === 'agentconnect')?.id ?? editable[0]?.id ?? '')
      })
      .catch(() => {
        if (!cancelled) setError(t('loadError'))
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false)
      })
    return () => {
      cancelled = true
    }
  }, [orgId, phase, t])

  async function connect() {
    if (!orgId || !agentId || loadingAgents) return
    setSubmitting(true)
    setError(null)
    try {
      await connectSlackWorkspace(orgId, installation, agentId)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('connectError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[480px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg)">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        <div>
          <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
            {t(phase === 'done' ? 'doneTitle' : 'title')}
          </h1>
          <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
            {t(phase === 'done' ? 'doneBody' : 'description')}
          </p>
        </div>
        {phase === 'loading' ? (
          <div className="flex justify-center py-6">
            <Spinner size={40} />
          </div>
        ) : null}
        {phase === 'ready' && workspace ? (
          <>
            <p className="text-[14px] text-(--text-primary)">{t('workspace', { name: workspace.workspaceName })}</p>
            {orgs.length ? (
              <label className="flex flex-col gap-2 text-[13px] text-(--text-secondary)">
                {t('organization')}
                <select
                  className="rounded-md border border-(--border-default) bg-(--surface-card) p-2 text-[14px] text-(--text-primary)"
                  value={orgId}
                  disabled={submitting}
                  onChange={(e) => {
                    setOrgId(e.target.value)
                    setAgentId('')
                    setAgents([])
                    setError(null)
                  }}
                >
                  {orgs.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || item.slug}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <p className="text-[13px] text-(--text-secondary)">{t('noOrganizations')}</p>
                <a href="/welcome?new=1" target="_blank" rel="noopener noreferrer" className="dsbtn dsbtn-secondary">
                  {t('createOrganization')}
                </a>
              </>
            )}
            {orgId &&
              (loadingAgents ? (
                <Spinner size={24} />
              ) : agents.length ? (
                <label className="flex flex-col gap-2 text-[13px] text-(--text-secondary)">
                  {t('agent')}
                  <select
                    className="rounded-md border border-(--border-default) bg-(--surface-card) p-2 text-[14px] text-(--text-primary)"
                    value={agentId}
                    disabled={submitting}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <p className="text-[13px] text-(--text-secondary)">{t('noAgents')}</p>
                  <a
                    href={`/${encodeURIComponent(org!.slug)}/agents`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="dsbtn dsbtn-secondary"
                  >
                    {t('manageAgents')}
                  </a>
                </>
              ))}
            <Button onClick={() => void connect()} disabled={submitting || loadingAgents || !agentId}>
              {t(submitting ? 'connecting' : 'connect')}
            </Button>
          </>
        ) : null}
        {phase === 'done' && workspace ? (
          <>
            <a href={workspace.slackUrl} className="dsbtn dsbtn-primary">
              {t('backToSlack')}
            </a>
            <a
              href={`/${encodeURIComponent(org!.slug)}/agents/${encodeURIComponent(agentId)}?tab=config`}
              className="dsbtn dsbtn-secondary"
            >
              {t('configureAgent')}
            </a>
          </>
        ) : null}
        {error && (
          <p role="alert" className="text-[13px] leading-[1.55] text-(--status-error)">
            {error}
          </p>
        )}
        {identityRequired && (
          <a href="/profile" target="_blank" rel="noopener noreferrer" className="dsbtn dsbtn-secondary">
            {t('openProfile')}
          </a>
        )}
        {(phase === 'error' || phase === 'ready') && (
          <Button variant="ghost" disabled={submitting} onClick={() => setRefresh((value) => value + 1)}>
            {t('refresh')}
          </Button>
        )}
      </div>
    </div>
  )
}
