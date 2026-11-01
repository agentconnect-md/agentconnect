import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { GithubMark } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'
import { deleteGithubApp, fetchGithubApps, githubAppPageUrl, syncGithubApp, type GithubOrgAppDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

// No 'use client' here: rendered only inside GithubCard's client boundary.
// The organization's own GitHub Apps, below the built-in App's installations; absent until the org creates one.
export function GithubOrgApps({
  canWrite,
  isOwner,
  agentNameOf
}: {
  canWrite: boolean
  isOwner: boolean
  /** Names the agent an App serves; absent (outside the console) ⇒ "in use". */
  agentNameOf?: (agentId: string) => string | undefined
}) {
  const t = useTranslations('Integrations.github.orgApps')
  const { activeOrg } = useOrgs()
  const { data: apps, mutate } = useSWR(activeOrg ? consoleKeys.githubApps(activeOrg.id) : null, ([, id]) =>
    fetchGithubApps(id ?? undefined)
  )
  const [syncing, setSyncing] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<GithubOrgAppDto | null>(null)

  if (!apps || apps.length === 0) return null

  const sync = async (app: GithubOrgAppDto) => {
    if (syncing) return
    setSyncing(app.id)
    setErr(null)
    try {
      await syncGithubApp(app.id)
      await mutate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(null)
    }
  }

  return (
    <>
      <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
        <span>{t('heading')}</span>
        <span>{t('installedOn')}</span>
      </div>
      {apps.map((app) => {
        const accounts = app.installations.filter((i) => !i.suspended).map((i) => i.accountLogin)
        return (
          <div
            key={app.id}
            data-org-app={app.slug}
            className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                <span className="flex h-[14px] w-[14px] items-center justify-center">
                  <GithubMark color="var(--text-primary)" fillPct={SQUARE_MARK_FILL_PCT} />
                </span>
              </span>
              <a
                className="mono min-w-0 truncate text-[12.5px] text-inherit underline-offset-2 hover:underline"
                href={githubAppPageUrl(app.slug)}
                target="_blank"
                rel="noreferrer"
              >
                {app.slug}
              </a>
              {app.agentId === null ? (
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">{t('free')}</span>
              ) : (
                <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {agentNameOf?.(app.agentId) ? t('usedBy', { agent: agentNameOf(app.agentId) ?? '' }) : t('inUse')}
                </span>
              )}
            </div>
            <span className="flex items-center justify-between gap-3 desktop:justify-end">
              <span className="mono min-w-0 truncate text-[12px] text-(--text-tertiary)">
                {accounts.length > 0 ? accounts.join(', ') : t('notInstalled')}
              </span>
              {canWrite && (
                <span className="flex flex-none items-center gap-1">
                  <a
                    className="iconbtn"
                    href={`${githubAppPageUrl(app.slug)}/installations/new`}
                    target="_blank"
                    rel="noreferrer"
                    title={t('install')}
                    aria-label={t('install')}
                  >
                    <Icon name="external-link" size={14} />
                  </a>
                  <button
                    type="button"
                    className="iconbtn"
                    title={t('sync')}
                    aria-label={t('sync')}
                    disabled={syncing !== null}
                    onClick={() => void sync(app)}
                  >
                    <Icon name="refresh-cw" size={14} className={syncing === app.id ? 'animate-spin' : undefined} />
                  </button>
                  {isOwner && app.agentId === null && (
                    <AnchoredFlyout
                      ariaLabel={t('more')}
                      align="end"
                      width={200}
                      estimatedHeight={44}
                      triggerClassName="flex"
                      trigger={({ open, menuId, toggle }) => (
                        <button
                          type="button"
                          className="iconbtn"
                          title={t('more')}
                          aria-label={t('more')}
                          aria-haspopup="menu"
                          aria-expanded={open}
                          aria-controls={open ? menuId : undefined}
                          onClick={toggle}
                        >
                          <Icon name="ellipsis" size={14} />
                        </button>
                      )}
                    >
                      {({ close }) => (
                        <button
                          type="button"
                          role="menuitem"
                          className="fopt text-(--status-error)"
                          onClick={() => {
                            close(true)
                            setDeleting(app)
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{t('delete')}</span>
                        </button>
                      )}
                    </AnchoredFlyout>
                  )}
                </span>
              )}
            </span>
          </div>
        )
      })}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}
      {deleting && (
        <DeleteGithubAppDialog
          app={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            void mutate()
          }}
        />
      )}
    </>
  )
}

function DeleteGithubAppDialog({
  app,
  onClose,
  onDeleted
}: {
  app: GithubOrgAppDto
  onClose: () => void
  onDeleted: () => void
}) {
  const t = useTranslations('Integrations.github.orgApps')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const remove = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteGithubApp(app.id)
      onDeleted()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Scrim onEscape={busy ? undefined : onClose} onClick={busy ? undefined : onClose}>
      <div
        className="modal max-w-[460px]"
        role="dialog"
        aria-modal="true"
        aria-label={t('deleteTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('deleteTitle')}</span>
          <button type="button" className="iconbtn" aria-label={t('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
            {t.rich('deleteBody', { slug: () => <span className="mono text-(--text-primary)">{app.slug}</span> })}
          </p>
          {err && (
            <div
              role="alert"
              className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)"
            >
              {err}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            className={busy ? 'pointer-events-none opacity-50' : undefined}
          >
            {busy ? t('deleting') : t('deleteConfirm')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
