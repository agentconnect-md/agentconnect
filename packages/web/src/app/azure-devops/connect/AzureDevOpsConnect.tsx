'use client'

// Microsoft returns an administrator here (azure-devops-integration.md §3.2): finish the sign-in, pick the organization and projects, apply.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import {
  ApiError,
  applyAzureDevOpsConnectProjects,
  chooseAzureDevOpsConnectOrganization,
  fetchOrgs,
  finishAzureDevOpsSignIn,
  listAzureDevOpsConnectOrganizations,
  startAzureDevOpsConnect,
  verifyAzureDevOpsConnect,
  type AzureDevOpsConnectResultDto,
  type AzureDevOpsProjectGroup
} from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'

/** The organization and, for Manage project access, the connection a signed state names; the Control Plane re-checks the signature. */
export function azureDevOpsConnectState(state: string | null): { orgId: string; connectionId: string | null } | null {
  const payload = state?.split('.')[0]
  if (!payload) return null
  try {
    const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { o?: unknown; c?: unknown }
    if (typeof parsed.o !== 'string' || !parsed.o) return null
    return { orgId: parsed.o, connectionId: typeof parsed.c === 'string' && parsed.c ? parsed.c : null }
  } catch {
    return null
  }
}

interface Refusal {
  code: string
  message: string
  adminConsentUrl?: string
  authorizeUrl?: string
  checklist?: string[]
  ticket?: string
}

type Step =
  | { kind: 'loading' }
  | { kind: 'organization'; organizations: Array<{ id: string; name: string }> }
  | { kind: 'projects'; organization: string; projects: Array<{ id: string; name: string }> }
  | { kind: 'done'; result: AzureDevOpsConnectResultDto }
  | { kind: 'refused'; refusal: Refusal }

/** Refusals a manual step in Azure DevOps resolves; the ticket they carry resumes at verification. */
const MANUAL = new Set([
  'project_collection_administrator_required',
  'entitlement_refused',
  'memberships_incomplete',
  'not_in_organization',
  'no_repository_access',
  'access_revoked'
])

function refusalOf(e: unknown): Refusal {
  if (!(e instanceof ApiError)) return { code: 'unknown', message: e instanceof Error ? e.message : String(e) }
  const details = e.details ?? {}
  const text = (key: string) => (typeof details[key] === 'string' ? (details[key] as string) : undefined)
  const checklist = Array.isArray(details.checklist)
    ? details.checklist.filter((item): item is string => typeof item === 'string')
    : undefined
  const adminConsentUrl = text('adminConsentUrl')
  const authorizeUrl = text('authorizeUrl')
  const ticket = text('ticket')
  return {
    code: e.code ?? 'unknown',
    message: e.message,
    ...(adminConsentUrl ? { adminConsentUrl } : {}),
    ...(authorizeUrl ? { authorizeUrl } : {}),
    ...(checklist?.length ? { checklist } : {}),
    ...(ticket ? { ticket } : {})
  }
}

