'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { DaemonSelect } from '@/components/console/DaemonSelect'
import {
  deleteAgentGithubApp,
  fetchAgentGithubApp,
  fetchGithubInstallations,
  startAgentGithubAppManifest,
  syncAgentGithubApp
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

const TEXT = 'font-sans text-[12px] font-normal leading-normal text-(--text-secondary)'
const PERSONAL = '\u0000personal'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Posts the manifest to GitHub as a top-level form, which is the only way GitHub accepts one. */
function submitToGithub(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = action
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'manifest'
  field.value = JSON.stringify(manifest)
  form.appendChild(field)
  document.body.appendChild(form)
  form.submit()
}

/** The bot this agent acts as on GitHub: the shared deployment App, or its own App created through GitHub. */
export function GithubIdentityField({ agentId, className }: { agentId: string; className?: string }) {
  const t = useTranslations('Common.githubIdentity')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id
  const { data, mutate } = useSWR(
    consoleKeys.agentGithubApp(orgId, agentId),
    ([, id]) => fetchAgentGithubApp(id ?? undefined, agentId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  const { data: installs } = useSWR(
    data?.enabled && !data.app ? consoleKeys.githubInstallations(orgId) : null,
    ([, id]) => fetchGithubInstallations(id as string).then((r) => r.installations),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  const owners = [
    ...new Set(
      (installs ?? []).filter((i) => i.accountType === 'Organization' && !i.suspended).map((i) => i.accountLogin)
    )
  ]
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState<'create' | 'sync' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (!data?.enabled) return null
  const app = data.app
  const chosenOwner = owner || owners[0] || PERSONAL

  const run = async (kind: 'create' | 'sync' | 'remove', action: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const create = () =>
    run('create', async () => {
      const form = await startAgentGithubAppManifest(agentId, chosenOwner === PERSONAL ? undefined : chosenOwner)
      submitToGithub(form.action, form.manifest)
    })

  return (
    <div className={`fld min-w-0 ${className ?? ''}`}>
      <span className="fldlbl">{t('label')}</span>
      {app ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)">{app.slug}[bot]</span>
          <span className={TEXT}>
            {app.installations.length === 0
              ? t('notInstalled')
              : t('installedOn', {
                  accounts: app.installations
                    .map((i) => (i.suspended ? t('suspended', { account: i.accountLogin }) : i.accountLogin))
                    .join(', ')
                })}
          </span>
          <span className="flex-1" />
          {app.installations.length === 0 ? (
            <a
              className="dsbtn xs dsbtn-secondary no-underline"
              href={`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`}
            >
              {t('install')}
            </a>
          ) : (
            <Button
              variant="secondary"
              size="xs"
              disabled={busy !== null}
              onClick={() =>
                void run('sync', async () => {
                  const synced = await syncAgentGithubApp(agentId)
                  await mutate({ enabled: true, app: synced.app }, { revalidate: false })
                })
              }
            >
              {busy === 'sync' ? t('syncing') : t('sync')}
            </Button>
          )}
          <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => setConfirming(true)}>
            {t('remove')}
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={TEXT}>{t('shared')}</span>
          <span className="flex-1" />
          <DaemonSelect
            value={chosenOwner}
            ariaLabel={t('owner')}
            options={[
              ...owners.map((login) => ({ value: login, label: login })),
              { value: PERSONAL, label: t('personal') }
            ]}
            onChange={setOwner}
          />
          <Button variant="secondary" size="xs" disabled={busy !== null} onClick={() => void create()}>
            {busy === 'create' ? t('creating') : t('create')}
          </Button>
        </div>
      )}
      {error && !confirming && (
        <div role="alert" className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
          {error}
        </div>
      )}
      {confirming && app && (
        <ConfirmationDialog
          title={t('removeTitle', { slug: app.slug })}
          confirmLabel={t('remove')}
          busy={busy === 'remove'}
          busyLabel={t('removing')}
          error={error}
          destructive
          onConfirm={() =>
            void run('remove', async () => {
              await deleteAgentGithubApp(agentId)
              setConfirming(false)
              await mutate()
            })
          }
          onClose={() => (busy === 'remove' ? undefined : setConfirming(false))}
        >
          {t('removeBody')}
        </ConfirmationDialog>
      )}
    </div>
  )
}
