// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The organization's one Azure DevOps connection and the repositories in use under it (azure-devops-integration.md §3.2, §5, §8).

import { useEffect, useState, type ReactNode } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { AzureDevOpsMark, LoadingState } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { docsPageUrl } from '@/lib/help-links'
import { useOrgs } from '@/lib/org-context'
import { azureDevOpsOrganizationUrl, azureDevOpsRepositoryUrl } from '@/lib/azure-devops-repositories'
import {
  ApiError,
  connectAzureDevOps,
  disconnectAzureDevOps,
  fetchAzureDevOpsConnections,
  fetchAzureDevOpsRepositories,
  replaceAzureDevOpsSecret,
  rotateAzureDevOpsHookKey,
  startAzureDevOpsConnect,
  type AzureDevOpsConnectionDto,
  type AzureDevOpsHookKeyRotationDto,
  type AzureDevOpsHookReason,
  type AzureDevOpsRepositoryBindingDto,
  type AzureDevOpsStateReason
} from '@/lib/api'

type Panel = 'own' | 'secret' | null

interface OwnApplicationDraft {
  organization: string
  tenantId: string
  clientId: string
  clientSecret: string
}

const EMPTY_DRAFT: OwnApplicationDraft = { organization: '', tenantId: '', clientId: '', clientSecret: '' }

/** Control Plane refusals the card words itself; anything else is shown as the Control Plane wrote it. */
const REFUSAL_KEYS = {
  connection_exists: 'refusals.connectionExists',
  AZURE_DEVOPS_ORGANIZATION_TAKEN: 'refusals.organizationTaken',
  deployment_application_missing: 'refusals.deploymentApplicationMissing'
} as const

/** Microsoft's sign-in is a full-page hop; the connect page brings the person back. */
function goTo(url: string): void {
  window.location.assign(url)
}

/** Each hook reason's badge tone and message keys; a healthy repository shows nothing (§11.2). */
const HOOK_REASON = {
  webhook_unverified: {
    badge: 'hookBadges.webhookUnverified',
    reason: 'hookReasons.webhookUnverified',
    tone: 'bg-(--status-info-soft) text-(--status-info)'
  },
  triggers_not_allowed: {
    badge: 'hookBadges.triggersNotAllowed',
    reason: 'hookReasons.triggersNotAllowed',
    reasonOwn: 'hookReasons.triggersNotAllowedOwn',
    tone: 'bg-(--status-paused-soft) text-(--amber-500)'
  },
  relay_url_unconfigured: {
    badge: 'hookBadges.relayUrlUnconfigured',
    reason: 'hookReasons.relayUrlUnconfigured',
    tone: 'bg-(--status-error-soft) text-(--status-error)'
  },
  subscriptions_failed: {
    badge: 'hookBadges.subscriptionsFailed',
    reason: 'hookReasons.subscriptionsFailed',
    tone: 'bg-(--status-error-soft) text-(--status-error)'
  }
} as const satisfies Record<AzureDevOpsHookReason, { badge: string; reason: string; reasonOwn?: string; tone: string }>

/** A rotation refusal's message key. */
function rotateRefusalKey(reason: string | null) {
  if (reason === 'no_subscriptions') return 'rotateRefusals.noSubscriptions'
  if (reason === 'convergence_in_progress') return 'rotateRefusals.busy'
  if (reason === 'relay_url_unconfigured') return 'rotateRefusals.relayUrlUnconfigured'
  if (reason === 'binding_missing' || reason === 'connection_missing') return 'rotateRefusals.missing'
  return 'rotateRefusals.failed'
}

