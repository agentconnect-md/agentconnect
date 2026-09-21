import { Fragment, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { GithubMark, LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import {
  fetchGithubInstallUrl,
  fetchGithubInstallations,
  syncGithubInstallations,
  type GithubInstallationDto
} from '@/lib/api'
import UninstallGithubInstallationModal from '@/components/console/modals/UninstallGithubInstallationModal'

// No 'use client' here: rendered only inside a client boundary — the Integrations page, or the
// native code-host dialog an admin MCP tool opens in webchat.
//
// The deployment GitHub App powering github-app workspaces (repo picker +
// credential-free daemon git). Deployment-config opt-in: when the CP has no
// GITHUB_APP_* env the routes 404 and this card shows the disabled note.
// Installations are org-level infrastructure (like bots) — every member can
// see them; installing and syncing are writes (viewers don't get those buttons),
// while uninstalling the App from an account is owner-only.
export default function GithubCard({ canWrite, isOwner }: { canWrite: boolean; isOwner: boolean }) {
  const t = useTranslations('Integrations')
  // Gate the org-scoped fetch on the active org (same hard-refresh race as SlackCard):
  // before OrgProvider resolves, `orgBase()` throws → the catch would show "not enabled"
  // even when it IS. Re-fetch once the org resolves / on switch.
  const { activeOrg } = useOrgs()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [installs, setInstalls] = useState<GithubInstallationDto[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<GithubInstallationDto | null>(null)

  useEffect(() => {
    if (!activeOrg) return
    let alive = true
    setEnabled(null)
    fetchGithubInstallations()
      .then(({ enabled, installations }) => {
        if (!alive) return
        setEnabled(enabled)
        setInstalls(installations)
      })
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [activeOrg])

  // The install link mints a ONE-SHOT signed state — fetch fresh per click.
  const install = async () => {
    setErr(null)
    try {
      const url = await fetchGithubInstallUrl()
      if (url) window.open(url, '_blank', 'noopener')
      else setErr('Could not mint an install link.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Refresh the org's claimed installations after GitHub changes or an install
  // finished in the other tab just now.
  const sync = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      setInstalls(await syncGithubInstallations())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle flex items-center gap-2">
          {/* The box and fill the bot tabs' marks use, so a code host reads the same size as a chat platform. */}
          <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
            <GithubMark color="var(--text-primary)" fillPct={SQUARE_MARK_FILL_PCT} />
          </span>
          GitHub
        </span>
        {enabled === true && canWrite && (
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={sync}>
              <Icon name="refresh-cw" size={13} />
              {busy ? t('github.syncing') : t('github.sync')}
            </Button>
            <Button onClick={install}>
              <Icon name="external-link" size={13} />
              {t('github.install')}
            </Button>
          </span>
        )}
      </div>
      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          Not enabled on this deployment — the control plane has no GitHub App configured.
        </div>
      )}
      {enabled === true && installs.length === 0 && (
        <div className="px-4 py-7 text-center">
          <div className="font-sans text-[13px] font-semibold leading-normal">No installations yet</div>
          <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            Install the GitHub App to use private repositories with credential-free clone and push.
          </div>
        </div>
      )}
      {/* Desktop only: the row collapses to one stacked column below the
          breakpoint, where a two-track header would label nothing. */}
      {enabled === true && installs.length > 0 && (
        <div className="row h hidden grid-cols-[minmax(0,1fr)_auto] gap-[11px] desktop:grid">
          <span>{t('installation')}</span>
          <span>{t('repositoryAccess')}</span>
        </div>
      )}
      {enabled === true &&
        installs.map((i) => (
          <Fragment key={i.id}>
            <div className="row grid-cols-1 gap-2 desktop:grid-cols-[minmax(0,1fr)_auto] desktop:gap-[11px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-(--border-default) bg-(--surface-card)">
                  <span className="flex h-[14px] w-[14px] items-center justify-center">
                    <GithubMark color="var(--text-primary)" fillPct={SQUARE_MARK_FILL_PCT} />
                  </span>
                </span>
                <span className="mono min-w-0 truncate text-[12.5px]">{i.accountLogin}</span>
                <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                  {i.accountType === 'Organization' ? 'org' : 'user'}
                </span>
                {i.suspended && <span className="badge bg-(--status-error-soft) text-(--status-error)">suspended</span>}
                {i.permissionsStatus === 'outdated' && (
                  <span className="badge bg-(--status-paused-soft) text-(--amber-500)">needs update</span>
                )}
              </div>
              <span className="flex items-center justify-between gap-3 desktop:justify-end">
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {i.repositorySelection === 'all' ? t('github.allRepositories') : t('github.selectedRepositories')}
                </span>
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-(--status-error) hover:text-(--status-error)"
                    onClick={() => setUninstalling(i)}
                  >
                    <Icon name="unplug" size={13} />
                    {t('github.uninstall')}
                  </Button>
                )}
              </span>
            </div>
            {i.permissionsStatus === 'outdated' && (
              <div
                role="status"
                className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                  <span>This installation&rsquo;s GitHub permissions need updating before all features will work.</span>
                </span>
                <a href={i.settingsUrl} target="_blank" rel="noopener noreferrer" className="lnk flex-none text-[12px]">
                  Update permissions
                  <Icon name="external-link" size={12} />
                </a>
              </div>
            )}
          </Fragment>
        ))}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}
      {uninstalling && (
        <div className="scrim" onClick={() => setUninstalling(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <UninstallGithubInstallationModal
              installation={uninstalling}
              onClose={() => setUninstalling(null)}
              onUninstalled={(id) => {
                setInstalls((current) => current.filter((installation) => installation.id !== id))
                setUninstalling(null)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
