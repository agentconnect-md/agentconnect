'use client'

// Microsoft returns an administrator here (azure-devops-integration.md §3.2): finish the sign-in, pick the organization and projects, apply.

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { TooltipLayer } from '@/components/console/Tooltip'
import {
  ApiError,
  applyAzureDevOpsConnectProjects,
  chooseAzureDevOpsConnectOrganization,
  fetchOrgs,
  finishAzureDevOpsSignIn,
  listAzureDevOpsConnectOrganizations,
  startAzureDevOpsConnect,
  verifyAzureDevOpsConnect,
  type AzureDevOpsConnectFlowDto,
  type AzureDevOpsConnectResultDto,
  type AzureDevOpsProjectGroup
} from '@/lib/api'
import { getUser, isAuthConfigured, login } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import AzureDevOpsVerify from './AzureDevOpsVerify'

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

// The code is single-use: Strict Mode's second effect run shares the first run's redemption.
const redemptions = new Map<string, Promise<AzureDevOpsConnectFlowDto>>()

function redeemOnce(
  orgId: string,
  input: { state: string; code?: string; error?: string; error_description?: string }
): Promise<AzureDevOpsConnectFlowDto> {
  const pending = redemptions.get(input.state)
  if (pending) return pending
  const started = finishAzureDevOpsSignIn(orgId, input)
  redemptions.set(input.state, started)
  void started.then(
    () => redemptions.delete(input.state),
    () => redemptions.delete(input.state)
  )
  return started
}

interface Refusal {
  code: string
  message: string
  adminConsentUrl?: string
  authorizeUrl?: string
  checklist?: string[]
  ticket?: string
}

type ProjectAccess = { group: AzureDevOpsProjectGroup; allowTriggers: boolean }

type Project = { id: string; name: string; access?: ProjectAccess }

type Step =
  | { kind: 'loading' }
  | { kind: 'organization'; organizations: Project[] }
  | { kind: 'projects'; organization: string; projects: Project[] }
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

/** Each refusal's title and what the person must do, as message keys under `refusals`. */
const REFUSAL_COPY = {
  consent_required: ['consentTitle', 'consentBody'],
  tenant_mismatch: ['tenantTitle', 'tenantBody'],
  project_collection_administrator_required: ['pcaTitle', 'pcaBody'],
  entitlement_refused: ['entitlementTitle', 'manualBody'],
  memberships_incomplete: ['membershipsTitle', 'manualBody'],
  not_in_organization: ['notInOrganizationTitle', 'manualBody'],
  access_revoked: ['notInOrganizationTitle', 'notInOrganizationBody'],
  no_repository_access: ['noRepositoryTitle', 'noRepositoryBody'],
  insufficient_rights: ['insufficientTitle', 'insufficientBody'],
  personal_account: ['personalTitle', 'personalBody'],
  AZURE_DEVOPS_ORGANIZATION_TAKEN: ['takenTitle', 'takenBody'],
  connection_exists: ['connectionExistsTitle', 'connectionExistsBody'],
  connect_flow_invalid: ['expiredTitle', 'expiredBody'],
  connect_state_invalid: ['expiredTitle', 'expiredBody']
} as const satisfies Record<string, readonly [string, string]>

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