export default function AzureDevOpsCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('Integrations.azureDevOps')
  const locale = useLocale()
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [deploymentApplication, setDeploymentApplication] = useState(false)
  const [connection, setConnection] = useState<AzureDevOpsConnectionDto | null>(null)
  const [bindings, setBindings] = useState<AzureDevOpsRepositoryBindingDto[]>([])
  const [panel, setPanel] = useState<Panel>(null)
  const [draft, setDraft] = useState<OwnApplicationDraft>(EMPTY_DRAFT)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [rotating, setRotating] = useState<AzureDevOpsRepositoryBindingDto | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setEnabled(null)
    fetchAzureDevOpsConnections()
      .then(async (listed) => {
        if (!alive) return
        setEnabled(listed.enabled)
        setDeploymentApplication(listed.deploymentApplication)
        setConnection(listed.connections[0] ?? null)
        if (!listed.enabled || listed.connections.length === 0) return
        const rows = await fetchAzureDevOpsRepositories().catch(() => [])
        if (alive) setBindings(rows)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  const errorText = (e: unknown): string => {
    const key = e instanceof ApiError && e.code ? REFUSAL_KEYS[e.code as keyof typeof REFUSAL_KEYS] : undefined
    if (key) return t(key)
    return e instanceof Error ? e.message : String(e)
  }

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setErr(null)
    setNotice(null)
    try {
      await action()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const connectWithMicrosoft = (connectionId?: string) =>
    run(connectionId ? 'manage' : 'microsoft', async () =>
      goTo((await startAzureDevOpsConnect(connectionId)).authorizeUrl)
    )

  const connectOwn = () =>
    run('own', async () => {
      const record = await connectAzureDevOps({
        organization: draft.organization.trim(),
        tenantId: draft.tenantId.trim(),
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret.trim()
      })
      setConnection(record)
      setBindings([])
      setDraft(EMPTY_DRAFT)
      setPanel(null)
    })

  const replaceSecret = (target: AzureDevOpsConnectionDto) =>
    run('secret', async () => {
      setConnection(await replaceAzureDevOpsSecret(target.id, secret.trim()))
      setSecret('')
      setPanel(null)
      setNotice(t('secretReplaced'))
      // A replaced secret recovers the bindings it degraded, so re-read them.
      const rows = await fetchAzureDevOpsRepositories().catch(() => null)
      if (rows) setBindings(rows)
    })

  const disconnect = (target: AzureDevOpsConnectionDto) =>
    run('disconnect', async () => {
      try {
        await disconnectAzureDevOps(target.id)
        setConnection(null)
        setBindings([])
      } finally {
        setDisconnecting(false)
      }
    })

  const rotationText = (outcome: AzureDevOpsHookKeyRotationDto): string => {
    if (outcome.rotated) return outcome.reason ? t('rotatedPartly') : t('rotated')
    return t(rotateRefusalKey(outcome.reason))
  }

  const rotate = (target: AzureDevOpsRepositoryBindingDto) =>
    run('rotate', async () => {
      try {
        const outcome = await rotateAzureDevOpsHookKey(target.id)
        if (outcome.rotated) setNotice(rotationText(outcome))
        else setErr(rotationText(outcome))
        const rows = await fetchAzureDevOpsRepositories().catch(() => null)
        if (rows) setBindings(rows)
      } finally {
        setRotating(null)
      }
    })

  const closePanel = () => {
    setPanel(null)
    setDraft(EMPTY_DRAFT)
    setSecret('')
    setErr(null)
  }

  const ownComplete =
    draft.organization.trim() !== '' &&
    draft.tenantId.trim() !== '' &&
    draft.clientId.trim() !== '' &&
    draft.clientSecret.trim() !== ''

  // The fix differs by who holds the secret: the card for an own application, Setup for the deployment's.
  const reasonText = (reason: AzureDevOpsStateReason | null, own: boolean): string => {
    if (reason === 'secret_rejected')
      return own ? t('reasons.secretRejectedOwn') : t('reasons.secretRejectedDeployment')
    if (reason === 'access_revoked') return own ? t('reasons.accessRevokedOwn') : t('reasons.accessRevoked')
    if (reason === 'repository_unavailable') return t('reasons.repositoryUnavailable')
    return t('reasons.unknown')
  }

  const own = connection?.credentialSource === 'own'

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
            <AzureDevOpsMark fillPct={SQUARE_MARK_FILL_PCT} />
          </span>
          {t('title')}
        </span>
        {enabled === true && canWrite && connection === null && panel === null && (
          <Button
            disabled={busy !== null}
            onClick={() => (deploymentApplication ? void connectWithMicrosoft() : setPanel('own'))}
          >
            <Icon name="plug" size={13} />
            {deploymentApplication
              ? busy === 'microsoft'
                ? t('redirecting')
                : t('connectWithMicrosoft')
              : t('connect')}
          </Button>
        )}
      </div>

      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('notEnabled')}
        </div>
      )}

      {enabled === true && connection === null && panel === null && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">{t('notConnected')}</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            {deploymentApplication ? t('notConnectedHint') : t('ownApplicationOnly')}
          </div>
          {canWrite && deploymentApplication && (
            <button
              type="button"
              className="lnk mt-2 font-sans text-[12.5px] font-medium leading-normal"
              onClick={() => setPanel('own')}
            >
              {t('useOwnApplication')}
            </button>
          )}
        </div>
      )}

      {enabled === true && canWrite && connection === null && panel === 'own' && (
        <div data-azure-devops-own-app="" className="border-b border-(--border-subtle) px-4 py-[13px]">
          <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
            <OwnField label={t('fields.organization')}>
              <input
                className="inp mn font-mono text-[12.5px]"
                autoComplete="off"
                placeholder="example-org"
                value={draft.organization}
                onChange={(event) => setDraft({ ...draft, organization: event.target.value })}
              />
            </OwnField>
            <OwnField label={t('fields.tenantId')}>
              <input
                className="inp mn font-mono text-[12.5px]"
                autoComplete="off"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={draft.tenantId}
                onChange={(event) => setDraft({ ...draft, tenantId: event.target.value })}
              />
            </OwnField>
            <OwnField label={t('fields.clientId')}>
              <input
                className="inp mn font-mono text-[12.5px]"
                autoComplete="off"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={draft.clientId}
                onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
              />
            </OwnField>
            <OwnField label={t('fields.clientSecret')}>
              <input
                className="inp mn font-mono text-[12.5px]"
                type="password"
                autoComplete="new-password"
                value={draft.clientSecret}
                onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
              />
            </OwnField>
          </div>
          <div className="mt-[10px] flex items-start gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            <Icon name="users" size={13} className="mt-[2px] flex-none" />
            <span>{t('ownApplicationHint')}</span>
          </div>
          {/* Allow triggers runs only through the deployment application's sign-in (§11.1); an own application is granted by hand. */}
          <div
            data-azure-devops-own-triggers=""
            className="mt-[6px] flex items-start gap-[6px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)"
          >
            <Icon name="zap" size={13} className="mt-[2px] flex-none" />
            <span>{t('ownApplicationTriggers')}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-[10px]">
            <Button size="sm" disabled={busy !== null || !ownComplete} onClick={() => void connectOwn()}>
              <Icon name="plug" size={13} />
              {busy === 'own' ? t('checking') : t('connect')}
            </Button>
            <Button variant="ghost" size="sm" onClick={closePanel}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {enabled === true && connection !== null && (
        <div data-azure-devops-connection={connection.id}>
          <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
            <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                <span className="flex h-[14px] w-[14px] items-center justify-center">
                  <AzureDevOpsMark fillPct={SQUARE_MARK_FILL_PCT} />
                </span>
              </span>
              <a
                href={azureDevOpsOrganizationUrl(connection.organization)}
                target="_blank"
                rel="noopener noreferrer"
                title={t('openOrganization', { organization: connection.organization })}
                className="mono min-w-0 truncate text-[12.5px] text-(--text-primary) no-underline hover:underline"
              >
                {connection.organization}
              </a>
              {connection.identityName && (
                <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {connection.identityName}
                </span>
              )}
              {connection.state === 'connected' ? (
                <span className="badge bg-(--status-online-soft) text-(--status-online)">{t('connected')}</span>
              ) : (
                <span className="badge bg-(--status-paused-soft) text-(--amber-500)">{t('degraded')}</span>
              )}
            </div>
            {canWrite && (
              <span className="flex flex-wrap items-center justify-end gap-3">
                {!own && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy !== null}
                    onClick={() => void connectWithMicrosoft(connection.id)}
                  >
                    <Icon name="folder-key" size={13} />
                    {busy === 'manage' ? t('redirecting') : t('manageProjectAccess')}
                  </Button>
                )}
                {own && panel === null && (
                  <Button variant="ghost" size="xs" onClick={() => setPanel('secret')}>
                    <Icon name="key-round" size={13} />
                    {t('replaceSecret')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-(--status-error) hover:text-(--status-error)"
                  disabled={busy !== null}
                  onClick={() => setDisconnecting(true)}
                >
                  <Icon name="unplug" size={13} />
                  {t('disconnect')}
                </Button>
              </span>
            )}
          </div>
          {connection.state === 'degraded' && (
            <div
              role="status"
              className="flex items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500)"
            >
              <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
              <span>{reasonText(connection.stateReason, own)}</span>
            </div>
          )}
          {canWrite && panel === 'secret' && own && (
            <div data-azure-devops-secret="" className="border-b border-(--border-subtle) px-4 py-[13px]">
              <OwnField label={t('fields.newClientSecret')}>
                <input
                  className="inp mn font-mono text-[12.5px]"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </OwnField>
              <div className="mt-3 flex flex-wrap items-center gap-[10px]">
                <Button
                  size="sm"
                  disabled={busy !== null || secret.trim() === ''}
                  onClick={() => void replaceSecret(connection)}
                >
                  <Icon name="key-round" size={13} />
                  {busy === 'secret' ? t('checking') : t('replaceSecret')}
                </Button>
                <Button variant="ghost" size="sm" onClick={closePanel}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* One line on the shared identity's reach; the docs page carries the detail (§3.6, §9). */}
      {enabled === true && (
        <div
          data-azure-devops-attention=""
          className="flex items-start gap-2 border-b border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)"
        >
          <Icon name="shield-alert" size={13} className="mt-[2px] flex-none" />
          <span>
            {t('attention')}{' '}
            <a
              className="lnk inline-flex items-center gap-[2px] whitespace-nowrap"
              href={docsPageUrl(CODE_HOST_PROJECTION['azure-devops'].docsPath, locale)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('learnMore')}
              <Icon name="arrow-up-right" size={12} />
            </a>
          </span>
        </div>
      )}

      {enabled === true && connection !== null && bindings.length === 0 && (
        <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('noRepositories')}
        </div>
      )}
      {enabled === true &&
        connection !== null &&
        bindings.map((binding) => (
          <RepositoryRow
            key={binding.id}
            binding={binding}
            own={own}
            canWrite={canWrite}
            busy={busy !== null}
            stateReason={binding.state === 'runtime_degraded' ? reasonText(binding.stateReason, own) : null}
            onRotate={() => setRotating(binding)}
          />
        ))}

      {rotating && (
        <Scrim onEscape={() => setRotating(null)} onClick={() => setRotating(null)}>
          <div className="modal" data-azure-devops-rotate={rotating.id} onClick={(event) => event.stopPropagation()}>
            <div className="modalhead">
              <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--surface-sunken)">
                <Icon name="key-round" size={16} />
              </span>
              <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('rotateTitle')}</span>
              <button className="iconbtn" onClick={() => setRotating(null)} aria-label={t('close')}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modalbody">
              <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
                {t('rotateBody', { repo: rotating.repoPath })}
              </p>
            </div>
            <div className="modalfoot">
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => setRotating(null)}>
                {t('cancel')}
              </Button>
              <Button
                onClick={() => void rotate(rotating)}
                className={busy === 'rotate' ? 'pointer-events-none opacity-50' : undefined}
              >
                <Icon name="refresh-cw" size={15} />
                {busy === 'rotate' ? t('working') : t('rotate')}
              </Button>
            </div>
          </div>
        </Scrim>
      )}

      {notice && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {notice}
        </div>
      )}
      {err && (
        <div role="alert" className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
          {err}
        </div>
      )}

      {disconnecting && connection && (
        <Scrim onEscape={() => setDisconnecting(false)} onClick={() => setDisconnecting(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modalhead">
              <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
                <span className="flex h-4 w-4 items-center justify-center">
                  <AzureDevOpsMark fillPct={100} />
                </span>
              </span>
              <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('disconnectTitle')}</span>
              <button className="iconbtn" onClick={() => setDisconnecting(false)} aria-label={t('close')}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modalbody">
              <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
                {t('disconnectBody', { organization: connection.organization })}
              </p>
            </div>
            <div className="modalfoot">
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => setDisconnecting(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void disconnect(connection)}
                className={busy === 'disconnect' ? 'pointer-events-none opacity-50' : undefined}
              >
                <Icon name="unplug" size={15} />
                {busy === 'disconnect' ? t('working') : t('disconnect')}
              </Button>
            </div>
          </div>
        </Scrim>
      )}
    </div>
  )
}

/** One repository in use: its access state, its triggers' service hooks, and the key rotation. */
function RepositoryRow({
  binding,
  own,
  canWrite,
  busy,
  stateReason,
  onRotate
}: {
  binding: AzureDevOpsRepositoryBindingDto
  own: boolean
  canWrite: boolean
  busy: boolean
  stateReason: string | null
  onRotate: () => void
}) {
  const t = useTranslations('Integrations.azureDevOps')
  const format = useFormatter()
  const subscriptions = binding.subscriptions ?? []
  const hook = binding.hookReason ? HOOK_REASON[binding.hookReason] : null
  const lastDelivery = binding.lastVerifiedDeliveryAt
    ? t('lastDelivery', { time: format.relativeTime(new Date(binding.lastVerifiedDeliveryAt), { now: Date.now() }) })
    : t('noDeliveryYet')
  return (
    <div
      className="row grid-cols-[minmax(0,1fr)_auto] items-center gap-[11px]"
      data-azure-devops-repository={binding.id}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
          <a
            href={azureDevOpsRepositoryUrl(binding.repoPath) ?? binding.cloneUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t('openRepository', { repo: binding.repoPath })}
            className="mono min-w-0 truncate text-[12.5px] text-(--text-primary) no-underline hover:underline"
          >
            {binding.repoPath}
          </a>
          {binding.state === 'runtime_degraded' && (
            <span className="badge bg-(--status-paused-soft) text-(--amber-500)">{t('degraded')}</span>
          )}
          {hook && (
            <span className={`badge ${hook.tone}`} data-azure-devops-hook-reason={binding.hookReason}>
              {t(hook.badge)}
            </span>
          )}
        </div>
        {stateReason && (
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
            {stateReason}
          </div>
        )}
        {hook && (
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
            {t('reasonOwn' in hook && own ? hook.reasonOwn : hook.reason)}
          </div>
        )}
        {/* One status per repository: a problem is its badge alone; a working trigger shows its last event. */}
        {!hook && subscriptions.length > 0 && (
          <div
            data-azure-devops-last-event
            className="mt-[3px] flex min-w-0 items-center gap-x-[6px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)"
          >
            <Icon name="webhook" size={12} className="flex-none" />
            <span>{lastDelivery}</span>
          </div>
        )}
      </div>
      <span className="flex items-center justify-end gap-2">
        {canWrite && subscriptions.length > 0 && (
          <button
            className="iconbtn h-7 w-7 flex-none"
            title={t('rotateKey')}
            aria-label={t('rotateKey')}
            disabled={busy}
            onClick={onRotate}
          >
            <Icon name="key-round" size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

function OwnField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="fld">
      <span className="fldlbl">{label}</span>
      {children}
    </label>
  )
}
