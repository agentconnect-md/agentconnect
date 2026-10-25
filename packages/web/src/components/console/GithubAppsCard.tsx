'use client'

// Settings → "GitHub Apps": GitHub Apps the organization registers beside the
// deployment App so an agent can act as its own bot. Owner-only. The private key
// is WRITE-ONLY — it is sent once on registration and never read back. Hidden
// entirely when this deployment has no GitHub App configured.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import {
  deleteGithubApp,
  fetchGithubApps,
  fetchGithubInstallations,
  registerGithubApp,
  syncGithubApp,
  type GithubRegisteredAppDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { Button, Icon } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { LoadingState } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'

const FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const INPUT = `h-8 ${FIELD}`
const TEXTAREA = `min-h-32 resize-y py-[6px] leading-[1.5] ${FIELD}`
const LABEL = 'font-sans text-[12px] font-semibold leading-normal text-(--text-primary)'
const HELP = 'font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function GithubAppsCard({ orgId, isOwner }: { orgId: string | undefined; isOwner: boolean }) {
  const t = useTranslations('Settings.githubApps')
  // The installations list doubles as the feature probe (404 ⇒ off), shared with the checklist.
  const { data: enabled } = useSWR(
    isOwner ? consoleKeys.githubApp(orgId) : null,
    ([, id]) => fetchGithubInstallations(id as string).then((r) => r.enabled),
    { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  )
  const {
    data: apps,
    error: loadError,
    mutate
  } = useSWR<GithubRegisteredAppDto[]>(isOwner && enabled ? consoleKeys.githubApps(orgId) : null, ([, id]) =>
    fetchGithubApps(id as string)
  )
  const [registering, setRegistering] = useState(false)
  const [removing, setRemoving] = useState<GithubRegisteredAppDto | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  useEffect(() => {
    setRegistering(false)
    setRemoving(null)
    setRemoveError(null)
    setSyncError(null)
  }, [orgId])

  if (!isOwner || !enabled) return null

  const confirmRemove = async () => {
    if (!removing || removeBusy) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await deleteGithubApp(removing.id)
      setRemoving(null)
      await mutate()
    } catch (err) {
      setRemoveError(errorMessage(err))
    } finally {
      setRemoveBusy(false)
    }
  }

  const sync = async (app: GithubRegisteredAppDto) => {
    if (syncing) return
    setSyncing(app.id)
    setSyncError(null)
    try {
      await syncGithubApp(app.id)
      await mutate()
    } catch (err) {
      setSyncError(errorMessage(err))
    } finally {
      setSyncing(null)
    }
  }

  return (
    <div className="card mt-[18px]" id="github-apps">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">{t('title')}</span>
          {apps && apps.length > 0 && <span className="mono text-[11px] text-(--text-tertiary)">{apps.length}</span>}
        </span>
        <Button variant="secondary" size="xs" onClick={() => setRegistering(true)}>
          <Icon name="plus" size={14} />
          {t('register')}
        </Button>
      </div>

      <div className="px-4 pb-[2px] pt-[13px]">
        <div className={HELP}>{t('description')}</div>
      </div>

      {apps === undefined && !loadError ? (
        <LoadingState size={22} padding={20} />
      ) : loadError ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          {t('loadError')}
        </div>
      ) : !apps || apps.length === 0 ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('empty')}
        </div>
      ) : (
        <div className="py-1">
          {apps.map((app) => (
            <div
              key={app.id}
              className="flex flex-col gap-[6px] px-4 py-[10px] desktop:flex-row desktop:items-center desktop:gap-3"
            >
              <span className="flex min-w-0 items-center gap-[7px] desktop:flex-1">
                <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)">{app.slug}[bot]</span>
                <span className="mono flex-none text-[11px] text-(--text-tertiary)">
                  {t('appId', { appId: app.appId })}
                </span>
              </span>
              <span className="min-w-0 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:flex-1">
                {app.installations.length === 0
                  ? t('noInstallations')
                  : app.installations
                      .map((i) => (i.suspended ? t('suspended', { account: i.accountLogin }) : i.accountLogin))
                      .join(', ')}
              </span>
              <span className="flex flex-none items-center gap-1">
                <Button variant="secondary" size="xs" disabled={syncing !== null} onClick={() => void sync(app)}>
                  {syncing === app.id ? t('syncing') : t('sync')}
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    setRemoveError(null)
                    setRemoving(app)
                  }}
                >
                  {t('remove')}
                </Button>
              </span>
            </div>
          ))}
          {syncError && (
            <div role="alert" className="px-4 py-[6px] font-sans text-[12px] leading-[1.5] text-(--status-error)">
              {syncError}
            </div>
          )}
        </div>
      )}

      {registering && (
        <RegisterSheet
          onClose={() => setRegistering(false)}
          onSaved={async () => {
            setRegistering(false)
            await mutate()
          }}
        />
      )}

      {removing && (
        <ConfirmationDialog
          title={t('removeTitle', { slug: removing.slug })}
          confirmLabel={t('remove')}
          busy={removeBusy}
          busyLabel={t('removing')}
          error={removeError}
          onConfirm={() => void confirmRemove()}
          onClose={() => (removeBusy ? undefined : setRemoving(null))}
        >
          {t('removeBody')}
        </ConfirmationDialog>
      )}
    </div>
  )
}

function RegisterSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations('Settings.githubApps')
  const [appId, setAppId] = useState('')
  const [clientId, setClientId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const appIdNumber = Number(appId)
  const valid = Number.isInteger(appIdNumber) && appIdNumber > 0 && privateKey.trim() !== ''

  const save = async () => {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      await registerGithubApp({
        appId: appIdNumber,
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        privateKey
      })
      await onSaved()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Scrim onEscape={busy ? undefined : onClose}>
      <div className="modal max-w-[560px]" role="dialog" aria-modal="true" aria-label={t('registerTitle')}>
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('registerTitle')}</span>
          <button type="button" className="iconbtn" aria-label={t('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modalbody flex flex-col gap-[18px]">
          <label className="flex flex-col gap-[6px]">
            <span className={LABEL}>{t('appIdLabel')}</span>
            <input
              className={INPUT}
              type="number"
              inputMode="numeric"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              aria-label={t('appIdLabel')}
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-[6px]">
            <span className={LABEL}>{t('clientIdLabel')}</span>
            <input
              className={INPUT}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('clientIdLabel')}
            />
          </label>

          <label className="flex flex-col gap-[6px]">
            <span className={LABEL}>{t('privateKeyLabel')}</span>
            <textarea
              className={TEXTAREA}
              placeholder={t('privateKeyPlaceholder')}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('privateKeyLabel')}
            />
            <span className={HELP}>{t('privateKeyHelp')}</span>
          </label>

          {error && (
            <div role="alert" className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              {error}
            </div>
          )}
        </div>

        <div className="modalfoot">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !valid}>
            {busy ? t('registering') : t('register')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
