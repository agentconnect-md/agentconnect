import { Fragment, useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { SQUARE_MARK_FILL_PCT } from '@/components/mark-box'
import { GithubMark, LoadingState } from '@/components/marks'
import { useOrgs } from '@/lib/org-context'
import {
  fetchBuiltinGithubAppSlug,
  fetchGithubApps,
  fetchGithubInstallUrl,
  fetchGithubInstallations,
  syncGithubApp,
  syncGithubInstallations,
  type GithubInstallationDto
} from '@/lib/api'
import UninstallGithubInstallationModal from '@/components/console/modals/UninstallGithubInstallationModal'
import { Scrim } from '@/components/console/Scrim'
import { GithubAppRow, GithubOrgApps, INSTALLATION_ROW } from '@/components/console/GithubOrgApps'
import { consoleKeys } from '@/lib/swr-keys'

// No 'use client' here: rendered only inside a client boundary — the Integrations page, or the
// native code-host dialog an admin MCP tool opens in webchat.
//
// The deployment GitHub App powering github-app workspaces (repo picker +
// credential-free daemon git). Deployment-config opt-in: when the CP has no
// GITHUB_APP_* env the routes 404 and this card shows the disabled note.
// Installations are org-level infrastructure (like bots) — every member can
// see them; installing and syncing are writes (viewers don't get those buttons),
// while uninstalling the App from an account is owner-only.
export default function GithubCard({
  canWrite,
  isOwner,
  agentNameOf
}: {
  canWrite: boolean
  isOwner: boolean
  /** Names the agent an organization App serves; the console passes it, the webchat dialog does not. */
  agentNameOf?: (agentId: string) => string | undefined
}) {
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
  // Each App is a first-level row over its installations; the built-in App opens expanded.
  const [builtInOpen, setBuiltInOpen] = useState(true)
  const { mutate } = useSWRConfig()
  const { data: builtInSlug } = useSWR(activeOrg ? consoleKeys.githubBuiltinApp(activeOrg.id) : null, ([, id]) =>
    fetchBuiltinGithubAppSlug(id ?? undefined)
  )

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
      else setErr(t('github.installLinkError'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Re-pull every App's installations from GitHub, the built-in App's and each organization App's; one failing App doesn't stop the rest.
  const sync = async () => {
    if (busy || !activeOrg) return
    setBusy(true)
    setErr(null)
    try {
      const [builtIn, ...orgApps] = await Promise.allSettled([
        syncGithubInstallations(),
        ...(await fetchGithubApps(activeOrg.id)).map((app) => syncGithubApp(app.id))
      ])
      if (builtIn?.status === 'fulfilled') setInstalls(builtIn.value)
      await mutate(consoleKeys.githubApps(activeOrg.id))
      const failed = [builtIn, ...orgApps].find((result) => result?.status === 'rejected')
      if (failed?.status === 'rejected') {
        setErr(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
      }
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
          {t('github.label')}
        </span>
        {enabled === true && canWrite && (
          <Button variant="ghost" onClick={sync}>
            <Icon name="refresh-cw" size={13} />
            {busy ? t('github.syncing') : t('github.sync')}
          </Button>
        )}
      </div>
      {enabled === null && <LoadingState size={22} padding={20} />}
      {enabled === false && (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('github.notEnabled')}
        </div>
      )}
      {enabled === true && (
        <div data-builtin-app>
          <GithubAppRow
            open={builtInOpen}
            onToggle={() => setBuiltInOpen((open) => !open)}
            label={builtInOpen ? t('github.collapse') : t('github.expand')}
            aside={
              canWrite && (
                <Button size="xs" variant="ghost" onClick={install}>
                  <Icon name="external-link" size={13} />
                  {t('github.install')}
                </Button>
              )
            }
          >
            <span className="mono min-w-0 truncate text-[12.5px]">{builtInSlug ?? t('github.label')}</span>
            <span className="badge bg-(--surface-active) text-(--text-tertiary)">{t('github.builtIn')}</span>
          </GithubAppRow>
          {builtInOpen && installs.length === 0 && (
            <div className={INSTALLATION_ROW}>
              <div>
                <div className="font-sans text-[13px] font-semibold leading-normal">{t('github.noInstallations')}</div>
                <div className="mt-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {t('github.noInstallationsHint')}
                </div>
              </div>
            </div>
          )}
          {builtInOpen &&
            installs.map((i) => (
              <Fragment key={i.id}>
                <div className={INSTALLATION_ROW}>
                  <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                    <span className="mono min-w-0 truncate text-[12.5px]">{i.accountLogin}</span>
                    <span className="badge bg-(--surface-active) text-(--text-tertiary)">
                      {i.accountType === 'Organization' ? t('github.organization') : t('github.user')}
                    </span>
                    {i.suspended && (
                      <span className="badge bg-(--status-error-soft) text-(--status-error)">
                        {t('github.suspended')}
                      </span>
                    )}
                    {i.permissionsStatus === 'outdated' && (
                      <span className="badge bg-(--status-paused-soft) text-(--amber-500)">
                        {t('github.needsUpdate')}
                      </span>
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
                    className="flex flex-col items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--amber-500) desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3 desktop:pl-[50px]"
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      <Icon name="triangle-alert" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
                      <span>{t('github.permissionsNeedUpdate')}</span>
                    </span>
                    <a
                      href={i.settingsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="lnk flex-none text-[12px]"
                    >
                      {t('github.updatePermissions')}
                      <Icon name="external-link" size={12} />
                    </a>
                  </div>
                )}
              </Fragment>
            ))}
        </div>
      )}
      {enabled === true && (
        <GithubOrgApps canWrite={canWrite} isOwner={isOwner} {...(agentNameOf ? { agentNameOf } : {})} />
      )}
      {err && (
        <div className="px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">{err}</div>
      )}
      {uninstalling && (
        <Scrim onEscape={() => setUninstalling(null)} onClick={() => setUninstalling(null)}>
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
        </Scrim>
      )}
    </div>
  )
}