export default function AzureDevOpsConnect() {
  const t = useTranslations('Auth.azureDevOpsConnect')
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [orgId, setOrgId] = useState('')
  const [integrationsHref, setIntegrationsHref] = useState('/')
  const [chosenOrganization, setChosenOrganization] = useState('')
  const [groups, setGroups] = useState<Map<string, AzureDevOpsProjectGroup>>(new Map())
  // The flow ticket lives in this page's memory for the flow alone: never storage, never a URL.
  const flow = useRef<{ flowId: string; ticket: string; connectionId: string | null } | null>(null)
  const [organizations, setOrganizations] = useState<Array<{ id: string; name: string }>>([])
  // Manage project access names its connection in the signed state.
  const [connectionId, setConnectionId] = useState<string | null>(null)

  const refuse = (e: unknown) => {
    const refusal = refusalOf(e)
    if (refusal.ticket && flow.current) flow.current = { ...flow.current, ticket: refusal.ticket }
    setStep({ kind: 'refused', refusal })
  }

  const showProjects = (organization: string, projects: Array<{ id: string; name: string }>) => {
    setGroups(new Map())
    setStep({ kind: 'projects', organization, projects })
  }

  const chooseOrganization = async (org: string, organization: string) => {
    const current = flow.current
    if (!current) return
    const chosen = await chooseAzureDevOpsConnectOrganization(org, current.flowId, current.ticket, organization)
    flow.current = { ...current, ticket: chosen.ticket }
    showProjects(chosen.organization, chosen.projects)
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const state = params.get('state')
    const target = azureDevOpsConnectState(state)
    if (!state || !target) {
      setStep({ kind: 'refused', refusal: { code: 'connect_state_invalid', message: '' } })
      return
    }
    setConnectionId(target.connectionId)
    setOrgId(target.orgId)
    let cancelled = false
    void (async () => {
      if (isAuthConfigured() && !(await getUser())) {
        writeFlowState('returnTo', window.location.pathname + window.location.search)
        await login()
        return
      }
      const slug = (await fetchOrgs().catch(() => [])).find((o) => o.id === target.orgId)?.slug
      if (!cancelled && slug) setIntegrationsHref(`/${slug}/integrations`)
      try {
        const code = params.get('code')
        const error = params.get('error')
        const description = params.get('error_description')
        // The code is single-use, so the address bar drops it before anything can replay it.
        window.history.replaceState(null, '', window.location.pathname)
        const started = await finishAzureDevOpsSignIn(target.orgId, {
          state,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
          ...(description ? { error_description: description } : {})
        })
        if (cancelled) return
        flow.current = { flowId: started.flowId, ticket: started.ticket, connectionId: started.connectionId }
        // Manage project access keeps its organization, so the picker is skipped.
        if (started.organization) {
          await chooseOrganization(target.orgId, started.organization)
          return
        }
        const listed = await listAzureDevOpsConnectOrganizations(target.orgId, started.flowId, started.ticket)
        if (cancelled) return
        setOrganizations(listed)
        setChosenOrganization(listed.length === 1 ? listed[0]!.name : '')
        setStep({ kind: 'organization', organizations: listed })
      } catch (e) {
        if (!cancelled) refuse(e)
      }
    })()
    return () => {
      cancelled = true
    }
    // Runs once per landing.
  }, [])

  const act = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      refuse(e)
    } finally {
      setBusy(false)
    }
  }

  const continueWithOrganization = () =>
    act(async () => {
      if (chosenOrganization) await chooseOrganization(orgId, chosenOrganization)
    })

  const apply = () =>
    act(async () => {
      const current = flow.current
      if (!current || groups.size === 0) return
      const projects = [...groups.entries()].map(([projectId, group]) => ({ projectId, group }))
      setStep({
        kind: 'done',
        result: await applyAzureDevOpsConnectProjects(orgId, current.flowId, current.ticket, projects)
      })
    })

  const checkAgain = () =>
    act(async () => {
      const current = flow.current
      if (!current) return
      setStep({ kind: 'done', result: await verifyAzureDevOpsConnect(orgId, current.flowId, current.ticket) })
    })

  const startOver = () =>
    act(async () => {
      window.location.assign((await startAzureDevOpsConnect(connectionId ?? undefined, orgId)).authorizeUrl)
    })

  const toggleProject = (projectId: string) =>
    setGroups((current) => {
      const next = new Map(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.set(projectId, 'readers')
      return next
    })

  const setGroup = (projectId: string, group: AzureDevOpsProjectGroup) =>
    setGroups((current) => new Map(current).set(projectId, group))

  const managed = connectionId !== null

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[480px] flex-col gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 font-sans shadow-(--shadow-lg) max-desktop:px-5">
        <div className="flex justify-center">
          <Wordmark height={30} />
        </div>
        {step.kind === 'loading' ? (
          <div className="flex flex-col items-center gap-4 py-6 text-[14px] text-(--text-secondary)">
            <Spinner size={40} />
            {t('connecting')}
          </div>
        ) : step.kind === 'organization' ? (
          <>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
                {t('organizationTitle')}
              </h1>
            </div>
            {step.organizations.length === 0 ? (
              <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('noOrganizations')}</p>
            ) : (
              <div role="radiogroup" className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
                {step.organizations.map((organization) => (
                  <label
                    key={organization.id}
                    className="flex cursor-pointer items-center gap-[10px] text-[14px] text-(--text-primary)"
                  >
                    <input
                      type="radio"
                      name="azure-devops-organization"
                      checked={chosenOrganization === organization.name}
                      onChange={() => setChosenOrganization(organization.name)}
                    />
                    <span className="mono min-w-0 truncate">{organization.name}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-[10px]">
              {step.organizations.length === 0 ? (
                <Button onClick={() => void startOver()} disabled={busy}>
                  {t('startOver')}
                </Button>
              ) : (
                <Button onClick={() => void continueWithOrganization()} disabled={busy || !chosenOrganization}>
                  {busy ? t('working') : t('continue')}
                </Button>
              )}
              <a href={integrationsHref} className="dsbtn dsbtn-ghost">
                {t('cancel')}
              </a>
            </div>
          </>
        ) : step.kind === 'projects' ? (
          <>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('projectsTitle')}</h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {t('projectsDescription', { organization: step.organization })}
              </p>
            </div>
            {step.projects.length === 0 ? (
              <p className="text-[13px] leading-[1.55] text-(--text-secondary)">{t('noProjects')}</p>
            ) : (
              <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
                {step.projects.map((project) => {
                  const group = groups.get(project.id)
                  return (
                    <div
                      key={project.id}
                      data-azure-devops-project={project.id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-[10px] text-[14px] text-(--text-primary)">
                        <input
                          type="checkbox"
                          checked={group !== undefined}
                          disabled={busy}
                          onChange={() => toggleProject(project.id)}
                        />
                        <span className="min-w-0 truncate">{project.name}</span>
                      </label>
                      {group !== undefined && (
                        <span
                          role="group"
                          aria-label={t('groupFor', { project: project.name })}
                          className="pillbar flex-none gap-[2px] p-[2px]"
                        >
                          {(['readers', 'contributors'] as const).map((value) => (
                            <button
                              key={value}
                              type="button"
                              aria-pressed={group === value}
                              disabled={busy}
                              className={
                                group === value
                                  ? 'pill on px-[10px] py-[3px] text-[12px]'
                                  : 'pill px-[10px] py-[3px] text-[12px]'
                              }
                              onClick={() => setGroup(project.id, value)}
                            >
                              {value === 'readers' ? t('readers') : t('contributors')}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-[12px] leading-[1.5] text-(--text-tertiary)">{t('groupHint')}</p>
            <div className="flex flex-wrap gap-[10px]">
              <Button onClick={() => void apply()} disabled={busy || groups.size === 0}>
                {busy ? t('applying') : managed ? t('apply') : t('connect')}
              </Button>
              <a href={integrationsHref} className="dsbtn dsbtn-ghost">
                {t('cancel')}
              </a>
            </div>
          </>
        ) : step.kind === 'done' ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-online-soft)">
              <Icon name="check" size={22} color="var(--status-online)" />
            </span>
            <div>
              <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">
                {managed ? t('managedTitle') : t('doneTitle')}
              </h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {t('doneBody', { organization: step.result.connection.organization })}
              </p>
            </div>
            <a href={integrationsHref} className="dsbtn dsbtn-primary">
              {t('backToIntegrations')}
            </a>
          </div>
        ) : (
          <RefusalView
            refusal={step.refusal}
            busy={busy}
            canChooseAnother={!managed && organizations.length > 1}
            canStartOver={orgId !== ''}
            integrationsHref={integrationsHref}
            onCheckAgain={() => void checkAgain()}
            onStartOver={() => void startOver()}
            onChooseAnother={() => setStep({ kind: 'organization', organizations })}
          />
        )}
      </div>
    </div>
  )
}

function RefusalView({
  refusal,
  busy,
  canChooseAnother,
  canStartOver,
  integrationsHref,
  onCheckAgain,
  onStartOver,
  onChooseAnother
}: {
  refusal: Refusal
  busy: boolean
  canChooseAnother: boolean
  canStartOver: boolean
  integrationsHref: string
  onCheckAgain: () => void
  onStartOver: () => void
  onChooseAnother: () => void
}) {
  const t = useTranslations('Auth.azureDevOpsConnect')
  const manual = MANUAL.has(refusal.code)
  const copy = (() => {
    switch (refusal.code) {
      case 'consent_required':
        return { title: t('refusals.consentTitle'), body: t('refusals.consentBody') }
      case 'tenant_mismatch':
        return { title: t('refusals.tenantTitle'), body: t('refusals.tenantBody') }
      case 'project_collection_administrator_required':
        return { title: t('refusals.pcaTitle'), body: t('refusals.manualBody') }
      case 'entitlement_refused':
        return { title: t('refusals.entitlementTitle'), body: t('refusals.manualBody') }
      case 'memberships_incomplete':
        return { title: t('refusals.membershipsTitle'), body: t('refusals.manualBody') }
      case 'not_in_organization':
      case 'access_revoked':
        return { title: t('refusals.notInOrganizationTitle'), body: t('refusals.manualBody') }
      case 'no_repository_access':
        return { title: t('refusals.noRepositoryTitle'), body: t('refusals.manualBody') }
      case 'insufficient_rights':
        return { title: t('refusals.insufficientTitle'), body: t('refusals.insufficientBody') }
      case 'personal_account':
        return { title: t('refusals.personalTitle'), body: t('refusals.personalBody') }
      case 'AZURE_DEVOPS_ORGANIZATION_TAKEN':
        return { title: t('refusals.takenTitle'), body: t('refusals.takenBody') }
      case 'connect_flow_invalid':
      case 'connect_state_invalid':
        return { title: t('refusals.expiredTitle'), body: t('refusals.expiredBody') }
      default:
        return { title: t('refusals.genericTitle'), body: refusal.message || t('refusals.expiredBody') }
    }
  })()
  // A manual refusal without its own checklist says what to do in the Control Plane's message.
  const steps = refusal.checklist ?? (manual && refusal.message ? [refusal.message] : undefined)
  return (
    <div data-azure-devops-refusal={refusal.code} className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-(--status-paused-soft)">
          <Icon name={manual ? 'list-checks' : 'link-2-off'} size={19} color="var(--amber-500)" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{copy.title}</h1>
          <p role="alert" className="mt-1 text-[13px] leading-[1.55] text-(--text-secondary)">
            {copy.body}
          </p>
        </div>
      </div>
      {steps && (
        <ol className="m-0 flex list-decimal flex-col gap-[6px] pl-5 text-[13px] leading-[1.55] text-(--text-primary)">
          {steps.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ol>
      )}
      {refusal.code === 'consent_required' && refusal.adminConsentUrl && (
        <div className="flex flex-col gap-[6px]">
          <span className="text-[12px] text-(--text-tertiary)">{t('refusals.consentLink')}</span>
          <a
            className="mono break-all rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 text-[12px] text-(--text-primary)"
            href={refusal.adminConsentUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {refusal.adminConsentUrl}
          </a>
        </div>
      )}
      <div className="flex flex-wrap gap-[10px]">
        {manual && refusal.ticket ? (
          <Button onClick={onCheckAgain} disabled={busy}>
            <Icon name="rotate-ccw" size={14} />
            {busy ? t('working') : t('checkAgain')}
          </Button>
        ) : refusal.code === 'tenant_mismatch' && refusal.authorizeUrl ? (
          <Button onClick={() => window.location.assign(refusal.authorizeUrl!)}>
            <Icon name="log-in" size={14} />
            {t('signInAgain')}
          </Button>
        ) : refusal.code === 'AZURE_DEVOPS_ORGANIZATION_TAKEN' && canChooseAnother ? (
          <Button onClick={onChooseAnother}>{t('chooseAnother')}</Button>
        ) : canStartOver ? (
          <Button onClick={onStartOver} disabled={busy}>
            {busy ? t('working') : t('startOver')}
          </Button>
        ) : null}
        <a href={integrationsHref} className="dsbtn dsbtn-ghost">
          {t('backToIntegrations')}
        </a>
      </div>
    </div>
  )
}
