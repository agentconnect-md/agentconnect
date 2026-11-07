// No 'use client' here: rendered only inside a client boundary (IntegrationsView).

// The organization's one Azure DevOps connection and the repositories in use under it (azure-devops-integration.md §3.2, §5, §8).

import { useEffect, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { AzureDevOpsMark, LoadingState } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { docsPageUrl } from '@/lib/help-links'
import { useOrgs } from '@/lib/org-context'
import { azureDevOpsOrganizationUrl } from '@/lib/azure-devops-repositories'
import {
  connectAzureDevOps,
  disconnectAzureDevOps,
  fetchAzureDevOpsConnections,
  fetchAzureDevOpsRepositories,
  replaceAzureDevOpsSecret,
  startAzureDevOpsConnect,
  type AzureDevOpsConnectionDto,
  type AzureDevOpsRepositoryBindingDto,
  type AzureDevOpsStateReason
} from '@/lib/api'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Panel = 'own' | 'secret' | null

interface OwnApplicationDraft {
  organization: string
  tenantId: string
  clientId: string
  clientSecret: string
}

const EMPTY_DRAFT: OwnApplicationDraft = { organization: '', tenantId: '', clientId: '', clientSecret: '' }

/** Microsoft's sign-in is a full-page hop; the connect page brings the person back. */
function goTo(url: string): void {
  window.location.assign(url)
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
      setDraft(EMPTY_DRAFT)
      setPanel(null)
    })

  const replaceSecret = (target: AzureDevOpsConnectionDto) =>
    run('secret', async () => {
      setConnection(await replaceAzureDevOpsSecret(target.id, secret.trim()))
      setSecret('')
      setPanel(null)
      setNotice(t('secretReplaced'))
      setBindings(await fetchAzureDevOpsRepositories().catch(() => bindings))
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

  const reasonText = (reason: AzureDevOpsStateReason | null, source: AzureDevOpsConnectionDto['credentialSource']) =>
    reason === 'secret_rejected'
      ? source === 'own'
        ? t('reasons.secretRejectedOwn')
        : t('reasons.secretRejectedDeployment')
      : reason === 'access_revoked'
        ? t('reasons.accessRevoked')
        : reason === 'repository_unavailable'
          ? t('reasons.repositoryUnavailable')
          : null

  // One short line about the shared identity's reach, with the docs page for the detail (§3.6, §9).
  const attention = (
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
  )

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
          {canWrite && deploymentApplication && (
            <button
              type="button"
              className="lnk mt-2 font-sans text-[12.5px] font-medium leading-normal"
              onClick={() => setPanel('own')}
            >
              {t('useOwnApplication')}
            </button>
          )}
          {canWrite && !deploymentApplication && (
            <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('ownApplicationOnly')}
            </div>
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
                {connection.credentialSource === 'deployment' && (
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
                {connection.credentialSource === 'own' && panel === null && (
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
              <span>{reasonText(connection.stateReason, connection.credentialSource) ?? t('reasons.unknown')}</span>
            </div>
          )}
          {canWrite && panel === 'secret' && connection.credentialSource === 'own' && (
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

      {enabled === true && attention}

      {enabled === true && connection !== null && bindings.length === 0 && (
        <div className="px-4 py-5 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('noRepositories')}
        </div>
      )}
      {enabled === true &&
        connection !== null &&
        bindings.map((binding) => {
          const reason =
            binding.state === 'runtime_degraded' ? reasonText(binding.stateReason, connection.credentialSource) : null
          return (
            <div key={binding.id} className="row grid-cols-1 gap-[11px]" data-azure-devops-repository={binding.id}>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                  <span className="mono min-w-0 truncate text-[12.5px] text-(--text-primary)" title={binding.repoPath}>
                    {binding.repoPath}
                  </span>
                  {binding.state === 'runtime_degraded' && (
                    <span className="badge bg-(--status-paused-soft) text-(--amber-500)">{t('degraded')}</span>
                  )}
                </div>
                {reason && (
                  <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)">
                    {reason}
                  </div>
                )}
              </div>
            </div>
          )
        })}

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

function OwnField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="fld">
      <span className="fldlbl">{label}</span>
      {children}
    </label>
  )
}
