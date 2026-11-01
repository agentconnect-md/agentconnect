import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import Link from 'next/link'
import { AgentIconView, GithubMark } from '@/components/marks'
import { useConsoleData } from '@/lib/data-context'
import { Scrim } from '@/components/console/Scrim'
import { deleteGithubApp, fetchGithubApps, githubAppPageUrl, type GithubOrgAppDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

// No 'use client' here: rendered only inside GithubCard's client boundary.

/** One GitHub App's first-level row: a toggle over its installations on the left, its summary and actions on the right. */
export function GithubAppRow({
  open,
  onToggle,
  label,
  icon,
  children,
  aside,
  dataAttr
}: {
  open: boolean
  onToggle: () => void
  label: string
  /** Leads the row; absent ⇒ the GitHub mark. */
  icon?: ReactNode
  children: ReactNode
  aside: ReactNode
  dataAttr?: string
}) {
  return (
    <div
      data-github-app={dataAttr}
      className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
        <button
          type="button"
          className="iconbtn h-6 w-6 flex-none"
          aria-expanded={open}
          aria-label={label}
          title={label}
          onClick={onToggle}
        >
          <Icon name="chevron-down" size={14} className={open ? undefined : '-rotate-90'} />
        </button>
        {icon ?? (
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
            <span className="flex h-[14px] w-[14px] items-center justify-center">
              <GithubMark color="var(--text-primary)" fillPct={SQUARE_MARK_FILL_PCT} />
            </span>
          </span>
        )}
        {children}
      </div>
      <span className="flex items-center justify-between gap-3 desktop:justify-end">{aside}</span>
    </div>
  )
}

/** Opens the App's install page on GitHub, as an icon like every other row action. */
export function InstallAppButton({ href, onClick }: { href?: string; onClick?: () => void }) {
  const t = useTranslations('Integrations.github')
  return (
    <button
      type="button"
      className="iconbtn"
      title={t('install')}
      aria-label={t('install')}
      onClick={onClick ?? (() => href && window.open(href, '_blank', 'noopener'))}
    >
      <Icon name="external-link" size={14} />
    </button>
  )
}

/** An installation nested under its App: indented on the sunken surface. */
export const INSTALLATION_ROW =
  'row grid-cols-1 gap-2 bg-(--surface-sunken) desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px] desktop:pl-[50px]'

// The organization's own GitHub Apps, each over its installations; absent until the org creates one.
export function GithubOrgApps({ canWrite, isOwner }: { canWrite: boolean; isOwner: boolean }) {
  const t = useTranslations('Integrations.github')
  const { activeOrg, orgPath } = useOrgs()
  const { getAgent } = useConsoleData()
  const { data: apps, mutate } = useSWR(activeOrg ? consoleKeys.githubApps(activeOrg.id) : null, ([, id]) =>
    fetchGithubApps(id ?? undefined)
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState<GithubOrgAppDto | null>(null)

  if (!apps || apps.length === 0) return null

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <>
      {apps.map((app) => {
        const open = expanded.has(app.id)
        const agent = app.agentId ? getAgent(app.agentId) : undefined
        const agentName = agent ? (agent.displayName ?? agent.name) : ''
        return (
          <div key={app.id} data-org-app={app.slug}>
            <GithubAppRow
              open={open}
              onToggle={() => toggle(app.id)}
              label={open ? t('collapse') : t('expand')}
              icon={
                agent ? (
                  <Link
                    href={orgPath(`/agents/${encodeURIComponent(agent.id)}`)}
                    title={t('orgApps.openAgent', { agent: agentName })}
                    className="flex flex-none no-underline"
                  >
                    <span className="av h-7 w-7 flex-none rounded-[7px]">
                      <AgentIconView icon={agent.icon} runtime={agent.runtime || agent.model || ''} size={28} />
                    </span>
                  </Link>
                ) : undefined
              }
              aside={
                <>
                  {canWrite && <InstallAppButton href={`${githubAppPageUrl(app.slug)}/installations/new`} />}
                  {/* Only a free App can be deleted. */}
                  {isOwner && app.agentId === null && (
                    <button
                      type="button"
                      className="iconbtn text-(--status-error)"
                      title={t('orgApps.delete')}
                      aria-label={t('orgApps.delete')}
                      onClick={() => setDeleting(app)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </>
              }
            >
              <a
                className="mono min-w-0 truncate text-[12.5px] text-inherit underline-offset-2 hover:underline"
                href={githubAppPageUrl(app.slug)}
                target="_blank"
                rel="noreferrer"
              >
                {app.slug}
              </a>
              {app.agentId === null ? (
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">{t('orgApps.free')}</span>
              ) : agent ? (
                <Link
                  href={orgPath(`/agents/${encodeURIComponent(agent.id)}`)}
                  className="badge min-w-0 truncate bg-(--surface-active) text-(--text-secondary) no-underline hover:text-(--text-primary)"
                >
                  {agentName}
                </Link>
              ) : (
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">{t('orgApps.inUse')}</span>
              )}
            </GithubAppRow>
            {open &&
              (app.installations.length === 0 ? (
                <div className={INSTALLATION_ROW}>
                  <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {t('orgApps.noInstallations')}
                  </span>
                </div>
              ) : (
                app.installations.map((i) => (
                  <div key={i.id} className={INSTALLATION_ROW}>
                    <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                      <span className="mono min-w-0 truncate text-[12.5px]">{i.accountLogin}</span>
                      <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                        {i.accountType === 'Organization' ? t('organization') : t('user')}
                      </span>
                      {i.suspended && (
                        <span className="badge bg-(--status-error-soft) text-(--status-error)">{t('suspended')}</span>
                      )}
                    </div>
                    <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {i.repositorySelection === 'all' ? t('allRepositories') : t('selectedRepositories')}
                    </span>
                  </div>
                ))
              ))}
          </div>
        )
      })}
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