function OrganizationConnect() {
  const t = useTranslations('Auth.azureDevOpsConnect')
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [orgId, setOrgId] = useState('')
  const [integrationsHref, setIntegrationsHref] = useState('/')
  const [chosenOrganization, setChosenOrganization] = useState('')
  const [groups, setGroups] = useState<Map<string, AzureDevOpsProjectGroup>>(new Map())
  // Allow triggers per project, where the person changed it; otherwise on for Contributors and off for Readers (§11.1).
  const [triggerPicks, setTriggerPicks] = useState<Map<string, boolean>>(new Map())
  // Every project, including ones created later; while on, the per-project rows are left as they are.
  const [allProjects, setAllProjects] = useState<ProjectAccess | null>(null)
  // The flow ticket lives in this page's memory for the flow alone: never storage, never a URL.
  const flow = useRef<{ flowId: string; ticket: string } | null>(null)
  // The landing's query, read once: the first effect run clears the address bar, and Strict Mode runs it again.
  const landingSearch = useRef<string | null>(null)
  const [organizations, setOrganizations] = useState<Project[]>([])
  // Manage project access names its connection in the signed state.
  const [connectionId, setConnectionId] = useState<string | null>(null)

  const refuse = (e: unknown) => {
    const refusal = refusalOf(e)
    if (refusal.ticket && flow.current) flow.current = { ...flow.current, ticket: refusal.ticket }
    setStep({ kind: 'refused', refusal })
  }

  const chooseOrganization = async (org: string, organization: string) => {
    const current = flow.current
    if (!current) return
    const chosen = await chooseAzureDevOpsConnectOrganization(org, current.flowId, current.ticket, organization)
    flow.current = { ...current, ticket: chosen.ticket }
    // Opens on what the application already holds; Apply makes Azure DevOps match the page.
    const held = chosen.projects.filter((project) => project.access)
    setGroups(new Map(held.map((project) => [project.id, project.access!.group])))
    setTriggerPicks(new Map(held.map((project) => [project.id, project.access!.allowTriggers])))
    setAllProjects(chosen.allProjects ?? null)
    setStep({ kind: 'projects', organization: chosen.organization, projects: chosen.projects })
  }

  useEffect(() => {
    landingSearch.current ??= window.location.search
    const params = new URLSearchParams(landingSearch.current)
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
      const code = params.get('code')
      const error = params.get('error')
      const description = params.get('error_description')
      // The code is single-use, so the address bar drops it before anything can replay it.
      window.history.replaceState(null, '', window.location.pathname)
      void fetchOrgs()
        .catch(() => [])
        .then((orgs) => {
          const slug = orgs.find((o) => o.id === target.orgId)?.slug
          if (!cancelled && slug) setIntegrationsHref(`/${slug}/integrations`)
        })
      try {
        const started = await redeemOnce(target.orgId, {
          state,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
          ...(description ? { error_description: description } : {})
        })
        if (cancelled) return
        flow.current = { flowId: started.flowId, ticket: started.ticket }
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
      if (!current || (groups.size === 0 && !allProjects)) return
      const projects = [...groups.entries()].map(([projectId, group]) => ({
        projectId,
        group,
        allowTriggers: triggersAllowed(projectId, group)
      }))
      setStep({
        kind: 'done',
        result: await applyAzureDevOpsConnectProjects(orgId, current.flowId, current.ticket, projects, allProjects)
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

  // A newly checked project starts at Write with triggers allowed.
  const toggleProject = (projectId: string) => {
    setGroups((current) => {
      const next = new Map(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.set(projectId, 'contributors')
      return next
    })
    setTriggerPicks((current) => {
      const next = new Map(current)
      next.delete(projectId)
      return next
    })
  }

  // A group change resets the project's Allow triggers to that group's default.
  const setGroup = (projectId: string, group: AzureDevOpsProjectGroup) => {
    setGroups((current) => new Map(current).set(projectId, group))
    setTriggerPicks((current) => {
      const next = new Map(current)
      next.delete(projectId)
      return next
    })
  }

  const triggersAllowed = (projectId: string, group: AzureDevOpsProjectGroup): boolean =>
    triggerPicks.get(projectId) ?? group === 'contributors'

  const setTriggers = (projectId: string, allowed: boolean) =>
    setTriggerPicks((current) => new Map(current).set(projectId, allowed))

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
            <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{t('organizationTitle')}</h1>
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
              <h1 className="flex items-center gap-2 text-[18px] font-semibold leading-normal text-(--text-primary)">
                {t('projectsTitle')}
                <span
                  className="flex text-(--text-tertiary)"
                  title={t('projectsHint')}
                  data-azure-devops-projects-hint=""
                >
                  <Icon name="info" size={14} />
                </span>
              </h1>
              <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">
                {t('projectsDescription', { organization: step.organization })}
              </p>
            </div>
            <div data-azure-devops-all-projects="" className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-[10px] text-[14px] font-medium text-(--text-primary)">
                <input
                  type="checkbox"
                  checked={allProjects !== null}
                  disabled={busy}
                  onChange={() =>
                    setAllProjects((current) => (current ? null : { group: 'contributors', allowTriggers: true }))
                  }
                />
                <span className="min-w-0 truncate">{t('allProjects')}</span>
                <span className="flex text-(--text-tertiary)" title={t('allProjectsHint')}>
                  <Icon name="info" size={13} />
                </span>
              </label>
              {allProjects && (
                <AccessControls
                  label={t('allProjects')}
                  access={allProjects}
                  busy={busy}
                  onGroup={(group) => setAllProjects({ group, allowTriggers: group === 'contributors' })}
                  onTriggers={(allowTriggers) => setAllProjects({ ...allProjects, allowTriggers })}
                />
              )}
            </div>
            {allProjects ? null : step.projects.length === 0 ? (
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
                        <AccessControls
                          label={project.name}
                          triggersFor={project.id}
                          access={{ group, allowTriggers: triggersAllowed(project.id, group) }}
                          busy={busy}
                          onGroup={(value) => setGroup(project.id, value)}
                          onTriggers={(allowed) => setTriggers(project.id, allowed)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-[10px]">
              <Button onClick={() => void apply()} disabled={busy || (groups.size === 0 && !allProjects)}>
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
            <TriggerOutcomes result={step.result} />
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
      <TooltipLayer />
    </div>
  )
}

export default function AzureDevOpsConnect() {
  const [verification, setVerification] = useState<boolean | null>(null)
  useEffect(() => {
    setVerification(new URLSearchParams(window.location.search).get('state')?.startsWith('azure-verify.') ?? false)
  }, [])
  if (verification === null) return null
  return verification ? <AzureDevOpsVerify /> : <OrganizationConnect />
}

/** Projects where Allow triggers did not take (§11.1), with what is left to do by hand; silent when every grant took. */
function TriggerOutcomes({ result }: { result: AzureDevOpsConnectResultDto }) {
  const t = useTranslations('Auth.azureDevOpsConnect')
  const missed = (result.triggers ?? []).filter((grant) => grant.outcome !== 'granted')
  if (missed.length === 0 && !result.checklist?.length) return null
  return (
    <div
      data-azure-devops-trigger-outcomes=""
      className="flex w-full flex-col gap-2 rounded-md border border-(--border-subtle) bg-(--status-paused-soft) px-3 py-[10px] text-left"
    >
      <div className="flex items-start gap-2 text-[13px] font-semibold leading-[1.5] text-(--text-primary)">
        <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[3px] flex-none" />
        <span>{t('triggersMissedTitle')}</span>
      </div>
      {missed.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px] leading-[1.5] text-(--text-secondary)">
          {missed.map((grant) => (
            <li key={grant.projectId} data-azure-devops-trigger-outcome={grant.outcome} className="break-words">
              {grant.outcome === 'refused'
                ? t('triggersRefused', { project: grant.projectName })
                : t('triggersFailed', { project: grant.projectName })}
            </li>
          ))}
        </ul>
      )}
      {/* The checklist comes from the Control Plane: it names the application by its client ID. */}
      {result.checklist?.length ? (
        <ol className="m-0 flex list-decimal flex-col gap-[6px] pl-5 text-[12.5px] leading-[1.55] text-(--text-primary)">
          {result.checklist.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ol>
      ) : null}
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
  const keys = REFUSAL_COPY[refusal.code as keyof typeof REFUSAL_COPY]
  const title = keys ? t(`refusals.${keys[0]}`) : t('refusals.genericTitle')
  // Unlisted refusals say what to do in the Control Plane's own message.
  const body = keys ? t(`refusals.${keys[1]}`) : refusal.message || t('refusals.expiredBody')
  const checkAgain = manual && refusal.ticket !== undefined
  return (
    <div data-azure-devops-refusal={refusal.code} className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-(--status-paused-soft)">
          <Icon name={manual ? 'list-checks' : 'link-2-off'} size={19} color="var(--amber-500)" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold leading-normal text-(--text-primary)">{title}</h1>
          <p role="alert" className="mt-1 text-[13px] leading-[1.55] text-(--text-secondary)">
            {body}
          </p>
        </div>
      </div>
      {/* The checklist comes from the Control Plane: it names the application by its client ID. */}
      {refusal.checklist && (
        <ol className="m-0 flex list-decimal flex-col gap-[6px] pl-5 text-[13px] leading-[1.55] text-(--text-primary)">
          {refusal.checklist.map((item) => (
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
        {checkAgain ? (
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
        ) : canStartOver && refusal.code !== 'connection_exists' ? (
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

/** Read or Write, and Allow triggers, for one project or for all of them. */
function AccessControls({
  label,
  triggersFor,
  access,
  busy,
  onGroup,
  onTriggers
}: {
  label: string
  triggersFor?: string
  access: ProjectAccess
  busy: boolean
  onGroup: (group: AzureDevOpsProjectGroup) => void
  onTriggers: (allowed: boolean) => void
}) {
  const t = useTranslations('Auth.azureDevOpsConnect')
  return (
    <span className="flex flex-none items-center gap-3">
      <span role="group" aria-label={t('groupFor', { project: label })} className="pillbar flex-none gap-[2px] p-[2px]">
        {(['readers', 'contributors'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={access.group === value}
            disabled={busy}
            className={
              access.group === value ? 'pill on px-[10px] py-[3px] text-[12px]' : 'pill px-[10px] py-[3px] text-[12px]'
            }
            onClick={() => onGroup(value)}
          >
            {value === 'readers' ? t('read') : t('write')}
          </button>
        ))}
      </span>
      <label
        data-azure-devops-allow-triggers={triggersFor ?? 'all'}
        className="flex cursor-pointer items-center gap-[6px] text-[12.5px] text-(--text-secondary)"
      >
        <input
          type="checkbox"
          checked={access.allowTriggers}
          disabled={busy}
          onChange={(event) => onTriggers(event.target.checked)}
        />
        {t('allowTriggers')}
      </label>
    </span>
  )
}
